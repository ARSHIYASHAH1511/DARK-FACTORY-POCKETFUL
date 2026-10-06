import assert from "node:assert/strict";
import { Ledger, LedgerError, SYSTEM_RESERVE } from "./ledger.ts";
import { parseAmount } from "./money.ts";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${(err as Error).message}`);
  }
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof LedgerError) return err.code;
    throw err;
  }
  throw new Error("expected LedgerError, nothing thrown");
}

function fresh(): Ledger {
  const ledger = new Ledger();
  ledger.openAccount("alice");
  ledger.openAccount("bob");
  return ledger;
}

console.log("stage-1: double-entry zero-sum engine");

test("system reserve 0000-0000 exists on construction", () => {
  assert.equal(new Ledger().balance(SYSTEM_RESERVE), 0n);
});

test("I5 mint moves cents from system reserve to account", () => {
  const ledger = fresh();
  ledger.mint("t1", "alice", 10_000);
  assert.equal(ledger.balance("alice"), 10_000n);
  assert.equal(ledger.balance(SYSTEM_RESERVE), -10_000n);
});

test("transfer debits sender and credits receiver", () => {
  const ledger = fresh();
  ledger.mint("t1", "alice", "10000");
  ledger.transfer("t2", "alice", "bob", 2_500);
  assert.equal(ledger.balance("alice"), 7_500n);
  assert.equal(ledger.balance("bob"), 2_500n);
});

test("I1 every transaction writes two signed entries summing to zero", () => {
  const ledger = fresh();
  ledger.mint("t1", "alice", 500);
  const entries = ledger.entriesFor("t1");
  assert.equal(entries.length, 2);
  assert.equal(entries.reduce((s, e) => s + e.amount, 0n), 0n);
});

test("I1 trial balance is zero after many postings", () => {
  const ledger = fresh();
  ledger.mint("t0", "alice", 10_000);
  for (let i = 0; i < 50; i++) {
    const [from, to] = i % 2 === 0 ? ["alice", "bob"] : ["bob", "alice"];
    ledger.transfer(`t-${i + 1}`, from, to, 1);
  }
  assert.equal(ledger.trialBalance(), 0n);
  assert.equal(ledger.unbalancedTxns(), 0);
});

test("I2 balance is folded from entries (no stored balance field)", () => {
  const ledger = fresh();
  ledger.mint("t1", "alice", 300);
  assert.ok(!/balance/i.test(JSON.stringify(ledger.accountRecord("alice"))));
});

for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1e3", "-1", "0", "01", " 1", null, undefined, {}]) {
  test(`I4 rejects bad amount ${typeof bad === "string" ? JSON.stringify(bad) : String(bad)} with 0 rows written`, () => {
    const ledger = fresh();
    ledger.mint("t1", "alice", 1_000);
    const before = ledger.entryCount();
    assert.equal(code(() => ledger.transfer("t2", "alice", "bob", bad)), "VALIDATION");
    assert.equal(ledger.entryCount(), before);
  });
}

test("I4 rejects amount beyond int64 with OVERFLOW", () => {
  assert.equal(code(() => parseAmount("9223372036854775808")), "OVERFLOW");
});

test("I4 accepts large digit strings as exact bigint", () => {
  const ledger = fresh();
  ledger.mint("t1", "alice", "900000000000000001");
  assert.equal(ledger.balance("alice"), 900000000000000001n);
});

test("I5 rejects overdraft on customer account", () => {
  const ledger = fresh();
  ledger.mint("t1", "alice", 100);
  assert.equal(code(() => ledger.transfer("t2", "alice", "bob", 101)), "INSUFFICIENT_FUNDS");
  assert.equal(ledger.balance("alice"), 100n);
});

test("rejects self-transfer", () => {
  const ledger = fresh();
  ledger.mint("t1", "alice", 100);
  assert.equal(code(() => ledger.transfer("t2", "alice", "alice", 1)), "VALIDATION");
});

test("rejects unknown accounts", () => {
  assert.equal(code(() => fresh().mint("t1", "ghost", 1)), "UNKNOWN_ACCOUNT");
});

test("rejects duplicate transaction id", () => {
  const ledger = fresh();
  ledger.mint("t1", "alice", 100);
  assert.equal(code(() => ledger.mint("t1", "alice", 100)), "DUPLICATE_TXN");
  assert.equal(ledger.balance("alice"), 100n);
});

test("I1 rejects unbalanced multi-leg posting atomically", () => {
  const ledger = fresh();
  assert.equal(
    code(() => ledger.post("t1", [{ accountId: "alice", amount: 100n }, { accountId: SYSTEM_RESERVE, amount: -99n }])),
    "VALIDATION",
  );
  assert.equal(ledger.entryCount(), 0);
});

test("rejects duplicate account open and invalid ids", () => {
  const ledger = fresh();
  assert.equal(code(() => ledger.openAccount("alice")), "DUPLICATE_ACCOUNT");
  assert.equal(code(() => ledger.openAccount("")), "VALIDATION");
});

test("I3 entries are frozen (append-only)", () => {
  const ledger = fresh();
  ledger.mint("t1", "alice", 100);
  const [entry] = ledger.entriesFor("t1");
  assert.throws(() => {
    (entry as { amount: bigint }).amount = 999_999n;
  }, TypeError);
  assert.equal(ledger.balance("alice"), 100n);
});

console.log(`\nstage-1: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
