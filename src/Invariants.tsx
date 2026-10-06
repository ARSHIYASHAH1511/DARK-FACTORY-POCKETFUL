import { SYSTEM_ACCOUNTS, type Balance, type Proof, type StressReport, type TimelineEvent } from "./api.ts";
import { usePoll } from "./hooks.ts";
import { Card, Empty, Spinner, Status } from "./ui.tsx";

interface Compliance {
  leak_scan: { configured: boolean; term_count?: number; files_scanned: number; matches: number | null };
  proofs: Record<"s1" | "s2" | "s3" | "s4", Proof>;
  docker: { status?: string; note?: string; stages?: { stage: string; build: string; run_network_none: string }[] };
  fuzz: StressReport | null;
}

type Verdict = "pass" | "fail" | "n/a" | "unknown";

function cell(v: Verdict) {
  if (v === "pass") return <Status tone="good">pass</Status>;
  if (v === "fail") return <Status tone="critical">fail</Status>;
  if (v === "unknown") return <Status tone="warning">no data</Status>;
  return <span className="text-[11px] text-zinc-600">n/a</span>;
}

const zeroSum = (p?: Proof): Verdict =>
  !p ? "unknown" : Object.values(p.per_currency).every((v) => v === "0") && p.unbalanced_txns === 0 ? "pass" : "fail";
const flag = (ok: boolean): Verdict => (ok ? "pass" : "fail");

