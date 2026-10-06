# DARK-FACTORY: Full-Stack Zero-Sum Ledger Plan (Architect, Step 1)

DAG: SCHEMA_DESIGN -> INTERFACE_CONTRACT -> INVARIANT_SUITE -> HANDOFF

## 0. Baseline and decisions

- The repo today has Python stages (`stage-N/*.py`). They store a mutable `balance` column/dict, which violates I2 below. **Decision:** `git mv` them to `legacy/python/stage-N/` with a one-line README noting they predate the invariant. The new TypeScript stages replace them in `stage-1/` … `stage-4/`. Invariant scanners skip `legacy/`.
- Runtime is **Node 24** (verified locally: v24.21.0). Stage engines use **zero npm dependencies**: `node:sqlite` (`DatabaseSync`), `node:crypto`, `node:http`, `node:worker_threads`. TS is limited to erasable syntax (no `enum`, `namespace`, or parameter properties), so `node src/test.ts` and `npx tsx src/test.ts` both run it. Because of this, each stage Docker image builds and runs with `--network none`.
- stage tsconfig: `"module":"nodenext","allowImportingTsExtensions":true,"noEmit":true,"erasableSyntaxOnly":true,"verbatimModuleSyntax":true,"strict":true`. Imports use `.ts` extensions.
- Root: `package.json` (express, react, react-dom, vite, @vitejs/plugin-react, tailwindcss, tsx, typescript), `server.ts` (unified Express), `index.html` + `src/` (UI), `vite.config.ts`. Runtime DBs go in `data/`, which is gitignored. Tests use temp dirs (`fs.mkdtempSync`).

## 1. SCHEMA_DESIGN

### Invariants (each one is objectively testable)

| ID | Invariant | Enforcement | Test oracle |
|----|-----------|-------------|-------------|
| I1 | Zero-sum: for every txn and every currency, `SUM(amount) = 0`. Globally, `SUM(amount) GROUP BY currency = 0`. | Engine builds entries, then asserts the sum is 0 before INSERT, all inside the same `BEGIN IMMEDIATE`. | `SELECT txn_id, currency FROM entries GROUP BY txn_id, currency HAVING SUM(amount) <> 0` returns 0 rows. Same for the global per-currency query. |
| I2 | No stored balances. A balance is always `SELECT COALESCE(SUM(amount),0) FROM entries WHERE account_id=? AND currency=?`. | Schema review | `SELECT sql FROM sqlite_master` contains no `balance` token. A repo grep of `stage-*/src` for `balance\s+(INTEGER|BIGINT)` returns 0 hits. |
| I3 | Append-only. No UPDATE or DELETE on `entries`, `transactions`, `hold_events`, or `idempotency`. | `BEFORE UPDATE` / `BEFORE DELETE` triggers → `RAISE(ABORT,'append-only')` | Tests attempt UPDATE and DELETE and expect the ABORT. A row count never decreases across any API call. |
| I4 | Integer money. Every `amount` is a 64-bit integer, non-zero. Request amounts are strictly positive. | `STRICT` tables with `CHECK (typeof(amount)='integer' AND amount <> 0)`. Engine uses `bigint` (`db.setReadBigInts(true)` / `stmt.setReadBigInts(true)`). API accepts a digit string `^[1-9][0-9]{0,17}$` or a safe integer `number`. Anything else gives 400 VALIDATION. Results are checked against ±(2^63−1), else 400 OVERFLOW. | Fuzz with `1.5`, `"1e3"`, `-1`, `0`, `NaN`, `"9223372036854775808"`: all rejected and 0 rows written. |
| I5 | Reserve and no-overdraft. `0000-0000` (System Reserve) is the only account that may go negative. Mint means reserve −X and user +X. Every other account must have balance ≥ 0 after every txn, checked inside the write lock. | Engine | The 100-way fuzz finishes with exactly 50 successes and a victim balance of 0, never negative. |
| I6 | Idempotency. Same `Idempotency-Key` and same `request_hash`: return the stored response and write 0 new rows. Same key with a different hash: 409 IDEMPOTENCY_CONFLICT. | `idempotency(key PRIMARY KEY)` row is written in the **same** DB txn as the entries. | 50 replays → 1 txn and 49 `replayed:true`. Tampered payload → 409, 0 rows. |
| I7 | Dual timestamps. Every txn has `valid_at` (business time, client-supplied, defaults to now) and `system_at` (server, strictly monotonic: `max(Date.now(), last_system_at+1)` read inside the lock). Both are INTEGER epoch ms. | Engine | `system_at` is strictly increasing in insertion order. As-of queries are reproducible. |
| I8 | Reversal is additive. Reversing txn T inserts a new txn R (`reverses_txn_id=T`, UNIQUE) whose entries are T's entries negated, so a 2-entry T gives +2 rows. R has `valid_at = T.valid_at` and `system_at = now`. 0 rows deleted. Reversing a reversal gives 409 REVERSAL_OF_REVERSAL. Reversing twice gives 409 ALREADY_REVERSED. If the reversal would overdraw a non-reserve account: 409 INSUFFICIENT_FUNDS. | UNIQUE + engine | Row count goes from n to n+2. As-of `system_at < R.system_at` shows the pre-correction view. |
| I9 | Hold state machine: `HELD → CAPTURED` or `HELD → RELEASED`. Both are terminal. | `CREATE UNIQUE INDEX one_terminal ON hold_events(hold_id) WHERE state IN ('CAPTURED','RELEASED')` plus a state check under the lock. | 20 concurrent capture/release on one hold → exactly 1 succeeds. HOLD-ESCROW balance equals the sum of open holds. |
| I10 | FX and fees in integer basis points (10000 bps = 1.0000). `fee = amount*fee_bps/10000n` (bigint floor). `net = amount-fee`. `converted = net*rate_bps/10000n`. | Engine | Per-currency zero-sum holds exactly. Rounding dust stays in FX-POOL, never lost. |

