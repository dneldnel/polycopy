import * as readline from "node:readline";
import type { LogEntry } from "./logger";
import { Store } from "./store";
import type { AppConfig } from "./types";

type ConnectionState = "connected" | "disconnected" | "unknown" | "n/a";

interface CreateRuntimeTuiOptions {
  config: AppConfig;
  store: Store;
  onQuit?: () => void;
}

const MAX_RECENT_EVENTS = 8;
const MAX_RECENT_TRADES = 5;
const MAX_RECENT_ORDERS = 6;
const MAX_RECENT_FILLS = 5;

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (value.length <= width) {
    return value;
  }
  if (width <= 3) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 3)}...`;
}

function formatTime(iso: string): string {
  return iso.slice(11, 19);
}

function formatUptime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600)
    .toString()
    .padStart(2, "0");
  const minutes = Math.floor((totalSeconds % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

export function compactAddress(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 3) {
    return value;
  }
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function compactId(value: string, head = 8, tail = 6): string {
  if (value.length <= head + tail + 3) {
    return value;
  }
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function summarizePairs(fields: Record<string, unknown>, keys: string[]): string {
  const parts = keys
    .map((key) => {
      const value = fields[key];
      if (value == null) {
        return null;
      }
      if (typeof value === "number" || typeof value === "boolean") {
        return `${key}=${String(value)}`;
      }
      const text = asString(value);
      return text ? `${key}=${text}` : null;
    })
    .filter((value): value is string => value != null);
  return parts.join(" ");
}

export function summarizeEventFields(event: string, fields: Record<string, unknown>): string {
  const assetId = asString(fields.assetId) ?? asString(fields.market) ?? "unknown-asset";
  const title = asString(fields.title);
  const outcome = asString(fields.outcome);
  const marketLabel = oneLine([title, outcome].filter(Boolean).join(" / ")) || assetId;
  const side = asString(fields.side) ?? "?";
  const size = asString(fields.size) ?? asString(fields.matchedSize) ?? "?";
  const price = asString(fields.price) ?? "?";
  const reason = asString(fields.reason) ?? asString(fields.statusReason);
  const status = asString(fields.status);

  switch (event) {
    case "app.started":
      return summarizePairs(fields, ["leaderWallet", "followerWallet", "simulationMode", "sqlitePath"]);
    case "app.stopping":
      return summarizePairs(fields, ["signal", "leaderTrades", "followerOrders", "followerFills", "runtimeEvents"]);
    case "websocket.connected":
      return "leader websocket connected";
    case "websocket.disconnected":
      return "leader websocket disconnected";
    case "user_websocket.connected":
      return "user websocket connected";
    case "user_websocket.disconnected":
      return "user websocket disconnected";
    case "leader_trade.observed":
      return `${side} ${marketLabel} size ${size} @ ${price}`;
    case "leader_trade.duplicate_ignored":
      return summarizePairs(fields, ["tradeId"]);
    case "leader_trade.invalid_payload":
      return "invalid leader trade payload";
    case "follower_order.submitted":
      return `${side} ${assetId} size ${size} @ ${price} order ${compactId(
        asString(fields.clobOrderId) ?? "unknown"
      )}${status ? ` ${status}` : ""}`;
    case "follower_order.submission_failed":
      return `${side} ${assetId} size ${size} @ ${price}${reason ? ` failed ${reason}` : " failed"}`;
    case "follower_order.invalid_size":
      return summarizePairs(fields, ["tradeId", "size", "leaderSize", "orderSizeMode", "fixedOrderSize", "sizeMultiplier"]);
    case "follower_order.simulated":
      return `${side} ${assetId} size ${size} @ ${price} simulated`;
    case "follower_order.skipped_user_ws_disconnected":
      return `${side} ${assetId} size ${size} @ ${price} skipped user websocket disconnected`;
    case "follower_order.updated":
      return `order ${compactId(asString(fields.clobOrderId) ?? "unknown")} status=${
        status ?? "unknown"
      } matched=${asString(fields.matchedSize) ?? "?"}/${asString(fields.originalSize) ?? "?"}`;
    case "follower_fill.recorded":
      return `${side} ${assetId} size ${size} @ ${price} trade ${compactId(
        asString(fields.clobTradeId) ?? "unknown"
      )}`;
    case "user_websocket.invalid_order_payload":
      return "invalid user order payload";
    case "user_websocket.invalid_trade_payload":
      return "invalid user trade payload";
    case "user_websocket.process_failed":
    case "leader_trade.process_failed":
    case "app.crashed":
      return reason ?? summarizePairs(fields, ["messageType"]);
    case "tui.disabled_non_tty":
      return "stdout is not a TTY; falling back to JSON logs";
    default: {
      const compact = summarizePairs(fields, Object.keys(fields).slice(0, 4));
      return compact || "no details";
    }
  }
}

function pushRecent(target: string[], value: string, maxSize: number): void {
  target.unshift(oneLine(value));
  if (target.length > maxSize) {
    target.length = maxSize;
  }
}

function sectionLines(title: string, rows: string[], width: number): string[] {
  const separator = "-".repeat(Math.max(12, width));
  const lines = [separator, title];
  if (rows.length === 0) {
    lines.push("  (none yet)");
    return lines;
  }
  for (const row of rows) {
    lines.push(`  ${truncate(row, Math.max(1, width - 2))}`);
  }
  return lines;
}

function connectionBadge(state: ConnectionState): string {
  switch (state) {
    case "connected":
      return "UP";
    case "disconnected":
      return "DOWN";
    case "n/a":
      return "N/A";
    default:
      return "INIT";
  }
}

export class RuntimeTui {
  private readonly config: AppConfig;
  private readonly store: Store;
  private readonly onQuit?: () => void;
  private readonly recentEvents: string[] = [];
  private readonly recentTrades: string[] = [];
  private readonly recentOrders: string[] = [];
  private readonly recentFills: string[] = [];
  private readonly startedAt = Date.now();
  private readonly keypressHandler = (_chars: string, key: readline.Key): void => {
    if (key.ctrl && key.name === "c") {
      this.onQuit?.();
      return;
    }
    if (key.name === "q") {
      this.onQuit?.();
    }
  };

  private timer: NodeJS.Timeout | null = null;
  private active = false;
  private rawModeEnabled = false;
  private leaderConnection: ConnectionState = "unknown";
  private userConnection: ConnectionState;

  constructor(options: CreateRuntimeTuiOptions) {
    this.config = options.config;
    this.store = options.store;
    this.onQuit = options.onQuit;
    this.userConnection = options.config.simulationMode ? "n/a" : "unknown";
  }

  start(): boolean {
    if (!process.stdout.isTTY) {
      return false;
    }

    this.active = true;
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    if (process.stdin.isTTY) {
      readline.emitKeypressEvents(process.stdin);
      process.stdin.on("keypress", this.keypressHandler);
      if (typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(true);
        this.rawModeEnabled = true;
      }
      process.stdin.resume();
    }

    this.render();
    this.timer = setInterval(() => {
      this.render();
    }, 1000);
    return true;
  }

  stop(): void {
    if (!this.active) {
      return;
    }

    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (process.stdin.isTTY) {
      process.stdin.removeListener("keypress", this.keypressHandler);
      if (this.rawModeEnabled && typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(false);
      }
      this.rawModeEnabled = false;
      process.stdin.pause();
    }

    process.stdout.write("\x1b[?25h\x1b[?1049l");
  }

  record(entry: LogEntry): void {
    if (!this.active) {
      return;
    }

    this.applyConnectionState(entry.event);

    const summary = summarizeEventFields(entry.event, entry.fields);
    pushRecent(
      this.recentEvents,
      `${formatTime(entry.ts)} ${entry.level.toUpperCase()} ${entry.event} ${summary}`,
      MAX_RECENT_EVENTS
    );

    if (entry.event === "leader_trade.observed") {
      pushRecent(this.recentTrades, `${formatTime(entry.ts)} ${summary}`, MAX_RECENT_TRADES);
    }

    if (
      entry.event === "follower_order.submitted" ||
      entry.event === "follower_order.submission_failed" ||
      entry.event === "follower_order.updated" ||
      entry.event === "follower_order.simulated" ||
      entry.event === "follower_order.skipped_user_ws_disconnected"
    ) {
      pushRecent(this.recentOrders, `${formatTime(entry.ts)} ${summary}`, MAX_RECENT_ORDERS);
    }

    if (entry.event === "follower_fill.recorded") {
      pushRecent(this.recentFills, `${formatTime(entry.ts)} ${summary}`, MAX_RECENT_FILLS);
    }

    this.render();
  }

  private applyConnectionState(event: string): void {
    if (event === "websocket.connected") {
      this.leaderConnection = "connected";
      return;
    }
    if (event === "websocket.disconnected") {
      this.leaderConnection = "disconnected";
      return;
    }
    if (event === "user_websocket.connected") {
      this.userConnection = "connected";
      return;
    }
    if (event === "user_websocket.disconnected") {
      this.userConnection = "disconnected";
    }
  }

  private render(): void {
    if (!this.active) {
      return;
    }

    const width = Math.max(80, process.stdout.columns ?? 120);
    const uptime = formatUptime(Date.now() - this.startedAt);
    const activeOrders = this.store.listTrackableOrders(500).length;
    const lines = [
      truncate(
        `Polycopy V2 TUI | ${this.config.simulationMode ? "SIM" : "LIVE"} | leader ws ${connectionBadge(
          this.leaderConnection
        )} | user ws ${connectionBadge(this.userConnection)} | uptime ${uptime}`,
        width
      ),
      truncate(
        `Leader ${compactAddress(this.config.leaderWallet)} -> Follower ${compactAddress(
          this.config.followerWallet
        )} | DB ${this.config.sqlitePath}`,
        width
      ),
      truncate(
        `Counts: leader trades ${this.store.countLeaderTrades()} | follower orders ${this.store.countFollowerOrders()} | active orders ${activeOrders} | fills ${this.store.countFollowerFills()} | events ${this.store.countRuntimeEvents()}`,
        width
      ),
      ...sectionLines("Recent Leader Trades", this.recentTrades, width),
      ...sectionLines("Recent Order Activity", this.recentOrders, width),
      ...sectionLines("Recent Fills", this.recentFills, width),
      ...sectionLines("Recent Events", this.recentEvents, width),
      "-".repeat(Math.max(12, width)),
      truncate("Press q to stop the bot, or Ctrl+C to exit.", width),
    ];

    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
    process.stdout.write(lines.join("\n"));
  }
}

export function createRuntimeTui(options: CreateRuntimeTuiOptions): RuntimeTui {
  return new RuntimeTui(options);
}
