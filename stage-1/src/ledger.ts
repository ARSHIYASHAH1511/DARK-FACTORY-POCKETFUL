// Stage 1 — in-memory double-entry ledger.
// I1  every transaction's signed entries sum to exactly 0n
// I2  no stored balances: balance(a) = SUM(entries where account = a)
// I3  entries are append-only and frozen
// I4  amounts are positive integer cents (bigint); entries carry the sign
// I5  only the System Reserve (0000-0000) may go negative

import { LedgerError, checkedAdd, parseAmount } from "./money.ts";

export { LedgerError } from "./money.ts";
export const SYSTEM_RESERVE = "0000-0000";

export interface Leg {
  accountId: string;
  amount: bigint; // signed cents
}

export interface Entry {
  readonly entryId: number;
  readonly txnId: string;
  readonly accountId: string;
  readonly amount: bigint;
}

export interface AccountRecord {
  readonly accountId: string;
  readonly createdAt: number;
}

export class Ledger {
  private readonly accounts = new Map<string, AccountRecord>();
  private readonly entries: Entry[] = [];
  private readonly txnIds = new Set<string>();

  constructor() {
    this.openAccount(SYSTEM_RESERVE);
  }

  openAccount(accountId: string): AccountRecord {
    if (typeof accountId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(accountId)) {
      throw new LedgerError("VALIDATION", "account_id must be 1-64 chars of [A-Za-z0-9_-]");
    }
    if (this.accounts.has(accountId)) throw new LedgerError("DUPLICATE_ACCOUNT", `account already exists: ${accountId}`);
    const record = Object.freeze({ accountId, createdAt: Date.now() });
    this.accounts.set(accountId, record);
    return record;
  }

  accountRecord(accountId: string): AccountRecord {
    const record = this.accounts.get(accountId);
    if (!record) throw new LedgerError("UNKNOWN_ACCOUNT", `unknown account: ${accountId}`);
    return record;
  }

  listAccounts(): string[] {
    return [...this.accounts.keys()];
  }

  balance(accountId: string): bigint {
    this.accountRecord(accountId);
    let sum = 0n;
    for (const e of this.entries) if (e.accountId === accountId) sum += e.amount;
    return sum;
  }

  balances(): { accountId: string; balance: bigint }[] {
    return this.listAccounts().map((accountId) => ({ accountId, balance: this.balance(accountId) }));
  }

  trialBalance(): bigint {
    return this.entries.reduce((sum, e) => sum + e.amount, 0n);
  }

  unbalancedTxns(): number {
    const sums = new Map<string, bigint>();
    for (const e of this.entries) sums.set(e.txnId, (sums.get(e.txnId) ?? 0n) + e.amount);
    return [...sums.values()].filter((s) => s !== 0n).length;
  }

  entryCount(): number {
    return this.entries.length;
  }

  txnCount(): number {
    return this.txnIds.size;
  }

  entriesFor(txnId: string): Entry[] {
    return this.entries.filter((e) => e.txnId === txnId);
  }

  journal(): readonly Entry[] {
    return this.entries;
  }

  // Validates everything up front, then appends all legs: all-or-nothing.
  post(txnId: string, legs: Leg[]): Entry[] {
    if (!txnId) throw new LedgerError("VALIDATION", "txn_id cannot be empty");
    if (this.txnIds.has(txnId)) throw new LedgerError("DUPLICATE_TXN", `duplicate transaction: ${txnId}`);
    if (legs.length < 2) throw new LedgerError("VALIDATION", "a transaction needs at least two legs");

    const seen = new Set<string>();
    let sum = 0n;
    for (const leg of legs) {
      this.accountRecord(leg.accountId);
      if (seen.has(leg.accountId)) throw new LedgerError("VALIDATION", `account appears twice in transaction: ${leg.accountId}`);
      seen.add(leg.accountId);
      if (typeof leg.amount !== "bigint" || leg.amount === 0n) throw new LedgerError("VALIDATION", "leg amount must be a non-zero bigint");
      sum += leg.amount;
    }
    if (sum !== 0n) throw new LedgerError("VALIDATION", `zero-sum violation: legs sum to ${sum}`);

    for (const leg of legs) {
      const after = checkedAdd(this.balance(leg.accountId), leg.amount);
      if (after < 0n && leg.accountId !== SYSTEM_RESERVE) {
        throw new LedgerError("INSUFFICIENT_FUNDS", `insufficient funds in ${leg.accountId}`);
      }
    }

    const base = this.entries.length + 1;
    const committed = legs.map((leg, i) =>
      Object.freeze({ entryId: base + i, txnId, accountId: leg.accountId, amount: leg.amount }),
    );
    this.entries.push(...committed);
    this.txnIds.add(txnId);
    return committed;
  }

  transfer(txnId: string, from: string, to: string, amount: unknown): Entry[] {
    const cents = parseAmount(amount);
    if (from === to) throw new LedgerError("VALIDATION", "debit and credit accounts must differ");
    return this.post(txnId, [
      { accountId: from, amount: -cents },
      { accountId: to, amount: cents },
    ]);
  }

  mint(txnId: string, to: string, amount: unknown): Entry[] {
    return this.transfer(txnId, SYSTEM_RESERVE, to, amount);
  }
}
