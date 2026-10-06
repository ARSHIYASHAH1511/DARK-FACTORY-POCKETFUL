// Thin client for the unified server. Every value comes from the API; nothing is hardcoded.

export type Stage = "s1" | "s2" | "s3" | "s4";

export interface ApiError {
  code: string;
  message: string;
}

export type ApiResult<T> = { ok: true; data: T; status: number; replayed?: boolean } | { ok: false; error: ApiError; status: number };

async function call<T>(method: string, path: string, body?: unknown, idempotent = false): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (idempotent) headers["idempotency-key"] = crypto.randomUUID();
  try {
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json();
    if (json.ok) return { ok: true, data: json.data as T, status: res.status, replayed: res.headers.get("idempotent-replayed") === "true" };
    return { ok: false, error: json.error as ApiError, status: res.status };
  } catch (err) {
    return { ok: false, error: { code: "NETWORK", message: (err as Error).message }, status: 0 };
  }
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  // Stage 1 has no idempotency layer; stages 2-4 require a fresh key per user action.
  post: <T>(path: string, body: unknown = {}) => call<T>("POST", path, body, !path.startsWith("/api/s1/")),
};

export interface Balance {
  account_id: string;
  currency: string;
  balance: string;
}

export interface JournalEntry {
  entry_id: number;
  txn_id: string;
  account_id: string;
  currency: string;
  amount: string;
  kind?: string;
  valid_at?: number;
  system_at?: number;
}

export interface Proof {
  per_currency: Record<string, string>;
  unbalanced_txns: number;
  out_of_range_balances: number;
  entry_count: number;
  txn_count: number;
  schema_has_balance: boolean;
  escrow_matches_open_holds?: boolean;
}

export interface StressReport {
  concurrency: number;
  replays: number;
  throughput_rps: number;
  wall_ms: number;
  p50_ms: number;
  p99_ms: number;
  busy_retries: number;
  busy_exhausted: number;
  scenario_a: { ok: number; insufficient_funds: number; other: number; victim_balance: string; sink_balance: string };
  scenario_b: { applied: number; replayed: number; other: number; donor_debited: string };
  scenario_c: { status: number; code: string | null; rows_written: number };
  scenario_d: { integrity_check: string; per_currency: Record<string, string>; unbalanced_txns: number; schema_has_balance: boolean };
  double_spends: number;
  violations: string[];
  passed: boolean;
  at?: number;
  pool_size?: number;
}

export interface Telemetry {
  uptime_ms: number;
  total_entries: number;
  total_txns: number;
  all_conserved: boolean;
  stages: { stage: Stage; entry_count: number; txn_count: number; per_currency: Record<string, string>; unbalanced_txns: number; conserved: boolean }[];
  last_fuzz: StressReport | null;
}

export interface TestResult {
  stage: number;
  passed: number;
  failed: number;
  exit_code: number;
  duration_ms: number;
  at: string;
  stdout_tail: string;
}

export interface TimelineEvent {
  txn_id: string;
  kind: string;
  valid_at: number;
  system_at: number;
  reverses_txn_id: string | null;
}

export interface Hold {
  hold_id: string;
  state: "HELD" | "CAPTURED" | "RELEASED";
  payer: string;
  amount: string;
  currency: string;
  events: { event_id: number; state: string; txn_id: string }[];
}

export function formatCents(cents: string | number | bigint, currency = "USD"): string {
  const v = BigInt(cents);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "−" : ""}${whole}.${frac} ${currency === "***" ? "" : currency}`.trim();
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}

export const SYSTEM_ACCOUNTS = new Set(["0000-0000", "9999-FEE", "HOLD-ESCROW", "FX-POOL"]);
