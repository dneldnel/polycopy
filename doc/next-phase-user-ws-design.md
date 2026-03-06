# Next Phase Design: User Websocket

This file captures the intended next step after the current minimal runtime.

## Goal

Replace polling-based fill tracking with authenticated Polymarket CLOB user websocket updates.

## Why

The minimal runtime already records:

- leader filled trades
- follower order submissions
- websocket lifecycle events

The missing piece is follower order lifecycle and fill lifecycle:

- `submitted`
- `live`
- `partially_filled`
- `filled`
- `cancelled`
- `rejected`
- trade-level fills

The correct source for this is not the leader activity websocket. It is the authenticated CLOB `user` websocket channel.

## Planned Data Flow

1. Keep the existing leader websocket for `leader_trades`.
2. Add a second websocket client for authenticated follower updates.
3. Subscribe that client to relevant leader/follower markets.
4. When a follower order is submitted, associate:
   - `leader_trade_id`
   - `clob_order_id`
   - `condition_id`
   - `asset_id`
5. Consume `order` events from the user channel:
   - update `follower_orders.status`
   - update `original_size`
   - update `matched_size`
   - update `associate_trade_ids`
6. Consume `trade` events from the user channel:
   - insert one row into `follower_fills`
   - update `follower_orders.matched_size`
   - mark `follower_orders.status` as `partially_filled` or `filled`
7. Keep a very low-frequency reconciliation poll only as fallback, not as primary tracking.

## Expected Database Usage

Tables that become active in this phase:

- `leader_trades`
- `follower_orders`
- `follower_fills`
- `runtime_events`

## Minimal Implementation Plan

1. Add `userOrderStream.ts`
2. Add authenticated websocket connection bootstrap
3. Add subscription state keyed by market / condition id
4. Parse `order` updates into `follower_orders`
5. Parse `trade` updates into `follower_fills`
6. Add reconnect handling and resubscription

## Design Boundary

This phase should still remain minimal:

- no web frontend
- no Turso sync
- no generalized strategy engine
- no heavy monitor rewrite
