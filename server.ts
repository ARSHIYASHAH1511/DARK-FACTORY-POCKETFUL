// Unified DARK FACTORY server: mounts the four stage engines in-process under
// /api/s1..s4, adds /api/meta/* for the Command Center, and serves the built UI.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";

import { Ledger as Stage1Ledger, LedgerError as Stage1Error, SYSTEM_RESERVE } from "./stage-1/src/ledger.ts";
import { HTTP_STATUS as STAGE1_STATUS } from "./stage-1/src/money.ts";
import { SqliteLedger as Stage2Ledger, type Route as Route2 } from "./stage-2/src/ledger.ts";
import { StressPool, runStress, type StressReport } from "./stage-2/src/stress-test.ts";
import { SqliteLedger as Stage3Ledger, type AsOf, type Route as Route3 } from "./stage-3/src/ledger.ts";
import { SqliteLedger as Stage4Ledger, quoteFx, type Route as Route4 } from "./stage-4/src/ledger.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(ROOT, "data"));
const EVIDENCE_DIR = join(ROOT, "evidence");
const DIST_DIR = join(ROOT, "dist");
const PORT = Number(process.env.PORT ?? 3000);
const STARTED_AT = Date.now();

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(EVIDENCE_DIR, { recursive: true });

// ---------------------------------------------------------------- engines
const s1 = new Stage1Ledger();
const s2 = new Stage2Ledger(join(DATA_DIR, "stage-2.db"));
const s3 = new Stage3Ledger(join(DATA_DIR, "stage-3.db"));
const s4 = new Stage4Ledger(join(DATA_DIR, "stage-4.db"));
type DurableLedger = Stage2Ledger | Stage3Ledger | Stage4Ledger;
const durable: Record<string, DurableLedger> = { s2, s3, s4 };

// Demo seed. Fixed idempotency keys make it safe to run on every boot:
// a restart replays the stored responses and writes 0 new rows.
async function seed(): Promise<void> {
  for (const id of ["alice", "bob"]) s1.listAccounts().includes(id) || s1.openAccount(id);
  if (s1.balance("alice") === 0n) s1.mint("seed-s1-mint", "alice", 100_000);
  for (const [name, ledger] of Object.entries(durable)) {
    const submit = (route: string, body: Record<string, unknown>, key: string) =>
      (ledger.submit as (r: string, b: Record<string, unknown>, k: string) => Promise<unknown>)(route, body, `seed-${name}-${key}`);
    await submit("accounts", { account_id: "alice" }, "acct-alice");
    await submit("accounts", { account_id: "bob" }, "acct-bob");
    await submit("mint", { account_id: "alice", amount: 100_000 }, "mint-alice");
  }
  await s4.submit("accounts", { account_id: "eur_carol", currency: "EUR" }, "seed-s4-acct-carol");
  await s4.submit("fund_pool", { currency: "EUR", amount: 1_000_000 }, "seed-s4-pool-eur");
  await s4.submit("fund_pool", { currency: "USD", amount: 1_000_000 }, "seed-s4-pool-usd");
}

// ---------------------------------------------------------------- helpers
const json = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

function send(res: Response, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.status(status).set({ "content-type": "application/json", ...headers }).send(json(body));
}

const ok = (res: Response, data: unknown) => send(res, 200, { ok: true, data });
const fail = (res: Response, status: number, code: string, message: string) => send(res, status, { ok: false, error: { code, message } });

type Handler = (req: Request, res: Response) => unknown;
const wrap = (fn: Handler) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};

function idempotencyKey(req: Request): string {
  const key = req.headers["idempotency-key"];
  return typeof key === "string" ? key : "";
}

function mutation(ledger: DurableLedger, route: string, body: (req: Request) => Record<string, unknown> = (req) => req.body ?? {}) {
  return wrap(async (req, res) => {
    const out = await (ledger.submit as (r: string, b: Record<string, unknown>, k: string) => Promise<{ status: number; body: unknown; replayed: boolean }>)(
      route,
      body(req),
      idempotencyKey(req),
    );
    send(res, out.status, out.body, { "idempotent-replayed": String(out.replayed) });
  });
}

