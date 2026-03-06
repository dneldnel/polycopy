import { loadConfig } from "./config";
import { scaleOrderSize, submitLeaderPriceLimitOrder } from "./executor";
import { startLeaderStream } from "./leaderStream";
import { createLogger, errorMessage } from "./logger";
import { normalizeLeaderTradePayload } from "./normalize";
import { createAuthenticatedClobClient } from "./polymarket";
import { Store } from "./store";
import type { ActivityTradePayload } from "./types";
import { startUserOrderStream, type UserOrderStreamController } from "./userOrderStream";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger();
  const store = new Store(config.sqlitePath);
  const clobClient = config.simulationMode ? null : await createAuthenticatedClobClient(config);
  const userOrderStream: UserOrderStreamController | null =
    !config.simulationMode && clobClient?.creds
      ? startUserOrderStream({
          store,
          auth: clobClient.creds,
          recordEvent: (level, eventType, payload = {}) => {
            store.insertRuntimeEvent(level, eventType, payload);
            logger[level](eventType, payload);
          },
        })
      : null;

  const recordEvent = (
    level: "info" | "warn" | "error",
    eventType: string,
    payload: Record<string, unknown> = {}
  ): void => {
    store.insertRuntimeEvent(level, eventType, payload);
    logger[level](eventType, payload);
  };

  recordEvent("info", "app.started", {
    leaderWallet: config.leaderWallet,
    followerWallet: config.followerWallet,
    proxyWalletAddress: config.proxyWalletAddress || null,
    simulationMode: config.simulationMode,
    sqlitePath: config.sqlitePath,
    sizeMultiplier: config.sizeMultiplier,
  });

  if (!config.simulationMode) {
    if (!userOrderStream) {
      throw new Error("User websocket requires authenticated CLOB API credentials.");
    }
    await userOrderStream.waitUntilConnected();
  }

  const processLeaderPayload = async (payload: ActivityTradePayload): Promise<void> => {
    const trade = normalizeLeaderTradePayload(payload, "websocket");
    if (!trade) {
      recordEvent("warn", "leader_trade.invalid_payload");
      return;
    }

    const observed = store.observeLeaderTrade(trade);
    if (!observed.isNew) {
      recordEvent("info", "leader_trade.duplicate_ignored", {
        tradeId: trade.tradeId,
      });
      return;
    }

    recordEvent("info", "leader_trade.observed", {
      leaderTradeId: observed.record.id,
      tradeId: trade.tradeId,
      assetId: trade.assetId,
      side: trade.side,
      price: trade.price,
      size: trade.size,
      title: trade.title,
      outcome: trade.outcome,
    });

    const scaledSize = scaleOrderSize(trade.size, config.sizeMultiplier);
    if (!scaledSize) {
      store.insertFollowerOrder({
        leaderTradeId: observed.record.id,
        followerWallet: config.followerWallet,
        clobOrderId: null,
        conditionId: trade.conditionId,
        assetId: trade.assetId,
        side: trade.side,
        limitPrice: trade.price,
        requestedSize: trade.size,
        status: "submission_failed",
        statusReason: "invalid_scaled_size",
      });
      recordEvent("error", "follower_order.invalid_size", {
        leaderTradeId: observed.record.id,
        tradeId: trade.tradeId,
        size: trade.size,
        sizeMultiplier: config.sizeMultiplier,
      });
      return;
    }

    if (config.simulationMode) {
      store.insertFollowerOrder({
        leaderTradeId: observed.record.id,
        followerWallet: config.followerWallet,
        clobOrderId: null,
        conditionId: trade.conditionId,
        assetId: trade.assetId,
        side: trade.side,
        limitPrice: trade.price,
        requestedSize: scaledSize,
        originalSize: scaledSize,
        matchedSize: "0",
        status: "simulated",
        statusReason: "simulation_mode",
      });
      recordEvent("info", "follower_order.simulated", {
        leaderTradeId: observed.record.id,
        tradeId: trade.tradeId,
        assetId: trade.assetId,
        side: trade.side,
        price: trade.price,
        size: scaledSize,
      });
      return;
    }

    if (!userOrderStream?.isConnected()) {
      store.insertFollowerOrder({
        leaderTradeId: observed.record.id,
        followerWallet: config.followerWallet,
        clobOrderId: null,
        conditionId: trade.conditionId,
        assetId: trade.assetId,
        side: trade.side,
        limitPrice: trade.price,
        requestedSize: scaledSize,
        status: "submission_failed",
        statusReason: "user_ws_disconnected",
      });
      recordEvent("warn", "follower_order.skipped_user_ws_disconnected", {
        leaderTradeId: observed.record.id,
        tradeId: trade.tradeId,
        assetId: trade.assetId,
        side: trade.side,
        price: trade.price,
        size: scaledSize,
      });
      return;
    }

    const submission = await submitLeaderPriceLimitOrder(clobClient!, {
      assetId: trade.assetId,
      side: trade.side,
      price: trade.price,
      size: scaledSize,
    });

    if (!submission.ok) {
      store.insertFollowerOrder({
        leaderTradeId: observed.record.id,
        followerWallet: config.followerWallet,
        clobOrderId: null,
        conditionId: trade.conditionId,
        assetId: trade.assetId,
        side: trade.side,
        limitPrice: trade.price,
        requestedSize: scaledSize,
        status: "submission_failed",
        statusReason: submission.reason,
      });
      recordEvent("error", "follower_order.submission_failed", {
        leaderTradeId: observed.record.id,
        tradeId: trade.tradeId,
        assetId: trade.assetId,
        side: trade.side,
        price: trade.price,
        size: scaledSize,
        reason: submission.reason,
      });
      return;
    }

    store.insertFollowerOrder({
      leaderTradeId: observed.record.id,
      followerWallet: config.followerWallet,
      clobOrderId: submission.orderId,
      conditionId: trade.conditionId,
      assetId: trade.assetId,
      side: trade.side,
      limitPrice: submission.price,
      requestedSize: submission.size,
      originalSize: submission.size,
      matchedSize: "0",
      status: "submitted",
      statusReason: submission.status,
    });

    recordEvent("info", "follower_order.submitted", {
      leaderTradeId: observed.record.id,
      tradeId: trade.tradeId,
      clobOrderId: submission.orderId,
      assetId: trade.assetId,
      side: trade.side,
      price: submission.price,
      size: submission.size,
      status: submission.status,
    });
  };

  const stream = startLeaderStream({
    leaderWallet: config.leaderWallet,
    logger,
    onConnected: () => {
      store.insertRuntimeEvent("info", "websocket.connected", {
        leaderWallet: config.leaderWallet,
      });
    },
    onDisconnected: () => {
      store.insertRuntimeEvent("warn", "websocket.disconnected", {
        leaderWallet: config.leaderWallet,
      });
    },
    onTrade: async (payload) => {
      try {
        await processLeaderPayload(payload);
      } catch (error) {
        recordEvent("error", "leader_trade.process_failed", {
          reason: errorMessage(error),
        });
      }
    },
  });

  const shutdown = (signal: NodeJS.Signals) => {
    recordEvent("info", "app.stopping", {
      signal,
      leaderTrades: store.countLeaderTrades(),
      followerOrders: store.countFollowerOrders(),
      followerFills: store.countFollowerFills(),
      runtimeEvents: store.countRuntimeEvents(),
    });
    stream.close();
    userOrderStream?.close();
    store.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  const logger = createLogger();
  try {
    const config = loadConfig();
    const store = new Store(config.sqlitePath);
    store.insertRuntimeEvent("error", "app.crashed", {
      reason: errorMessage(error),
    });
    store.close();
  } catch {}
  logger.error("app.crashed", {
    reason: errorMessage(error),
  });
  process.exit(1);
});
