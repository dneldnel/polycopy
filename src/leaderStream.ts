import type { Message, SubscriptionMessage } from "@polymarket/real-time-data-client";
import { errorMessage, type Logger } from "./logger";
import type { ActivityTradePayload } from "./types";

const LeaderWebSocket = require("ws") as LeaderSocketConstructor;

const LEADER_WS_URL = "wss://ws-live-data.polymarket.com";
const LEADER_WS_PING_INTERVAL_MS = 30_000;
const LEADER_WS_RECONNECT_BASE_MS = 1_000;
const LEADER_WS_RECONNECT_MAX_MS = 30_000;

type LeaderSocketData = string | Buffer | ArrayBuffer | Buffer[];

interface LeaderSocket {
  readyState: number;
  close(code?: number, data?: string): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "message", listener: (data: LeaderSocketData, isBinary: boolean) => void): this;
  on(event: "open", listener: () => void): this;
  on(event: "pong", listener: () => void): this;
  ping(data?: Buffer | string, mask?: boolean, cb?: (error?: Error) => void): void;
  removeAllListeners(): this;
  send(data: string, cb?: (error?: Error) => void): void;
  terminate(): void;
}

interface LeaderSocketConstructor {
  new (url: string): LeaderSocket;
  readonly OPEN: number;
}

function asPayload(value: unknown): ActivityTradePayload | null {
  return value && typeof value === "object" ? (value as ActivityTradePayload) : null;
}

function asMessage(value: unknown): Message | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.topic !== "string" || typeof record.type !== "string" || !("payload" in record)) {
    return null;
  }

  return record as unknown as Message;
}

function decodeSocketData(data: LeaderSocketData): string | null {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((entry) => (Buffer.isBuffer(entry) ? entry : Buffer.from(entry)))).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return null;
}

function decodeCloseReason(reason: Buffer): string | null {
  const text = reason.toString("utf8").trim();
  return text === "" ? null : text;
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

export interface StartLeaderStreamOptions {
  leaderWallet: string;
  logger: Logger;
  onTrade: (payload: ActivityTradePayload) => Promise<void> | void;
  onConnected?: (context: LeaderStreamConnectedContext) => Promise<void> | void;
  onDisconnected?: (context: LeaderStreamDisconnectedContext) => Promise<void> | void;
}

export function startLeaderStream(options: StartLeaderStreamOptions): { close(): void } {
  const subscription: SubscriptionMessage = {
    subscriptions: [{ topic: "activity", type: "trades" }],
  };
  let socket: LeaderSocket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let reconnectAttempt = 0;
  let closedIntentionally = false;
  let disconnectSource: LeaderStreamDisconnectedContext["source"] = "close";
  let awaitingPong = false;

  const clearReconnectTimer = (): void => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const clearHeartbeatTimer = (): void => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    awaitingPong = false;
  };

  const startHeartbeat = (currentSocket: LeaderSocket): void => {
    clearHeartbeatTimer();
    heartbeatTimer = setInterval(() => {
      if (currentSocket !== socket || currentSocket.readyState !== LeaderWebSocket.OPEN) {
        return;
      }

      if (awaitingPong) {
        disconnectSource = "heartbeat_timeout";
        currentSocket.terminate();
        return;
      }

      awaitingPong = true;
      currentSocket.ping(undefined, undefined, (error) => {
        if (error) {
          options.logger.error("websocket.ping_failed", {
            leaderWallet: options.leaderWallet,
            reason: errorMessage(error),
          });
        }
      });
    }, LEADER_WS_PING_INTERVAL_MS);
  };

  const scheduleReconnect = (): void => {
    if (closedIntentionally) {
      return;
    }

    clearReconnectTimer();
    const reconnectInMs = reconnectDelayMs(reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectInMs);
  };

  const sendSubscription = (currentSocket: LeaderSocket): void => {
    currentSocket.send(
      JSON.stringify({
        action: "subscribe",
        ...subscription,
      }),
      (error) => {
        if (!error) {
          return;
        }

        options.logger.error("websocket.subscribe_failed", {
          leaderWallet: options.leaderWallet,
          reason: errorMessage(error),
        });
        currentSocket.close();
      }
    );
  };

  const handleSocketMessage = (rawData: LeaderSocketData): void => {
    const text = decodeSocketData(rawData);
    if (!text) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }

    const message = asMessage(parsed);
    if (!message || message.topic !== "activity" || message.type !== "trades") {
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

    void Promise.resolve(options.onTrade(payload)).catch((error) => {
      options.logger.error("leader_trade.callback_failed", {
        leaderWallet: options.leaderWallet,
        reason: errorMessage(error),
      });
    });
  };

  const connect = (): void => {
    clearReconnectTimer();
    disconnectSource = "close";
    const currentSocket = new LeaderWebSocket(LEADER_WS_URL);
    socket = currentSocket;

    currentSocket.on("open", () => {
      if (currentSocket !== socket || closedIntentionally) {
        return;
      }

      const currentReconnectAttempt = reconnectAttempt;
      reconnectAttempt = 0;
      awaitingPong = false;
      sendSubscription(currentSocket);
      startHeartbeat(currentSocket);
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
    });

    currentSocket.on("pong", () => {
      if (currentSocket !== socket) {
        return;
      }
      awaitingPong = false;
    });

    currentSocket.on("message", (data) => {
      if (currentSocket !== socket || closedIntentionally) {
        return;
      }
      handleSocketMessage(data);
    });

    currentSocket.on("error", (error) => {
      if (currentSocket !== socket || closedIntentionally) {
        return;
      }
      options.logger.error("websocket.error", {
        leaderWallet: options.leaderWallet,
        reason: errorMessage(error),
      });
    });

    currentSocket.on("close", (code, reasonBuffer) => {
      if (currentSocket !== socket) {
        return;
      }

      socket = null;
      clearHeartbeatTimer();
      if (closedIntentionally) {
        return;
      }

      const reason = decodeCloseReason(reasonBuffer);
      const reconnectInMs = reconnectDelayMs(reconnectAttempt);
      const context: LeaderStreamDisconnectedContext = {
        code,
        reason,
        reconnectInMs,
        source: disconnectSource,
      };
      disconnectSource = "close";
      options.logger.warn("websocket.disconnected", {
        leaderWallet: options.leaderWallet,
        code: context.code,
        reason: context.reason ?? undefined,
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
      scheduleReconnect();
    });
  };

  connect();
  return {
    close() {
      closedIntentionally = true;
      clearReconnectTimer();
      clearHeartbeatTimer();
      if (socket) {
        const currentSocket = socket;
        socket = null;
        currentSocket.removeAllListeners();
        currentSocket.terminate();
      }
    },
  };
}
