import { useEffect, useMemo, useState } from "react";
import {
  SYSTEM_ACCOUNTS,
  api,
  formatCents,
  type Balance,
  type Hold,
  type JournalEntry,
  type Proof,
  type Stage,
  type StressReport,
  type TimelineEvent,
} from "./api.ts";
import { usePoll } from "./hooks.ts";
import { Button, Card, Empty, ErrorLine, Field, Input, Select, Spinner, Stat, Status, cx } from "./ui.tsx";

const STAGES: { id: Stage; label: string; detail: string }[] = [
  { id: "s1", label: "Stage 1", detail: "Double-entry core · in-memory" },
  { id: "s2", label: "Stage 2", detail: "Idempotency · WAL lock" },
  { id: "s3", label: "Stage 3", detail: "Bitemporal · reversals" },
  { id: "s4", label: "Stage 4", detail: "FX · fees · escrow" },
];

const bitemporal = (s: Stage) => s === "s3" || s === "s4";

function useLedger(stage: Stage, asOfSystem: number | null) {
  const query = asOfSystem !== null && bitemporal(stage) ? `?as_of_system=${asOfSystem}` : "";
  const balances = usePoll<Balance[]>(`/api/${stage}/balances${query}`);
  const journal = usePoll<JournalEntry[]>(`/api/${stage}/journal?limit=40`);
  const proof = usePoll<Proof>(`/api/${stage}/proof`);
  const refresh = () => {
    balances.refresh();
    journal.refresh();
    proof.refresh();
  };
  return { balances: balances.data, journal: journal.data, proof: proof.data, refresh };
}

export function Harness() {
  const [stage, setStage] = useState<Stage>("s4");
  const [asOfSystem, setAsOfSystem] = useState<number | null>(null);
  useEffect(() => setAsOfSystem(null), [stage]);
  const { balances, journal, proof, refresh } = useLedger(stage, asOfSystem);
  const userAccounts = useMemo(() => (balances ?? []).filter((b) => !SYSTEM_ACCOUNTS.has(b.account_id)), [balances]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {STAGES.map((s) => (
          <button
            key={s.id}
            onClick={() => setStage(s.id)}
            className={cx(
              "rounded-md border px-3 py-1.5 text-left transition-colors",
              stage === s.id ? "border-emerald-500/60 bg-emerald-500/5" : "border-zinc-800 hover:border-zinc-700",
            )}
          >
            <div className="text-[13px] font-medium text-zinc-100">{s.label}</div>
            <div className="text-[11px] text-zinc-500">{s.detail}</div>
          </button>
        ))}
      </div>

      <ConservationHero proof={proof} stage={stage} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="space-y-4">
          <Operations stage={stage} accounts={userAccounts} onDone={refresh} />
          {stage === "s4" && <FxCard accounts={userAccounts} onDone={refresh} />}
          {stage === "s4" && <EscrowCard accounts={userAccounts} onDone={refresh} />}
        </div>
        <div className="space-y-4">
          <BalancesCard balances={balances} asOfSystem={asOfSystem} />
          {bitemporal(stage) && <TimeTravelCard stage={stage} asOfSystem={asOfSystem} onChange={setAsOfSystem} />}
          <JournalCard stage={stage} journal={journal} onDone={refresh} />
        </div>
      </div>

      <BlastCard />
    </div>
  );
}

// ---------------------------------------------------------------- hero

