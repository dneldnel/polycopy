import "dotenv/config";
import { startLeaderStream, type LeaderStreamDiagnosticEvent } from "./leaderStream";
import { createLogger, errorMessage } from "./logger";
import { normalizeLeaderTradePayload } from "./normalize";
import type { ActivityTradePayload, NormalizedLeaderTrade } from "./types";

type ConnectionState = "connecting" | "connected" | "disconnected";

interface WatchDiagnostics {
  socketOpenedAt: number | null;
  subscriptionSentAt: number | null;
  lastMessageAt: number | null;
  rawMessageCount: number;
  activityTradeCount: number;
  matchedTradeCount: number;
  walletMismatchCount: number;
  invalidPayloadCount: number;
  parseFailureCount: number;
  ignoredMessageCount: number;
  lastOtherWallet: string | null;
  lastIssue: string | null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function createWatchDiagnostics(): WatchDiagnostics {
  return {
    socketOpenedAt: null,
    subscriptionSentAt: null,
    lastMessageAt: null,
    rawMessageCount: 0,
    activityTradeCount: 0,
    matchedTradeCount: 0,
    walletMismatchCount: 0,
    invalidPayloadCount: 0,
    parseFailureCount: 0,
    ignoredMessageCount: 0,
    lastOtherWallet: null,
    lastIssue: null,
  };
}

function normalizeAddress(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`Invalid ${label}: ${value || "(empty)"}`);
  }
  return normalized;
}

function getLeaderWallet(argv: string[], env: NodeJS.ProcessEnv): string {
  const argWallet = argv.find((value) => value.startsWith("0x"));
  if (argWallet) {
    return normalizeAddress(argWallet, "leader wallet argument");
  }

  const envWallet = asString(env.LEADER_WALLET_ADDRESS);
  if (!envWallet) {
    throw new Error("Missing LEADER_WALLET_ADDRESS");
  }

  return normalizeAddress(envWallet, "leader wallet");
}

