function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function compactId(value: string, head = 8, tail = 6): string {
  if (value.length <= head + tail + 3) {
    return value;
  }
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function summarizePairs(fields: Record<string, unknown>, keys: string[]): string {
  const parts = keys
    .map((key) => {
      const value = fields[key];
      if (value == null) {
        return null;
      }
      if (typeof value === "number" || typeof value === "boolean") {
        return `${key}=${String(value)}`;
      }
      const text = asString(value);
      return text ? `${key}=${text}` : null;
    })
    .filter((value): value is string => value != null);
  return parts.join(" ");
}

export function summarizeEventFields(event: string, fields: Record<string, unknown>): string {
  const assetId = asString(fields.assetId) ?? asString(fields.market) ?? "unknown-asset";
  const title = asString(fields.title);
  const outcome = asString(fields.outcome);
  const marketLabel = oneLine([title, outcome].filter(Boolean).join(" / ")) || assetId;
  const side = asString(fields.side) ?? "?";
  const size = asString(fields.size) ?? asString(fields.matchedSize) ?? "?";
  const price = asString(fields.price) ?? "?";
  const reason = asString(fields.reason) ?? asString(fields.statusReason);
  const status = asString(fields.status);

  switch (event) {
    case "app.started":
      return summarizePairs(fields, ["leaderWallet", "followerWallet", "simulationMode", "sqlitePath"]);
    case "app.stopping":
      return summarizePairs(fields, ["signal", "leaderTrades", "followerOrders", "followerFills", "runtimeEvents"]);
    case "websocket.connected":
      return "leader websocket connected";
    case "websocket.disconnected":
      return "leader websocket disconnected";
    case "user_websocket.connected":
      return "user websocket connected";
    case "user_websocket.disconnected":
      return "user websocket disconnected";
    case "leader_trade.observed":
      return `${side} ${marketLabel} size ${size} @ ${price}`;
    case "leader_trade.duplicate_ignored":
      return summarizePairs(fields, ["tradeId"]);
    case "leader_trade.invalid_payload":
      return "invalid leader trade payload";
    case "follower_order.submitted":
      return `${side} ${assetId} size ${size} @ ${price} order ${compactId(
        asString(fields.clobOrderId) ?? "unknown"
      )}${status ? ` ${status}` : ""}`;
    case "follower_order.submission_failed":
      return `${side} ${assetId} size ${size} @ ${price}${reason ? ` failed ${reason}` : " failed"}`;
    case "follower_order.invalid_size":
      return summarizePairs(fields, ["tradeId", "size", "leaderSize", "orderSizeMode", "fixedOrderSize", "sizeMultiplier"]);
    case "follower_order.simulated":
      return `${side} ${assetId} size ${size} @ ${price} simulated`;
    case "follower_order.skipped_user_ws_disconnected":
      return `${side} ${assetId} size ${size} @ ${price} skipped user websocket disconnected`;
    case "follower_order.updated":
      return `order ${compactId(asString(fields.clobOrderId) ?? "unknown")} status=${
        status ?? "unknown"
      } matched=${asString(fields.matchedSize) ?? "?"}/${asString(fields.originalSize) ?? "?"}`;
    case "follower_fill.recorded":
      return `${side} ${assetId} size ${size} @ ${price} trade ${compactId(
        asString(fields.clobTradeId) ?? "unknown"
      )}`;
    case "user_websocket.invalid_order_payload":
      return "invalid user order payload";
    case "user_websocket.invalid_trade_payload":
      return "invalid user trade payload";
    case "user_websocket.process_failed":
    case "leader_trade.process_failed":
    case "app.crashed":
      return reason ?? summarizePairs(fields, ["messageType"]);
    case "tui.disabled_non_tty":
      return "stdout is not a TTY; falling back to JSON logs";
    default: {
      const compact = summarizePairs(fields, Object.keys(fields).slice(0, 4));
      return compact || "no details";
    }
  }
}
