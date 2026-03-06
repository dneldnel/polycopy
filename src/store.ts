import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  FollowerFillRecord,
  FollowerOrderRecord,
  FollowerOrderStatus,
  LeaderTradeRecord,
  NormalizedLeaderTrade,
  RuntimeEventRecord,
  TradeSide,
} from "./types";

interface LeaderTradeRow {
  id: number;
  leader_wallet: string;
  trade_id: string;
  transaction_hash: string | null;
  activity_timestamp: number;
  received_at: string;
  asset_id: string;
  condition_id: string | null;
  side: TradeSide;
  price: string;
  size: string;
  slug: string | null;
  event_slug: string | null;
  outcome: string | null;
  title: string | null;
  end_date: string | null;
  raw_payload_json: string;
  source: string;
  created_at: string;
}

interface FollowerOrderRow {
  id: number;
  leader_trade_id: number;
  follower_wallet: string;
  clob_order_id: string | null;
  condition_id: string | null;
  asset_id: string;
  side: TradeSide;
  limit_price: string;
  requested_size: string;
  original_size: string | null;
  matched_size: string | null;
  status: FollowerOrderStatus;
  status_reason: string | null;
  associate_trade_ids_json: string;
  submitted_at: string;
  last_status_at: string;
  created_at: string;
  updated_at: string;
}

interface FollowerFillRow {
  id: number;
  follower_order_id: number;
  clob_trade_id: string;
  market: string | null;
  asset_id: string | null;
  side: TradeSide;
  price: string;
  size: string;
  status: string | null;
  match_time: string | null;
  last_update: string | null;
  outcome: string | null;
  transaction_hash: string | null;
  trader_side: "TAKER" | "MAKER" | null;
  raw_json: string;
  created_at: string;
}

interface RuntimeEventRow {
  id: number;
  level: "info" | "warn" | "error";
  event_type: string;
  payload_json: string;
  created_at: string;
}

export interface ObserveLeaderTradeResult {
  isNew: boolean;
  record: LeaderTradeRecord;
}

export interface FollowerOrderInsert {
  leaderTradeId: number;
  followerWallet: string;
  clobOrderId: string | null;
  conditionId?: string | null;
  assetId: string;
  side: TradeSide;
  limitPrice: string;
  requestedSize: string;
  originalSize?: string | null;
  matchedSize?: string | null;
  status: FollowerOrderStatus;
  statusReason?: string | null;
  associateTradeIds?: string[];
  submittedAt?: string;
}

export interface FollowerOrderPatch {
  conditionId?: string | null;
  status?: FollowerOrderStatus;
  statusReason?: string | null;
  originalSize?: string | null;
  matchedSize?: string | null;
  associateTradeIds?: string[];
  lastStatusAt?: string;
}

export interface FollowerFillInsert {
  followerOrderId: number;
  clobTradeId: string;
  market: string | null;
  assetId: string | null;
  side: TradeSide;
  price: string;
  size: string;
  status: string | null;
  matchTime: string | null;
  lastUpdate: string | null;
  outcome: string | null;
  transactionHash: string | null;
  traderSide: "TAKER" | "MAKER" | null;
  rawJson: string;
}

const TERMINAL_ORDER_STATUSES = new Set<FollowerOrderStatus>([
  "simulated",
  "submission_failed",
  "filled",
  "cancelled",
  "rejected",
]);

