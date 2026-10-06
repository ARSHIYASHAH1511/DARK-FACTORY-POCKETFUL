import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, requestHash } from "./idempotency.ts";
import { RESERVED_ACCOUNT_IDS, SqliteLedger, SYSTEM_RESERVE, type Outcome } from "./ledger.ts";
import { MAX_I64 } from "./money.ts";

let passed = 0;
let failed = 0;
const dirs: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${(err as Error).stack}`);
  }
}

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "df-s2-"));
  dirs.push(dir);
  return join(dir, "ledger.db");
}

let keySeq = 0;
const key = () => `k-${++keySeq}`;

async function seeded(): Promise<SqliteLedger> {
  const ledger = new SqliteLedger(tempDb());
  await ledger.submit("accounts", { account_id: "alice" }, key());
  await ledger.submit("accounts", { account_id: "bob" }, key());
  await ledger.submit("mint", { account_id: "alice", amount: "10000" }, key());
  return ledger;
}

console.log("stage-2: idempotent SQLite WAL ledger");

await test("canonical JSON is key-order independent; hash covers route", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  assert.equal(requestHash("transfer", { a: 1, b: 2 }), requestHash("transfer", { b: 2, a: 1 }));
  assert.notEqual(requestHash("transfer", { a: 1 }), requestHash("mint", { a: 1 }));
  assert.match(requestHash("mint", {}), /^[0-9a-f]{64}$/);
});

await test("WAL journal mode is active", () => {
  const ledger = new SqliteLedger(tempDb());
  assert.equal(ledger.journalMode(), "wal");
  ledger.close();
});

await test("I2 schema has no balance column; system reserve exists", async () => {
  const ledger = await seeded();
  assert.equal(ledger.proof().schema_has_balance, false);
  assert.equal(ledger.balance(SYSTEM_RESERVE, "USD"), -10000n);
  assert.equal(ledger.balance("alice", "USD"), 10000n);
  ledger.close();
});

await test("I1 transfer conserves value, per-txn and global sums are zero", async () => {
  const ledger = await seeded();
  const out = await ledger.submit("transfer", { from: "alice", to: "bob", amount: 2500 }, key());
  assert.equal(out.status, 201);
  assert.equal(ledger.balance("alice", "USD"), 7500n);
  assert.equal(ledger.balance("bob", "USD"), 2500n);
  const proof = ledger.proof();
  assert.deepEqual(proof.per_currency, { USD: "0" });
  assert.equal(proof.unbalanced_txns, 0);
  ledger.close();
});

await test("I3 triggers block UPDATE and DELETE on append-only tables", async () => {
  const path = tempDb();
  const ledger = new SqliteLedger(path);
  await ledger.submit("accounts", { account_id: "alice" }, key());
  await ledger.submit("mint", { account_id: "alice", amount: 5 }, key());
  const raw = new DatabaseSync(path);
  for (const sql of [
    "UPDATE entries SET amount = amount * 2",
    "DELETE FROM entries",
    "UPDATE transactions SET memo = 'x'",
    "DELETE FROM transactions",
    "UPDATE idempotency SET status = 200",
    "DELETE FROM idempotency",
  ]) {
    assert.throws(() => raw.exec(sql), /append-only/, sql);
  }
  raw.close();
  assert.equal(ledger.balance("alice", "USD"), 5n);
  ledger.close();
});

await test("I4 STRICT schema rejects non-integer and zero amounts at the DB layer", async () => {
  const path = tempDb();
  const ledger = new SqliteLedger(path);
  await ledger.submit("accounts", { account_id: "alice" }, key());
  const raw = new DatabaseSync(path);
  raw.exec("INSERT INTO transactions(txn_id, kind, valid_at, system_at) VALUES ('x', 'MINT', 1, 1)");
  assert.throws(() => raw.exec("INSERT INTO entries(txn_id, account_id, currency, amount) VALUES ('x', 'alice', 'USD', 1.5)"));
  assert.throws(() => raw.exec("INSERT INTO entries(txn_id, account_id, currency, amount) VALUES ('x', 'alice', 'USD', 0)"));
  raw.close();
  ledger.close();
});

for (const bad of [0, -1, 1.5, "1e3", "-1", "9223372036854775808", null]) {
  await test(`I4 rejects amount ${JSON.stringify(bad)} with 0 rows written`, async () => {
    const ledger = await seeded();
    const before = ledger.proof().entry_count;
    const out = await ledger.submit("transfer", { from: "alice", to: "bob", amount: bad }, key());
    assert.equal(out.status, 400);
    assert.ok(["VALIDATION", "OVERFLOW"].includes(out.body.error!.code));
    assert.equal(ledger.proof().entry_count, before);
    ledger.close();
  });
}

await test("I5 overdraft rejected with INSUFFICIENT_FUNDS", async () => {
  const ledger = await seeded();
  const out = await ledger.submit("transfer", { from: "alice", to: "bob", amount: 10001 }, key());
  assert.equal(out.status, 409);
  assert.equal(out.body.error!.code, "INSUFFICIENT_FUNDS");
  assert.equal(ledger.balance("alice", "USD"), 10000n);
  ledger.close();
});

await test("self-transfer, unknown account and currency mismatch are rejected", async () => {
  const ledger = await seeded();
  await ledger.submit("accounts", { account_id: "eve", currency: "EUR" }, key());
  assert.equal((await ledger.submit("transfer", { from: "alice", to: "alice", amount: 1 }, key())).body.error!.code, "VALIDATION");
  assert.equal((await ledger.submit("transfer", { from: "alice", to: "ghost", amount: 1 }, key())).body.error!.code, "UNKNOWN_ACCOUNT");
  assert.equal((await ledger.submit("transfer", { from: "alice", to: "eve", amount: 1 }, key())).body.error!.code, "CURRENCY_MISMATCH");
  ledger.close();
});

await test("I6 replay with same key and payload returns stored response, writes 0 rows", async () => {
  const ledger = await seeded();
  const k = key();
  const first = await ledger.submit("transfer", { from: "alice", to: "bob", amount: 100 }, k);
  const count = ledger.proof().entry_count;
  const second = await ledger.submit("transfer", { amount: 100, to: "bob", from: "alice" }, k);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.body, first.body);
  assert.equal(second.status, first.status);
  assert.equal(ledger.proof().entry_count, count);
  assert.equal(ledger.balance("bob", "USD"), 100n);
  ledger.close();
});

await test("I6 same key with tampered payload -> 409 IDEMPOTENCY_CONFLICT, 0 rows", async () => {
  const ledger = await seeded();
  const k = key();
  await ledger.submit("transfer", { from: "alice", to: "bob", amount: 100 }, k);
  const count = ledger.proof().entry_count;
  const tampered = await ledger.submit("transfer", { from: "alice", to: "bob", amount: 9999 }, k);
  assert.equal(tampered.status, 409);
  assert.equal(tampered.body.error!.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(ledger.proof().entry_count, count);
  ledger.close();
});

await test("I6 business failures are also recorded and replayed deterministically", async () => {
  const ledger = await seeded();
  const k = key();
  const first = await ledger.submit("transfer", { from: "alice", to: "bob", amount: 50000 }, k);
  await ledger.submit("mint", { account_id: "alice", amount: 100000 }, key());
  const replay = await ledger.submit("transfer", { from: "alice", to: "bob", amount: 50000 }, k);
  assert.equal(first.body.error!.code, "INSUFFICIENT_FUNDS");
  assert.equal(replay.replayed, true);
  assert.equal(replay.body.error!.code, "INSUFFICIENT_FUNDS");
  assert.equal(ledger.balance("bob", "USD"), 0n);
  ledger.close();
});

await test("missing or malformed Idempotency-Key is rejected", async () => {
  const ledger = await seeded();
  assert.equal((await ledger.submit("transfer", { from: "alice", to: "bob", amount: 1 }, "")).body.error!.code, "VALIDATION");
  assert.equal((await ledger.submit("transfer", { from: "alice", to: "bob", amount: 1 }, "x".repeat(300))).body.error!.code, "VALIDATION");
  ledger.close();
});

await test("I7 system_at is strictly monotonic", async () => {
  const ledger = await seeded();
  for (let i = 0; i < 20; i++) await ledger.submit("transfer", { from: "alice", to: "bob", amount: 1 }, key());
  const times = ledger.journal(1000).map((e) => e.system_at);
  const txnTimes = [...new Set(times)].reverse();
  for (let i = 1; i < txnTimes.length; i++) assert.ok(txnTimes[i] > txnTimes[i - 1]);
  ledger.close();
});

await test("BEGIN IMMEDIATE contention: retries with backoff then succeeds", async () => {
  const path = tempDb();
  const ledger = new SqliteLedger(path);
  await ledger.submit("accounts", { account_id: "alice" }, key());
  const blocker = new DatabaseSync(path);
  blocker.exec("BEGIN IMMEDIATE");
  setTimeout(() => blocker.exec("COMMIT"), 40);
  const out = await ledger.submit("mint", { account_id: "alice", amount: 7 }, key());
  assert.equal(out.status, 201);
  assert.ok(ledger.stats.busyRetries > 0, "expected at least one busy retry");
  blocker.close();
  ledger.close();
});

await test("lock held forever -> 503 BUSY_EXHAUSTED, nothing written", async () => {
  const path = tempDb();
  const ledger = new SqliteLedger(path, { busyDeadlineMs: 50 });
  await ledger.submit("accounts", { account_id: "alice" }, key());
  const blocker = new DatabaseSync(path);
  blocker.exec("BEGIN IMMEDIATE");
  const out = await ledger.submit("mint", { account_id: "alice", amount: 7 }, key());
  blocker.exec("ROLLBACK");
  blocker.close();
  assert.equal(out.status, 503);
  assert.equal(out.body.error!.code, "BUSY_EXHAUSTED");
  assert.equal(ledger.balance("alice", "USD"), 0n);
  ledger.close();
});

await test("integrity_check is ok", async () => {
  const ledger = await seeded();
  assert.equal(ledger.integrityCheck(), "ok");
  ledger.close();
});

// --- regressions from adversary report (credit-leg overflow bricked /balances)

await test("REGRESSION max mint repeated until OVERFLOW 400; balances stay readable", async () => {
  const ledger = new SqliteLedger(tempDb());
  await ledger.submit("accounts", { account_id: "whale" }, key());
  const statuses: number[] = [];
  let overflow: Outcome | undefined;
  for (let i = 0; i < 12; i++) {
    const out = await ledger.submit("mint", { account_id: "whale", amount: "999999999999999999" }, key());
    statuses.push(out.status);
    if (out.status !== 201) {
      overflow = out;
      break;
    }
  }
  assert.ok(overflow, `expected OVERFLOW, got statuses ${statuses.join(",")}`);
  assert.equal(overflow.status, 400);
  assert.equal(overflow.body.error!.code, "OVERFLOW");
  assert.equal(statuses.filter((s) => s === 201).length, 9);
  assert.equal(ledger.balance("whale", "USD"), 9n * 999999999999999999n);
  assert.ok(ledger.balances().length > 0);
  const proof = ledger.proof();
  assert.deepEqual(proof.per_currency, { USD: "0" });
  assert.equal(proof.out_of_range_balances, 0);
  ledger.close();
});

await test("REGRESSION reserve debit is range-checked: total supply per currency <= MAX_I64", async () => {
  // Every user balance is bounded by total supply, so the reserve bound makes credit overflow unreachable.
  const ledger = new SqliteLedger(tempDb());
  await ledger.submit("accounts", { account_id: "a" }, key());
  await ledger.submit("accounts", { account_id: "b" }, key());
  const chunk = 999999999999999999n; // largest single request amount (18 digits)
  for (let i = 0; i < 9; i++) assert.equal((await ledger.submit("mint", { account_id: "a", amount: chunk.toString() }, key())).status, 201);
  const headroom = MAX_I64 - 9n * chunk;
  assert.equal((await ledger.submit("mint", { account_id: "b", amount: (headroom - 1n).toString() }, key())).status, 201);
  assert.equal((await ledger.submit("mint", { account_id: "b", amount: "1" }, key())).status, 201);
  const out = await ledger.submit("mint", { account_id: "b", amount: "1" }, key());
  assert.equal(out.body.error?.code, "OVERFLOW");
  assert.equal(ledger.balance(SYSTEM_RESERVE, "USD"), -MAX_I64);
  assert.equal(ledger.balance("b", "USD"), headroom);
  assert.equal(ledger.balances().length, 3);
  ledger.close();
});

await test("REGRESSION proof sums are overflow-safe across many max-size txns", async () => {
  const ledger = new SqliteLedger(tempDb());
  await ledger.submit("accounts", { account_id: "a" }, key());
  await ledger.submit("accounts", { account_id: "b" }, key());
  const big = "900000000000000000";
  await ledger.submit("mint", { account_id: "a", amount: big }, key());
  for (let i = 0; i < 12; i++) {
    const [from, to] = i % 2 === 0 ? ["a", "b"] : ["b", "a"];
    assert.equal((await ledger.submit("transfer", { from, to, amount: big }, key())).status, 201);
  }
  assert.deepEqual(ledger.proof().per_currency, { USD: "0" });
  assert.equal(ledger.balances().find((r) => r.account_id === "a")!.balance, big);
  ledger.close();
});

await test("REGRESSION system account ids are reserved for users (case-insensitive)", async () => {
  const ledger = new SqliteLedger(tempDb());
  for (const id of [...RESERVED_ACCOUNT_IDS, "9999-fee", "hold-escrow", "Hold-Escrow", "fx-pool"]) {
    const out = await ledger.submit("accounts", { account_id: id }, key());
    assert.equal(out.status, 400, id);
    assert.equal(out.body.error!.code, "VALIDATION", id);
  }
  ledger.close();
});

await test("REGRESSION journal limit tolerates NaN / non-integers", async () => {
  const ledger = await seeded();
  for (const limit of [Number.NaN, 1.5, -3, Infinity]) assert.ok(Array.isArray(ledger.journal(limit)));
  ledger.close();
});

await test("busy budget is a deadline, not an attempt count", async () => {
  const path = tempDb();
  const ledger = new SqliteLedger(path, { busyDeadlineMs: 150 });
  await ledger.submit("accounts", { account_id: "alice" }, key());
  const blocker = new DatabaseSync(path);
  blocker.exec("BEGIN IMMEDIATE");
  const started = performance.now();
  const out = await ledger.submit("mint", { account_id: "alice", amount: 1 }, key());
  const elapsed = performance.now() - started;
  blocker.exec("ROLLBACK");
  blocker.close();
  assert.equal(out.body.error!.code, "BUSY_EXHAUSTED");
  assert.ok(elapsed >= 150, `gave up after ${elapsed}ms`);
  ledger.close();
});

await test("I2 detector is live: a balance column anywhere in the schema is flagged", async () => {
  const path = tempDb();
  const ledger = new SqliteLedger(path);
  assert.equal(ledger.proof().schema_has_balance, false);
  const raw = new DatabaseSync(path);
  raw.exec("CREATE TABLE sneaky (account_id TEXT, Balance INTEGER)");
  raw.close();
  assert.equal(ledger.proof().schema_has_balance, true);
  ledger.close();
});

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
console.log(`\nstage-2: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