### Tables (stages 2–4, `STRICT`, WAL, `PRAGMA foreign_keys=ON`, `busy_timeout=0` with app-level retry)

```sql
accounts(account_id TEXT PRIMARY KEY, currency TEXT NOT NULL CHECK(length(currency)=3),
         kind TEXT NOT NULL CHECK(kind IN ('USER','SYSTEM')), created_at INTEGER NOT NULL)
         -- user accounts are single-currency; SYSTEM accounts (0000-0000, 9999-FEE, HOLD-ESCROW, FX-POOL) are multi-currency: currency column = '***'
transactions(txn_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('MINT','TRANSFER','FX','REVERSAL','HOLD','CAPTURE','RELEASE')),
         valid_at INTEGER NOT NULL, system_at INTEGER NOT NULL UNIQUE,
         reverses_txn_id TEXT UNIQUE REFERENCES transactions(txn_id), memo TEXT)
entries(entry_id INTEGER PRIMARY KEY, txn_id TEXT NOT NULL REFERENCES transactions(txn_id),
         account_id TEXT NOT NULL REFERENCES accounts(account_id), currency TEXT NOT NULL,
         amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount <> 0))
         -- INDEX (account_id, currency), INDEX (txn_id)
idempotency(key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, status INTEGER NOT NULL,
         response_json TEXT NOT NULL, system_at INTEGER NOT NULL)
hold_events(event_id INTEGER PRIMARY KEY, hold_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('HELD','CAPTURED','RELEASED')),
         txn_id TEXT NOT NULL REFERENCES transactions(txn_id), payer TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>0), currency TEXT NOT NULL)
         -- UNIQUE(hold_id) WHERE state='HELD'; UNIQUE(hold_id) WHERE state IN ('CAPTURED','RELEASED')
```
Stage 1 is in-memory: an `Entry[]` journal with the same I1/I2/I3/I4/I5 semantics (it uses `Object.freeze` and has no balance map).

