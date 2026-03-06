import { OrderType, Side, type ClobClient } from "@polymarket/clob-client";
import type { SubmitLimitOrderInput, SubmitLimitOrderResult } from "./types";

function parsePositiveNumber(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
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

export async function submitLeaderPriceLimitOrder(
  client: ClobClient,
  input: SubmitLimitOrderInput
): Promise<SubmitLimitOrderResult> {
  const price = parsePositiveNumber(input.price);
  const size = parsePositiveNumber(input.size);
  if (price == null || size == null) {
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
      price: input.price,
      size: input.size,
    };
  }

  return {
    ok: false,
    reason: String(response.errorMsg || response.status || "order_submission_failed"),
    price: input.price,
    size: input.size,
  };
}
