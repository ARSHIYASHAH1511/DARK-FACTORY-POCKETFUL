// Stage 2 chaos harness. DatabaseSync is synchronous, so HTTP requests inside
// one process would serialize on the event loop and never contend for the
// lock. Instead every request runs in its own worker_thread with its own
// SQLite connection, and all workers are released at once by an Atomics barrier.
//
//   A  100 workers each withdraw 100 from acc_victim (balance 5000), unique keys
//      -> exactly 50 OK, 50 INSUFFICIENT_FUNDS, victim = 0, 0 BUSY_EXHAUSTED
//   B  50 workers replay one identical key + payload -> 1 applied, 49 replayed
//   C  same key, tampered amount -> 409 IDEMPOTENCY_CONFLICT, 0 rows written
//   D  PRAGMA integrity_check = ok, per-currency global sum = 0

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { SqliteLedger, type Route } from "./ledger.ts";

interface Job {
  route: Route;
  body: Record<string, unknown>;
  key: string;
}

interface JobResult {
  status: number;
  code: string | null;
  replayed: boolean;
  latencyMs: number;
  busyRetries: number;
  finishedAt: number;
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
}

// ---------------------------------------------------------------- worker side
interface JobMessage {
  dbPath: string;
  barrier: SharedArrayBuffer;
  job: Job;
}

// Opens a private connection, signals ready, blocks on the barrier, then fires.
async function runJob({ dbPath, barrier, job }: JobMessage): Promise<JobResult> {
  const gate = new Int32Array(barrier);
  const ledger = new SqliteLedger(dbPath);
  Atomics.add(gate, 0, 1); // ready
  Atomics.wait(gate, 1, 0); // block until go flag flips
  const start = performance.now();
  const out = await ledger.submit(job.route, job.body, job.key);
  const result: JobResult = {
    status: out.status,
    code: out.body.error?.code ?? null,
    replayed: out.replayed,
    latencyMs: performance.now() - start,
    busyRetries: ledger.stats.busyRetries,
    finishedAt: performance.timeOrigin + performance.now(),
  };
  ledger.close();
  return result;
}

if (!isMainThread && workerData?.role === "stress-worker") {
  parentPort!.postMessage(await runJob(workerData as JobMessage));
}
if (!isMainThread && workerData?.role === "stress-pool-worker") {
  parentPort!.on("message", async (msg: JobMessage) => parentPort!.postMessage(await runJob(msg)));
}

// ---------------------------------------------------------------- main side
type Blast = (dbPath: string, jobs: Job[]) => Promise<{ results: JobResult[]; wallMs: number }>;

const SELF = fileURLToPath(import.meta.url);

// Releases all jobs at once; wall time is measured from the barrier, so
// isolate start-up and connection opening never count toward throughput.
async function release(gate: Int32Array, n: number, pending: Promise<JobResult>[]) {
  while (Atomics.load(gate, 0) < n) await new Promise((r) => setTimeout(r, 2));
  const goAt = performance.timeOrigin + performance.now();
  Atomics.store(gate, 1, 1);
  Atomics.notify(gate, 1);
  const results = await Promise.all(pending);
  return { results, wallMs: Math.max(...results.map((r) => r.finishedAt)) - goAt };
}

// CLI default: one fresh worker per job.
const spawnPerJob: Blast = async (dbPath, jobs) => {
  const barrier = new SharedArrayBuffer(8);
  const pending = jobs.map(
    (job) =>
      new Promise<JobResult>((resolve, reject) => {
        const worker = new Worker(SELF, { workerData: { role: "stress-worker", dbPath, barrier, job }, execArgv: process.execArgv });
        worker.once("message", resolve);
        worker.once("error", reject);
        worker.once("exit", (code) => code !== 0 && reject(new Error(`worker exited ${code}`)));
      }),
  );
  return release(new Int32Array(barrier), jobs.length, pending);
};

// Long-lived servers: workers are created once and reused for every run.
export class StressPool {
  readonly size: number;
  private readonly workers: Worker[];

  constructor(size = 100) {
    this.size = size;
    this.workers = Array.from({ length: size }, () => {
      const worker = new Worker(SELF, { workerData: { role: "stress-pool-worker" }, execArgv: process.execArgv });
      worker.unref();
      return worker;
    });
  }

