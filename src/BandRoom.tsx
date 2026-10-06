import { useState } from "react";
import { usePoll } from "./hooks.ts";
import { Card, Empty, Spinner, Status, cx } from "./ui.tsx";

interface Band {
  seats: { seat: string; title: string; file: string; mandate: string | null }[];
  milestones: { id: number; label: string; status: "done" | "pending" | "failed"; source: string; detail?: string }[];
  commits: { hash: string; author: string; date: string; subject: string }[];
}

function summary(mandate: string | null): string[] {
  if (!mandate) return [];
  const lines = mandate.split(/\r?\n/);
  const start = lines.findIndex((l) => /^responsibilities/i.test(l.trim()));
  return lines
    .slice(start >= 0 ? start + 1 : 0)
    .filter((l) => /^\s*[-*]\s+/.test(l))
    .slice(0, 4)
    .map((l) => l.replace(/^\s*[-*]\s+/, ""));
}

export function BandRoom() {
  const { data } = usePoll<Band>("/api/meta/band", 5000);
  const [open, setOpen] = useState<string>("implementer");
  if (!data) return <Empty><Spinner /></Empty>;
  const seat = data.seats.find((s) => s.seat === open);
  const done = data.milestones.filter((m) => m.status === "done").length;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {data.seats.map((s, i) => (
          <button
            key={s.seat}
            onClick={() => setOpen(s.seat)}
            className={cx(
              "rounded-lg border p-4 text-left transition-colors",
              open === s.seat ? "border-emerald-500/60 bg-emerald-500/5" : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-700",
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-zinc-500">Seat {i + 1}</span>
              <span className="font-mono text-[11px] text-zinc-600">{s.file}</span>
            </div>
            <div className="mt-1 text-[15px] font-semibold text-zinc-100">{s.title}</div>
            <ul className="mt-2 space-y-1 text-[12px] text-zinc-400">
              {summary(s.mandate).map((l) => (
                <li key={l} className="flex gap-1.5"><span className="text-zinc-600">–</span>{l}</li>
              ))}
              {!s.mandate && <li className="text-zinc-600">mandate file missing</li>}
            </ul>
          </button>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <Card title={`Raw mandate — .band/mandates/${seat?.file ?? ""}`}>
          <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-zinc-300">{seat?.mandate ?? "—"}</pre>
        </Card>
        <div className="space-y-4">
          <Card title="Autonomous timeline" action={<span className="num text-[12px] text-zinc-400">{done} / {data.milestones.length} complete</span>}>
            <ol>
              {data.milestones.map((m, i) => (
                <li key={m.id} className="relative flex gap-3 pb-3 last:pb-0">
                  {i < data.milestones.length - 1 && <span className="absolute left-[9px] top-5 h-full w-px bg-zinc-800" aria-hidden />}
                  <span
                    className={cx(
                      "relative z-10 mt-0.5 flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full border text-[10px]",
                      m.status === "done" ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-300" : m.status === "failed" ? "border-critical/60 text-[#f07070]" : "border-zinc-700 text-zinc-600",
                    )}
                  >
                    {m.id}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] text-zinc-200">{m.label}</span>
                      {m.status === "done" ? <Status tone="good">done</Status> : m.status === "failed" ? <Status tone="critical">failed</Status> : <Status tone="neutral">pending</Status>}
                      {m.detail && <span className="num text-[11px] text-zinc-500">{m.detail}</span>}
                    </div>
                    <div className="font-mono text-[11px] text-zinc-600">{m.source}</div>
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-[11px] text-zinc-500">Statuses come from evidence files on disk, not hardcoded. Pending means no evidence has been recorded yet.</p>
          </Card>
          <Card title="Recent commits">
            {data.commits.length === 0 ? (
              <Empty>No commits.</Empty>
            ) : (
              <ul className="space-y-1.5 text-[12px]">
                {data.commits.slice(0, 10).map((c) => (
                  <li key={c.hash} className="flex gap-2">
                    <span className="font-mono text-zinc-500">{c.hash}</span>
                    <span className="truncate text-zinc-300">{c.subject}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
