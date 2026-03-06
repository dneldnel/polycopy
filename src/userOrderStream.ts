import {
  ConnectionStatus,
  RealTimeDataClient,
  type ClobApiKeyCreds,
  type Message,
  type SubscriptionMessage,
} from "@polymarket/real-time-data-client";
import { extractFollowerFillFromTrade, normalizeFollowerOrderStatus } from "./followerLifecycle";
import { errorMessage } from "./logger";
import { Store } from "./store";
import type { FollowerOrderRecord, UserOrderStreamPayload, UserTradeStreamPayload } from "./types";

type RecordEvent = (
  level: "info" | "warn" | "error",
  eventType: string,
  payload?: Record<string, unknown>
) => void;

export interface StartUserOrderStreamOptions {
  store: Store;
  auth: ClobApiKeyCreds;
  recordEvent: RecordEvent;
}

export interface UserOrderStreamController {
  close(): void;
  isConnected(): boolean;
  waitUntilConnected(timeoutMs?: number): Promise<void>;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asUserOrderPayload(value: unknown): UserOrderStreamPayload | null {
  const payload = asObject(value);
  if (!payload || typeof payload.id !== "string") {
    return null;
  }
  return payload as unknown as UserOrderStreamPayload;
}

function asUserTradePayload(value: unknown): UserTradeStreamPayload | null {
  const payload = asObject(value);
  if (!payload || typeof payload.id !== "string" || typeof payload.taker_order_id !== "string") {
    return null;
  }
  if (!Array.isArray(payload.maker_orders)) {
    return null;
  }
  return payload as unknown as UserTradeStreamPayload;
}

function normalizeStatusReason(parts: Array<string | null | undefined>): string | null {
  const filtered = parts
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .map((value) => value.trim());
  return filtered.length > 0 ? filtered.join(":") : null;
}

function toIsoTimestamp(value: string | number | null | undefined): string | null {
  if (value == null) {
    return null;
  }

  if (typeof value === "string" && value.trim() === "") {
    return null;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const milliseconds = numeric >= 1_000_000_000_000 ? numeric : numeric * 1000;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function didOrderSnapshotChange(previous: FollowerOrderRecord, next: FollowerOrderRecord): boolean {
  return (
    previous.conditionId !== next.conditionId ||
    previous.originalSize !== next.originalSize ||
    previous.matchedSize !== next.matchedSize ||
    previous.status !== next.status ||
    previous.statusReason !== next.statusReason ||
    JSON.stringify(previous.associateTradeIds) !== JSON.stringify(next.associateTradeIds)
  );
}

function handleOrderMessage(store: Store, payload: UserOrderStreamPayload, recordEvent: RecordEvent): void {
  const order = store.getFollowerOrderByClobOrderId(payload.id);
  if (!order) {
    return;
  }

  const originalSize = payload.original_size ?? order.originalSize ?? order.requestedSize;
  const matchedSize = payload.size_matched ?? order.matchedSize ?? "0";
  const updated = store.updateFollowerOrder(order.id, {
    conditionId: payload.market ?? order.conditionId ?? null,
    originalSize,
    matchedSize,
    status: normalizeFollowerOrderStatus(payload.status, matchedSize, originalSize),
    statusReason: normalizeStatusReason([payload.type, payload.status]),
    lastStatusAt: toIsoTimestamp(payload.created_at) ?? new Date().toISOString(),
  });

  if (!updated || !didOrderSnapshotChange(order, updated)) {
    return;
  }

  recordEvent("info", "follower_order.updated", {
    followerOrderId: updated.id,
    clobOrderId: updated.clobOrderId,
    conditionId: updated.conditionId,
    status: updated.status,
    matchedSize: updated.matchedSize,
    originalSize: updated.originalSize,
    reason: updated.statusReason,
    source: "user_ws.order",
  });
}

function handleTradeMessage(store: Store, payload: UserTradeStreamPayload, recordEvent: RecordEvent): void {
  const candidateOrderIds = new Set<string>([
    payload.taker_order_id,
    ...payload.maker_orders
      .map((entry) => entry?.order_id)
      .filter((value): value is string => typeof value === "string" && value.trim() !== ""),
  ]);

  for (const orderId of candidateOrderIds) {
    const order = store.getFollowerOrderByClobOrderId(orderId);
    if (!order) {
      continue;
    }

    const fill = extractFollowerFillFromTrade(orderId, payload);
    if (!fill) {
      continue;
    }

    const inserted = store.upsertFollowerFill({
      followerOrderId: order.id,
      ...fill,
    });

    const associateTradeIds = order.associateTradeIds.includes(payload.id)
      ? order.associateTradeIds
      : [...order.associateTradeIds, payload.id];
    const matchedSize = String(store.sumFollowerFillSize(order.id));
    const originalSize = order.originalSize ?? order.requestedSize;
    const updated = store.updateFollowerOrder(order.id, {
      conditionId: payload.market ?? order.conditionId ?? null,
      originalSize,
      matchedSize,
      associateTradeIds,
      status: normalizeFollowerOrderStatus(payload.status, matchedSize, originalSize),
      statusReason: normalizeStatusReason([payload.status]),
      lastStatusAt:
        toIsoTimestamp(payload.last_update) ?? toIsoTimestamp(payload.match_time) ?? new Date().toISOString(),
    });

    if (inserted) {
      recordEvent("info", "follower_fill.recorded", {
        followerOrderId: order.id,
        clobOrderId: order.clobOrderId,
        clobTradeId: fill.clobTradeId,
        market: fill.market,
        assetId: fill.assetId,
        side: fill.side,
        price: fill.price,
        size: fill.size,
        traderSide: fill.traderSide,
        source: "user_ws.trade",
      });
    }

    if (updated && didOrderSnapshotChange(order, updated)) {
      recordEvent("info", "follower_order.updated", {
        followerOrderId: updated.id,
        clobOrderId: updated.clobOrderId,
        conditionId: updated.conditionId,
        status: updated.status,
        matchedSize: updated.matchedSize,
        originalSize: updated.originalSize,
        reason: updated.statusReason,
        source: "user_ws.trade",
      });
    }
  }
}

export function startUserOrderStream(options: StartUserOrderStreamOptions): UserOrderStreamController {
  let connected = false;
  let initialConnectResolved = false;
  let resolveInitialConnect: (() => void) | null = null;
  const initialConnect = new Promise<void>((resolve) => {
    resolveInitialConnect = resolve;
  });

  const subscription: SubscriptionMessage = {
    subscriptions: [
      {
        topic: "clob_user",
        type: "order",
        clob_auth: options.auth,
      },
      {
        topic: "clob_user",
        type: "trade",
        clob_auth: options.auth,
      },
    ],
  };

  const client = new RealTimeDataClient({
    autoReconnect: true,
    onConnect(rtClient) {
      connected = true;
      options.recordEvent("info", "user_websocket.connected");
      rtClient.subscribe(subscription);
      if (!initialConnectResolved) {
        initialConnectResolved = true;
        resolveInitialConnect?.();
      }
    },
    onStatusChange(status) {
      if (status === ConnectionStatus.CONNECTING) {
        connected = false;
        return;
      }
      if (status === ConnectionStatus.DISCONNECTED) {
        connected = false;
        options.recordEvent("warn", "user_websocket.disconnected");
      }
    },
    onMessage(_client: RealTimeDataClient, message: Message) {
      if (message.topic !== "clob_user") {
        return;
      }

      try {
        if (message.type === "order") {
          const payload = asUserOrderPayload(message.payload);
          if (!payload) {
            options.recordEvent("warn", "user_websocket.invalid_order_payload");
            return;
          }
          handleOrderMessage(options.store, payload, options.recordEvent);
          return;
        }

        if (message.type === "trade") {
          const payload = asUserTradePayload(message.payload);
          if (!payload) {
            options.recordEvent("warn", "user_websocket.invalid_trade_payload");
            return;
          }
          handleTradeMessage(options.store, payload, options.recordEvent);
        }
      } catch (error) {
        options.recordEvent("error", "user_websocket.process_failed", {
          messageType: message.type,
          reason: errorMessage(error),
        });
      }
    },
  });

  client.connect();

  return {
    close() {
      client.disconnect();
    },
    isConnected() {
      return connected;
    },
    async waitUntilConnected(timeoutMs = 15_000) {
      if (connected || initialConnectResolved) {
        return;
      }

      await Promise.race([
        initialConnect,
        new Promise<void>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Timed out waiting for user websocket after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    },
  };
}
