// Deduplication layer (I6): token check + SHA-256 request digest.
// The idempotency row is read and written by the caller inside the same
// BEGIN IMMEDIATE transaction as the ledger entries, so a replay can never
// race a first execution.

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { LedgerError } from "./money.ts";

const KEY_PATTERN = /^[\x21-\x7e]{1,128}$/;

export function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function requestHash(route: string, body: unknown): string {
  return createHash("sha256").update(canonicalJson({ route, body })).digest("hex");
}

export function assertValidKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
    throw new LedgerError("VALIDATION", "Idempotency-Key header is required (1-128 printable ASCII chars)");
  }
}

export interface StoredResponse {
  status: number;
  responseJson: string;
}

export class IdempotencyStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  // Must be called inside the write transaction.
  // Returns the stored response for a matching replay, null for a fresh key,
  // and throws IDEMPOTENCY_CONFLICT when the key was used for a different request.
  lookup(key: string, hash: string): StoredResponse | null {
    const row = this.db
      .prepare("SELECT request_hash, status, response_json FROM idempotency WHERE key = ?")
      .get(key) as { request_hash: string; status: number | bigint; response_json: string } | undefined;
    if (!row) return null;
    if (row.request_hash !== hash) {
      throw new LedgerError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used with a different request payload");
    }
    return { status: Number(row.status), responseJson: row.response_json };
  }

  record(key: string, hash: string, status: number, responseJson: string, systemAt: number): void {
    this.db
      .prepare("INSERT INTO idempotency(key, request_hash, status, response_json, system_at) VALUES (?, ?, ?, ?, ?)")
      .run(key, hash, status, responseJson, systemAt);
  }
}
