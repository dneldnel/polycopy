import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveSqlitePath } from "./config";
import { summarizeEventFields } from "./eventSummary";
import { errorMessage } from "./logger";

interface RuntimeEventRow {
  id: number;
  level: "info" | "warn" | "error";
  event_type: string;
  payload_json: string;
  created_at: string;
}

interface CliOptions {
  dbPath: string;
  follow: boolean;
  help: boolean;
  limit: number;
}

interface DatabaseLike {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
}

const DEFAULT_LIMIT = 50;
const FOLLOW_POLL_MS = 2000;

function truncate(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }
  if (width <= 3) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 3)}...`;
}

function formatTimestamp(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function parsePayload(payloadJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { payloadJson };
  }
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage:",
      "  npm run events",
      "  npm run events -- --limit 20",
      "  npm run events -- --follow",
      "  npm run events -- --db ./data/polycopy-v2.sqlite",
      "",
      "Formats rows from the runtime_events table.",
      "",
    ].join("\n")
  );
}

function parseCliArgs(argv: string[]): CliOptions {
  let limit = DEFAULT_LIMIT;
  let follow = false;
  let dbPath = resolveSqlitePath(process.cwd());
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }

    if (arg === "-f" || arg === "--follow") {
      follow = true;
      continue;
    }

    if (arg === "-n" || arg === "--limit") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing value for --limit");
      }
      limit = Number(next);
      index += 1;
      continue;
    }

    if (arg === "--db") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing value for --db");
      }
      dbPath = path.resolve(process.cwd(), next);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Invalid --limit value: ${String(limit)}`);
  }

  return {
    dbPath,
    follow,
    help,
    limit,
  };
}

function hasRuntimeEventsTable(db: DatabaseLike): boolean {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'runtime_events'
    LIMIT 1
  `).get() as { name: string } | undefined;
  return Boolean(row);
}

function listLatestRuntimeEvents(db: DatabaseLike, limit: number): RuntimeEventRow[] {
  return db.prepare(`
    SELECT id, level, event_type, payload_json, created_at
    FROM runtime_events
    ORDER BY id DESC
    LIMIT ?
  `).all(limit) as RuntimeEventRow[];
}

function listRuntimeEventsAfterId(db: DatabaseLike, afterId: number): RuntimeEventRow[] {
  return db.prepare(`
    SELECT id, level, event_type, payload_json, created_at
    FROM runtime_events
    WHERE id > ?
    ORDER BY id ASC
  `).all(afterId) as RuntimeEventRow[];
}

function formatRuntimeEvent(row: RuntimeEventRow): string {
  const payload = parsePayload(row.payload_json);
  const summary = summarizeEventFields(row.event_type, payload);
  const width = Math.max(80, process.stdout.columns ?? 140);
  return [
    `[${formatTimestamp(row.created_at)}] ${row.level.toUpperCase().padEnd(5, " ")} ${row.event_type}`,
    `  ${truncate(summary, Math.max(1, width - 2))}`,
  ].join("\n");
}

function printRuntimeEvents(rows: RuntimeEventRow[]): void {
  if (rows.length === 0) {
    process.stdout.write("No runtime events found.\n");
    return;
  }

  for (const row of rows) {
    process.stdout.write(`${formatRuntimeEvent(row)}\n\n`);
  }
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  if (!fs.existsSync(options.dbPath)) {
    throw new Error(`Database not found: ${options.dbPath}`);
  }

  const sqlite = await import("node:sqlite");
  const db = new sqlite.DatabaseSync(options.dbPath) as DatabaseLike;
  db.exec("PRAGMA busy_timeout = 5000;");

  if (!hasRuntimeEventsTable(db)) {
    db.close();
    throw new Error(`runtime_events table not found: ${options.dbPath}`);
  }

  const initialRows = listLatestRuntimeEvents(db, options.limit).reverse();
  printRuntimeEvents(initialRows);

  if (!options.follow) {
    db.close();
    return;
  }

  let lastSeenId = initialRows.at(-1)?.id ?? 0;
  process.stdout.write(`Watching runtime_events in ${options.dbPath}. Polling every ${FOLLOW_POLL_MS / 1000}s. Press Ctrl+C to stop.\n`);

  const timer = setInterval(() => {
    const rows = listRuntimeEventsAfterId(db, lastSeenId);
    if (rows.length === 0) {
      return;
    }

    printRuntimeEvents(rows);
    lastSeenId = rows.at(-1)?.id ?? lastSeenId;
  }, FOLLOW_POLL_MS);

  const shutdown = (): void => {
    clearInterval(timer);
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>(() => {});
}

void main().catch((error) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exit(1);
});
