// Races N worker_threads (one SQLite connection each, released by an Atomics
// barrier) alternating capture/release on the same hold. Used by test.ts (I9).

import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { SqliteLedger } from "./ledger.ts";

export interface RaceResult {
  status: number;
  code: string | null;
}

if (!isMainThread && workerData?.role === "hold-racer") {
  const { dbPath, barrier, holdId, index } = workerData as { dbPath: string; barrier: SharedArrayBuffer; holdId: string; index: number };
  const gate = new Int32Array(barrier);
  const ledger = new SqliteLedger(dbPath);
  Atomics.add(gate, 0, 1);
  Atomics.wait(gate, 1, 0);
  const out = index % 2 === 0
    ? await ledger.submit("capture", { hold_id: holdId, to: "q" }, `race-${index}`)
    : await ledger.submit("release", { hold_id: holdId }, `race-${index}`);
  ledger.close();
  parentPort!.postMessage({ status: out.status, code: out.body.error?.code ?? null } satisfies RaceResult);
}

export async function raceHold(dbPath: string, holdId: string, n: number): Promise<RaceResult[]> {
  const barrier = new SharedArrayBuffer(8);
  const gate = new Int32Array(barrier);
  const self = fileURLToPath(import.meta.url);
  const pending = Array.from(
    { length: n },
    (_, index) =>
      new Promise<RaceResult>((resolve, reject) => {
        const worker = new Worker(self, { workerData: { role: "hold-racer", dbPath, barrier, holdId, index }, execArgv: process.execArgv });
        worker.once("message", resolve);
        worker.once("error", reject);
      }),
  );
  while (Atomics.load(gate, 0) < n) await new Promise((r) => setTimeout(r, 2));
  Atomics.store(gate, 1, 1);
  Atomics.notify(gate, 1);
  return Promise.all(pending);
}
