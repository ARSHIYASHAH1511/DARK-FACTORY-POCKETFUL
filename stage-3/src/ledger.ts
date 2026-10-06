// Stage 3 — bitemporal double-entry ledger on SQLite (WAL) with idempotent writes.
// Builds on stage 2 (BEGIN IMMEDIATE write lock, SHA-256 idempotency, append-only
// triggers) and adds two time axes per transaction:
//   valid_at   business-effective time, client-supplied (defaults to system_at)
//   system_at  commit time, strictly monotonic, assigned under the write lock
// Corrections never mutate history: reverse(T) appends a REVERSAL txn whose
// entries are T's negated, with valid_at = T.valid_at and reverses_txn_id = T (UNIQUE).
// No-overdraft (I5) holds at every valid-time point at or after a debit's valid_at.

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { IdempotencyStore, assertValidKey, requestHash } from "./idempotency.ts";
import { HTTP_STATUS, LedgerError, MAX_I64, checkedAdd, parseAmount } from "./money.ts";

export { LedgerError } from "./money.ts";
export const SYSTEM_RESERVE = "0000-0000";
export const RESERVED_ACCOUNT_IDS = [SYSTEM_RESERVE, "9999-FEE", "HOLD-ESCROW", "FX-POOL"] as const;

export type Route = "accounts" | "mint" | "transfer" | "reverse";

export interface AsOf {
  validAt?: number; // include txns with valid_at <= validAt
  systemAt?: number; // include txns with system_at <= systemAt
}

const MAX_VALID_AT = 253_402_300_799_999; // 9999-12-31T23:59:59.999Z

function parseValidAt(input: unknown, fallback: number): number {
  if (input === undefined) return fallback;
  const n = typeof input === "string" && /^[1-9][0-9]{0,14}$/.test(input) ? Number(input) : input;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0 || n > MAX_VALID_AT) {
    throw new LedgerError("VALIDATION", "valid_at must be a positive integer epoch-ms timestamp");
  }
  return n;
}

export interface Envelope {
  ok: boolean;
  data?: any;
  error?: { code: string; message: string };
}

export interface Outcome {
  status: number;
  body: Envelope;
  replayed: boolean;
}

export interface LedgerOptions {
  busyDeadlineMs?: number; // keep retrying SQLITE_BUSY until this long after the first attempt
  maxBackoffMs?: number;
}

interface Leg {
  accountId: string;
  currency: string;
  amount: bigint;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  currency   TEXT NOT NULL CHECK (length(currency) = 3),
  kind       TEXT NOT NULL CHECK (kind IN ('USER','SYSTEM')),
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS transactions (
  txn_id          TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('MINT','TRANSFER','FX','REVERSAL','HOLD','CAPTURE','RELEASE')),
  valid_at        INTEGER NOT NULL,
  system_at       INTEGER NOT NULL UNIQUE,
  reverses_txn_id TEXT UNIQUE REFERENCES transactions(txn_id),
  memo            TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS entries (
  entry_id   INTEGER PRIMARY KEY,
  txn_id     TEXT NOT NULL REFERENCES transactions(txn_id),
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  currency   TEXT NOT NULL,
  amount     INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount <> 0)
) STRICT;
CREATE INDEX IF NOT EXISTS entries_by_account ON entries(account_id, currency);
CREATE INDEX IF NOT EXISTS entries_by_txn ON entries(txn_id);
CREATE TABLE IF NOT EXISTS idempotency (
  key           TEXT PRIMARY KEY,
  request_hash  TEXT NOT NULL,
  status        INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  system_at     INTEGER NOT NULL
) STRICT;
${["accounts", "transactions", "entries", "idempotency"]
  .flatMap((t) => [
    `CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT, 'append-only: ${t}'); END;`,
    `CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, 'append-only: ${t}'); END;`,
  ])
  .join("\n")}
