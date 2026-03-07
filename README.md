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

## Environment

The app auto-loads a `.env` file from the project root via `dotenv`. You do not need to `export` every variable manually.

Use [`.env.example`](/Volumes/jd/projects/polymarket/polycopy-v2/.env.example) as the template for your local `.env`. The real `.env` is ignored by git.

Minimum required variables:

```bash
LEADER_WALLET_ADDRESS=0xLEADER_PROXY_WALLET
FOLLOWER_WALLET_ADDRESS=0xYOUR_FOLLOWER_PROFILE_ADDRESS
SIMULATION_MODE=true
```

Recommended proxy wallet setup:

```bash
LEADER_WALLET_ADDRESS=0xLEADER_PROXY_WALLET
FOLLOWER_WALLET_ADDRESS=0xYOUR_FOLLOWER_PROFILE_ADDRESS

SIMULATION_MODE=false

ORDER_SIZE_MODE=fixed
FIXED_ORDER_SIZE=5
SIZE_MULTIPLIER=1

WALLET_PRIVATE_KEY=0xYOUR_EOA_PRIVATE_KEY
SIGNATURE_TYPE=POLY_PROXY
PROXY_WALLET_ADDRESS=0xYOUR_PROXY_WALLET

CLOB_HTTP_URL=https://clob.polymarket.com
CHAIN_ID=137
POLYCOPY_V2_DB_PATH=./data/polycopy-v2.sqlite
POLYCOPY_V2_TUI=true

# Optional explicit API creds
# POLYMARKET_API_KEY=...
# POLYMARKET_API_SECRET=...
# POLYMARKET_API_PASSPHRASE=...
```

Notes:

- `LEADER_WALLET_ADDRESS` should usually be the leader proxy wallet, because the public activity stream is matched on `proxyWallet`
- `FOLLOWER_WALLET_ADDRESS` is your follower profile / funder wallet
- `PROXY_WALLET_ADDRESS` is your proxy wallet
- `WALLET_PRIVATE_KEY` is still your signing EOA private key, not the proxy address
- `SIGNATURE_TYPE` supports `EOA`, `POLY_PROXY`, and `POLY_GNOSIS_SAFE`

Order sizing modes:

- `ORDER_SIZE_MODE=fixed`: always place `FIXED_ORDER_SIZE`
- `ORDER_SIZE_MODE=multiplier`: place `leader_size * SIZE_MULTIPLIER`
- Defaults are `ORDER_SIZE_MODE=fixed` and `FIXED_ORDER_SIZE=5`

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

After `npm run db:init`, start with a dry run first:

```bash
npm run dev
```

Dry run with console TUI:

```bash
npm run dev:tui
```

Format the latest runtime events from SQLite:

```bash
npm run events
```

Follow new runtime events as they are written:

```bash
npm run events -- --follow
```

Watch only the latest leader trade heard by the public websocket:

```bash
npm run watch:leader
```

Optional wallet override:

```bash
npm run watch:leader -- 0xLEADER_PROXY_WALLET
```

Live mode:

```bash
# set SIMULATION_MODE=false in .env first
npm run dev
```

When `POLYCOPY_V2_TUI=true`, the process switches from raw JSON stdout logs to a full-screen terminal dashboard showing websocket status, aggregate counts, recent leader trades, recent follower order activity, recent fills, and recent runtime events. Press `q` or `Ctrl+C` to stop.

The TUI redraw cadence is 2 seconds, so bursty event traffic is batched into a steadier screen refresh.

`npm run watch:leader` is a lighter console watcher. It listens only to the public `activity/trades` websocket and redraws the terminal with the newest leader trade it sees. It does not backfill history.

`npm run events` reads the `runtime_events` table from the configured SQLite database and prints a formatted view of each event. Use `--follow` to tail new rows.

## Behavior

- leader websocket messages are filtered to `LEADER_WALLET_ADDRESS`
- each unique leader trade is inserted once
- follower orders are submitted as `GTC` limit orders at the leader trade price only while the authenticated user websocket is connected
- order size is `FIXED_ORDER_SIZE` when `ORDER_SIZE_MODE=fixed`
- order size is `leader_size * SIZE_MULTIPLIER` when `ORDER_SIZE_MODE=multiplier`
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
