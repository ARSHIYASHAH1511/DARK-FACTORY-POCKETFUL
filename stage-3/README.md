# Stage 3: Bitemporal audit ledger with immutable reversals

Stage 3 is stage 2 (WAL, `BEGIN IMMEDIATE`, SHA-256 idempotency, append-only triggers, bigint folds) plus two time axes per transaction. It has zero npm dependencies and needs Node 24 or later.

```sh
node src/test.ts      # 50 tests: all stage-2 invariants + bitemporal + reversal
node src/server.ts    # HTTP on :3004, DB at $LEDGER_DB (default data/stage-3.db)
```

## Time axes (I7)
| column | meaning | source |
|---|---|---|
| `valid_at` | When the event is effective in business terms. | Client-supplied (`valid_at`, epoch ms, 1 … 9999-12-31). Defaults to `system_at`. |
| `system_at` | When the ledger learned about it. | Server-assigned under the write lock: `max(now, last + 1)`, so strictly increasing (and `UNIQUE`). |

`GET /balances?as_of_valid=&as_of_system=` folds only transactions where `valid_at <= as_of_valid` and `system_at <= as_of_system`. Because entries are append-only, every as-of-system query is reproducible forever.

## No overdraft in valid time (I5)
A debit at `valid_at = v` must leave the account non-negative at every valid-time point `>= v`. That means three things:
- You cannot spend money before its valid time. This covers backdated debits and spending a future-dated credit early.
- A backdated debit cannot invalidate a later payment that was already recorded.
- The System Reserve `0000-0000` is the only exception.

## Reversals (I8)
`POST /reverse/:txn_id` (requires `Idempotency-Key`) appends a `REVERSAL` transaction:
- Its entries are the original's entries, negated: a 2-leg transaction gives +2 rows, and 0 rows are updated or deleted.
- `reverses_txn_id` points at the original. The column is `UNIQUE`, so the database itself refuses a second reversal.
- `valid_at` equals the original's, so the correction applies retroactively in valid time. `system_at` is now, so as-of-system views from before the correction still show the original.

Errors:
- `404 UNKNOWN_TXN`: no such transaction.
- `409 ALREADY_REVERSED`: the transaction was already reversed.
- `409 REVERSAL_OF_REVERSAL`: the target is itself a reversal.
- `409 INSUFFICIENT_FUNDS`: the original credit was already spent, so reversing it would overdraw an account.

## Routes
- `POST /accounts`, `/mint` and `/transfer` accept an optional `valid_at`.
- `POST /reverse/:txn_id`
- `GET /balances`, `/journal`, `/proof`
- `GET /timeline` returns `{min_system_at, max_system_at, events[]}` for the UI slider.
- `GET /history/:account_id` returns the account's entries with both time axes.

Reserved ids (`0000-0000`, `9999-FEE`, `HOLD-ESCROW`, `FX-POOL`) are blocked case-insensitively.