`;

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CURRENCY = /^[A-Z]{3}$/;

export function isBusy(err: unknown): boolean {
  const e = err as { errcode?: number; message?: string };
  return (e?.errcode !== undefined && (e.errcode & 0xff) === 5) || /database is locked|SQLITE_BUSY/i.test(e?.message ?? "");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export const toJson = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

function errorOutcome(err: LedgerError): Outcome {
  return { status: HTTP_STATUS[err.code], body: { ok: false, error: { code: err.code, message: err.message } }, replayed: false };
}

export class SqliteLedger {
  readonly db: DatabaseSync;
  readonly stats = { busyRetries: 0, busyExhausted: 0, commits: 0 };
  private readonly idem: IdempotencyStore;
  private readonly busyDeadlineMs: number;
  private readonly maxBackoffMs: number;

  constructor(path: string, options: LedgerOptions = {}) {
    this.busyDeadlineMs = options.busyDeadlineMs ?? 30_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 50;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 0");
    this.initSync(() => {
      this.db.exec("PRAGMA journal_mode = WAL");
    });
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL");
    this.initSync(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(SCHEMA);
        this.db
          .prepare("INSERT OR IGNORE INTO accounts(account_id, currency, kind, created_at) VALUES (?, '***', 'SYSTEM', ?)")
          .run(SYSTEM_RESERVE, Date.now());
        this.db.exec("COMMIT");
      } catch (err) {
        this.rollbackQuietly();
        throw err;
      }
    });
    this.idem = new IdempotencyStore(this.db);
  }

  close(): void {
    this.db.close();
  }

  // Construction is synchronous; many workers may open the same file at once.
  private initSync(fn: () => void): void {
    const deadline = performance.now() + this.busyDeadlineMs;
    for (let attempt = 0; ; attempt++) {
      try {
        return fn();
      } catch (err) {
        if (!isBusy(err) || performance.now() >= deadline) throw err;
        this.stats.busyRetries++;
        sleepSync(this.backoff(attempt));
      }
    }
  }

  private backoff(attempt: number): number {
    const ceiling = Math.min(this.maxBackoffMs, 2 ** attempt);
    return Math.max(1, Math.round(ceiling / 2 + Math.random() * (ceiling / 2)));
  }

  private rollbackQuietly(): void {
    try {
      this.db.exec("ROLLBACK");
    } catch {
      // no transaction open
    }
  }

  // Runs fn while holding the database's single write lock.
  async withWriteTxn<T>(fn: () => T): Promise<T> {
    const started = performance.now();
    for (let attempt = 0; ; attempt++) {
      try {
        this.db.exec("BEGIN IMMEDIATE");
        break;
      } catch (err) {
        if (!isBusy(err)) throw err;
        const remaining = started + this.busyDeadlineMs - performance.now();
        if (remaining <= 0) {
          this.stats.busyExhausted++;
          throw new LedgerError("BUSY_EXHAUSTED", `write lock not acquired within ${this.busyDeadlineMs}ms (${attempt + 1} attempts)`);
        }
        this.stats.busyRetries++;
        await sleep(Math.min(remaining, this.backoff(attempt)));
      }
    }
    try {
      const result = fn();
      this.initSync(() => this.db.exec("COMMIT"));
      this.stats.commits++;
      return result;
    } catch (err) {
      this.rollbackQuietly();
      throw err;
    }
  }

  async submit(route: Route, body: Record<string, unknown>, key: string): Promise<Outcome> {
    try {
      assertValidKey(key);
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new LedgerError("VALIDATION", "body must be a JSON object");
      }
      const hash = requestHash(route, body);
      return await this.withWriteTxn(() => {
        const stored = this.idem.lookup(key, hash);
        if (stored) return { status: stored.status, body: JSON.parse(stored.responseJson), replayed: true };

        const systemAt = this.nextSystemAt();
        let status: number;
        let envelope: Envelope;
        this.db.exec("SAVEPOINT op");
        try {
          const data = this.apply(route, body, systemAt);
          this.db.exec("RELEASE op");
          status = 201;
          envelope = { ok: true, data };
        } catch (err) {
          this.db.exec("ROLLBACK TO op");
          this.db.exec("RELEASE op");
          if (!(err instanceof LedgerError)) throw err;
          status = HTTP_STATUS[err.code];
          envelope = { ok: false, error: { code: err.code, message: err.message } };
        }
        const json = toJson(envelope);
        this.idem.record(key, hash, status, json, systemAt);
        return { status, body: JSON.parse(json) as Envelope, replayed: false };
      });
    } catch (err) {
      if (err instanceof LedgerError) return errorOutcome(err);
      throw err;
    }
  }

  private apply(route: Route, body: Record<string, unknown>, systemAt: number): unknown {
    switch (route) {
      case "accounts":
        return this.openAccount(body.account_id, body.currency ?? "USD", systemAt);
      case "mint": {
        const amount = parseAmount(body.amount);
        const validAt = parseValidAt(body.valid_at, systemAt);
        const account = this.userAccount(body.account_id);
        return this.post("MINT", [
          { accountId: SYSTEM_RESERVE, currency: account.currency, amount: -amount },
          { accountId: account.account_id, currency: account.currency, amount },
        ], systemAt, validAt);
      }
      case "reverse":
        return this.reverse(body.txn_id, systemAt);
      case "transfer": {
        const amount = parseAmount(body.amount);
        const validAt = parseValidAt(body.valid_at, systemAt);
        if (body.from === body.to) throw new LedgerError("VALIDATION", "debit and credit accounts must differ");
        const from = this.userAccount(body.from);
        const to = this.userAccount(body.to);
        if (from.currency !== to.currency) {
          throw new LedgerError("CURRENCY_MISMATCH", `${from.account_id} is ${from.currency}, ${to.account_id} is ${to.currency}`);
        }
        return this.post("TRANSFER", [
          { accountId: from.account_id, currency: from.currency, amount: -amount },
          { accountId: to.account_id, currency: to.currency, amount },
        ], systemAt, validAt);
      }
      default:
        throw new LedgerError("VALIDATION", `unknown route: ${String(route)}`);
    }
  }

  private openAccount(accountId: unknown, currency: unknown, systemAt: number) {
    if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId)) {
      throw new LedgerError("VALIDATION", "account_id must be 1-64 chars of [A-Za-z0-9_-]");
    }
    if ((RESERVED_ACCOUNT_IDS as readonly string[]).includes(accountId.toUpperCase())) {
      throw new LedgerError("VALIDATION", `${accountId} is a reserved system account id`);
    }
    if (typeof currency !== "string" || !CURRENCY.test(currency)) throw new LedgerError("VALIDATION", "currency must be a 3-letter ISO code");
    if (this.db.prepare("SELECT 1 FROM accounts WHERE account_id = ?").get(accountId)) {
      throw new LedgerError("DUPLICATE_ACCOUNT", `account already exists: ${accountId}`);
    }
    const createdAt = systemAt;
    this.db.prepare("INSERT INTO accounts(account_id, currency, kind, created_at) VALUES (?, ?, 'USER', ?)").run(accountId, currency, createdAt);
    return { account_id: accountId, currency, kind: "USER", created_at: createdAt };
  }

  private account(accountId: unknown): { account_id: string; currency: string; kind: string } {
    const row = typeof accountId === "string"
      ? this.db.prepare("SELECT account_id, currency, kind FROM accounts WHERE account_id = ?").get(accountId)
      : undefined;
    if (!row) throw new LedgerError("UNKNOWN_ACCOUNT", `unknown account: ${String(accountId)}`);
    return row as { account_id: string; currency: string; kind: string };
  }

  private userAccount(accountId: unknown) {
    const account = this.account(accountId);
    if (account.kind !== "USER") throw new LedgerError("VALIDATION", `${account.account_id} is a system account`);
    return account;
  }

  private nextSystemAt(): number {
    const row = this.db.prepare("SELECT MAX(system_at) AS last FROM transactions").get() as { last: number | null };
    return Math.max(Date.now(), (row.last ?? 0) + 1);
  }

  // Lowest balance the account reaches at any valid-time point >= validAt
  // (the balance at validAt itself, then after each later valid_at group).
  private minBalanceFrom(accountId: string, currency: string, validAt: number): bigint {
    const stmt = this.db.prepare(`
      SELECT t.valid_at AS valid_at, e.amount AS amount
      FROM entries e JOIN transactions t ON t.txn_id = e.txn_id
      WHERE e.account_id = ? AND e.currency = ?
      ORDER BY t.valid_at, e.entry_id`);
    stmt.setReadBigInts(true);
    const rows = stmt.all(accountId, currency) as { valid_at: bigint; amount: bigint }[];
    const v = BigInt(validAt);
    let cum = 0n;
    let i = 0;
    while (i < rows.length && rows[i].valid_at <= v) cum += rows[i++].amount;
    let min = cum;
    while (i < rows.length) {
      const t = rows[i].valid_at;
      while (i < rows.length && rows[i].valid_at === t) cum += rows[i++].amount;
      if (cum < min) min = cum;
    }
    return min;
  }

  // Must run inside withWriteTxn. Validates I1, I4 (int64 range) and I5, then appends.
  private post(kind: string, legs: Leg[], systemAt: number, validAt: number = systemAt, reversesTxnId: string | null = null) {
    const perCurrency = new Map<string, bigint>();
    for (const leg of legs) perCurrency.set(leg.currency, (perCurrency.get(leg.currency) ?? 0n) + leg.amount);
    for (const [currency, sum] of perCurrency) {
      if (sum !== 0n) throw new LedgerError("VALIDATION", `zero-sum violation in ${currency}: ${sum}`);
    }
    for (const leg of legs) {
      // Every leg, credits included: a balance outside int64 would make SUM() overflow forever.
      checkedAdd(this.balance(leg.accountId, leg.currency), leg.amount);
      if (leg.amount < 0n && leg.accountId !== SYSTEM_RESERVE) {
        if (this.minBalanceFrom(leg.accountId, leg.currency, validAt) + leg.amount < 0n) {
          throw new LedgerError("INSUFFICIENT_FUNDS", `insufficient funds in ${leg.accountId} at or after valid_at ${validAt}`);
        }
      }
    }

    const txnId = randomUUID();
    this.db
      .prepare("INSERT INTO transactions(txn_id, kind, valid_at, system_at, reverses_txn_id) VALUES (?, ?, ?, ?, ?)")
      .run(txnId, kind, validAt, systemAt, reversesTxnId);
    const insert = this.db.prepare("INSERT INTO entries(txn_id, account_id, currency, amount) VALUES (?, ?, ?, ?)");
    for (const leg of legs) insert.run(txnId, leg.accountId, leg.currency, leg.amount);

    // Defense in depth: re-prove I1 from what was actually written.
    const check = this.db.prepare("SELECT COUNT(*) AS bad FROM (SELECT currency FROM entries WHERE txn_id = ? GROUP BY currency HAVING SUM(amount) <> 0)").get(txnId) as { bad: number };
    if (Number(check.bad) !== 0) throw new Error(`I1 violated after insert for ${txnId}`);

    return {
      txn_id: txnId,
      kind,
      valid_at: validAt,
      system_at: systemAt,
      reverses_txn_id: reversesTxnId,
      entries: legs.map((l) => ({ account_id: l.accountId, currency: l.currency, amount: l.amount })),
    };
  }

  // Must run inside withWriteTxn. Appends the inverse of txnId; never touches the original rows.
  private reverse(txnId: unknown, systemAt: number) {
    if (typeof txnId !== "string" || txnId.length === 0 || txnId.length > 64) {
      throw new LedgerError("VALIDATION", "txn_id is required");
    }
    const original = this.db.prepare("SELECT txn_id, kind, valid_at FROM transactions WHERE txn_id = ?").get(txnId) as
      | { txn_id: string; kind: string; valid_at: number }
      | undefined;
    if (!original) throw new LedgerError("UNKNOWN_TXN", `unknown transaction: ${txnId}`);
    if (original.kind === "REVERSAL") throw new LedgerError("REVERSAL_OF_REVERSAL", "a reversal cannot itself be reversed");
    if (this.db.prepare("SELECT 1 FROM transactions WHERE reverses_txn_id = ?").get(txnId)) {
      throw new LedgerError("ALREADY_REVERSED", `transaction already reversed: ${txnId}`);
    }
    const stmt = this.db.prepare("SELECT account_id, currency, amount FROM entries WHERE txn_id = ? ORDER BY entry_id");
    stmt.setReadBigInts(true);
    const legs = (stmt.all(txnId) as { account_id: string; currency: string; amount: bigint }[]).map((e) => ({
      accountId: e.account_id,
      currency: e.currency,
      amount: -e.amount,
    }));
    return this.post("REVERSAL", legs, systemAt, Number(original.valid_at), txnId);
  }

  balance(accountId: string, currency: string): bigint {
    this.account(accountId);
    const stmt = this.db.prepare("SELECT COALESCE(SUM(amount), 0) AS balance FROM entries WHERE account_id = ? AND currency = ?");
    stmt.setReadBigInts(true);
    return (stmt.get(accountId, currency) as { balance: bigint }).balance;
  }

  // A system-time cut can only look at the past: the ledger cannot know what it has not yet recorded.
  private checkAsOf(asOf: AsOf): void {
    if (asOf.systemAt === undefined) return;
    const row = this.db.prepare("SELECT MAX(system_at) AS last FROM transactions").get() as { last: number | null };
    if (asOf.systemAt > Math.max(Date.now(), Number(row.last ?? 0))) {
      throw new LedgerError("VALIDATION", "as_of_system cannot be in the future");
    }
  }

  balanceAsOf(accountId: string, currency: string, asOf: AsOf): bigint {
    this.checkAsOf(asOf);
    this.account(accountId);
    return this.fold(asOf).byAccount.get(`${accountId}|${currency}`) ?? 0n;
  }

  balancesAsOf(asOf: AsOf) {
    return this.balances(asOf);
  }

  // Folds entries with bigint (no intermediate SQLite SUM() can overflow),
  // optionally restricted to a bitemporal as-of cut.
  private fold(asOf: AsOf = {}): { byAccount: Map<string, bigint>; byCurrency: Map<string, bigint>; byTxn: Map<string, bigint> } {
    const byAccount = new Map<string, bigint>();
    const byCurrency = new Map<string, bigint>();
    const byTxn = new Map<string, bigint>();
    const stmt = this.db.prepare(`
      SELECT e.txn_id, e.account_id, e.currency, e.amount
      FROM entries e JOIN transactions t ON t.txn_id = e.txn_id
      WHERE (?1 IS NULL OR t.valid_at <= ?1) AND (?2 IS NULL OR t.system_at <= ?2)
      ORDER BY e.entry_id`);
    stmt.setReadBigInts(true);
    for (const r of stmt.iterate(asOf.validAt ?? null, asOf.systemAt ?? null) as Iterable<{ txn_id: string; account_id: string; currency: string; amount: bigint }>) {
      const ak = `${r.account_id}|${r.currency}`;
      const tk = `${r.txn_id}|${r.currency}`;
      byAccount.set(ak, (byAccount.get(ak) ?? 0n) + r.amount);
      byCurrency.set(r.currency, (byCurrency.get(r.currency) ?? 0n) + r.amount);
      byTxn.set(tk, (byTxn.get(tk) ?? 0n) + r.amount);
    }
    return { byAccount, byCurrency, byTxn };
  }

  timeline() {
    const events = (this.db.prepare("SELECT txn_id, kind, valid_at, system_at, reverses_txn_id FROM transactions ORDER BY system_at").all() as {
      txn_id: string;
      kind: string;
      valid_at: number;
      system_at: number;
      reverses_txn_id: string | null;
    }[]).map((e) => ({ ...e, valid_at: Number(e.valid_at), system_at: Number(e.system_at) }));
    return {
      min_system_at: events.length ? events[0].system_at : null,
      max_system_at: events.length ? events[events.length - 1].system_at : null,
      events,
    };
  }

  history(accountId: string) {
    this.account(accountId);
    const stmt = this.db.prepare(`
      SELECT e.entry_id, e.txn_id, e.currency, e.amount, t.kind, t.valid_at, t.system_at, t.reverses_txn_id
      FROM entries e JOIN transactions t ON t.txn_id = e.txn_id
      WHERE e.account_id = ? ORDER BY t.system_at, e.entry_id`);
    stmt.setReadBigInts(true);
    return (stmt.all(accountId) as Record<string, bigint | string | null>[]).map((r) => ({
      entry_id: Number(r.entry_id),
      txn_id: r.txn_id as string,
      currency: r.currency as string,
      amount: (r.amount as bigint).toString(),
      kind: r.kind as string,
      valid_at: Number(r.valid_at),
      system_at: Number(r.system_at),
      reverses_txn_id: r.reverses_txn_id as string | null,
    }));
  }

  balances(asOf: AsOf = {}): { account_id: string; currency: string; balance: string }[] {
    this.checkAsOf(asOf);
    const { byAccount } = this.fold(asOf);
    const accounts = this.db
      .prepare("SELECT account_id, currency FROM accounts WHERE (?1 IS NULL OR created_at <= ?1) ORDER BY account_id")
      .all(asOf.systemAt ?? null) as { account_id: string; currency: string }[];
    const rows: { account_id: string; currency: string; balance: string }[] = [];
    for (const a of accounts) {
      const held = [...byAccount.entries()].filter(([k]) => k.startsWith(`${a.account_id}|`));
      if (held.length === 0 && a.currency !== "***") rows.push({ account_id: a.account_id, currency: a.currency, balance: "0" });
      for (const [k, v] of held) rows.push({ account_id: a.account_id, currency: k.split("|")[1], balance: v.toString() });
    }
    return rows;
  }

  journal(limit = 100) {
    const stmt = this.db.prepare(`
      SELECT e.entry_id, e.txn_id, e.account_id, e.currency, e.amount, t.kind, t.valid_at, t.system_at
      FROM entries e JOIN transactions t ON t.txn_id = e.txn_id
      ORDER BY e.entry_id DESC LIMIT ?`);
    stmt.setReadBigInts(true);
    const safeLimit = Number.isInteger(limit) ? Math.max(1, Math.min(1000, limit)) : 100;
    return (stmt.all(safeLimit) as Record<string, bigint | string>[]).map((r) => ({
      entry_id: Number(r.entry_id),
      txn_id: r.txn_id as string,
      account_id: r.account_id as string,
      currency: r.currency as string,
      amount: (r.amount as bigint).toString(),
      kind: r.kind as string,
      valid_at: Number(r.valid_at),
      system_at: Number(r.system_at),
    }));
  }

  proof() {
    const { byAccount, byCurrency, byTxn } = this.fold();
    const perCurrency: Record<string, string> = {};
    for (const [currency, total] of byCurrency) perCurrency[currency] = total.toString();
    const counts = this.db.prepare("SELECT (SELECT COUNT(*) FROM entries) AS entries, (SELECT COUNT(*) FROM transactions) AS txns").get() as {
      entries: number;
      txns: number;
    };
    const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").all() as { sql: string }[];
    return {
      per_currency: perCurrency,
      unbalanced_txns: [...byTxn.values()].filter((v) => v !== 0n).length,
      out_of_range_balances: [...byAccount.values()].filter((v) => v > MAX_I64 || v < -MAX_I64).length,
      entry_count: Number(counts.entries),
      txn_count: Number(counts.txns),
      schema_has_balance: schema.some((r) => /\bbalance\b/i.test(r.sql)),
    };
  }

  journalMode(): string {
    return (this.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
  }

  integrityCheck(): string {
    return (this.db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
  }
}
