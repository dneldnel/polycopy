import type { OpenOrder, Trade } from "@polymarket/clob-client";

export type TradeSide = "BUY" | "SELL";
export type SignatureTypeName = "EOA" | "POLY_PROXY" | "POLY_GNOSIS_SAFE";
export type OrderSizeModeName = "fixed" | "multiplier";

export interface AppConfig {
  leaderWallet: string;
  followerWallet: string;
  proxyWalletAddress: string;
  walletPrivateKey: string;
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  sqlitePath: string;
  simulationMode: boolean;
  orderSizeMode: OrderSizeModeName;
  fixedOrderSize: number;
  sizeMultiplier: number;
  clobHttpUrl: string;
  chainId: number;
  signatureType: SignatureTypeName;
  tuiEnabled: boolean;
}

export interface ActivityTradePayload {
  asset?: string;
  conditionId?: string;
  proxyWallet?: string;
  side?: string;
  size?: number | string;
  price?: number | string;
  timestamp?: number | string;
  transactionHash?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
  title?: string;
  endDate?: string;
}

export interface NormalizedLeaderTrade {
  leaderWallet: string;
  tradeId: string;
  transactionHash: string | null;
  activityTimestamp: number;
  receivedAt: string;
  assetId: string;
  conditionId: string | null;
  side: TradeSide;
  price: string;
  size: string;
  slug: string | null;
  eventSlug: string | null;
  outcome: string | null;
  title: string | null;
  endDate: string | null;
  rawPayload: ActivityTradePayload;
  source: string;
}

export interface LeaderTradeRecord extends NormalizedLeaderTrade {
  id: number;
  createdAt: string;
}

export type FollowerOrderStatus =
  | "simulated"
  | "submission_failed"
  | "submitted"
  | "live"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "rejected"
  | "unknown";

export interface FollowerOrderRecord {
  id: number;
  leaderTradeId: number;
  followerWallet: string;
  clobOrderId: string | null;
  conditionId: string | null;
  assetId: string;
  side: TradeSide;
  limitPrice: string;
  requestedSize: string;
  originalSize: string | null;
  matchedSize: string | null;
  status: FollowerOrderStatus;
  statusReason: string | null;
  associateTradeIds: string[];
  submittedAt: string;
  lastStatusAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface FollowerFillRecord {
  id: number;
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
  createdAt: string;
}

export interface UserOrderStreamPayload extends OpenOrder {
  type?: string;
}

export type UserTradeStreamPayload = Omit<Trade, "trader_side"> & {
  trader_side?: "TAKER" | "MAKER" | null;
};

export interface RuntimeEventRecord {
  id: number;
  level: "info" | "warn" | "error";
  eventType: string;
  payloadJson: string;
  createdAt: string;
}

export interface SubmitLimitOrderInput {
  assetId: string;
  side: TradeSide;
  price: string;
  size: string;
}

export type SubmitLimitOrderResult =
  | {
      ok: true;
      orderId: string;
      status: string;
      price: string;
      size: string;
    }
  | {
      ok: false;
      reason: string;
      price: string;
      size: string;
    };