### Per-stage scope
- **stage-1** `src/ledger.ts`, `src/server.ts` (node:http), `src/test.ts`: accounts, mint, transfer, fold balance, global proof.
- **stage-2** `src/idempotency.ts` (canonical JSON with sorted keys → SHA-256 hex over `{route, body}`), `src/ledger.ts` (SQLite WAL, `BEGIN IMMEDIATE`, retry on `SQLITE_BUSY`/`database is locked`: exponential backoff 1ms·2^n with jitter, capped at 50ms, max 200 attempts, then 503 BUSY_EXHAUSTED), `src/server.ts`, `src/stress-test.ts`, `src/test.ts`.
- **stage-3** stage-2 plus `valid_at`/`system_at`, `balanceAsOf(acct, cur, {validAt?, systemAt?})`, `reverse(txnId)`, `history(acct)`, `src/test.ts`.
- **stage-4** stage-3 plus multi-currency FX (`rate_bps`, `fee_bps`; the fee routes to `9999-FEE` in the source currency), holds (`hold`/`capture`/`release` via `HOLD-ESCROW`), `src/test.ts`.
- Each stage has `package.json` (`"type":"module"`, scripts `test`, `start`), `tsconfig.json`, and a `Dockerfile`: `FROM node:24-alpine`, `COPY . .`, `CMD ["node","src/test.ts"]`. No `npm install` step.

### Concurrency model (adversary focus)
`DatabaseSync` is synchronous, so 100 HTTP requests inside one process serialize on the event loop and **do not** exercise the lock. `stress-test.ts` must spawn **100 `worker_threads`**, each with its own connection to one temp DB file, released together by a `SharedArrayBuffer` + `Atomics.wait/notify` start barrier.

Scenario A: `acc_victim` is minted 5000. Each of the 100 workers withdraws 100 to `acc_sink` with a unique key. **Expected:** exactly 50 OK, 50 INSUFFICIENT_FUNDS, victim = 0, 0 unresolved BUSY, I1 holds.

Scenario B: 50 workers send the same key and payload. **Expected:** 1 txn row, 49 replayed.

Scenario C: same key, different amount. **Expected:** 409.

Scenario D: after A–C, the `PRAGMA integrity_check` result is `ok`.

The test prints JSON `{throughput_rps, p50_ms, p99_ms, busy_retries, double_spends:0, ...}` and exits non-zero on any violation.

## 2. INTERFACE_CONTRACT (unified `server.ts`, Express, port `PORT||3000`)

Envelope: success `{ok:true, data}`, error `{ok:false, error:{code,message}}`. Money is serialized as **decimal strings**. Codes: VALIDATION 400, OVERFLOW 400, UNKNOWN_ACCOUNT 404, UNKNOWN_TXN 404, INSUFFICIENT_FUNDS 409, IDEMPOTENCY_CONFLICT 409, ALREADY_REVERSED 409, REVERSAL_OF_REVERSAL 409, HOLD_NOT_ACTIVE 409, CURRENCY_MISMATCH 409, BUSY_EXHAUSTED 503. Mutating routes on s2–s4 require the `Idempotency-Key` header; without it the server returns 400.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| POST | `/api/s{1..4}/accounts` | `{account_id, currency?}` | account |
| POST | `/api/s{1..4}/mint` | `{account_id, amount, currency?, valid_at?}` | txn + entries |
| POST | `/api/s{1..4}/transfer` | `{from, to, amount, valid_at?}` | txn + entries |
| GET | `/api/s{n}/balances` | `?as_of_valid=&as_of_system=` (s3/s4) | `[{account_id,currency,balance}]` folded via SUM |
| GET | `/api/s{n}/journal` | `?limit=&before=` | entries, newest first |
| GET | `/api/s{n}/proof` | — | `{per_currency:{USD:"0"}, unbalanced_txns:0, entry_count, txn_count, schema_has_balance:false}` |
| POST | `/api/s2/fuzz` | `{concurrency:100, replays:50}` | stress JSON (runs the same module as `stress-test.ts`, on an isolated temp DB) |
| POST | `/api/s3/reverse/:txn_id` | — | reversal txn |
| GET | `/api/s3/timeline` | — | `{min_system_at, max_system_at, events:[{txn_id,kind,valid_at,system_at}]}` for the slider |
| POST | `/api/s4/fx` | `{from, to, amount, rate_bps, fee_bps}` | txn |
| POST | `/api/s4/holds` / `/api/s4/holds/:id/capture` `{to}` / `/api/s4/holds/:id/release` | | hold + state history |
| GET | `/api/meta/telemetry` | — | entry and txn counts per stage, per-currency global sums, last fuzz, uptime |
| POST | `/api/meta/tests` | `{stage?:1..4}` | spawns `node stage-N/src/test.ts`, returns `{stage, passed, failed, duration_ms, stdout_tail}`, and writes `evidence/stage-N.json` |
| GET | `/api/meta/band` | — | mandates (`.band/mandates/*.md` raw), 8 milestones derived from `evidence/*.json` and `git log` |
| GET | `/api/meta/compliance` | — | leaked-term scan (term list from env `LEAK_TERMS`, never hardcoded in the UI bundle), proof results, Docker matrix read from `evidence/docker.json` |
| GET | `/api/meta/files` / `/api/meta/file?path=` | — | tracked files (`git ls-files`). Path must be in that list, otherwise 400, so there is no traversal. |
| GET | `*` | — | `dist/index.html` (SPA) + static |

