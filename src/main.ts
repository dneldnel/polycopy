import { loadConfig } from "./config";
import { resolveOrderSize, submitLeaderPriceLimitOrder } from "./executor";
import { startLeaderStream } from "./leaderStream";
import { createLogger, errorMessage } from "./logger";
import { normalizeLeaderTradePayload } from "./normalize";
import { createAuthenticatedClobClient } from "./polymarket";
import { renderStartupChecks, sleep, validateStartupChecks } from "./preflight";
import { Store } from "./store";
import { createRuntimeTui, type RuntimeTui } from "./tui";
import type { ActivityTradePayload } from "./types";
import { startUserOrderStream, type UserOrderStreamController } from "./userOrderStream";

let activeTui: RuntimeTui | null = null;
const STARTUP_PREFLIGHT_DELAY_MS = 5000;

async function main(): Promise<void> {
  process.stdout.write("[startup preflight] running checks...\n");
  const startupChecks = await validateStartupChecks(process.env);
  process.stdout.write(renderStartupChecks(startupChecks, STARTUP_PREFLIGHT_DELAY_MS));
  await sleep(STARTUP_PREFLIGHT_DELAY_MS);

  const config = loadConfig();
  const store = new Store(config.sqlitePath);
  const tui = config.tuiEnabled
    ? createRuntimeTui({
        config,
        store,
        onQuit: () => {
          process.kill(process.pid, "SIGINT");
        },
      })
    : null;
  const tuiActive = tui?.start() ?? false;
  activeTui = tuiActive ? tui : null;
  const logger = createLogger(
    tuiActive && tui
      ? {
          silent: true,
          onWrite: (entry) => {
            tui.record(entry);
          },
        }
      : {}
  );
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

  if (config.tuiEnabled && !tuiActive) {
    logger.warn("tui.disabled_non_tty");
  }

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
    orderSizeMode: config.orderSizeMode,
    fixedOrderSize: config.fixedOrderSize,
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

    const requestedSize = resolveOrderSize(
      trade.size,
      config.orderSizeMode,
      config.fixedOrderSize,
      config.sizeMultiplier
    );
    const attemptedSize = config.orderSizeMode === "fixed" ? String(config.fixedOrderSize) : trade.size;
    if (!requestedSize) {
      store.insertFollowerOrder({
        leaderTradeId: observed.record.id,
        followerWallet: config.followerWallet,
        clobOrderId: null,
        conditionId: trade.conditionId,
        assetId: trade.assetId,
        side: trade.side,
        limitPrice: trade.price,
        requestedSize: attemptedSize,
        status: "submission_failed",
        statusReason: "invalid_requested_size",
      });
      recordEvent("error", "follower_order.invalid_size", {
        leaderTradeId: observed.record.id,
        tradeId: trade.tradeId,
        size: attemptedSize,
        leaderSize: trade.size,
        orderSizeMode: config.orderSizeMode,
        fixedOrderSize: config.fixedOrderSize,
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
        requestedSize,
        originalSize: requestedSize,
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
        size: requestedSize,
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
        requestedSize,
        status: "submission_failed",
        statusReason: "user_ws_disconnected",
      });
      recordEvent("warn", "follower_order.skipped_user_ws_disconnected", {
        leaderTradeId: observed.record.id,
        tradeId: trade.tradeId,
        assetId: trade.assetId,
        side: trade.side,
        price: trade.price,
        size: requestedSize,
      });
      return;
    }

    const submission = await submitLeaderPriceLimitOrder(clobClient!, {
      assetId: trade.assetId,
      side: trade.side,
      price: trade.price,
      size: requestedSize,
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
        requestedSize,
        status: "submission_failed",
        statusReason: submission.reason,
      });
      recordEvent("error", "follower_order.submission_failed", {
        leaderTradeId: observed.record.id,
        tradeId: trade.tradeId,
        assetId: trade.assetId,
        side: trade.side,
        price: trade.price,
        size: requestedSize,
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
    onConnected: (context) => {
      store.insertRuntimeEvent("info", "websocket.connected", {
        leaderWallet: config.leaderWallet,
        pingIntervalMs: context.pingIntervalMs,
        reconnectAttempt: context.reconnectAttempt,
      });
    },
    onDisconnected: (context) => {
      store.insertRuntimeEvent("warn", "websocket.disconnected", {
        leaderWallet: config.leaderWallet,
        code: context.code,
        reason: context.reason,
        reconnectInMs: context.reconnectInMs,
        source: context.source,
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
    activeTui?.stop();
    activeTui = null;
    stream.close();
    userOrderStream?.close();
    store.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  activeTui?.stop();
  activeTui = null;
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
