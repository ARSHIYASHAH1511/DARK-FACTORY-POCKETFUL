# Stage 4: Multi-currency FX, fee routing and escrow holds

This stage is stage 3 (bitemporal, immutable reversals, idempotent WAL writes) plus integer basis-point FX, fees, and a three-state escrow. It has zero npm dependencies and needs Node 24 or later.

```sh
node src/test.ts      # 73 tests, incl. a 20-worker capture/release race
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
10000 bps = 1.0000. All arithmetic is bigint with floor division.

```
fee       = amount * fee_bps / 10000
net       = amount - fee
converted = net * rate_bps / 10000
```

- **Transfer with fee** (`fee_bps` 0–10000, optional) produces 3 legs: payer −amount, payee +net, `9999-FEE` +fee. A fee that consumes the whole amount is rejected.
- **FX** (`rate_bps` 1–1e9, `fee_bps` 0–9999) produces up to 5 legs:
  - payer −amount (A)
  - `9999-FEE` +fee (A)
  - `FX-POOL` +net (A)
  - `FX-POOL` −converted (B)
  - payee +converted (B)
- Zero-sum holds exactly **per currency**.
- The floor remainder ("dust") stays with `FX-POOL` as source-currency value, so nothing is created or lost.
- A conversion that floors to 0 is rejected.
- If the pool can't cover the payout in the target currency, the request gets `409 INSUFFICIENT_FUNDS`.
- `GET /fx/quote?amount=&rate_bps=&fee_bps=` returns the same numbers without writing anything.

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
- `POST /accounts {account_id, currency?}`, `/mint`, `/transfer {.., fee_bps?}`, `/fund-pool {currency, amount}`, `/fx {from,to,amount,rate_bps,fee_bps}`
- `POST /holds {payer, amount}`, `/holds/:id/capture {to}`, `/holds/:id/release`, `/reverse/:txn_id`
- `GET /holds`, `/holds/:id`, `/fx/quote`, `/balances?as_of_valid=&as_of_system=`, `/journal`, `/timeline`, `/history/:acct`, `/proof`