Each stage's `server.ts` exposes the same routes for that stage alone, using node:http, on port `3001+n`. The unified server imports engine modules directly and does not proxy.

## 3. Command Center UI spec (React 18 + Tailwind, Vite → `dist/`)

Visual: dark neutral (`zinc-950` bg, `zinc-800` hairlines), one accent (emerald for "conservation holds", red only for violations), Inter + JetBrains Mono, tabular numerals, dense Linear-style spacing, no gradients or emoji.

- **Top bar** (`ui_topbar`): wordmark `DARK FACTORY`, 4 tabs (Harness · BAND Room · Invariants · Artifacts), a live journal-entry counter that polls `/api/meta/telemetry` every 1s, a global Σ=0 pill, and a **Run Test Suite** button with per-stage results inline.
- **Harness** (`ui_harness`): stage selector s1–s4, mint and transfer forms (amount input in cents, with a formatted display), and a live journal table. **Blast 100 Concurrent Requests** shows a progress state, then throughput, p50/p99, successes/rejections, busy retries, and a `double-spends: 0` badge. **Time-travel slider** over `system_at` (s3) shows balances re-folding as-of, with a reversal button per txn. **Escrow card** (s4) shows HELD → CAPTURED/RELEASED as a 3-node state diagram with illegal transitions disabled. FX form shows the computed fee and converted amount before submit.
- **BAND Room** (`ui_band`): 4 seat cards (Architect, Implementer, Adversary, Verifier) with mandate summaries, a raw mandate viewer (monospace), and an 8-milestone timeline: (1) spec published, (2) S1 green, (3) S2 green, (4) adversary certified, (5) S3 green, (6) S4 green, (7) UI + unified server build, (8) release verified. Status comes from `/api/meta/band`, not hardcoded.
- **Invariants** (`ui_compliance`): table I1–I10 with live pass/fail from `/proof` for each stage, the leaked-term scan result (match count), and the Docker matrix (stage × build × `--network none` run).
- **Artifacts** (`ui_artifacts`): file tree from `/api/meta/files`, a syntax-highlighted viewer (lightweight: `highlight.js` core + ts/json/md/dockerfile langs), and a copy button.

Root scripts: `build` = `vite build`, `start` = `npm run build && tsx server.ts`, `test` = runs the 4 stage tests sequentially, then the stress test.

## 4. INVARIANT_SUITE (acceptance gates; the verifier checks each one with real output)

1. `npx tsx stage-{1,2,3,4}/src/test.ts`: all pass, each covering every applicable I-row above plus negative cases (unknown account, self-transfer → VALIDATION, currency mismatch, bad amounts).
2. `npx tsx stage-2/src/stress-test.ts`: scenarios A–D exact, exit 0.
3. A concurrent-hold test (I9) in stage-4.
4. Schema scan: no `balance` column in any stage DB. Triggers block UPDATE and DELETE.
5. `npm run build` succeeds. Record the actual duration; the < 1s target is aspirational and must be reported honestly.
6. `npm start`, then `curl :3000/api/meta/telemetry` returns 200 and `curl :3000/` serves HTML.
7. `grep -rn -i "<term>" .band/mandates/` returns 0 matches.
8. For each stage: `docker build` and `docker run --rm --network none` both exit 0. If Docker is unavailable on the host, report **NOT RUN**, not pass.
9. Release certificate: the commit and push hashes must be quoted from real git output. The "Live Dashboard URL" may be stated as live **only if** an HTTP GET to it returns 200 during verification; otherwise label it unverified. "100% VERIFIED" is only allowed if gates 1–8 all pass.