function asOf(req: Request): AsOf {
  const parse = (name: string) => {
    const raw = req.query[name];
    if (raw === undefined || raw === "") return undefined;
    if (typeof raw !== "string" || !/^[0-9]{1,15}$/.test(raw)) throw new HttpError(400, "VALIDATION", `${name} must be an integer epoch-ms timestamp`);
    return Number(raw);
  };
  return { validAt: parse("as_of_valid"), systemAt: parse("as_of_system") };
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function limitOf(req: Request): number {
  const n = Number(req.query.limit ?? 100);
  return Number.isInteger(n) ? Math.max(1, Math.min(1000, n)) : 100;
}

// ---------------------------------------------------------------- app
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

// Stage 1 — in-memory core (no idempotency layer by design).
let s1Seq = 0;
const s1Txn = () => `s1-${Date.now()}-${++s1Seq}`;
const s1Wire = (e: { entryId: number; txnId: string; accountId: string; amount: bigint }) => ({
  entry_id: e.entryId,
  txn_id: e.txnId,
  account_id: e.accountId,
  currency: "USD",
  amount: e.amount,
});
const s1Do = (fn: (req: Request) => unknown) =>
  wrap((req, res) => {
    try {
      send(res, 201, { ok: true, data: fn(req) });
    } catch (err) {
      if (err instanceof Stage1Error) return fail(res, STAGE1_STATUS[err.code], err.code, err.message);
      throw err;
    }
  });
app.post("/api/s1/accounts", s1Do((req) => {
  const a = s1.openAccount(req.body?.account_id);
  return { account_id: a.accountId, currency: "USD", created_at: a.createdAt };
}));
app.post("/api/s1/mint", s1Do((req) => {
  const id = s1Txn();
  return { txn_id: id, kind: "MINT", entries: s1.mint(id, req.body?.account_id, req.body?.amount).map(s1Wire) };
}));
app.post("/api/s1/transfer", s1Do((req) => {
  const id = s1Txn();
  return { txn_id: id, kind: "TRANSFER", entries: s1.transfer(id, req.body?.from, req.body?.to, req.body?.amount).map(s1Wire) };
}));
app.get("/api/s1/balances", (_req, res) => ok(res, s1.balances().map((b) => ({ account_id: b.accountId, currency: "USD", balance: b.balance }))));
app.get("/api/s1/journal", (req, res) => ok(res, [...s1.journal()].reverse().slice(0, limitOf(req)).map(s1Wire)));
app.get("/api/s1/proof", (_req, res) =>
  ok(res, {
    per_currency: s1.entryCount() ? { USD: s1.trialBalance() } : {},
    unbalanced_txns: s1.unbalancedTxns(),
    out_of_range_balances: 0,
    entry_count: s1.entryCount(),
    txn_count: s1.txnCount(),
    schema_has_balance: false,
    reserve: SYSTEM_RESERVE,
  }),
);

// Stages 2-4 — shared surface.
for (const [name, ledger] of Object.entries(durable)) {
  const base = `/api/${name}`;
  app.post(`${base}/accounts`, mutation(ledger, "accounts"));
  app.post(`${base}/mint`, mutation(ledger, "mint"));
  app.post(`${base}/transfer`, mutation(ledger, "transfer"));
  app.get(`${base}/journal`, (req, res) => ok(res, ledger.journal(limitOf(req))));
  app.get(`${base}/proof`, (_req, res) => ok(res, ledger.proof()));
  app.get(`${base}/balances`, wrap((req, res) => ok(res, name === "s2" ? s2.balances() : (ledger as Stage3Ledger).balances(asOf(req)))));
}

// Stage 2 — concurrency fuzzer on a warm worker pool (created on first use, kept for the server's life).
let pool: StressPool | null = null;
let fuzzRunning = false;
let lastFuzz: (StressReport & { at: number; pool_size: number }) | null = null;
app.post("/api/s2/fuzz", wrap(async (req, res) => {
  if (fuzzRunning) return fail(res, 429, "FUZZ_IN_PROGRESS", "a fuzz run is already in progress");
  fuzzRunning = true;
  try {
    pool ??= new StressPool(100);
    const int = (v: unknown, fallback: number) => (Number.isSafeInteger(v) ? (v as number) : fallback);
    const concurrency = Math.min(pool.size, Math.max(2, Math.floor(int(req.body?.concurrency, 100) / 2) * 2));
    const replays = Math.min(pool.size, Math.max(2, int(req.body?.replays, 50)));
    const report = await runStress({ concurrency, replays, pool });
    lastFuzz = { ...report, at: Date.now(), pool_size: pool.size };
    ok(res, lastFuzz);
  } finally {
    fuzzRunning = false;
  }
}));

// Stage 3 & 4 — bitemporal.
for (const [name, ledger] of [["s3", s3], ["s4", s4]] as const) {
  app.post(`/api/${name}/reverse/:txn_id`, mutation(ledger, "reverse", (req) => ({ txn_id: req.params.txn_id })));
  app.get(`/api/${name}/timeline`, (_req, res) => ok(res, ledger.timeline()));
  app.get(`/api/${name}/history/:account_id`, wrap((req, res) => ok(res, ledger.history(String(req.params.account_id)))));
}

// Stage 4 — FX, fees, escrow.
app.post("/api/s4/fx", mutation(s4, "fx"));
app.post("/api/s4/fund-pool", mutation(s4, "fund_pool"));
app.post("/api/s4/holds", mutation(s4, "hold"));
app.post("/api/s4/holds/:id/capture", mutation(s4, "capture", (req) => ({ ...(req.body ?? {}), hold_id: req.params.id })));
app.post("/api/s4/holds/:id/release", mutation(s4, "release", (req) => ({ ...(req.body ?? {}), hold_id: req.params.id })));
app.get("/api/s4/holds", (_req, res) => ok(res, s4.holds()));
app.get("/api/s4/holds/:id", wrap((req, res) => ok(res, s4.hold(String(req.params.id)))));
app.get("/api/s4/fx/quote", wrap((req, res) => {
  const int = (name: string, fallback?: string) => {
    const raw = (req.query[name] as string | undefined) ?? fallback;
    if (raw === undefined || !/^(0|[1-9][0-9]{0,9})$/.test(raw)) throw new HttpError(400, "VALIDATION", `${name} must be a non-negative integer`);
    return BigInt(raw);
  };
  const amount = int("amount");
  const rate = int("rate_bps");
  const fee = int("fee_bps", "0");
  if (amount < 1n || rate < 1n || fee > 9_999n) throw new HttpError(400, "VALIDATION", "amount >= 1, rate_bps >= 1, fee_bps <= 9999");
  ok(res, { amount, rate_bps: rate, fee_bps: fee, ...quoteFx(amount, rate, fee) });
}));

// ---------------------------------------------------------------- meta
function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function proofs() {
  const p1 = { per_currency: s1.entryCount() ? { USD: s1.trialBalance().toString() } : {}, unbalanced_txns: s1.unbalancedTxns(), out_of_range_balances: 0, entry_count: s1.entryCount(), txn_count: s1.txnCount(), schema_has_balance: false };
  return { s1: p1, s2: s2.proof(), s3: s3.proof(), s4: s4.proof() };
}

app.get("/api/meta/telemetry", (_req, res) => {
  const p = proofs();
  const stages = Object.entries(p).map(([stage, proof]) => ({
    stage,
    entry_count: proof.entry_count,
    txn_count: proof.txn_count,
    per_currency: proof.per_currency,
    unbalanced_txns: proof.unbalanced_txns,
    conserved: Object.values(proof.per_currency).every((v) => v === "0") && proof.unbalanced_txns === 0 && proof.out_of_range_balances === 0,
  }));
  ok(res, {
    uptime_ms: Date.now() - STARTED_AT,
    total_entries: stages.reduce((s, x) => s + x.entry_count, 0),
    total_txns: stages.reduce((s, x) => s + x.txn_count, 0),
    all_conserved: stages.every((s) => s.conserved),
    stages,
    last_fuzz: lastFuzz,
  });
});

// Test runner: fixed argv only, one run per stage at a time.
const testsRunning = new Set<number>();
function runStageTest(stage: number): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise) => {
    const started = performance.now();
    execFile(process.execPath, [join(ROOT, `stage-${stage}`, "src", "test.ts")], { cwd: ROOT, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const summary = stdout.match(/(\d+) passed, (\d+) failed/);
      const result = {
        stage,
        passed: summary ? Number(summary[1]) : 0,
        failed: summary ? Number(summary[2]) : 1,
        exit_code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        duration_ms: Math.round(performance.now() - started),
        node: process.version,
        at: new Date().toISOString(),
        stdout_tail: (stdout + (stderr ? `\n${stderr}` : "")).split("\n").filter((l) => !/ExperimentalWarning|--trace-warnings/.test(l)).slice(-40).join("\n"),
      };
      writeFileSync(join(EVIDENCE_DIR, `stage-${stage}.json`), JSON.stringify(result, null, 2));
      resolvePromise(result);
    });
  });
}

