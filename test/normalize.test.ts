import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLeaderTradePayload } from "../src/normalize";

test("normalizeLeaderTradePayload returns a normalized leader trade", () => {
  const trade = normalizeLeaderTradePayload({
    proxyWallet: "0x1111111111111111111111111111111111111111",
    asset: "asset-1",
    side: "buy",
    price: "0.42",
    size: "10",
    timestamp: 1710000000,
    transactionHash: "0xabc",
    outcome: "YES",
    title: "Test Market",
  });

  assert.ok(trade);
  assert.equal(trade?.leaderWallet, "0x1111111111111111111111111111111111111111");
  assert.equal(trade?.side, "BUY");
  assert.equal(trade?.price, "0.42");
  assert.equal(trade?.size, "10");
  assert.equal(trade?.activityTimestamp, 1710000000000);
});

test("normalizeLeaderTradePayload rejects incomplete payloads", () => {
  const trade = normalizeLeaderTradePayload({
    proxyWallet: "0x1111111111111111111111111111111111111111",
    asset: "asset-1",
  });

  assert.equal(trade, null);
});