## 5. HANDOFF: implementer task order
1. `git mv` Python stages to `legacy/python/`, then root scaffold and `.gitignore` (`node_modules/`, `dist/`, `data/`, `*.db*`).
2. stage-1 (TDD) → run its test.
3. stage-2 (idempotency, WAL lock, stress-test) → run it → hand to the adversary.
4. After the adversary certifies: stage-3 → stage-4, both TDD.
5. Unified `server.ts` and the UI → `npm run build` → smoke test on :3000 → hand to the verifier.

```arch
{
  "kind": "layered",
  "title": "DARK-FACTORY full-stack zero-sum ledger",
  "layers": [
    { "id": "ui", "title": "Command Center UI (React + Tailwind, Vite build -> dist/)", "items": [
      { "id": "ui_topbar", "label": "Top bar", "detail": "Wordmark, 4 tabs, live entry counter, Run Test Suite" },
      { "id": "ui_harness", "label": "Live Ledger Harness", "detail": "Mint, transfer, Blast 100 concurrent, zero-sum telemetry, time-travel slider, escrow state machine" },
      { "id": "ui_band", "label": "BAND Room", "detail": "4 seat cards, mandate viewer, 8-milestone timeline" },
      { "id": "ui_compliance", "label": "Invariants & Compliance", "detail": "Leaked-term scan, conservation proof, Docker matrix" },
      { "id": "ui_artifacts", "label": "Repository Artifacts", "detail": "Syntax-highlighted explorer with copy" }
    ] },
    { "id": "api", "title": "Unified Express server (server.ts, port 3000)", "items": [
      { "id": "api_router", "label": "Router /api/s1..s4 + /api/meta", "detail": "JSON contract, zod-style validation, uniform error envelope" },
      { "id": "api_fuzz", "label": "Fuzzer endpoint", "detail": "POST /api/s2/fuzz: 100 workers vs acc_victim + 50 replays" },
      { "id": "api_tests", "label": "Test runner endpoint", "detail": "POST /api/meta/tests spawns npx tsx stage-N/src/test.ts" },
      { "id": "api_static", "label": "Static UI", "detail": "Serves dist/ with SPA fallback" }
    ] },
    { "id": "engines", "title": "Stage engines (TypeScript, isolated packages)", "items": [
      { "id": "s1_core", "label": "Stage 1 Double-Entry Core", "detail": "In-memory append-only journal, fold balances" },
      { "id": "s2_wal", "label": "Stage 2 Idempotency + WAL lock", "detail": "SHA-256 request hash, BEGIN IMMEDIATE, busy backoff" },
      { "id": "s3_bitemporal", "label": "Stage 3 Bitemporal audit", "detail": "valid_at/system_at, as-of queries, inverse-entry reversal" },
      { "id": "s4_escrow", "label": "Stage 4 FX + fees + escrow", "detail": "bps integer FX, 9999-FEE, HOLD-ESCROW 3-state machine" }
    ] },
    { "id": "store", "title": "Storage (node:sqlite, WAL, no native deps)", "items": [
      { "id": "tbl_entries", "label": "entries (append-only)", "detail": "BIGINT signed amounts; UPDATE/DELETE blocked by triggers" },
      { "id": "tbl_txns", "label": "transactions", "detail": "txn header, valid_at, system_at, reverses_txn_id UNIQUE; + idempotency(key PK, request_hash)" },
      { "id": "tbl_holds", "label": "hold_events (append-only)", "detail": "Hold state derived from latest event" },
      { "id": "tbl_accounts", "label": "accounts", "detail": "id, currency, kind. No balance column" }
    ] }
  ],
  "flows": [
    { "from": "ui", "to": "api", "label": "fetch JSON + 1s polling" },
    { "from": "api", "to": "engines", "label": "in-process calls" },
    { "from": "engines", "to": "store", "label": "SQL in BEGIN IMMEDIATE txns" },
    { "from": "api_fuzz", "to": "s2_wal", "label": "worker_threads, 1 connection each" }
  ]
}
```
