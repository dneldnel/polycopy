import {
  ConnectionStatus,
  RealTimeDataClient,
  type Message,
  type SubscriptionMessage,
} from "@polymarket/real-time-data-client";
import { errorMessage, type Logger } from "./logger";
import type { ActivityTradePayload } from "./types";

const LEADER_WS_PING_INTERVAL_MS = 5_000;
const LEADER_WS_RECONNECT_BASE_MS = 1_000;
const LEADER_WS_RECONNECT_MAX_MS = 30_000;

function asPayload(value: unknown): ActivityTradePayload | null {
  return value && typeof value === "object" ? (value as ActivityTradePayload) : null;
}

function reconnectDelayMs(attempt: number): number {
  return Math.min(LEADER_WS_RECONNECT_BASE_MS * 2 ** attempt, LEADER_WS_RECONNECT_MAX_MS);
}

export interface LeaderStreamConnectedContext {
  pingIntervalMs: number;
  reconnectAttempt: number;
}

export interface LeaderStreamDisconnectedContext {
  code: number;
  reason: string | null;
  reconnectInMs: number;
  source: "close" | "heartbeat_timeout";
}

export type LeaderStreamDiagnosticEvent =
  | {
      type: "socket.opened";
    }
  | {
      type: "websocket.subscription_sent";
    }
  | {
      type: "websocket.message_received";
      preview: string;
    }
  | {
      type: "websocket.message_parse_failed";
      preview: string;
    }
  | {
      type: "websocket.message_ignored";
      topic: string | null;
      messageType: string | null;
    }
  | {
      type: "leader_trade.invalid_payload";
      keys: string[];
    }
  | {
      type: "leader_trade.wallet_mismatch";
      proxyWallet: string | null;
    }
  | {
      type: "leader_trade.matched";
      proxyWallet: string | null;
    };

export interface StartLeaderStreamOptions {
  leaderWallet: string;
  logger: Logger;
  onTrade: (payload: ActivityTradePayload) => Promise<void> | void;
  onConnected?: (context: LeaderStreamConnectedContext) => Promise<void> | void;
  onDisconnected?: (context: LeaderStreamDisconnectedContext) => Promise<void> | void;
  onDiagnostic?: (event: LeaderStreamDiagnosticEvent) => void;
}

export function startLeaderStream(options: StartLeaderStreamOptions): { close(): void } {
  const subscription: SubscriptionMessage = {
    subscriptions: [{ topic: "activity", type: "trades" }],
  };

  let reconnectAttempt = 0;
  let closedIntentionally = false;
  let isConnected = false;

  const emitDiagnostic = (event: LeaderStreamDiagnosticEvent): void => {
    options.onDiagnostic?.(event);
  };

  const handleMessage = (message: Message): void => {
    emitDiagnostic({
      type: "websocket.message_received",
      preview: JSON.stringify({
        topic: message.topic,
        type: message.type,
        payload: message.payload,
      }).slice(0, 160),
    });

    if (message.topic !== "activity" || message.type !== "trades") {
      emitDiagnostic({
        type: "websocket.message_ignored",
        topic: message.topic ?? null,
        messageType: message.type ?? null,
      });
      return;
    }

    const payload = asPayload(message.payload);
    if (!payload) {
      emitDiagnostic({
        type: "leader_trade.invalid_payload",
        keys: [],
      });
      options.logger.warn("leader_trade.invalid_payload");
      return;
    }

    const proxyWallet = typeof payload.proxyWallet === "string" ? payload.proxyWallet.toLowerCase() : "";
    if (proxyWallet !== options.leaderWallet) {
      emitDiagnostic({
        type: "leader_trade.wallet_mismatch",
        proxyWallet: proxyWallet || null,
      });
      return;
    }

    emitDiagnostic({
      type: "leader_trade.matched",
      proxyWallet: proxyWallet || null,
    });

    void Promise.resolve(options.onTrade(payload)).catch((error) => {
      options.logger.error("leader_trade.callback_failed", {
        leaderWallet: options.leaderWallet,
        reason: errorMessage(error),
      });
    });
  };

  const client = new RealTimeDataClient({
    autoReconnect: true,
    pingInterval: LEADER_WS_PING_INTERVAL_MS,
    onConnect(rtClient) {
      if (closedIntentionally) {
        return;
      }

      emitDiagnostic({
        type: "socket.opened",
      });

      rtClient.subscribe(subscription);
      emitDiagnostic({
        type: "websocket.subscription_sent",
      });

      const currentReconnectAttempt = reconnectAttempt;
      reconnectAttempt = 0;
      isConnected = true;

      options.logger.info("websocket.connected", {
        leaderWallet: options.leaderWallet,
        pingIntervalMs: LEADER_WS_PING_INTERVAL_MS,
        reconnectAttempt: currentReconnectAttempt,
      });

      if (options.onConnected) {
        void Promise.resolve(
          options.onConnected({
            pingIntervalMs: LEADER_WS_PING_INTERVAL_MS,
            reconnectAttempt: currentReconnectAttempt,
          })
        ).catch((error) => {
          options.logger.error("websocket.connected_callback_failed", {
            leaderWallet: options.leaderWallet,
            reason: errorMessage(error),
          });
        });
      }
    },
    onMessage(_, message) {
      if (closedIntentionally) {
        return;
      }

      try {
        handleMessage(message);
      } catch (error) {
        options.logger.error("websocket.message_processing_failed", {
          leaderWallet: options.leaderWallet,
          reason: errorMessage(error),
        });
      }
    },
    onStatusChange(status) {
      if (closedIntentionally) {
        return;
      }

      if (status !== ConnectionStatus.DISCONNECTED || !isConnected) {
        return;
      }

      isConnected = false;
      const reconnectInMs = reconnectDelayMs(reconnectAttempt);
      reconnectAttempt += 1;
      const context: LeaderStreamDisconnectedContext = {
        code: 1006,
        reason: null,
        reconnectInMs,
        source: "close",
      };

      options.logger.warn("websocket.disconnected", {
        leaderWallet: options.leaderWallet,
        code: context.code,
        reconnectInMs: context.reconnectInMs,
        source: context.source,
      });

      if (options.onDisconnected) {
        void Promise.resolve(options.onDisconnected(context)).catch((error) => {
          options.logger.error("websocket.disconnected_callback_failed", {
            leaderWallet: options.leaderWallet,
            reason: errorMessage(error),
          });
        });
      }
    },
  });

  client.connect();

  return {
    close() {
      closedIntentionally = true;
      isConnected = false;
      client.disconnect();
    },
  };
}
