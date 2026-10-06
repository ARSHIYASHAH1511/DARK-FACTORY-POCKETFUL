// Integer-cent money handling shared by the stage-2 engine and server (I4).

export type ErrorCode =
  | "VALIDATION"
  | "OVERFLOW"
  | "UNKNOWN_ACCOUNT"
  | "DUPLICATE_ACCOUNT"
  | "DUPLICATE_TXN"
  | "INSUFFICIENT_FUNDS"
  | "CURRENCY_MISMATCH"
  | "IDEMPOTENCY_CONFLICT"
  | "BUSY_EXHAUSTED";

export const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  OVERFLOW: 400,
  UNKNOWN_ACCOUNT: 404,
  DUPLICATE_ACCOUNT: 409,
  DUPLICATE_TXN: 409,
  INSUFFICIENT_FUNDS: 409,
  CURRENCY_MISMATCH: 409,
  IDEMPOTENCY_CONFLICT: 409,
  BUSY_EXHAUSTED: 503,
};

export class LedgerError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

export const MAX_I64 = 2n ** 63n - 1n;
const DIGITS = /^[1-9][0-9]{0,17}$/;

// Accepts a positive digit string or a positive safe-integer number; returns bigint cents.
export function parseAmount(input: unknown): bigint {
  if (typeof input === "bigint") {
    if (input <= 0n) throw new LedgerError("VALIDATION", "amount must be a positive integer number of cents");
    if (input > MAX_I64) throw new LedgerError("OVERFLOW", "amount exceeds 64-bit range");
    return input;
  }
  if (typeof input === "number" && Number.isSafeInteger(input) && input > 0) return BigInt(input);
  if (typeof input === "string" && DIGITS.test(input)) return BigInt(input);
  if (typeof input === "string" && /^[0-9]+$/.test(input) && BigInt(input) > MAX_I64) {
    throw new LedgerError("OVERFLOW", "amount exceeds 64-bit range");
  }
  throw new LedgerError("VALIDATION", `amount must be a positive integer number of cents, got ${String(input)}`);
}

export function checkedAdd(a: bigint, b: bigint): bigint {
  const r = a + b;
  if (r > MAX_I64 || r < -MAX_I64) throw new LedgerError("OVERFLOW", "balance exceeds 64-bit range");
  return r;
}
