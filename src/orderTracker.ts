import type { OpenOrder, Trade } from "@polymarket/clob-client";
import { extractFollowerFillFromTrade, normalizeFollowerOrderStatus } from "./followerLifecycle";
import { errorMessage, type Logger } from "./logger";
import type { OrderTrackerClient } from "./polymarket";
import { type FollowerOrderRecord } from "./types";
import { Store } from "./store";

function belongsToOrder(orderId: string, trade: Trade): boolean {
  if (trade.taker_order_id === orderId) {
    return true;
  }
  return trade.maker_orders.some((makerOrder) => makerOrder.order_id === orderId);
}

async function fetchOrderTrades(
  client: OrderTrackerClient,
  order: FollowerOrderRecord,
  associateTradeIds: string[]
): Promise<Trade[]> {
  if (!order.clobOrderId) {
    return [];
  }

  const byId = new Map<string, Trade>();
  for (const tradeId of associateTradeIds) {
    const trades = await client.getTrades({ id: tradeId }, true);
    for (const trade of trades) {
      if (belongsToOrder(order.clobOrderId, trade)) {
        byId.set(trade.id, trade);
      }
    }
  }

  const recentTrades = await client.getTrades({ asset_id: order.assetId }, true);
  for (const trade of recentTrades) {
    if (belongsToOrder(order.clobOrderId, trade)) {
      byId.set(trade.id, trade);
    }
  }

  return [...byId.values()];
}

async function syncOneOrder(store: Store, client: OrderTrackerClient, order: FollowerOrderRecord, logger: Logger): Promise<void> {
  let remoteOrder: OpenOrder | null = null;
  try {
    remoteOrder = await client.getOrder(order.clobOrderId!);
  } catch (error) {
    logger.warn("order_tracker.get_order_failed", {
      followerOrderId: order.id,
      clobOrderId: order.clobOrderId,
      reason: errorMessage(error),
    });
  }

  const trades = await fetchOrderTrades(client, order, remoteOrder?.associate_trades ?? order.associateTradeIds);
  const associateTradeIds = new Set<string>(order.associateTradeIds);
  let insertedFills = 0;

  for (const trade of trades) {
    associateTradeIds.add(trade.id);
    const fill = extractFollowerFillFromTrade(order.clobOrderId!, trade);
    if (!fill) {
      continue;
    }
    if (store.insertFollowerFill({ followerOrderId: order.id, ...fill })) {
      insertedFills += 1;
    }
  }

  const matchedSize = remoteOrder?.size_matched ?? (store.sumFollowerFillSize(order.id) > 0 ? String(store.sumFollowerFillSize(order.id)) : order.matchedSize);
  const originalSize = remoteOrder?.original_size ?? order.originalSize ?? order.requestedSize;
  const nextStatus = remoteOrder
    ? normalizeFollowerOrderStatus(remoteOrder.status, remoteOrder.size_matched, remoteOrder.original_size)
    : normalizeFollowerOrderStatus(order.status, matchedSize ?? null, originalSize ?? null);

  store.updateFollowerOrder(order.id, {
    status: nextStatus,
    statusReason: remoteOrder?.status ?? order.statusReason,
    originalSize,
    matchedSize,
    associateTradeIds: [...associateTradeIds],
    lastStatusAt: new Date().toISOString(),
  });

  if (insertedFills > 0) {
    logger.info("order_tracker.fills_recorded", {
      followerOrderId: order.id,
      clobOrderId: order.clobOrderId,
      insertedFills,
      status: nextStatus,
    });
  }
}

export interface OrderTrackerController {
  stop(): void;
  runOnce(): Promise<void>;
}

export function startOrderTracker(
  store: Store,
  client: OrderTrackerClient,
  logger: Logger,
  intervalMs: number
): OrderTrackerController {
  let closed = false;
  let running = false;

  const runOnce = async (): Promise<void> => {
    if (closed || running) {
      return;
    }
    running = true;
    try {
      const orders = store.listTrackableOrders();
      for (const order of orders) {
        await syncOneOrder(store, client, order, logger);
      }
    } catch (error) {
      logger.error("order_tracker.run_failed", {
        reason: errorMessage(error),
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);

  void runOnce();

  return {
    stop() {
      closed = true;
      clearInterval(timer);
    },
    runOnce,
  };
}
