import { useState } from "react";
import { api, compact, type Telemetry, type TestResult } from "./api.ts";
import { Button, Spinner, Status, cx } from "./ui.tsx";

export type Tab = "harness" | "band" | "invariants" | "artifacts";

const TABS: { id: Tab; label: string }[] = [
  { id: "harness", label: "Harness" },
  { id: "band", label: "BAND Room" },
  { id: "invariants", label: "Invariants" },
  { id: "artifacts", label: "Artifacts" },
];

export function TopBar({ tab, onTab, telemetry, onTests }: { tab: Tab; onTab: (t: Tab) => void; telemetry: Telemetry | null; onTests: () => void }) {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<TestResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runSuite() {
    setRunning(true);
    setError(null);
    const res = await api.post<TestResult[]>("/api/meta/tests", {});
    setRunning(false);
    if (res.ok) {
      setResults(res.data);
      onTests();
    } else setError(res.error.message);
  }

  return (
    <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
      <div className="mx-auto flex h-12 max-w-[1400px] items-center gap-6 px-5">
        <div className="text-[13px] font-semibold tracking-[0.18em] text-zinc-100">DARK FACTORY</div>
        <nav className="flex items-center gap-1" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => onTab(t.id)}
              className={cx(
                "h-8 rounded-md px-3 text-[13px] transition-colors",
                tab === t.id ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
              )}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-baseline gap-1.5 text-[12px] text-zinc-500" title="Journal entries across all four stages (live, 1s poll)">
            <span className="num text-[13px] font-medium text-zinc-200">{telemetry ? compact(telemetry.total_entries) : "—"}</span>
            journal entries
          </div>
          {telemetry &&
            (telemetry.all_conserved ? (
              <Status tone="good" title="Every currency in every stage sums to exactly 0">Σ = 0 conserved</Status>
            ) : (
              <Status tone="critical" title="A stage reports a non-zero sum">Σ ≠ 0 violation</Status>
            ))}
          <Button variant="primary" onClick={runSuite} disabled={running}>
            {running ? <Spinner /> : null}
            {running ? "Running…" : "Run Test Suite"}
          </Button>
        </div>
      </div>
      {(results || error) && (
        <div className="border-t border-zinc-800/80">
          <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-2 px-5 py-2 text-[12px]">
            <span className="text-zinc-500">Last suite run</span>
            {error && <Status tone="critical">{error}</Status>}
            {results?.map((r) => (
              <Status key={r.stage} tone={r.failed === 0 && r.passed > 0 ? "good" : "critical"} title={r.stdout_tail}>
                stage-{r.stage} {r.passed}/{r.passed + r.failed} · {r.duration_ms} ms
              </Status>
            ))}
            <button className="ml-auto text-zinc-500 hover:text-zinc-300" onClick={() => setResults(null)}>
              dismiss
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
