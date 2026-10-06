// Operator gate for privileged routes (FX rates, pool liquidity).
// Disabled entirely unless OPERATOR_TOKEN is set; compared in constant time.

import { createHash, timingSafeEqual } from "node:crypto";

const digest = (s: string) => createHash("sha256").update(s).digest();

export function isOperator(header: string | string[] | undefined, token = process.env.OPERATOR_TOKEN): boolean {
  if (!token || typeof header !== "string" || header.length === 0) return false;
  return timingSafeEqual(digest(header), digest(token));
}

export function feePolicyFromEnv(env: NodeJS.ProcessEnv = process.env): { transferBps: number; fxBps: number } {
  const read = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 0 || n > 10_000) throw new Error(`${name} must be an integer 0..10000`);
    return n;
  };
  return { transferBps: read("TRANSFER_FEE_BPS", 10), fxBps: read("FX_FEE_BPS", 50) };
}
