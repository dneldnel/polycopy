import type { Trade } from "@polymarket/clob-client";
import type { FollowerOrderStatus, TradeSide } from "./types";

interface TradeLikeMakerOrder {
  order_id: string;
  matched_amount: string;
  price: string;
  outcome: string;
  side: TradeSide;
}

interface TradeLike {
  id: string;
  taker_order_id: string;
  market: string;
  asset_id: string;
  side: TradeSide;
  size: string;
  price: string;
  status: string;
  match_time: string;
  last_update: string;
  outcome: string;
  maker_orders: TradeLikeMakerOrder[];
  transaction_hash: string;
  trader_side?: "TAKER" | "MAKER" | null;
}

export interface ExtractedFollowerFill {
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

function parseNumber(value: string | null | undefined): number {
  const parsed = Number(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeFollowerOrderStatus(
  rawStatus: string | null | undefined,
  matchedSize: string | null | undefined,
  originalSize: string | null | undefined
): FollowerOrderStatus {
  const normalized = (rawStatus ?? "").trim().toLowerCase();
  if (normalized.includes("cancel")) {
    return "cancelled";
  }
  if (normalized.includes("reject") || normalized.includes("fail")) {
    return "rejected";
  }

  const matched = parseNumber(matchedSize);
  const original = parseNumber(originalSize);
  if (original > 0 && matched >= original) {
    return "filled";
  }
  if (matched > 0) {
    return "partially_filled";
  }

  if (
    normalized === "submitted" ||
    normalized === "live" ||
    normalized === "open" ||
    normalized === "unmatched" ||
    normalized === "placement"
  ) {
    return "live";
  }
  if (normalized.includes("fill") || normalized.includes("match") || normalized === "mined") {
    return "filled";
  }
  return "unknown";
}

export function extractFollowerFillFromTrade(
  clobOrderId: string,
  trade: TradeLike | Trade
): ExtractedFollowerFill | null {
  if (trade.taker_order_id === clobOrderId) {
    return {
      clobTradeId: trade.id,
      market: trade.market ?? null,
      assetId: trade.asset_id ?? null,
      side: trade.side as TradeSide,
      price: trade.price,
      size: trade.size,
      status: trade.status ?? null,
      matchTime: trade.match_time ?? null,
      lastUpdate: trade.last_update ?? null,
      outcome: trade.outcome ?? null,
      transactionHash: trade.transaction_hash ?? null,
      traderSide: trade.trader_side ?? "TAKER",
      rawJson: JSON.stringify(trade),
    };
  }

  const makerOrder = trade.maker_orders.find((entry) => entry.order_id === clobOrderId);
  if (!makerOrder) {
    return null;
  }

  return {
    clobTradeId: trade.id,
    market: trade.market ?? null,
    assetId: trade.asset_id ?? null,
    side: makerOrder.side as TradeSide,
    price: makerOrder.price || trade.price,
    size: makerOrder.matched_amount || trade.size,
    status: trade.status ?? null,
    matchTime: trade.match_time ?? null,
    lastUpdate: trade.last_update ?? null,
    outcome: makerOrder.outcome ?? trade.outcome ?? null,
    transactionHash: trade.transaction_hash ?? null,
    traderSide: "MAKER",
    rawJson: JSON.stringify(trade),
  };
}
