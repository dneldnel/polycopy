import {
  ConnectionStatus,
  RealTimeDataClient,
  type Message,
  type SubscriptionMessage,
} from "@polymarket/real-time-data-client";
import type { Logger } from "./logger";
import type { ActivityTradePayload } from "./types";

function asPayload(value: unknown): ActivityTradePayload | null {
  return value && typeof value === "object" ? (value as ActivityTradePayload) : null;
}

export interface StartLeaderStreamOptions {
  leaderWallet: string;
  logger: Logger;
  onTrade: (payload: ActivityTradePayload) => Promise<void> | void;
  onConnected?: () => Promise<void> | void;
  onDisconnected?: () => Promise<void> | void;
}

export function startLeaderStream(options: StartLeaderStreamOptions): { close(): void } {
  const subscription: SubscriptionMessage = {
    subscriptions: [{ topic: "activity", type: "trades" }],
  };

  const client = new RealTimeDataClient({
    autoReconnect: true,
    onConnect(rtClient) {
      options.logger.info("websocket.connected", {
        leaderWallet: options.leaderWallet,
      });
      if (options.onConnected) {
        void Promise.resolve(options.onConnected()).catch((error) => {
          options.logger.error("websocket.connected_callback_failed", {
            leaderWallet: options.leaderWallet,
            reason: error instanceof Error ? error.message : String(error),
          });
        });
      }
      rtClient.subscribe(subscription);
    },
    onStatusChange(status: ConnectionStatus) {
      if (status === ConnectionStatus.DISCONNECTED) {
        options.logger.warn("websocket.disconnected", {
          leaderWallet: options.leaderWallet,
        });
        if (options.onDisconnected) {
          void Promise.resolve(options.onDisconnected()).catch((error) => {
            options.logger.error("websocket.disconnected_callback_failed", {
              leaderWallet: options.leaderWallet,
              reason: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }
    },
    async onMessage(_client: RealTimeDataClient, message: Message) {
      if (message.topic !== "activity" || message.type !== "trades") {
        return;
      }

      const payload = asPayload(message.payload);
      if (!payload) {
        options.logger.warn("leader_trade.invalid_payload");
        return;
      }

      const proxyWallet = typeof payload.proxyWallet === "string" ? payload.proxyWallet.toLowerCase() : "";
      if (proxyWallet !== options.leaderWallet) {
        return;
      }

      await options.onTrade(payload);
    },
  });

  client.connect();
  return {
    close() {
      client.disconnect();
    },
  };
}