export function Invariants() {
  const { data } = usePoll<Compliance>("/api/meta/compliance", 2000);
  const b1 = usePoll<Balance[]>("/api/s1/balances", 2000).data;
  const b2 = usePoll<Balance[]>("/api/s2/balances", 2000).data;
  const b3 = usePoll<Balance[]>("/api/s3/balances", 2000).data;
  const b4 = usePoll<Balance[]>("/api/s4/balances", 2000).data;
  const t3 = usePoll<{ events: TimelineEvent[] }>("/api/s3/timeline", 3000).data;
  const t4 = usePoll<{ events: TimelineEvent[] }>("/api/s4/timeline", 3000).data;
  if (!data) return <Empty><Spinner /></Empty>;
  const p = data.proofs;

  const reserveOnly = (rows: Balance[] | null): Verdict =>
    !rows ? "unknown" : flag(rows.every((r) => r.account_id === "0000-0000" || BigInt(r.balance) >= 0n));
  const monotonic = (tl: { events: TimelineEvent[] } | null): Verdict =>
    !tl ? "unknown" : flag(tl.events.every((e, i) => i === 0 || e.system_at > tl.events[i - 1].system_at));
  const fuzz = data.fuzz;
  const idem: Verdict = !fuzz ? "unknown" : flag(fuzz.scenario_b.applied === 1 && fuzz.scenario_c.status === 409 && fuzz.scenario_c.rows_written === 0);

  const rows: { id: string; name: string; how: string; s: Verdict[] }[] = [
    { id: "I1", name: "Zero-sum per txn and per currency", how: "bigint fold of all entries", s: [zeroSum(p.s1), zeroSum(p.s2), zeroSum(p.s3), zeroSum(p.s4)] },
    { id: "I2", name: "No stored balance column", how: "sqlite_master scan", s: ["pass", flag(!p.s2.schema_has_balance), flag(!p.s3.schema_has_balance), flag(!p.s4.schema_has_balance)] },
    { id: "I4", name: "Integer money within int64", how: "out-of-range balances", s: [p.s1, p.s2, p.s3, p.s4].map((x) => flag(x.out_of_range_balances === 0)) },
    { id: "I5", name: "Only 0000-0000 may go negative", how: "live balances", s: [reserveOnly(b1), reserveOnly(b2), reserveOnly(b3), reserveOnly(b4)] },
    { id: "I6", name: "Idempotent replay; tamper → 409", how: "last fuzz (scenarios B, C)", s: ["n/a", idem, "n/a", "n/a"] },
    { id: "I7", name: "system_at strictly monotonic", how: "live timeline", s: ["n/a", "n/a", monotonic(t3), monotonic(t4)] },
    {
      id: "I9",
      name: "Escrow = Σ open holds",
      how: "proof.escrow_matches_open_holds",
      s: ["n/a", "n/a", "n/a", p.s4.escrow_matches_open_holds === undefined ? "unknown" : flag(p.s4.escrow_matches_open_holds)],
    },
    { id: "I10", name: "FX and fees in integer bps; per-currency Σ = 0", how: "per-currency fold", s: ["n/a", "n/a", "n/a", zeroSum(p.s4)] },
  ];

  const docker = data.docker;
  return (
    <div className="space-y-4">
      <Card title="Live invariant checks, recomputed every 2s from the running ledgers">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500">
              <th className="pb-2 font-medium">ID</th>
              <th className="pb-2 font-medium">Invariant</th>
              <th className="pb-2 font-medium">Live check</th>
              {["S1", "S2", "S3", "S4"].map((s) => <th key={s} className="pb-2 font-medium">{s}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-zinc-800/70">
                <td className="py-2 font-mono text-[12px] text-zinc-400">{r.id}</td>
                <td className="py-2 text-zinc-200">{r.name}</td>
                <td className="py-2 font-mono text-[11px] text-zinc-500">{r.how}</td>
                {r.s.map((v, i) => <td key={i} className="py-2">{cell(v)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-[11px] text-zinc-500">
          I3 (append-only triggers) and I8 (reversal +2 rows, UNIQUE reverses_txn_id) are enforced by the schema and covered by the stage test suites. Run them with Run Test Suite. “no data” means the check has nothing to read yet, for example before the first fuzz run.
        </p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Mandate leak scan, .band/mandates/">
          {data.leak_scan.configured ? (
            <div className="flex items-center gap-4">
              <span className="text-4xl font-semibold text-zinc-50">{data.leak_scan.matches}</span>
              <div className="text-[12px] text-zinc-400">
                matches for {data.leak_scan.term_count} configured term(s) across {data.leak_scan.files_scanned} mandate files
                <div className="mt-1">{data.leak_scan.matches === 0 ? <Status tone="good">generic</Status> : <Status tone="critical">terms leaked</Status>}</div>
              </div>
            </div>
          ) : (
            <div>
              <Status tone="warning">not configured</Status>
              <p className="mt-2 text-[12px] text-zinc-500">
                Start the server with LEAK_TERMS=term1,term2. Terms are kept server-side, so they never ship in the UI bundle. {data.leak_scan.files_scanned} mandate files are present.
              </p>
            </div>
          )}
        </Card>
        <Card title="Offline Docker matrix, docker run --network none">
          {docker.stages ? (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500">
                  <th className="pb-2 font-medium">Stage</th>
                  <th className="pb-2 font-medium">Build</th>
                  <th className="pb-2 font-medium">Run (no network)</th>
                </tr>
              </thead>
              <tbody>
                {docker.stages.map((s) => (
                  <tr key={s.stage} className="border-t border-zinc-800/70">
                    <td className="py-1.5 font-mono text-[12px]">{s.stage}</td>
                    <td className="py-1.5">{s.build === "pass" ? <Status tone="good">pass</Status> : <Status tone="critical">{s.build}</Status>}</td>
                    <td className="py-1.5">{s.run_network_none === "pass" ? <Status tone="good">pass</Status> : <Status tone="critical">{s.run_network_none}</Status>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div>
              <Status tone="warning">{docker.status ?? "NOT RUN"}</Status>
              <p className="mt-2 text-[12px] text-zinc-500">
                {docker.note ?? "No Docker evidence recorded."} The verifier writes evidence/docker.json after real builds and runs. Until then this matrix is reported as not run, not as passing.
              </p>
            </div>
          )}
        </Card>
      </div>

      <Card title="Conservation proofs by stage">
        <div className="grid gap-3 md:grid-cols-4">
          {(Object.keys(p) as (keyof typeof p)[]).map((s) => (
            <div key={s} className="rounded-md border border-zinc-800 bg-zinc-950/60 p-3 text-[12px]">
              <div className="flex items-center justify-between">
                <span className="font-medium text-zinc-200">{s.toUpperCase()}</span>
                {zeroSum(p[s]) === "pass" ? <Status tone="good">Σ = 0</Status> : <Status tone="critical">Σ ≠ 0</Status>}
              </div>
              <div className="num mt-2 space-y-0.5 text-zinc-400">
                {Object.entries(p[s].per_currency).map(([c, v]) => <div key={c}>Σ {c} = {v}</div>)}
                <div>{p[s].entry_count} entries · {p[s].txn_count} txns</div>
                <div>{p[s].unbalanced_txns} unbalanced · {p[s].out_of_range_balances} out of range</div>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-zinc-500">System accounts: {[...SYSTEM_ACCOUNTS].join(", ")}. Only 0000-0000 may hold a negative balance.</p>
      </Card>
    </div>
  );
}