function compact(value: string | null, head = 10, tail = 8): string {
  if (!value) {
    return "-";
  }
  if (value.length <= head + tail + 3) {
    return value;
  }
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function formatTimestamp(timestamp: number): string {
  const date = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp) : new Date();
  return new Intl.DateTimeFormat("en-GB", {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function formatTimestampOrDash(timestamp: number | null): string {
  return timestamp ? formatTimestamp(timestamp) : "-";
}

function statusLabel(state: ConnectionState): string {
  if (state === "connected") {
    return "socket connected";
  }
  if (state === "disconnected") {
    return "socket disconnected (auto-retrying)";
  }
  return "socket connecting";
}

function line(label: string, value: string): string {
  return `${label.padEnd(10, " ")} ${value}`;
}

function rule(): string {
  const width = process.stdout.columns ?? 80;
  return "=".repeat(Math.max(48, Math.min(width, 88)));
}

function missingRequiredTradeFields(payload: ActivityTradePayload): string[] {
  const side = asString(payload.side).toUpperCase();
  const price = payload.price;
  const size = payload.size;
  const missing: string[] = [];

  if (!asString(payload.proxyWallet)) {
    missing.push("proxyWallet");
  }
  if (!asString(payload.asset)) {
    missing.push("asset");
  }
  if (side !== "BUY" && side !== "SELL") {
    missing.push("side");
  }
  if (!(typeof price === "number" || asString(price))) {
    missing.push("price");
  }
  if (!(typeof size === "number" || asString(size))) {
    missing.push("size");
  }

  return missing;
}

function applyDiagnostic(diagnostics: WatchDiagnostics, event: LeaderStreamDiagnosticEvent): void {
  if (event.type === "socket.opened") {
    diagnostics.socketOpenedAt = Date.now();
    diagnostics.lastIssue = "socket opened";
    return;
  }

  if (event.type === "websocket.subscription_sent") {
    diagnostics.subscriptionSentAt = Date.now();
    diagnostics.lastIssue = "subscribe frame sent";
    return;
  }

  if (event.type === "websocket.message_received") {
    diagnostics.rawMessageCount += 1;
    diagnostics.lastMessageAt = Date.now();
    return;
  }

  if (event.type === "websocket.message_parse_failed") {
    diagnostics.parseFailureCount += 1;
    diagnostics.lastIssue = `message parse failed: ${event.preview || "(empty)"}`;
    return;
  }

  if (event.type === "websocket.message_ignored") {
    diagnostics.ignoredMessageCount += 1;
    const descriptor =
      event.topic && event.messageType
        ? `${event.topic}/${event.messageType}`
        : event.topic
          ? event.topic
          : "unknown message";
    diagnostics.lastIssue = `ignored non-activity message: ${descriptor}`;
    return;
  }

  if (event.type === "leader_trade.invalid_payload") {
    diagnostics.activityTradeCount += 1;
    diagnostics.invalidPayloadCount += 1;
    diagnostics.lastIssue =
      event.keys.length > 0
        ? `activity/trades payload invalid: keys ${event.keys.join(", ")}`
        : "activity/trades payload invalid";
    return;
  }

  if (event.type === "leader_trade.wallet_mismatch") {
    diagnostics.activityTradeCount += 1;
    diagnostics.walletMismatchCount += 1;
    diagnostics.lastOtherWallet = event.proxyWallet;
    diagnostics.lastIssue = `wallet mismatch: ${compact(event.proxyWallet)}`;
    return;
  }

  diagnostics.activityTradeCount += 1;
  diagnostics.matchedTradeCount += 1;
  diagnostics.lastIssue = "leader wallet matched";
}

function diagnosticsSummary(
  connectionState: ConnectionState,
  diagnostics: WatchDiagnostics,
  renderedTradeCount: number
): string {
  if (connectionState === "connecting") {
    return "waiting for websocket open";
  }
  if (connectionState === "disconnected") {
    return diagnostics.lastIssue ?? "socket disconnected";
  }
  if (!diagnostics.subscriptionSentAt) {
    return "socket open; subscribe frame not confirmed sent";
  }
  if (diagnostics.rawMessageCount === 0) {
    return "subscription sent; no websocket messages seen yet";
  }
  if (diagnostics.activityTradeCount === 0) {
    return "messages arrived, but none were activity/trades";
  }
  if (diagnostics.matchedTradeCount === 0) {
    if (diagnostics.walletMismatchCount > 0) {
      return `activity/trades arrived, but leader wallet did not match (${compact(diagnostics.lastOtherWallet)})`;
    }
    return diagnostics.lastIssue ?? "activity/trades arrived, but none matched leader wallet";
  }
  if (renderedTradeCount === 0) {
    return diagnostics.lastIssue ?? "leader wallet matched, but payload normalization failed";
  }
  return "leader trades are being received";
}

function renderScreen(input: {
  leaderWallet: string;
  startedAt: Date;
  connectionState: ConnectionState;
  tradeCount: number;
  latestTrade: NormalizedLeaderTrade | null;
  diagnostics: WatchDiagnostics;
}): string {
  const divider = rule();
  const lines = [
    divider,
    "Leader WS Tape",
    divider,
    line("Status", statusLabel(input.connectionState)),
    line("Leader", input.leaderWallet),
    line("Started", formatTimestamp(input.startedAt.getTime())),
    line("Trades", `${input.tradeCount} rendered / ${input.diagnostics.matchedTradeCount} matched`),
    line("Scope", "public activity/trades stream"),
    line("Sub", input.diagnostics.subscriptionSentAt ? "subscribe frame sent" : "pending"),
    line("LastMsg", formatTimestampOrDash(input.diagnostics.lastMessageAt)),
    line("RawMsg", String(input.diagnostics.rawMessageCount)),
    line("TradeMsg", String(input.diagnostics.activityTradeCount)),
    line("Mismatch", String(input.diagnostics.walletMismatchCount)),
    line("Invalid", String(input.diagnostics.invalidPayloadCount)),
    line("Ignored", String(input.diagnostics.ignoredMessageCount)),
    line("ParseErr", String(input.diagnostics.parseFailureCount)),
    line("Other", compact(input.diagnostics.lastOtherWallet)),
    line("Diag", diagnosticsSummary(input.connectionState, input.diagnostics, input.tradeCount)),
    "",
  ];

  if (!input.latestTrade) {
    lines.push("Waiting for the next leader trade heard by websocket...");
    if (input.diagnostics.lastIssue) {
      lines.push(input.diagnostics.lastIssue);
    }
    return lines.join("\n");
  }

  const market = input.latestTrade.title ?? input.latestTrade.slug ?? input.latestTrade.assetId;
  lines.push("Latest Leader Activity");
  lines.push(divider);
  lines.push(line("Time", formatTimestamp(input.latestTrade.activityTimestamp)));
  lines.push(line("Side", input.latestTrade.side));
  lines.push(line("Price", input.latestTrade.price));
  lines.push(line("Size", input.latestTrade.size));
  lines.push(line("Outcome", input.latestTrade.outcome ?? "-"));
  lines.push(line("Market", market));
  lines.push(line("Event", input.latestTrade.eventSlug ?? "-"));
  lines.push(line("Asset", compact(input.latestTrade.assetId, 14, 10)));
  lines.push(line("Cond", compact(input.latestTrade.conditionId, 14, 10)));
  lines.push(line("Tx", compact(input.latestTrade.transactionHash, 14, 10)));
  lines.push(line("TradeId", compact(input.latestTrade.tradeId, 18, 12)));

  return lines.join("\n");
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage:",
      "  npm run watch:leader",
      "  npm run watch:leader -- 0xLEADER_PROXY_WALLET",
      "",
      "Reads LEADER_WALLET_ADDRESS from .env by default and prints the latest",
      "leader activity/trade seen on the public websocket.",
      "",
    ].join("\n")
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    printUsage();
    return;
  }

  const leaderWallet = getLeaderWallet(args, process.env);
  const startedAt = new Date();
  let latestTrade: NormalizedLeaderTrade | null = null;
  let tradeCount = 0;
  let connectionState: ConnectionState = "connecting";
  const diagnostics = createWatchDiagnostics();

  const render = (): void => {
    if (process.stdout.isTTY) {
      process.stdout.write("\x1B[2J\x1B[H");
    }

    process.stdout.write(
      `${renderScreen({
        leaderWallet,
        startedAt,
        connectionState,
        tradeCount,
        latestTrade,
        diagnostics,
      })}\n`
    );
  };

  const logger = createLogger({
    silent: true,
    onWrite(entry) {
      if (entry.event === "websocket.connected") {
        connectionState = "connected";
        render();
        return;
      }

      if (entry.event === "websocket.disconnected") {
        connectionState = "disconnected";
        render();
      }
    },
  });

  const stream = startLeaderStream({
    leaderWallet,
    logger,
    onDiagnostic(event) {
      applyDiagnostic(diagnostics, event);
      render();
    },
    onTrade(payload) {
      const trade = normalizeLeaderTradePayload(payload, "websocket");
      if (!trade) {
        diagnostics.invalidPayloadCount += 1;
        diagnostics.lastIssue = `matched wallet but payload missing fields: ${missingRequiredTradeFields(payload).join(", ") || "unknown"}`;
        render();
        return;
      }

      latestTrade = trade;
      tradeCount += 1;
      render();
    },
  });

  const shutdown = (): void => {
    stream.close();
    process.stdout.write("\nStopped leader websocket watcher.\n");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  render();
}

void main().catch((error) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exit(1);
});