export function isTerminalOrderStatus(status: FollowerOrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.has(status);
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(sqlitePath: string) {
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    this.db = new DatabaseSync(sqlitePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.applySchema();
  }

  private applySchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS leader_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        leader_wallet TEXT NOT NULL,
        trade_id TEXT NOT NULL UNIQUE,
        transaction_hash TEXT,
        activity_timestamp INTEGER NOT NULL,
        received_at TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        condition_id TEXT,
        side TEXT NOT NULL,
        price TEXT NOT NULL,
        size TEXT NOT NULL,
        slug TEXT,
        event_slug TEXT,
        outcome TEXT,
        title TEXT,
        end_date TEXT,
        raw_payload_json TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS follower_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        leader_trade_id INTEGER NOT NULL,
        follower_wallet TEXT NOT NULL,
        clob_order_id TEXT UNIQUE,
        condition_id TEXT,
        asset_id TEXT NOT NULL,
        side TEXT NOT NULL,
        limit_price TEXT NOT NULL,
        requested_size TEXT NOT NULL,
        original_size TEXT,
        matched_size TEXT,
        status TEXT NOT NULL,
        status_reason TEXT,
        associate_trade_ids_json TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        last_status_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (leader_trade_id, follower_wallet),
        FOREIGN KEY (leader_trade_id) REFERENCES leader_trades(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS follower_fills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        follower_order_id INTEGER NOT NULL,
        clob_trade_id TEXT NOT NULL,
        market TEXT,
        asset_id TEXT,
        side TEXT NOT NULL,
        price TEXT NOT NULL,
        size TEXT NOT NULL,
        status TEXT,
        match_time TEXT,
        last_update TEXT,
        outcome TEXT,
        transaction_hash TEXT,
        trader_side TEXT,
        raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (follower_order_id, clob_trade_id),
        FOREIGN KEY (follower_order_id) REFERENCES follower_orders(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS runtime_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

    `);

    this.ensureColumn("follower_orders", "condition_id", "TEXT");
    this.ensureFollowerFillsCompositeKey();

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_leader_trades_activity_timestamp
        ON leader_trades(activity_timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_follower_orders_status
        ON follower_orders(status, last_status_at DESC);
      CREATE INDEX IF NOT EXISTS idx_follower_orders_condition_id
        ON follower_orders(condition_id, status, last_status_at DESC);
      CREATE INDEX IF NOT EXISTS idx_follower_fills_order_id
        ON follower_fills(follower_order_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runtime_events_created_at
        ON runtime_events(created_at DESC);
    `);
  }

  private ensureColumn(tableName: string, columnName: string, columnTypeSql: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === columnName)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnTypeSql}`);
  }

  private ensureFollowerFillsCompositeKey(): void {
    const schema = this.db.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'follower_fills'
    `).get() as { sql: string } | undefined;

    if (!schema?.sql || !schema.sql.includes("clob_trade_id TEXT NOT NULL UNIQUE")) {
      return;
    }

    this.db.exec(`
      BEGIN;
      CREATE TABLE follower_fills_next (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        follower_order_id INTEGER NOT NULL,
        clob_trade_id TEXT NOT NULL,
        market TEXT,
        asset_id TEXT,
        side TEXT NOT NULL,
        price TEXT NOT NULL,
        size TEXT NOT NULL,
        status TEXT,
        match_time TEXT,
        last_update TEXT,
        outcome TEXT,
        transaction_hash TEXT,
        trader_side TEXT,
        raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (follower_order_id, clob_trade_id),
        FOREIGN KEY (follower_order_id) REFERENCES follower_orders(id) ON DELETE CASCADE
      );
      INSERT OR IGNORE INTO follower_fills_next (
        id,
        follower_order_id,
        clob_trade_id,
        market,
        asset_id,
        side,
        price,
        size,
        status,
        match_time,
        last_update,
        outcome,
        transaction_hash,
        trader_side,
        raw_json,
        created_at
      )
      SELECT
        id,
        follower_order_id,
        clob_trade_id,
        market,
        asset_id,
        side,
        price,
        size,
        status,
        match_time,
        last_update,
        outcome,
        transaction_hash,
        trader_side,
        raw_json,
        created_at
      FROM follower_fills;
      DROP TABLE follower_fills;
      ALTER TABLE follower_fills_next RENAME TO follower_fills;
      COMMIT;
    `);
  }

  observeLeaderTrade(trade: NormalizedLeaderTrade): ObserveLeaderTradeResult {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO leader_trades (
        leader_wallet,
        trade_id,
        transaction_hash,
        activity_timestamp,
        received_at,
        asset_id,
        condition_id,
        side,
        price,
        size,
        slug,
        event_slug,
        outcome,
        title,
        end_date,
        raw_payload_json,
        source,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trade.leaderWallet,
      trade.tradeId,
      trade.transactionHash,
      trade.activityTimestamp,
      trade.receivedAt,
      trade.assetId,
      trade.conditionId,
      trade.side,
      trade.price,
      trade.size,
      trade.slug,
      trade.eventSlug,
      trade.outcome,
      trade.title,
      trade.endDate,
      JSON.stringify(trade.rawPayload),
      trade.source,
      new Date().toISOString()
    );

    const row = this.db.prepare(`
      SELECT *
      FROM leader_trades
      WHERE trade_id = ?
    `).get(trade.tradeId) as LeaderTradeRow | undefined;
    if (!row) {
      throw new Error(`Failed to load leader trade ${trade.tradeId}`);
    }

    return {
      isNew: result.changes > 0,
      record: this.mapLeaderTradeRow(row),
    };
  }

  insertFollowerOrder(input: FollowerOrderInsert): FollowerOrderRecord {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO follower_orders (
        leader_trade_id,
        follower_wallet,
        clob_order_id,
        condition_id,
        asset_id,
        side,
        limit_price,
        requested_size,
        original_size,
        matched_size,
        status,
        status_reason,
        associate_trade_ids_json,
        submitted_at,
        last_status_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.leaderTradeId,
      input.followerWallet,
      input.clobOrderId,
      input.conditionId ?? null,
      input.assetId,
      input.side,
      input.limitPrice,
      input.requestedSize,
      input.originalSize ?? null,
      input.matchedSize ?? null,
      input.status,
      input.statusReason ?? null,
      JSON.stringify(input.associateTradeIds ?? []),
      input.submittedAt ?? now,
      input.submittedAt ?? now,
      now,
      now
    );

    const row = this.db.prepare(`
      SELECT *
      FROM follower_orders
      WHERE leader_trade_id = ? AND follower_wallet = ?
    `).get(input.leaderTradeId, input.followerWallet) as FollowerOrderRow | undefined;
    if (!row) {
      throw new Error(`Failed to load follower order for leader_trade_id=${input.leaderTradeId}`);
    }
    return this.mapFollowerOrderRow(row);
  }

  updateFollowerOrder(id: number, patch: FollowerOrderPatch): FollowerOrderRecord | null {
    const existing = this.db.prepare(`
      SELECT *
      FROM follower_orders
      WHERE id = ?
    `).get(id) as FollowerOrderRow | undefined;
    if (!existing) {
      return null;
    }

    const nextAssociateTradeIds =
      patch.associateTradeIds != null ? JSON.stringify(patch.associateTradeIds) : existing.associate_trade_ids_json;
    const nextStatusAt = patch.lastStatusAt ?? new Date().toISOString();

    this.db.prepare(`
      UPDATE follower_orders
      SET
        condition_id = ?,
        original_size = ?,
        matched_size = ?,
        status = ?,
        status_reason = ?,
        associate_trade_ids_json = ?,
        last_status_at = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      patch.conditionId ?? existing.condition_id,
      patch.originalSize ?? existing.original_size,
      patch.matchedSize ?? existing.matched_size,
      patch.status ?? existing.status,
      patch.statusReason ?? existing.status_reason,
      nextAssociateTradeIds,
      nextStatusAt,
      new Date().toISOString(),
      id
    );

    const updated = this.db.prepare(`
      SELECT *
      FROM follower_orders
      WHERE id = ?
    `).get(id) as FollowerOrderRow | undefined;
    return updated ? this.mapFollowerOrderRow(updated) : null;
  }

  listTrackableOrders(limit = 50): FollowerOrderRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM follower_orders
      WHERE clob_order_id IS NOT NULL
        AND status NOT IN ('simulated', 'submission_failed', 'filled', 'cancelled', 'rejected')
      ORDER BY last_status_at ASC
      LIMIT ?
    `).all(limit) as unknown as FollowerOrderRow[];
    return rows.map((row) => this.mapFollowerOrderRow(row));
  }

  listUserTrackedMarkets(limit = 256): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT condition_id
      FROM follower_orders
      WHERE condition_id IS NOT NULL
        AND status NOT IN ('simulated', 'submission_failed', 'cancelled', 'rejected')
      ORDER BY condition_id ASC
      LIMIT ?
    `).all(limit) as unknown as Array<{ condition_id: string | null }>;
    return rows
      .map((row) => row.condition_id)
      .filter((value): value is string => typeof value === "string" && value.trim() !== "");
  }

  getFollowerOrderByClobOrderId(clobOrderId: string): FollowerOrderRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM follower_orders
      WHERE clob_order_id = ?
    `).get(clobOrderId) as FollowerOrderRow | undefined;
    return row ? this.mapFollowerOrderRow(row) : null;
  }

  insertFollowerFill(input: FollowerFillInsert): boolean {
    return this.upsertFollowerFill(input);
  }

  upsertFollowerFill(input: FollowerFillInsert): boolean {
    const existing = this.db.prepare(`
      SELECT id
      FROM follower_fills
      WHERE follower_order_id = ? AND clob_trade_id = ?
    `).get(input.followerOrderId, input.clobTradeId) as { id: number } | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE follower_fills
        SET
          market = ?,
          asset_id = ?,
          side = ?,
          price = ?,
          size = ?,
          status = ?,
          match_time = ?,
          last_update = ?,
          outcome = ?,
          transaction_hash = ?,
          trader_side = ?,
          raw_json = ?
        WHERE id = ?
      `).run(
        input.market,
        input.assetId,
        input.side,
        input.price,
        input.size,
        input.status,
        input.matchTime,
        input.lastUpdate,
        input.outcome,
        input.transactionHash,
        input.traderSide,
        input.rawJson,
        existing.id
      );
      return false;
    }

    const result = this.db.prepare(`
      INSERT INTO follower_fills (
        follower_order_id,
        clob_trade_id,
        market,
        asset_id,
        side,
        price,
        size,
        status,
        match_time,
        last_update,
        outcome,
        transaction_hash,
        trader_side,
        raw_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.followerOrderId,
      input.clobTradeId,
      input.market,
      input.assetId,
      input.side,
      input.price,
      input.size,
      input.status,
      input.matchTime,
      input.lastUpdate,
      input.outcome,
      input.transactionHash,
      input.traderSide,
      input.rawJson,
      new Date().toISOString()
    );

    return result.changes > 0;
  }

  insertRuntimeEvent(
    level: "info" | "warn" | "error",
    eventType: string,
    payload: Record<string, unknown> = {}
  ): RuntimeEventRecord {
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO runtime_events (
        level,
        event_type,
        payload_json,
        created_at
      ) VALUES (?, ?, ?, ?)
    `).run(level, eventType, JSON.stringify(payload), createdAt);

    const row = this.db.prepare(`
      SELECT *
      FROM runtime_events
      ORDER BY id DESC
      LIMIT 1
    `).get() as RuntimeEventRow | undefined;
    if (!row) {
      throw new Error(`Failed to load runtime event ${eventType}`);
    }
    return this.mapRuntimeEventRow(row);
  }

  getFollowerOrderByLeaderTradeId(leaderTradeId: number, followerWallet: string): FollowerOrderRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM follower_orders
      WHERE leader_trade_id = ? AND follower_wallet = ?
    `).get(leaderTradeId, followerWallet) as FollowerOrderRow | undefined;
    return row ? this.mapFollowerOrderRow(row) : null;
  }

  countLeaderTrades(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM leader_trades`).get() as { count: number };
    return row.count;
  }

  countFollowerOrders(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM follower_orders`).get() as { count: number };
    return row.count;
  }

  countFollowerFills(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM follower_fills`).get() as { count: number };
    return row.count;
  }

  countRuntimeEvents(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM runtime_events`).get() as { count: number };
    return row.count;
  }

  sumFollowerFillSize(followerOrderId: number): number {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(CAST(size AS REAL)), 0) AS total
      FROM follower_fills
      WHERE follower_order_id = ?
    `).get(followerOrderId) as { total: number };
    return Number(row.total ?? 0);
  }

  close(): void {
    this.db.close();
  }

  private mapLeaderTradeRow(row: LeaderTradeRow): LeaderTradeRecord {
    return {
      id: row.id,
      leaderWallet: row.leader_wallet,
      tradeId: row.trade_id,
      transactionHash: row.transaction_hash,
      activityTimestamp: row.activity_timestamp,
      receivedAt: row.received_at,
      assetId: row.asset_id,
      conditionId: row.condition_id,
      side: row.side,
      price: row.price,
      size: row.size,
      slug: row.slug,
      eventSlug: row.event_slug,
      outcome: row.outcome,
      title: row.title,
      endDate: row.end_date,
      rawPayload: JSON.parse(row.raw_payload_json) as NormalizedLeaderTrade["rawPayload"],
      source: row.source,
      createdAt: row.created_at,
    };
  }

  private mapFollowerOrderRow(row: FollowerOrderRow): FollowerOrderRecord {
    return {
      id: row.id,
      leaderTradeId: row.leader_trade_id,
      followerWallet: row.follower_wallet,
      clobOrderId: row.clob_order_id,
      conditionId: row.condition_id,
      assetId: row.asset_id,
      side: row.side,
      limitPrice: row.limit_price,
      requestedSize: row.requested_size,
      originalSize: row.original_size,
      matchedSize: row.matched_size,
      status: row.status,
      statusReason: row.status_reason,
      associateTradeIds: JSON.parse(row.associate_trade_ids_json) as string[],
      submittedAt: row.submitted_at,
      lastStatusAt: row.last_status_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapFollowerFillRow(row: FollowerFillRow): FollowerFillRecord {
    return {
      id: row.id,
      followerOrderId: row.follower_order_id,
      clobTradeId: row.clob_trade_id,
      market: row.market,
      assetId: row.asset_id,
      side: row.side,
      price: row.price,
      size: row.size,
      status: row.status,
      matchTime: row.match_time,
      lastUpdate: row.last_update,
      outcome: row.outcome,
      transactionHash: row.transaction_hash,
      traderSide: row.trader_side,
      rawJson: row.raw_json,
      createdAt: row.created_at,
    };
  }

  private mapRuntimeEventRow(row: RuntimeEventRow): RuntimeEventRecord {
    return {
      id: row.id,
      level: row.level,
      eventType: row.event_type,
      payloadJson: row.payload_json,
      createdAt: row.created_at,
    };
  }
}
