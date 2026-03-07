import assert from "node:assert/strict";
import test from "node:test";
import { compactAddress, summarizeEventFields } from "../src/tui";

test("compactAddress shortens long hex strings", () => {
  assert.equal(compactAddress("0x1234567890abcdef1234567890abcdef12345678"), "0x1234...5678");
  assert.equal(compactAddress("0x1234"), "0x1234");
});

test("summarizeEventFields formats leader trades and order updates", () => {
  assert.equal(
    summarizeEventFields("leader_trade.observed", {
      side: "BUY",
      title: "Will BTC close above 100k",
      outcome: "YES",
      size: "12",
      price: "0.43",
    }),
    "BUY Will BTC close above 100k / YES size 12 @ 0.43"
  );

  assert.equal(
    summarizeEventFields("follower_order.updated", {
      clobOrderId: "0xabcdef1234567890",
      status: "partially_filled",
      matchedSize: "3",
      originalSize: "10",
    }),
    "order 0xabcdef...567890 status=partially_filled matched=3/10"
  );
});

test("summarizeEventFields falls back for non-tty warning", () => {
  assert.equal(
    summarizeEventFields("tui.disabled_non_tty", {}),
    "stdout is not a TTY; falling back to JSON logs"
  );
});

test("summarizeEventFields includes leader websocket disconnect context", () => {
  assert.equal(
    summarizeEventFields("websocket.disconnected", {
      code: 1006,
      reason: "heartbeat_timeout",
      source: "heartbeat_timeout",
      reconnectInMs: 1000,
    }),
    "leader websocket disconnected code=1006 reason=heartbeat_timeout source=heartbeat_timeout reconnectInMs=1000"
  );
});
