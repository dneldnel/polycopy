import type { ActivityTradePayload, NormalizedLeaderTrade, TradeSide } from "./types";

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function asNumericString(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const trimmed = value.trim();
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? trimmed : null;
  }
  return null;
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 1e12 ? value : Math.trunc(value * 1000);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed >= 1e12 ? parsed : Math.trunc(parsed * 1000);
    }
  }
  return 0;
}

function normalizeSide(value: unknown): TradeSide | null {
  const normalized = asString(value)?.toUpperCase();
  return normalized === "BUY" || normalized === "SELL" ? normalized : null;
}

function buildTradeId(
  transactionHash: string | null,
  activityTimestamp: number,
  assetId: string,
  side: TradeSide,
  price: string,
  size: string
): string {
  return [transactionHash ?? "nohash", String(activityTimestamp), assetId, side, price, size].join(":");
}

export function normalizeLeaderTradePayload(payload: ActivityTradePayload, source = "websocket"): NormalizedLeaderTrade | null {
  const leaderWallet = asString(payload.proxyWallet)?.toLowerCase() ?? null;
  const assetId = asString(payload.asset);
  const side = normalizeSide(payload.side);
  const price = asNumericString(payload.price);
  const size = asNumericString(payload.size);
  if (!leaderWallet || !assetId || !side || !price || !size) {
    return null;
  }

  const transactionHash = asString(payload.transactionHash)?.toLowerCase() ?? null;
  const activityTimestamp = normalizeTimestamp(payload.timestamp);

  return {
    leaderWallet,
    tradeId: buildTradeId(transactionHash, activityTimestamp, assetId, side, price, size),
    transactionHash,
    activityTimestamp,
    receivedAt: new Date().toISOString(),
    assetId,
    conditionId: asString(payload.conditionId),
    side,
    price,
    size,
    slug: asString(payload.slug),
    eventSlug: asString(payload.eventSlug),
    outcome: asString(payload.outcome),
    title: asString(payload.title),
    endDate: asString(payload.endDate),
    rawPayload: payload,
    source,
  };
}
