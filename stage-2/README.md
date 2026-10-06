# Stage 2: Idempotent SQLite WAL ledger

This stage has zero npm dependencies. It uses `node:sqlite`, `node:crypto` and `node:worker_threads`, and needs Node 24 or later.

```sh
node src/test.ts          # unit and regression suite
node src/stress-test.ts   # 100-worker chaos run (scenarios A-D)
node src/server.ts        # HTTP on :3003, DB at $LEDGER_DB (default data/stage-2.db)
```

## Write path
- Every mutation runs inside `BEGIN IMMEDIATE`, under the single write lock. Inside that lock it:
  - looks up the idempotency key,
  - checks the range and overdraft of every leg,
  - inserts the entries,
  - re-checks zero-sum in SQL,
  - records the idempotency row.
  It then commits.
- `SQLITE_BUSY` is retried with capped exponential backoff and jitter (1ms·2^n, at most 50ms). Retries continue until a 30s deadline from the first attempt. After that the request gets `503 BUSY_EXHAUSTED` and nothing is written.
- Tables are `STRICT`, and triggers make `accounts`, `transactions`, `entries` and `idempotency` append-only.
- No balance is stored. Balances and proofs are folded from `entries` using bigint, so no intermediate SQLite `SUM()` can overflow.

## Amount range
- A request amount is a positive integer string of at most 18 digits, or a positive safe-integer number.
- Every leg, credits included, must leave its account inside ±(2^63−1). Otherwise the request gets `400 OVERFLOW`.
- This also bounds the System Reserve (`0000-0000`), so total supply per currency is at most 2^63−1. Because of that, no user balance can overflow either.

## Idempotency semantics (by design)
- Mutating routes require `Idempotency-Key` (1–128 printable ASCII characters, no spaces).
- The fingerprint is the SHA-256 of canonical JSON (sorted keys) of `{route, body}`:
  - Key order and whitespace do not matter.
  - JSON types do matter: `amount: 2` and `amount: "2"` are different requests, so reusing the key gives `409 IDEMPOTENCY_CONFLICT`.
  - The same key on a different route also gives 409.
- Outcomes are stored, including business failures such as `INSUFFICIENT_FUNDS` or `VALIDATION`. A replay returns exactly the first response. To correct a request, send it with a **new** key.
- Responses with `503 BUSY_EXHAUSTED` are not stored, because nothing ran.

## Reserved account ids
Users cannot open these ids, compared case-insensitively: `0000-0000`, `9999-FEE`, `HOLD-ESCROW`, `FX-POOL`.

## HTTP hardening
- Request bodies are capped at 64KB. Larger bodies get `413`.
- `limit` falls back to 100 when it is not an integer.
- `POST /fuzz` runs one at a time; a second call while one is running gets `429 FUZZ_IN_PROGRESS`. Concurrency is clamped to 2–200.
