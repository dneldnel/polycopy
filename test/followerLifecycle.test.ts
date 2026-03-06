import assert from "node:assert/strict";
import test from "node:test";
import { extractFollowerFillFromTrade, normalizeFollowerOrderStatus } from "../src/followerLifecycle";

test("normalizeFollowerOrderStatus maps live, partial, filled, and cancelled states", () => {
  assert.equal(normalizeFollowerOrderStatus("LIVE", "0", "10"), "live");
  assert.equal(normalizeFollowerOrderStatus("MATCHED", "3", "10"), "partially_filled");
  assert.equal(normalizeFollowerOrderStatus("MATCHED", "10", "10"), "filled");
  assert.equal(normalizeFollowerOrderStatus("CANCELED", "0", "10"), "cancelled");
});

test("extractFollowerFillFromTrade supports taker and maker matches", () => {
  const trade = {
    id: "trade-1",
    taker_order_id: "taker-order",
    market: "condition-1",
    asset_id: "asset-1",
    side: "BUY" as const,
    size: "4",
    price: "0.41",
    status: "MINED",
    match_time: "1710000000",
    last_update: "1710000001",
    outcome: "YES",
    maker_orders: [
      {
        order_id: "maker-order",
        matched_amount: "2",
        price: "0.42",
        outcome: "YES",
        side: "SELL" as const,
      },
    ],
    transaction_hash: "0xtrade",
    trader_side: "TAKER" as const,
  };

  const takerFill = extractFollowerFillFromTrade("taker-order", trade);
  assert.deepEqual(
    takerFill && {
      clobTradeId: takerFill.clobTradeId,
      side: takerFill.side,
      size: takerFill.size,
      traderSide: takerFill.traderSide,
    },
    {
      clobTradeId: "trade-1",
      side: "BUY",
      size: "4",
      traderSide: "TAKER",
    }
  );

  const makerFill = extractFollowerFillFromTrade("maker-order", trade);
  assert.deepEqual(
    makerFill && {
      clobTradeId: makerFill.clobTradeId,
      side: makerFill.side,
      size: makerFill.size,
      traderSide: makerFill.traderSide,
    },
    {
      clobTradeId: "trade-1",
      side: "SELL",
      size: "2",
      traderSide: "MAKER",
    }
  );
});
