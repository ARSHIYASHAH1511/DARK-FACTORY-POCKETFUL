# BAND Factory

## Purpose

This repository was built by a four-seat BAND room. Each seat has its own mandate in `.band/mandates/`:

1. **Architect** sets the invariants, contracts and system boundaries.
2. **Implementer** builds against them test-first and fixes what the Adversary finds.
3. **Adversary** attacks the build without editing it. Each failure it finds is turned into a regression test.
4. **Verifier** re-runs every gate independently and alone decides whether to release.

The aim is to keep specification, implementation, failure discovery and verification separate. A release is accepted only when the verifier's own runs back up the requirements, not the reports of other seats.

## Invariants

| ID | Invariant | How it is enforced |
|----|-----------|--------------------|
| I1 | Zero-sum: `SUM(signed amount) = 0` per currency, across all entries and within every transaction | Write path rejects unbalanced transactions. `/proof` reports `per_currency` and `unbalanced_txns` |
| I2 | No mutable balance columns. Balances are always folded with `SELECT SUM(amount)` | Schema detector on every stage. A planted `Balance` column is flagged |
| I3 | Append-only. Reversals add two inverse entries and never change or delete rows | Frozen entries. Reversal race tests |
| —  | Integer cents only (no floats). FX in basis points (10000 bps = 1.0000). System reserve `0000-0000`, fees to `9999-FEE`, escrow in `HOLD-ESCROW` | `money.ts` validation. Stage 4 tests |

## Stages

| Stage | Scope | Suite (verifier run) |
|-------|-------|----------------------|
| `stage-1/` | In-memory double-entry core | 29 passed, 0 failed |
| `stage-2/` | SQLite WAL, `BEGIN IMMEDIATE` serialization with deadline-bounded backoff, SHA-256 idempotency | 30 passed, 0 failed; stress PASS |
| `stage-3/` | Bitemporal (`valid_at` / `system_at`), time-travel queries, append-only reversals | 53 passed, 0 failed |
| `stage-4/` | Basis-point FX, server-side fee policy, 3-state escrow holds | 82 passed, 0 failed |

**Pass rate: 194 / 194 (100%)** across the four stage suites, plus the Stage 2 stress test.

The original Python prototypes are kept in `legacy/python/`.

## Concurrency benchmark (Stage 2 stress test, verifier run)

| Metric | Result |
|--------|--------|
| Concurrent requests against one account | 100 |
| Outcome | 50 ok / 50 `INSUFFICIENT_FUNDS`, victim balance 0 |
| Idempotent replays (same key) | 1 applied, 49 replayed |
| Tampered payload on a used key | 409 `IDEMPOTENCY_CONFLICT`, 0 rows written |
| Double-spends | **0** |
| Busy-lock exhaustion (`SQLITE_BUSY` past deadline) | **0** |
| Throughput | 70.35 req/s |
| Latency | p50 528.82 ms, p99 1325.91 ms |
| Conservation | USD sum 0, `integrity_check` ok, 0 unbalanced transactions |

Throughput is machine-dependent. Writes are deliberately serialized, so this measures correctness under contention, not peak speed.

## Adversary certification

`evidence/adversary.json` certifies stages 2, 3 and 4. Stage 1 is covered by its suite only and was not attacked live. Highlights:

- 300-way and 1000-way HTTP races: exact funded count succeeds, and the rest get `INSUFFICIENT_FUNDS`.
- Integer overflow on mint was found and fixed. Max mints now end in `400 OVERFLOW`.
- A future `as_of_system` snapshot was found and fixed. It is now rejected.
- Client-supplied FX rate or fee was found and fixed. Both are now server policy, and a mismatch returns `409 POLICY_MISMATCH` with 0 rows.
- 100 concurrent escrow holds against a 5000-cent balance: exactly 50 succeed. 20 capture-vs-release races each have a single winner.
- End-of-attack proof: USD 0, EUR 0, 0 unbalanced transactions, escrow equals open holds.

## Release gates (verifier)

| Gate | Result |
|------|--------|
| Mandate genericness: `grep -rn -i <project-name> .band/mandates/` | **0 matches** |
| Typecheck: root and 4 stages | exit 0 |
| Stage suites | 194 / 194 |
| Stage 2 stress | PASS |
| Hermetic Docker: build, then `docker run --network none` for all 4 stages | **4 / 4 pass** (`evidence/docker.json`) |
| Egress probe inside container | only `lo`; external fetch blocked (`EAI_AGAIN`) |
| Production UI build (Vite, warm) | 893 ms |
| Server smoke: `GET /`, `/api/meta/telemetry`, SPA deep link, unknown `/api/*` | 200, 200, 200, 404 JSON |

Docker images need network access at build time only, to pull `node:24-alpine`. They have no npm dependencies, and every run happens with networking disabled.

## Run

```sh
npm install
npm start        # builds the UI and serves API + Command Center on http://localhost:3000
npm test         # all four stage suites + stress test
```

Per stage, hermetic:

```sh
docker build -t df-stage-2 stage-2
docker run --rm --network none df-stage-2
```

## Known limitations

- `POST /api/s2/fuzz` and `POST /api/meta/tests` have no authentication. They are single-flight demo endpoints and should not be exposed publicly as they are.
- Operator routes `/api/s4/admin/*` are disabled unless `OPERATOR_TOKEN` is set.
- The cold first build is slower than the warm build reported above.
- The externally hosted dashboard URL was provided, not verified. An HTTP GET reaches an AI Studio cookie-check interstitial, so it is unconfirmed whether that URL serves this build.

Verified and signed: **Verifier seat**, BAND room, 2026-10-06.