app.post("/api/meta/tests", wrap(async (req, res) => {
  const requested = req.body?.stage;
  const stages = requested === undefined ? [1, 2, 3, 4] : [Number(requested)];
  if (!stages.every((s) => [1, 2, 3, 4].includes(s))) throw new HttpError(400, "VALIDATION", "stage must be 1-4");
  if (stages.some((s) => testsRunning.has(s))) return fail(res, 429, "TESTS_IN_PROGRESS", "tests for that stage are already running");
  stages.forEach((s) => testsRunning.add(s));
  try {
    const results = await Promise.all(stages.map(runStageTest));
    ok(res, results);
  } finally {
    stages.forEach((s) => testsRunning.delete(s));
  }
}));

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return "";
  }
}

const SEATS = [
  { seat: "architect", title: "Architect", file: "01_architect.md" },
  { seat: "implementer", title: "Implementer", file: "02_implementer.md" },
  { seat: "adversary", title: "Adversary", file: "03_adversary.md" },
  { seat: "verifier", title: "Verifier", file: "04_verifier.md" },
];

app.get("/api/meta/band", (_req, res) => {
  const mandateDir = join(ROOT, ".band", "mandates");
  const seats = SEATS.map((s) => {
    const path = join(mandateDir, s.file);
    return { ...s, mandate: existsSync(path) ? readFileSync(path, "utf8") : null };
  });
  const stageEvidence = [1, 2, 3, 4].map((n) => readJsonFile<{ passed: number; failed: number; at: string }>(join(EVIDENCE_DIR, `stage-${n}.json`)));
  const green = (n: number) => {
    const e = stageEvidence[n - 1];
    return e ? (e.failed === 0 && e.passed > 0 ? "done" : "failed") : "pending";
  };
  const adversary = readJsonFile<{ certified_stages?: number[]; at?: string }>(join(EVIDENCE_DIR, "adversary.json"));
  const build = readJsonFile<{ duration_ms: number; at: string }>(join(EVIDENCE_DIR, "build.json"));
  const release = readJsonFile<{ verified?: boolean; commit?: string; at?: string }>(join(EVIDENCE_DIR, "release.json"));
  const milestones = [
    { id: 1, label: "Spec published", status: existsSync(join(ROOT, "plan.md")) ? "done" : "pending", source: "plan.md" },
    { id: 2, label: "Stage 1 green", status: green(1), source: "evidence/stage-1.json" },
    { id: 3, label: "Stage 2 green", status: green(2), source: "evidence/stage-2.json" },
    { id: 4, label: "Adversary certified", status: adversary?.certified_stages?.includes(2) ? "done" : "pending", source: "evidence/adversary.json" },
    { id: 5, label: "Stage 3 green", status: green(3), source: "evidence/stage-3.json" },
    { id: 6, label: "Stage 4 green", status: green(4), source: "evidence/stage-4.json" },
    { id: 7, label: "UI + unified server build", status: build && existsSync(join(DIST_DIR, "index.html")) ? "done" : "pending", source: "evidence/build.json", detail: build ? `${build.duration_ms} ms` : undefined },
    { id: 8, label: "Release verified", status: release?.verified ? "done" : "pending", source: "evidence/release.json" },
  ];
  const commits = git(["log", "-n", "20", "--pretty=format:%h%x09%an%x09%ad%x09%s", "--date=iso"])
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [hash, author, date, subject] = l.split("\t");
      return { hash, author, date, subject };
    });
  ok(res, { seats, milestones, commits });
});

