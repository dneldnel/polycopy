# Current Design

This file describes the currently implemented minimal runtime in `polycopy-v2`.

## Goal

Track one leader wallet, detect filled leader trades, immediately place the same-price follower limit order, and persist the full audit trail into SQLite.

## Current Scope

Implemented:

- leader trade intake from websocket activity stream
- leader trade normalization and deduplication
- SQLite persistence for leader trades
- follower `GTC` limit order submission at the leader trade price
- authenticated user websocket order / trade subscription
- SQLite persistence for follower order submissions and lifecycle updates
- SQLite persistence for follower fills
- SQLite persistence for runtime events such as:
  - `app.started`
  - `app.stopping`
  - `app.crashed`
  - `websocket.connected`
  - `websocket.disconnected`
  - `user_websocket.connected`
  - `user_websocket.disconnected`
  - `leader_trade.observed`
  - `follower_order.submitted`
  - `follower_order.submission_failed`
  - `follower_order.updated`
  - `follower_fill.recorded`

Not implemented in the current runtime:

- order-status polling
- disconnect backfill
- market filters
- web UI

## Main Runtime Path

1. `leaderStream.ts` listens to Polymarket realtime activity trades.
2. Messages are filtered to `LEADER_WALLET_ADDRESS`.
3. `normalize.ts` converts the payload into one normalized leader trade.
4. `store.ts` inserts that trade into `leader_trades`.
5. `userOrderStream.ts` maintains an authenticated `clob_user` subscription for follower order/trade updates.
6. `executor.ts` submits a follower `GTC` limit order at the exact leader price when the user websocket is connected.
7. `store.ts` inserts the follower submission into `follower_orders`.
8. `userOrderStream.ts` updates `follower_orders` from `order` events and inserts `follower_fills` from `trade` events.
9. `store.ts` inserts runtime audit rows into `runtime_events`.

## SQLite Tables

Current active tables:

- `leader_trades`
- `follower_orders`
- `follower_fills`
- `runtime_events`

## Notes

- websocket disconnects are stored in `runtime_events`, so they are visible in the database even without a monitor process.
- live order submission is gated on the user websocket being connected, so copied orders stay trackable without polling as the primary source.
