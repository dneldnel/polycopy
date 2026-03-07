import "dotenv/config";
import { startLeaderStream } from "./leaderStream";
import { createLogger, errorMessage } from "./logger";
import { normalizeLeaderTradePayload } from "./normalize";
import type { NormalizedLeaderTrade } from "./types";

type ConnectionState = "connecting" | "connected" | "disconnected";

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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

function statusLabel(state: ConnectionState): string {
  if (state === "connected") {
    return "connected";
  }
  if (state === "disconnected") {
    return "disconnected (auto-retrying)";
  }
  return "connecting";
}

function line(label: string, value: string): string {
  return `${label.padEnd(10, " ")} ${value}`;
}

function rule(): string {
  const width = process.stdout.columns ?? 80;
  return "=".repeat(Math.max(48, Math.min(width, 88)));
}

function renderScreen(input: {
  leaderWallet: string;
  startedAt: Date;
  connectionState: ConnectionState;
  tradeCount: number;
  latestTrade: NormalizedLeaderTrade | null;
}): string {
  const divider = rule();
  const lines = [
    divider,
    "Leader WS Tape",
    divider,
    line("Status", statusLabel(input.connectionState)),
    line("Leader", input.leaderWallet),
    line("Started", formatTimestamp(input.startedAt.getTime())),
    line("Trades", String(input.tradeCount)),
    line("Scope", "public activity/trades stream"),
    "",
  ];

  if (!input.latestTrade) {
    lines.push("Waiting for the next leader trade heard by websocket...");
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
    onTrade(payload) {
      const trade = normalizeLeaderTradePayload(payload, "websocket");
      if (!trade) {
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
