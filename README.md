# Polycopy V2

Minimal Polymarket copy-trading runtime focused on one path:

- watch one leader wallet for filled trades
- save leader trades into SQLite
- immediately place the same limit order at the leader price
- save follower order submissions into SQLite
- save runtime events such as websocket connect/disconnect into SQLite

This project intentionally does not include the old monitor / recovery / sync layers.

## Status

Current scope:

- realtime leader trade intake
- exact-price follower limit order submission
- authenticated user websocket order / trade tracking
- SQLite persistence for leader trades, follower orders, follower fills, and runtime events

Not included yet:

- order-status polling
- API backfill after disconnect
- web UI
- Turso sync
- advanced strategy filters

## Install

```bash
cd /Volumes/jd/projects/polymarket/polycopy-v2
npm install
```

## Required Exports

```bash
export LEADER_WALLET_ADDRESS="0xLEADER_PROXY_OR_WALLET"
export FOLLOWER_WALLET_ADDRESS="0xYOUR_FOLLOWER_OR_PROXY_WALLET"
export WALLET_PRIVATE_KEY="0xYOUR_EOA_PRIVATE_KEY"

export SIGNATURE_TYPE="EOA"
export CLOB_HTTP_URL="https://clob.polymarket.com"
export CHAIN_ID="137"
```

If the follower uses a proxy wallet:

```bash
export SIGNATURE_TYPE="POLY_GNOSIS_SAFE"
export PROXY_WALLET_ADDRESS="0xYOUR_PROXY_WALLET"
```

Optional:

```bash
export POLYCOPY_V2_DB_PATH="$PWD/data/polycopy-v2.sqlite"
export SIZE_MULTIPLIER="1"
export SIMULATION_MODE="true"

# Optional explicit API creds
# export POLYMARKET_API_KEY="..."
# export POLYMARKET_API_SECRET="..."
# export POLYMARKET_API_PASSPHRASE="..."
```

## Database

Default SQLite path:

- `data/polycopy-v2.sqlite`

Schema tables:

- `leader_trades`
- `follower_orders`
- `follower_fills`
- `runtime_events`

Create the database file and schema:

```bash
npm run db:init
```

## Run

Dry run first:

```bash
export SIMULATION_MODE="true"
npm run dev
```

Live mode:

```bash
export SIMULATION_MODE="false"
npm run dev
```

## Behavior

- leader websocket messages are filtered to `LEADER_WALLET_ADDRESS`
- each unique leader trade is inserted once
- follower orders are submitted as `GTC` limit orders at the leader trade price only while the authenticated user websocket is connected
- order size is `leader_size * SIZE_MULTIPLIER`
- websocket connect / disconnect events are written into `runtime_events`
- authenticated `clob_user` websocket events update `follower_orders` and populate `follower_fills`

## DB Note

If websocket disconnects, the current runtime writes a row into `runtime_events`.

Useful runtime event types include:

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
- `follower_order.skipped_user_ws_disconnected`

## Design Docs

- [current-design.md](/Volumes/jd/projects/polymarket/polycopy-v2/doc/current-design.md)
- [next-phase-user-ws-design.md](/Volumes/jd/projects/polymarket/polycopy-v2/doc/next-phase-user-ws-design.md)

## Main Files

- [main.ts](/Volumes/jd/projects/polymarket/polycopy-v2/src/main.ts)
- [store.ts](/Volumes/jd/projects/polymarket/polycopy-v2/src/store.ts)
- [leaderStream.ts](/Volumes/jd/projects/polymarket/polycopy-v2/src/leaderStream.ts)
- [userOrderStream.ts](/Volumes/jd/projects/polymarket/polycopy-v2/src/userOrderStream.ts)
- [executor.ts](/Volumes/jd/projects/polymarket/polycopy-v2/src/executor.ts)