  readonly blast: Blast = async (dbPath, jobs) => {
    if (jobs.length > this.size) throw new Error(`pool has ${this.size} workers, run needs ${jobs.length}`);
    const barrier = new SharedArrayBuffer(8);
    const pending = jobs.map(
      (job, i) =>
        new Promise<JobResult>((resolve, reject) => {
          const worker = this.workers[i];
          const onError = (err: Error) => reject(err);
          worker.once("error", onError);
          worker.once("message", (r: JobResult) => {
            worker.off("error", onError);
            resolve(r);
          });
          worker.postMessage({ dbPath, barrier, job } satisfies JobMessage);
        }),
    );
    return release(new Int32Array(barrier), jobs.length, pending);
  };

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const round = (n: number) => Math.round(n * 100) / 100;

export async function runStress(options: { concurrency?: number; replays?: number; pool?: StressPool } = {}): Promise<StressReport> {
  const concurrency = options.concurrency ?? 100;
  const replays = options.replays ?? 50;
  const blast: Blast = options.pool ? options.pool.blast : spawnPerJob;
  const perRequest = 100;
  const victimFunding = (concurrency / 2) * perRequest; // exactly half can succeed

  const dir = mkdtempSync(join(tmpdir(), "df-stress-"));
  const dbPath = join(dir, "ledger.db");
  const setup = new SqliteLedger(dbPath);
  try {
    let k = 0;
    for (const id of ["acc_victim", "acc_sink", "acc_donor"]) await setup.submit("accounts", { account_id: id }, `setup-${k++}`);
    await setup.submit("mint", { account_id: "acc_victim", amount: victimFunding }, `setup-${k++}`);
    await setup.submit("mint", { account_id: "acc_donor", amount: 1_000 }, `setup-${k++}`);

    const violations: string[] = [];

    // A — concurrent withdrawals racing the overdraft check
    const a = await blast(
      dbPath,
      Array.from({ length: concurrency }, (_, i) => ({
        route: "transfer" as const,
        body: { from: "acc_victim", to: "acc_sink", amount: perRequest },
        key: `victim-${i}`,
      })),
    );
    const aOk = a.results.filter((r) => r.status === 201).length;
    const aNsf = a.results.filter((r) => r.code === "INSUFFICIENT_FUNDS").length;
    const victim = setup.balance("acc_victim", "USD");
    const sink = setup.balance("acc_sink", "USD");
    if (aOk !== concurrency / 2) violations.push(`A: expected ${concurrency / 2} OK, got ${aOk}`);
    if (aNsf !== concurrency / 2) violations.push(`A: expected ${concurrency / 2} INSUFFICIENT_FUNDS, got ${aNsf}`);
    if (victim !== 0n) violations.push(`A: victim balance ${victim}, expected 0`);
    if (sink !== BigInt(victimFunding)) violations.push(`A: sink balance ${sink}, expected ${victimFunding}`);

    // B — identical replays racing each other
    const replayJob = { route: "transfer" as const, body: { from: "acc_donor", to: "acc_sink", amount: 7 }, key: "replay-storm" };
    const b = await blast(dbPath, Array.from({ length: replays }, () => replayJob));
    const bApplied = b.results.filter((r) => r.status === 201 && !r.replayed).length;
    const bReplayed = b.results.filter((r) => r.status === 201 && r.replayed).length;
    const donorDebited = 1_000n - setup.balance("acc_donor", "USD");
    if (bApplied !== 1) violations.push(`B: expected 1 applied, got ${bApplied}`);
    if (bReplayed !== replays - 1) violations.push(`B: expected ${replays - 1} replayed, got ${bReplayed}`);
    if (donorDebited !== 7n) violations.push(`B: donor debited ${donorDebited}, expected 7`);

    // C — tampered payload under a used key
    const before = setup.proof().entry_count;
    const c = await setup.submit("transfer", { ...replayJob.body, amount: 700 }, replayJob.key);
    const rowsWritten = setup.proof().entry_count - before;
    if (c.status !== 409 || c.body.error?.code !== "IDEMPOTENCY_CONFLICT") violations.push(`C: expected 409 IDEMPOTENCY_CONFLICT, got ${c.status}`);
    if (rowsWritten !== 0) violations.push(`C: ${rowsWritten} rows written`);

    // D — storage integrity and global conservation
    const integrity = setup.integrityCheck();
    const proof = setup.proof();
    if (integrity !== "ok") violations.push(`D: integrity_check = ${integrity}`);
    for (const [cur, sum] of Object.entries(proof.per_currency)) if (sum !== "0") violations.push(`D: ${cur} global sum ${sum}`);
    if (proof.unbalanced_txns !== 0) violations.push(`D: ${proof.unbalanced_txns} unbalanced txns`);
    if (proof.schema_has_balance) violations.push("D: schema contains a balance column");

    const all = [...a.results, ...b.results];
    const busyExhausted = all.filter((r) => r.code === "BUSY_EXHAUSTED").length;
    if (busyExhausted > 0) violations.push(`${busyExhausted} requests ended in BUSY_EXHAUSTED`);
    const doubleSpends = Math.max(0, aOk - concurrency / 2) + (victim < 0n ? 1 : 0) + Math.max(0, bApplied - 1);
    const latencies = a.results.map((r) => r.latencyMs);

    return {
      concurrency,
      replays,
      throughput_rps: round((concurrency / a.wallMs) * 1000),
      wall_ms: round(a.wallMs),
      p50_ms: round(percentile(latencies, 50)),
      p99_ms: round(percentile(latencies, 99)),
      busy_retries: all.reduce((s, r) => s + r.busyRetries, 0),
      busy_exhausted: busyExhausted,
      scenario_a: { ok: aOk, insufficient_funds: aNsf, other: concurrency - aOk - aNsf, victim_balance: victim.toString(), sink_balance: sink.toString() },
      scenario_b: { applied: bApplied, replayed: bReplayed, other: replays - bApplied - bReplayed, donor_debited: donorDebited.toString() },
      scenario_c: { status: c.status, code: c.body.error?.code ?? null, rows_written: rowsWritten },
      scenario_d: { integrity_check: integrity, per_currency: proof.per_currency, unbalanced_txns: proof.unbalanced_txns, schema_has_balance: proof.schema_has_balance },
      double_spends: doubleSpends,
      violations,
      passed: violations.length === 0,
    };
  } finally {
    setup.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (isMainThread && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = await runStress();
  console.log(JSON.stringify(report, null, 2));
  console.log(report.passed ? "\nstage-2 stress: PASS" : `\nstage-2 stress: FAIL\n  ${report.violations.join("\n  ")}`);
  process.exit(report.passed ? 0 : 1);
}
