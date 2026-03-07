import { OrderType, Side, type ClobClient } from "@polymarket/clob-client";
import type { OrderSizeModeName } from "./types";
import type { SubmitLimitOrderInput, SubmitLimitOrderResult } from "./types";

const DECIMAL_PATTERN = /^(?:\d+\.?\d*|\.\d+)$/;

function parsePositiveNumber(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function normalizePositiveDecimal(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "" || !DECIMAL_PATTERN.test(trimmed)) {
    return null;
  }

  const normalized = trimmed.startsWith(".") ? `0${trimmed}` : trimmed;
  const [rawWhole, rawFraction = ""] = normalized.split(".");
  const whole = rawWhole.replace(/^0+(?=\d)/, "") || "0";
  const fraction = rawFraction.replace(/0+$/, "");
  const canonical = fraction === "" ? whole : `${whole}.${fraction}`;
  return canonical === "0" ? null : canonical;
}

function decimalPlaces(value: string): number {
  const decimalIndex = value.indexOf(".");
  return decimalIndex === -1 ? 0 : value.length - decimalIndex - 1;
}

function toScaledInteger(value: string, scaleDigits: number): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(`${whole}${fraction.padEnd(scaleDigits, "0")}`);
}

function fromScaledInteger(value: bigint, scaleDigits: number): string {
  const digits = value.toString().padStart(scaleDigits + 1, "0");
  if (scaleDigits === 0) {
    return digits;
  }

  const whole = digits.slice(0, -scaleDigits) || "0";
  const fraction = digits.slice(-scaleDigits).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

export function normalizeLimitPriceUp(price: string, tickSize: string): string | null {
  const normalizedPrice = normalizePositiveDecimal(price);
  const normalizedTickSize = normalizePositiveDecimal(tickSize);
  if (!normalizedPrice || !normalizedTickSize) {
    return null;
  }

  const scaleDigits = Math.max(decimalPlaces(normalizedPrice), decimalPlaces(normalizedTickSize));
  const priceUnits = toScaledInteger(normalizedPrice, scaleDigits);
  const tickUnits = toScaledInteger(normalizedTickSize, scaleDigits);
  if (tickUnits <= 0n) {
    return null;
  }

  const normalizedUnits = ((priceUnits + tickUnits - 1n) / tickUnits) * tickUnits;
  return fromScaledInteger(normalizedUnits, scaleDigits);
}

export function scaleOrderSize(size: string, multiplier: number): string | null {
  const parsed = parsePositiveNumber(size);
  if (parsed == null) {
    return null;
  }
  const scaled = parsed * multiplier;
  if (!Number.isFinite(scaled) || scaled <= 0) {
    return null;
  }
  return String(scaled);
}

export function resolveOrderSize(
  leaderSize: string,
  mode: OrderSizeModeName,
  fixedOrderSize: number,
  sizeMultiplier: number
): string | null {
  if (mode === "fixed") {
    return parsePositiveNumber(String(fixedOrderSize)) != null ? String(fixedOrderSize) : null;
  }
  return scaleOrderSize(leaderSize, sizeMultiplier);
}

export async function submitLeaderPriceLimitOrder(
  client: ClobClient,
  input: SubmitLimitOrderInput
): Promise<SubmitLimitOrderResult> {
  const size = parsePositiveNumber(input.size);
  if (size == null) {
    return {
      ok: false,
      reason: "invalid_limit_order_input",
      price: input.price,
      size: input.size,
    };
  }

  const [tickSize, negRisk] = await Promise.all([
    client.getTickSize(input.assetId),
    client.getNegRisk(input.assetId),
  ]);

  const normalizedPrice = normalizeLimitPriceUp(input.price, tickSize);
  const price = normalizedPrice ? parsePositiveNumber(normalizedPrice) : null;
  const minimumPrice = parsePositiveNumber(tickSize);
  if (
    normalizedPrice == null ||
    price == null ||
    minimumPrice == null ||
    price < minimumPrice ||
    price > 1 - minimumPrice
  ) {
    return {
      ok: false,
      reason: "invalid_normalized_limit_price",
      price: normalizedPrice ?? input.price,
      size: input.size,
    };
  }

  const response = await client.createAndPostOrder(
    {
      tokenID: input.assetId,
      side: input.side === "BUY" ? Side.BUY : Side.SELL,
      price,
      size,
    },
    { tickSize, negRisk },
    OrderType.GTC,
    false,
    false
  );

  if (response.success && response.orderID) {
    return {
      ok: true,
      orderId: response.orderID,
      status: String(response.status || "submitted").toLowerCase(),
      price: normalizedPrice,
      size: input.size,
    };
  }

  return {
    ok: false,
    reason: String(response.errorMsg || response.status || "order_submission_failed"),
    price: normalizedPrice,
    size: input.size,
  };
}