function trackedFiles(): string[] {
  return git(["ls-files", "--cached", "--others", "--exclude-standard"])
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f && existsSync(join(ROOT, f)));
}

app.get("/api/meta/compliance", (_req, res) => {
  const terms = (process.env.LEAK_TERMS ?? "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const mandateDir = join(ROOT, ".band", "mandates");
  const mandates = existsSync(mandateDir) ? readdirSync(mandateDir).filter((f) => f.endsWith(".md")) : [];
  let matches = 0;
  for (const f of mandates) {
    const text = readFileSync(join(mandateDir, f), "utf8").toLowerCase();
    for (const t of terms) matches += text.split(t).length - 1;
  }
  const docker = readJsonFile<unknown>(join(EVIDENCE_DIR, "docker.json"));
  ok(res, {
    leak_scan: terms.length ? { configured: true, term_count: terms.length, files_scanned: mandates.length, matches } : { configured: false, files_scanned: mandates.length, matches: null },
    proofs: proofs(),
    docker: docker ?? { status: "NOT RUN", note: "evidence/docker.json not present" },
    fuzz: lastFuzz,
  });
});

app.get("/api/meta/files", (_req, res) => ok(res, trackedFiles()));
app.get("/api/meta/file", wrap((req, res) => {
  const path = String(req.query.path ?? "");
  if (!trackedFiles().includes(path)) throw new HttpError(400, "VALIDATION", "path is not a tracked repository file");
  const full = join(ROOT, path);
  if (statSync(full).size > 512 * 1024) throw new HttpError(400, "VALIDATION", "file larger than 512KB");
  ok(res, { path, content: readFileSync(full, "utf8") });
}));

app.use("/api", (_req, res) => fail(res, 404, "NOT_FOUND", "no such API route"));

// ---------------------------------------------------------------- UI
if (existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR, { index: false, maxAge: "1h" }));
  app.get("/{*splat}", (_req, res) => res.sendFile(join(DIST_DIR, "index.html")));
} else {
  app.get("/", (_req, res) => res.type("text").send("UI not built. Run `npm run build` (or `npm start`)."));
}

// ---------------------------------------------------------------- errors
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) return fail(res, err.status, err.code, err.message);
  const e = err as { type?: string; status?: number; code?: string; message?: string };
  if (e?.type === "entity.too.large") return fail(res, 413, "PAYLOAD_TOO_LARGE", "body exceeds 64kb");
  if (e?.type === "entity.parse.failed") return fail(res, 400, "VALIDATION", "invalid JSON body");
  if (e?.code && typeof e.code === "string" && /^[A-Z_]+$/.test(e.code) && e.message) {
    const status = e.code.startsWith("UNKNOWN_") ? 404 : 400;
    return fail(res, status, e.code, e.message);
  }
  console.error(err);
  fail(res, 500, "INTERNAL", "internal error");
});

await seed();
app.listen(PORT, () => console.log(`DARK FACTORY command center on http://localhost:${PORT}`));
