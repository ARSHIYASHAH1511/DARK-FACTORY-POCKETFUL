# Stage 4: Multi-currency FX, fee routing and escrow holds

This stage is stage 3 (bitemporal, immutable reversals, idempotent WAL writes) plus integer basis-point FX, fees, and a three-state escrow. It has zero npm dependencies and needs Node 24 or later.

```sh
node src/test.ts      # 82 tests, incl. a 20-worker capture/release race
node src/server.ts    # HTTP on :3005, DB at $LEDGER_DB (default data/stage-4.db)
```

## System accounts (multi-currency, `currency = '***'`, reserved case-insensitively)
| id | role | may go negative |
|---|---|---|
| `0000-0000` | System Reserve: issues money (mint, pool funding) | **yes (only this one)** |
| `9999-FEE` | collects fees in the source currency | no |
| `FX-POOL` | market maker: receives source currency, pays target currency | no; fund it first with `POST /fund-pool` |
| `HOLD-ESCROW` | holds escrowed funds | no |

## Basis points (I10)
10000 bps = 1.0000. All arithmetic is bigint.

```
fee       = ceil(amount * fee_bps / 10000)   # rounds UP: a non-zero policy always charges >= 1, so splitting cannot dodge it
net       = amount - fee
converted = floor(net * rate_bps / 10000)    # rounds DOWN: the dust stays in FX-POOL
```

## Server-side policy: clients cannot choose rates or fees
- **Fees** come from operator configuration: `TRANSFER_FEE_BPS` (default 10) and `FX_FEE_BPS` (default 50), each 0..10000. Every transfer and FX routes the fee to `9999-FEE` automatically.
- **FX rates** live in the append-only `fx_rates` table, and the latest row per pair wins. Only the operator sets them: `POST /admin/fx-rates {base, quote, rate_bps}` with `X-Operator-Token`. That route is disabled unless the server has `OPERATOR_TOKEN` set. A rate is refused if, combined with the inverse pair, a round trip could create value (`rate_ab * rate_ba > 10000²`).
- **Pool liquidity** is operator-only too: `POST /admin/fund-pool {currency, amount}`.
- Clients may send `rate_bps` or `fee_bps` only as **guards**. If either differs from the server value, the request gets `409 POLICY_MISMATCH` and writes 0 rows. A pair with no configured rate gets `409 NO_FX_RATE`.
- `GET /fx/rates`, `GET /fees` and `GET /fx/quote?from_currency=&to_currency=&amount=` preview the current policy without writing anything.

Legs:
- **Transfer:** payer −amount, payee +net, `9999-FEE` +fee.
- **FX:** payer −amount (A), `9999-FEE` +fee (A), `FX-POOL` +net (A), `FX-POOL` −converted (B), payee +converted (B).

Zero-sum holds exactly per currency. If the pool can't pay out the target currency, the request gets `409 INSUFFICIENT_FUNDS`.

## Escrow state machine (I9)
```
HELD ──capture{to}──▶ CAPTURED   (terminal)
  └───release──────▶ RELEASED   (terminal)
```

- **hold:** payer → `HOLD-ESCROW`.
- **capture:** `HOLD-ESCROW` → `to`. The `to` account must use the same currency, otherwise `CURRENCY_MISMATCH`.
- **release:** `HOLD-ESCROW` → payer.
- The state read and the transition both run under the same `BEGIN IMMEDIATE` lock. As a backstop, `hold_events` has `UNIQUE(hold_id) WHERE state='HELD'` and `UNIQUE(hold_id) WHERE state IN ('CAPTURED','RELEASED')`, and it is append-only through triggers.
- Errors:
  - `404 UNKNOWN_HOLD`: no such hold.
  - `409 HOLD_NOT_ACTIVE`: the hold is already terminal.
- `HOLD`, `CAPTURE` and `RELEASE` transactions cannot be reversed (400); use release instead. Other transaction kinds, FX included, reverse normally.
- `GET /proof` reports `escrow_matches_open_holds`: the `HOLD-ESCROW` balance per currency must equal the sum of holds whose latest state is HELD.

## Routes (all `POST` routes require `Idempotency-Key`)
- `POST /accounts {account_id, currency?}`, `/mint`, `/transfer {from,to,amount,fee_bps? (guard)}`, `/fx {from,to,amount,rate_bps? fee_bps? (guards)}`
- Operator (`X-Operator-Token`): `POST /admin/fx-rates`, `/admin/fund-pool`
- `POST /holds {payer, amount}`, `/holds/:id/capture {to}`, `/holds/:id/release`, `/reverse/:txn_id`
- `GET /holds`, `/holds/:id`, `/fx/quote`, `/fx/rates`, `/fees`, `/balances?as_of_valid=&as_of_system=`, `/journal`, `/timeline`, `/history/:acct`, `/proof`
