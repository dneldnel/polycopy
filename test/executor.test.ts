import assert from "node:assert/strict";
import test from "node:test";
import { type OrderType, type Side } from "@polymarket/clob-client";
import { normalizeLimitPriceUp, resolveOrderSize, submitLeaderPriceLimitOrder } from "../src/executor";

test("normalizeLimitPriceUp rounds prices up to the next valid tick", () => {
  assert.equal(normalizeLimitPriceUp("0.77384", "0.01"), "0.78");
  assert.equal(normalizeLimitPriceUp("0.74623423432", "0.001"), "0.747");
  assert.equal(normalizeLimitPriceUp("0.75", "0.01"), "0.75");
  assert.equal(normalizeLimitPriceUp(".75", "0.01"), "0.75");
});

test("resolveOrderSize supports fixed and multiplier modes", () => {
  assert.equal(resolveOrderSize("12", "fixed", 5, 1), "5");
  assert.equal(resolveOrderSize("12", "multiplier", 5, 0.5), "6");
  assert.equal(resolveOrderSize("12", "multiplier", 5, 1.25), "15");
});

test("submitLeaderPriceLimitOrder sends the normalized price to CLOB", async () => {
  const calls: Array<{
    userOrder: { tokenID: string; side: Side; price: number; size: number };
    options: { tickSize: string; negRisk: boolean };
    orderType: OrderType;
  }> = [];

  const client = {
    async getTickSize() {
      return "0.01";
    },
    async getNegRisk() {
      return false;
    },
    async createAndPostOrder(
      userOrder: { tokenID: string; side: Side; price: number; size: number },
      options: { tickSize: string; negRisk: boolean },
      orderType: OrderType
    ) {
      calls.push({ userOrder, options, orderType });
      return {
        success: true,
        orderID: "order-1",
        status: "live",
      };
    },
  };

  const result = await submitLeaderPriceLimitOrder(client as never, {
    assetId: "asset-1",
    side: "BUY",
    price: "0.77384",
    size: "5",
  });

  assert.deepEqual(calls, [
    {
      userOrder: {
        tokenID: "asset-1",
        side: "BUY",
        price: 0.78,
        size: 5,
      },
      options: {
        tickSize: "0.01",
        negRisk: false,
      },
      orderType: "GTC",
    },
  ]);
  assert.deepEqual(result, {
    ok: true,
    orderId: "order-1",
    status: "live",
    price: "0.78",
    size: "5",
  });
});

test("submitLeaderPriceLimitOrder rejects normalized prices outside market bounds", async () => {
  const client = {
    async getTickSize() {
      return "0.01";
    },
    async getNegRisk() {
      return false;
    },
    async createAndPostOrder() {
      throw new Error("should not submit");
    },
  };

  const result = await submitLeaderPriceLimitOrder(client as never, {
    assetId: "asset-1",
    side: "SELL",
    price: "0.999",
    size: "1",
  });

  assert.deepEqual(result, {
    ok: false,
    reason: "invalid_normalized_limit_price",
    price: "1",
    size: "1",
  });
});