function ConservationHero({ proof, stage }: { proof: Proof | null; stage: Stage }) {
  const sums = proof ? Object.entries(proof.per_currency) : [];
  const conserved = proof ? sums.every(([, v]) => v === "0") && proof.unbalanced_txns === 0 && proof.out_of_range_balances === 0 : null;
  return (
    <section className="grid gap-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-5 md:grid-cols-[auto_1fr] md:items-center">
      <div>
        <div className="text-[12px] text-zinc-500">Σ signed amounts, {stage.toUpperCase()} journal</div>
        <div className="mt-1 flex items-baseline gap-3">
          <span className="text-5xl font-semibold tracking-tight text-zinc-50">{proof ? (conserved ? "0" : "≠ 0") : "—"}</span>
          {conserved !== null &&
            (conserved ? <Status tone="good">zero-sum holds</Status> : <Status tone="critical">conservation violated</Status>)}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Journal entries" value={proof?.entry_count.toLocaleString("en-US") ?? "—"} />
        <Stat label="Transactions" value={proof?.txn_count.toLocaleString("en-US") ?? "—"} />
        <Stat label="Unbalanced txns" value={proof?.unbalanced_txns ?? "—"} />
        <Stat
          label="Per-currency Σ"
          value={sums.length ? sums.map(([c, v]) => `${c} ${v}`).join(" · ") : "no entries"}
          sub={proof?.escrow_matches_open_holds === undefined ? "folded with bigint" : proof.escrow_matches_open_holds ? "escrow = open holds" : "escrow mismatch"}
        />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- operations

function Operations({ stage, accounts, onDone }: { stage: Stage; accounts: Balance[]; onDone: () => void }) {
  const [mode, setMode] = useState<"transfer" | "mint" | "account">("transfer");
  const ids = accounts.map((a) => a.account_id);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("1000");
  const fees = usePoll<{ transfer_bps: number; fx_bps: number }>(stage === "s4" ? "/api/s4/fees" : null, 0).data;
  const [validAt, setValidAt] = useState("");
  const [newId, setNewId] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "good" | "critical"; text: string } | null>(null);

  useEffect(() => {
    if (!ids.includes(from)) setFrom(ids[0] ?? "");
    if (!ids.includes(to)) setTo(ids[1] ?? ids[0] ?? "");
  }, [ids.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    setBusy(true);
    setMessage(null);
    const valid = bitemporal(stage) && validAt ? { valid_at: new Date(validAt).getTime() } : {};
    const res =
      mode === "account"
        ? await api.post(`/api/${stage}/accounts`, { account_id: newId, ...(stage === "s4" ? { currency } : {}) })
        : mode === "mint"
          ? await api.post(`/api/${stage}/mint`, { account_id: to, amount, ...valid })
          : await api.post(`/api/${stage}/transfer`, { from, to, amount, ...valid });
    setBusy(false);
    if (res.ok) {
      setMessage({ tone: "good", text: `${res.status} committed${res.replayed ? " (replayed)" : ""}` });
      if (mode === "account") setNewId("");
      onDone();
    } else setMessage({ tone: "critical", text: `${res.status} ${res.error.code} — ${res.error.message}` });
  }

  return (
    <Card
      title="Post to the ledger"
      action={
        <div className="flex gap-1">
          {(["transfer", "mint", "account"] as const).map((m) => (
            <Button key={m} variant={mode === m ? "default" : "ghost"} className="h-7 px-2 text-[12px]" onClick={() => setMode(m)}>
              {m === "account" ? "New account" : m[0].toUpperCase() + m.slice(1)}
            </Button>
          ))}
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        {mode === "account" ? (
          <>
            <Field label="Account id">
              <Input value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="e.g. dave" />
            </Field>
            {stage === "s4" && (
              <Field label="Currency">
                <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
              </Field>
            )}
          </>
        ) : (
          <>
            {mode === "transfer" && (
              <Field label="From">
                <Select value={from} onChange={(e) => setFrom(e.target.value)}>
                  {accounts.map((a) => <option key={a.account_id} value={a.account_id}>{a.account_id} · {a.currency}</option>)}
                </Select>
              </Field>
            )}
            <Field label={mode === "mint" ? "Mint into (from 0000-0000)" : "To"}>
              <Select value={to} onChange={(e) => setTo(e.target.value)}>
                {accounts.map((a) => <option key={a.account_id} value={a.account_id}>{a.account_id} · {a.currency}</option>)}
              </Select>
            </Field>
            <Field label="Amount (integer cents)" hint={/^[1-9][0-9]*$/.test(amount) ? `= ${formatCents(amount, "")}` : "positive integer only"}>
              <Input value={amount} onChange={(e) => setAmount(e.target.value.trim())} inputMode="numeric" />
            </Field>
            {stage === "s4" && mode === "transfer" && (
              <Field label="Fee → 9999-FEE (server policy)" hint="rounded up; set by the operator, not the client">
                <div className="num flex h-8 items-center rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 text-[13px] text-zinc-300">
                  {fees ? `${fees.transfer_bps} bps · ${(fees.transfer_bps / 100).toFixed(2)}%` : "—"}
                  {fees && /^[1-9][0-9]*$/.test(amount) && (
                    <span className="ml-auto text-zinc-500">fee {formatCents(((BigInt(amount) * BigInt(fees.transfer_bps) + 9999n) / 10000n).toString(), "")}</span>
                  )}
                </div>
              </Field>
            )}
            {bitemporal(stage) && (
              <Field label="valid_at (optional)" hint="business time; empty = now">
                <Input type="datetime-local" value={validAt} onChange={(e) => setValidAt(e.target.value)} />
              </Field>
            )}
          </>
        )}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button variant="primary" onClick={submit} disabled={busy}>
          {busy && <Spinner />}
          {mode === "account" ? "Open account" : mode === "mint" ? "Mint" : "Transfer"}
        </Button>
        {stage !== "s1" && <span className="text-[11px] text-zinc-500">fresh Idempotency-Key per click</span>}
        {message && <Status tone={message.tone}>{message.text}</Status>}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- balances & journal

function BalancesCard({ balances, asOfSystem }: { balances: Balance[] | null; asOfSystem: number | null }) {
  return (
    <Card
      title="Balances — folded via Σ(entries), never stored"
      action={asOfSystem !== null ? <Status tone="warning">as of {new Date(asOfSystem).toLocaleTimeString()}</Status> : <Status tone="neutral">live</Status>}
    >
      {!balances ? (
        <Empty><Spinner /></Empty>
      ) : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500">
              <th className="pb-2 font-medium">Account</th>
              <th className="pb-2 font-medium">Kind</th>
              <th className="pb-2 text-right font-medium">Balance</th>
            </tr>
          </thead>
          <tbody>
            {balances.map((b) => (
              <tr key={`${b.account_id}-${b.currency}`} className="border-t border-zinc-800/70">
                <td className="py-1.5 font-mono text-[12px] text-zinc-200">{b.account_id}</td>
                <td className="py-1.5 text-[12px] text-zinc-500">{SYSTEM_ACCOUNTS.has(b.account_id) ? "system" : "user"}</td>
                <td className={cx("num py-1.5 text-right", BigInt(b.balance) < 0n ? "text-zinc-400" : "text-zinc-100")}>{formatCents(b.balance, b.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function JournalCard({ stage, journal, onDone }: { stage: Stage; journal: JournalEntry[] | null; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  async function reverse(txnId: string) {
    setPending(txnId);
    setError(null);
    const res = await api.post(`/api/${stage}/reverse/${encodeURIComponent(txnId)}`);
    setPending(null);
    if (!res.ok) setError(`${res.error.code} — ${res.error.message}`);
    onDone();
  }
  const firstOfTxn = new Set<number>();
  journal?.forEach((e, i) => (i === 0 || journal[i - 1].txn_id !== e.txn_id) && firstOfTxn.add(e.entry_id));
  return (
    <Card title="Journal — append-only, newest first">
      {!journal ? (
        <Empty><Spinner /></Empty>
      ) : journal.length === 0 ? (
        <Empty>No entries yet.</Empty>
      ) : (
        <div className="max-h-[420px] overflow-auto">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-zinc-900">
              <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="pb-2 font-medium">#</th>
                <th className="pb-2 font-medium">Txn</th>
                {stage !== "s1" && <th className="pb-2 font-medium">Kind</th>}
                <th className="pb-2 font-medium">Account</th>
                <th className="pb-2 text-right font-medium">Amount</th>
                {bitemporal(stage) && <th className="pb-2 pl-3 font-medium">valid / system</th>}
                {bitemporal(stage) && <th />}
              </tr>
            </thead>
            <tbody>
              {journal.map((e) => (
                <tr key={e.entry_id} className={cx(firstOfTxn.has(e.entry_id) && "border-t border-zinc-800/70")}>
                  <td className="num py-1 text-zinc-600">{e.entry_id}</td>
                  <td className="py-1 font-mono text-zinc-500" title={e.txn_id}>{firstOfTxn.has(e.entry_id) ? e.txn_id.slice(0, 8) : ""}</td>
                  {stage !== "s1" && <td className="py-1 text-zinc-400">{firstOfTxn.has(e.entry_id) ? e.kind : ""}</td>}
                  <td className="py-1 font-mono text-zinc-300">{e.account_id}</td>
                  <td className={cx("num py-1 text-right", e.amount.startsWith("-") ? "text-zinc-400" : "text-zinc-100")}>
                    {e.amount.startsWith("-") ? "" : "+"}{formatCents(e.amount, e.currency)}
                  </td>
                  {bitemporal(stage) && (
                    <td className="num py-1 pl-3 text-zinc-500">
                      {firstOfTxn.has(e.entry_id) && e.valid_at && e.system_at
                        ? `${new Date(e.valid_at).toLocaleDateString()} / ${new Date(e.system_at).toLocaleTimeString()}`
                        : ""}
                    </td>
                  )}
                  {bitemporal(stage) && (
                    <td className="py-1 text-right">
                      {firstOfTxn.has(e.entry_id) && e.kind !== "REVERSAL" && !["HOLD", "CAPTURE", "RELEASE"].includes(e.kind ?? "") && (
                        <Button variant="danger" className="h-6 px-2 text-[11px]" disabled={pending === e.txn_id} onClick={() => reverse(e.txn_id)}>
                          Reverse
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ErrorLine error={error} />
    </Card>
  );
}

// ---------------------------------------------------------------- time travel

function TimeTravelCard({ stage, asOfSystem, onChange }: { stage: Stage; asOfSystem: number | null; onChange: (v: number | null) => void }) {
  const { data } = usePoll<{ min_system_at: number | null; max_system_at: number | null; events: TimelineEvent[] }>(`/api/${stage}/timeline`, 2000);
  const events = data?.events ?? [];
  const index = asOfSystem === null ? events.length - 1 : Math.max(0, events.findIndex((e) => e.system_at === asOfSystem));
  const current = events[index];
  return (
    <Card
      title="Time travel — system_at axis"
      action={
        <Button variant="ghost" className="h-7 px-2 text-[12px]" onClick={() => onChange(null)} disabled={asOfSystem === null}>
          Return to now
        </Button>
      }
    >
      {events.length === 0 ? (
        <Empty>No transactions yet.</Empty>
      ) : (
        <>
          <input
            type="range"
            min={0}
            max={events.length - 1}
            value={index}
            onChange={(e) => {
              const i = Number(e.target.value);
              onChange(i === events.length - 1 ? null : events[i].system_at);
            }}
            className="w-full accent-emerald-400"
            aria-label="As-of transaction"
          />
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-zinc-400">
            <span>
              Event <span className="num text-zinc-200">{index + 1}</span> / {events.length}
            </span>
            {current && (
              <>
                <span className="font-mono text-zinc-300">{current.kind}</span>
                <span>system_at <span className="num text-zinc-200">{new Date(current.system_at).toLocaleString()}</span></span>
                <span>valid_at <span className="num text-zinc-200">{new Date(current.valid_at).toLocaleString()}</span></span>
                {current.reverses_txn_id && <span>reverses <span className="font-mono">{current.reverses_txn_id.slice(0, 8)}</span></span>}
              </>
            )}
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">Balances above re-fold from immutable entries with system_at ≤ the selected event. Earlier views never change.</p>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- FX

interface FxQuote {
  rate_bps: string;
  rate_set_at: number;
  fee_bps: string;
  fee: string;
  net: string;
  converted: string;
}

function FxCard({ accounts, onDone }: { accounts: Balance[]; onDone: () => void }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("10000");
  const [quote, setQuote] = useState<FxQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "good" | "critical"; text: string } | null>(null);
  const fromAcct = accounts.find((a) => a.account_id === from);
  const toAcct = accounts.find((a) => a.account_id === to);

  useEffect(() => {
    if (!from && accounts[0]) setFrom(accounts[0].account_id);
    if (!to) setTo(accounts.find((a) => a.currency !== accounts[0]?.currency)?.account_id ?? "");
  }, [accounts, from, to]);

  useEffect(() => {
    if (!fromAcct || !toAcct) return;
    const t = setTimeout(async () => {
      const res = await api.get<FxQuote>(`/api/s4/fx/quote?from_currency=${fromAcct.currency}&to_currency=${toAcct.currency}&amount=${encodeURIComponent(amount)}`);
      setQuote(res.ok ? res.data : null);
      setQuoteError(res.ok ? null : `${res.error.code}: ${res.error.message}`);
    }, 150);
    return () => clearTimeout(t);
  }, [amount, fromAcct?.currency, toAcct?.currency]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    if (!quote) return;
    setMessage(null);
    // The quoted rate and fee travel as guards: the server rejects the request if its policy changed meanwhile.
    const res = await api.post("/api/s4/fx", { from, to, amount, rate_bps: Number(quote.rate_bps), fee_bps: Number(quote.fee_bps) });
    if (res.ok) {
      setMessage({ tone: "good", text: "FX committed" });
      onDone();
    } else setMessage({ tone: "critical", text: `${res.error.code}: ${res.error.message}` });
  }

  return (
    <Card title="FX conversion at server rates (integer bps, 10000 bps = 1.0000)">
      <div className="grid grid-cols-2 gap-3">
        <Field label="From">
          <Select value={from} onChange={(e) => setFrom(e.target.value)}>
            {accounts.map((a) => <option key={a.account_id} value={a.account_id}>{a.account_id} · {a.currency}</option>)}
          </Select>
        </Field>
        <Field label="To">
          <Select value={to} onChange={(e) => setTo(e.target.value)}>
            {accounts.map((a) => <option key={a.account_id} value={a.account_id}>{a.account_id} · {a.currency}</option>)}
          </Select>
        </Field>
        <Field label="Amount (cents)">
          <Input value={amount} onChange={(e) => setAmount(e.target.value.trim())} />
        </Field>
        <Field label="Rate (operator-set)" hint={quote ? `set ${new Date(quote.rate_set_at).toLocaleString()}` : undefined}>
          <div className="num flex h-8 items-center rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 text-[13px] text-zinc-300">
            {quote ? `1 ${fromAcct?.currency} = ${(Number(quote.rate_bps) / 10000).toFixed(4)} ${toAcct?.currency} · ${quote.rate_bps} bps` : "—"}
          </div>
        </Field>
        <div className="col-span-2 rounded-md border border-zinc-800 bg-zinc-950/60 p-2.5 text-[12px]">
          <div className="text-[11px] uppercase tracking-wide text-zinc-500">Quote before submitting</div>
          {quote ? (
            <div className="num mt-1 grid grid-cols-3 gap-2 text-zinc-300">
              <div>fee ({quote.fee_bps} bps) → 9999-FEE<div className="text-zinc-100">{formatCents(quote.fee, fromAcct?.currency)}</div></div>
              <div>net → FX-POOL<div className="text-zinc-100">{formatCents(quote.net, fromAcct?.currency)}</div></div>
              <div>payee receives<div className="text-zinc-100">{formatCents(quote.converted, toAcct?.currency)}</div></div>
            </div>
          ) : (
            <div className="mt-1 text-zinc-500">{quoteError ?? "choose two accounts in different currencies"}</div>
          )}
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button variant="primary" onClick={submit} disabled={!quote || quote.converted === "0"}>Convert</Button>
        {message && <Status tone={message.tone}>{message.text}</Status>}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- escrow

const HOLD_STATES = ["HELD", "CAPTURED", "RELEASED"] as const;

function EscrowCard({ accounts, onDone }: { accounts: Balance[]; onDone: () => void }) {
  const { data: holds, refresh } = usePoll<Hold[]>("/api/s4/holds", 1500);
  const [payer, setPayer] = useState("");
  const [amount, setAmount] = useState("2500");
  const [payee, setPayee] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!payer && accounts[0]) setPayer(accounts[0].account_id);
    if (!payee && accounts[1]) setPayee(accounts[1].account_id);
  }, [accounts, payer, payee]);

  async function act(path: string, body: unknown) {
    setError(null);
    const res = await api.post(path, body);
    if (!res.ok) setError(`${res.error.code} — ${res.error.message}`);
    refresh();
    onDone();
  }

  const recent = (holds ?? []).slice(-5).reverse();
  return (
    <Card title="Escrow holds — HELD → CAPTURED | RELEASED">
      <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-3">
        <Field label="Payer">
          <Select value={payer} onChange={(e) => setPayer(e.target.value)}>
            {accounts.map((a) => <option key={a.account_id} value={a.account_id}>{a.account_id} · {a.currency}</option>)}
          </Select>
        </Field>
        <Field label="Amount (cents)">
          <Input value={amount} onChange={(e) => setAmount(e.target.value.trim())} />
        </Field>
        <Button variant="primary" onClick={() => act("/api/s4/holds", { payer, amount })}>Place hold</Button>
      </div>
      <div className="mt-3">
        <Field label="Capture pays to">
          <Select value={payee} onChange={(e) => setPayee(e.target.value)}>
            {accounts.map((a) => <option key={a.account_id} value={a.account_id}>{a.account_id} · {a.currency}</option>)}
          </Select>
        </Field>
      </div>
      <div className="mt-4 space-y-2">
        {recent.length === 0 && <Empty>No holds yet.</Empty>}
        {recent.map((h) => (
          <div key={h.hold_id} className="rounded-md border border-zinc-800 bg-zinc-950/50 p-3">
            <div className="flex items-center justify-between gap-2 text-[12px]">
              <span className="font-mono text-zinc-400">{h.hold_id.slice(0, 8)} · {h.payer}</span>
              <span className="num text-zinc-100">{formatCents(h.amount, h.currency)}</span>
            </div>
            <div className="mt-2 flex items-center gap-2" aria-label={`state ${h.state}`}>
              {HOLD_STATES.map((s, i) => {
                const reached = h.events.some((e) => e.state === s);
                const dead = h.state !== "HELD" && !reached;
                return (
                  <div key={s} className="flex items-center gap-2">
                    {i > 0 && <span className={cx("text-[11px]", dead ? "text-zinc-700" : "text-zinc-500")}>{i === 1 ? "→" : "|"}</span>}
                    <span
                      className={cx(
                        "rounded border px-2 py-0.5 text-[11px] font-medium",
                        reached ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300" : dead ? "border-zinc-800 text-zinc-700 line-through" : "border-zinc-700 text-zinc-400",
                      )}
                    >
                      {reached ? "● " : "○ "}{s}
                    </span>
                  </div>
                );
              })}
              <div className="ml-auto flex gap-1.5">
                <Button className="h-7 px-2 text-[12px]" disabled={h.state !== "HELD"} onClick={() => act(`/api/s4/holds/${h.hold_id}/capture`, { to: payee })}>Capture</Button>
                <Button variant="danger" className="h-7 px-2 text-[12px]" disabled={h.state !== "HELD"} onClick={() => act(`/api/s4/holds/${h.hold_id}/release`, {})}>Release</Button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <ErrorLine error={error} />
    </Card>
  );
}

// ---------------------------------------------------------------- blast

function BlastCard() {
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [report, setReport] = useState<StressReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!running) return;
    const started = performance.now();
    const id = setInterval(() => setElapsed(performance.now() - started), 100);
    return () => clearInterval(id);
  }, [running]);

  async function blast() {
    setRunning(true);
    setError(null);
    const res = await api.post<StressReport>("/api/s2/fuzz", { concurrency: 100, replays: 50 });
    setRunning(false);
    if (res.ok) setReport(res.data);
    else setError(`${res.error.code} — ${res.error.message}`);
  }

  return (
    <Card
      title="Concurrency fuzzer — 100 worker threads vs one account (stage 2 engine, isolated temp DB)"
      action={
        <Button variant="primary" onClick={blast} disabled={running}>
          {running && <Spinner />}
          {running ? `Blasting… ${(elapsed / 1000).toFixed(1)}s` : "Blast 100 Concurrent Requests"}
        </Button>
      }
    >
      {!report && !running && (
        <p className="text-[13px] text-zinc-400">
          Each request runs in its own worker thread with its own SQLite connection, released together by an Atomics barrier.
          <span className="text-zinc-500"> acc_victim holds 5,000¢ and 100 workers each withdraw 100¢, so exactly 50 may succeed. Then 50 identical replays and one tampered payload. The first run also warms the 100-worker pool.</span>
        </p>
      )}
      {running && !report && <Empty><Spinner /></Empty>}
      {report && (
        <div className={cx("space-y-3", running && "opacity-50")}>
          <div className="flex flex-wrap items-center gap-2">
            {report.passed ? <Status tone="good">all scenarios pass</Status> : <Status tone="critical">violations: {report.violations.length}</Status>}
            {report.double_spends === 0 ? <Status tone="good">double-spends: 0</Status> : <Status tone="critical">double-spends: {report.double_spends}</Status>}
            {report.busy_exhausted === 0 ? <Status tone="good">SQLITE_BUSY unresolved: 0</Status> : <Status tone="critical">BUSY exhausted: {report.busy_exhausted}</Status>}
            <Status tone={report.scenario_d.integrity_check === "ok" ? "good" : "critical"}>integrity_check: {report.scenario_d.integrity_check}</Status>
            {report.at && <span className="text-[11px] text-zinc-500">measured {new Date(report.at).toLocaleTimeString()} · pool {report.pool_size}</span>}
          </div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
            <Stat label="Throughput" value={`${report.throughput_rps} rps`} sub="from barrier release" />
            <Stat label="Wall time" value={`${Math.round(report.wall_ms)} ms`} />
            <Stat label="p50 latency" value={`${Math.round(report.p50_ms)} ms`} />
            <Stat label="p99 latency" value={`${Math.round(report.p99_ms)} ms`} />
            <Stat label="Succeeded" value={report.scenario_a.ok} sub={`of ${report.concurrency}`} />
            <Stat label="Refused (NSF)" value={report.scenario_a.insufficient_funds} />
            <Stat label="Replays" value={`${report.scenario_b.applied} + ${report.scenario_b.replayed}`} sub="applied + replayed" />
            <Stat label="Busy retries" value={report.busy_retries.toLocaleString("en-US")} />
          </div>
          <div className="grid gap-2 text-[12px] text-zinc-400 md:grid-cols-2">
            <div>victim balance <span className="num text-zinc-200">{report.scenario_a.victim_balance}</span> · sink <span className="num text-zinc-200">{report.scenario_a.sink_balance}</span></div>
            <div>tampered replay → <span className="num text-zinc-200">{report.scenario_c.status} {report.scenario_c.code}</span>, rows written <span className="num text-zinc-200">{report.scenario_c.rows_written}</span></div>
          </div>
          {report.violations.length > 0 && <pre className="font-mono text-[12px] text-[#f07070]">{report.violations.join("\n")}</pre>}
        </div>
      )}
      <ErrorLine error={error} />
    </Card>
  );
}
