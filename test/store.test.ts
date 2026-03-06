import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Store } from "../src/store";

test("store inserts leader trades once and persists follower orders/fills", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "polycopy-v2-"));
  const dbPath = path.join(tempDir, "test.sqlite");
  const store = new Store(dbPath);

  try {
    const observed = store.observeLeaderTrade({
      leaderWallet: "0x1111111111111111111111111111111111111111",
      tradeId: "trade-1",
      transactionHash: "0xabc",
      activityTimestamp: 1710000000000,
      receivedAt: new Date().toISOString(),
      assetId: "asset-1",
      conditionId: null,
      side: "BUY",
      price: "0.42",
      size: "10",
      slug: null,
      eventSlug: null,
      outcome: "YES",
      title: "Test Market",
      endDate: null,
      rawPayload: {},
      source: "test",
    });

    const duplicate = store.observeLeaderTrade({
      leaderWallet: "0x1111111111111111111111111111111111111111",
      tradeId: "trade-1",
      transactionHash: "0xabc",
      activityTimestamp: 1710000000000,
      receivedAt: new Date().toISOString(),
      assetId: "asset-1",
      conditionId: null,
      side: "BUY",
      price: "0.42",
      size: "10",
      slug: null,
      eventSlug: null,
      outcome: "YES",
      title: "Test Market",
      endDate: null,
      rawPayload: {},
      source: "test",
    });

    assert.equal(observed.isNew, true);
    assert.equal(duplicate.isNew, false);

    const order = store.insertFollowerOrder({
      leaderTradeId: observed.record.id,
      followerWallet: "0x2222222222222222222222222222222222222222",
      clobOrderId: "order-1",
      conditionId: "condition-1",
      assetId: "asset-1",
      side: "BUY",
      limitPrice: "0.42",
      requestedSize: "10",
      originalSize: "10",
      matchedSize: "0",
      status: "submitted",
      statusReason: "submitted",
    });

    assert.equal(store.countLeaderTrades(), 1);
    assert.equal(store.countFollowerOrders(), 1);
    assert.equal(order.conditionId, "condition-1");

    store.insertRuntimeEvent("warn", "websocket.disconnected", {
      leaderWallet: "0x1111111111111111111111111111111111111111",
    });
    assert.equal(store.countRuntimeEvents(), 1);

    const insertedFill = store.insertFollowerFill({
      followerOrderId: order.id,
      clobTradeId: "fill-1",
      market: "market-1",
      assetId: "asset-1",
      side: "BUY",
      price: "0.42",
      size: "3",
      status: "matched",
      matchTime: new Date().toISOString(),
      lastUpdate: new Date().toISOString(),
      outcome: "YES",
      transactionHash: "0xfill",
      traderSide: "TAKER",
      rawJson: "{\"id\":\"fill-1\"}",
    });

    assert.equal(insertedFill, true);
    assert.equal(store.countFollowerFills(), 1);
    assert.equal(store.sumFollowerFillSize(order.id), 3);

    const observed2 = store.observeLeaderTrade({
      leaderWallet: "0x1111111111111111111111111111111111111111",
      tradeId: "trade-2",
      transactionHash: "0xdef",
      activityTimestamp: 1710000001000,
      receivedAt: new Date().toISOString(),
      assetId: "asset-2",
      conditionId: "condition-2",
      side: "SELL",
      price: "0.55",
      size: "5",
      slug: null,
      eventSlug: null,
      outcome: "NO",
      title: "Second Market",
      endDate: null,
      rawPayload: {},
      source: "test",
    });

    const order2 = store.insertFollowerOrder({
      leaderTradeId: observed2.record.id,
      followerWallet: "0x2222222222222222222222222222222222222222",
      clobOrderId: "order-2",
      conditionId: "condition-2",
      assetId: "asset-2",
      side: "SELL",
      limitPrice: "0.55",
      requestedSize: "5",
      originalSize: "5",
      matchedSize: "0",
      status: "submitted",
      statusReason: "submitted",
    });

    const insertedSharedTrade = store.upsertFollowerFill({
      followerOrderId: order2.id,
      clobTradeId: "fill-1",
      market: "market-2",
      assetId: "asset-2",
      side: "SELL",
      price: "0.55",
      size: "1",
      status: "matched",
      matchTime: new Date().toISOString(),
      lastUpdate: new Date().toISOString(),
      outcome: "NO",
      transactionHash: "0xfill2",
      traderSide: "MAKER",
      rawJson: "{\"id\":\"fill-1\",\"order\":\"order-2\"}",
    });

    assert.equal(insertedSharedTrade, true);
    assert.equal(store.countFollowerFills(), 2);
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
