import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function Card({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-lg border border-zinc-800 bg-zinc-900/40", className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-2.5">
          <h2 className="text-[13px] font-medium text-zinc-300">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Button({ variant = "default", className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost" | "danger" }) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400",
        "disabled:cursor-not-allowed disabled:opacity-40",
        variant === "primary" && "bg-emerald-500 text-zinc-950 hover:bg-emerald-400",
        variant === "default" && "border border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-zinc-600 hover:bg-zinc-800",
        variant === "ghost" && "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200",
        variant === "danger" && "border border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-red-500/60 hover:text-red-300",
        className,
      )}
    />
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-zinc-500">{hint}</span>}
    </label>
  );
}

const control =
  "h-8 w-full min-w-0 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 text-[13px] text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500/70 focus:outline-none";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(control, "num", props.className)} />;
}

export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={cx(control, props.className)}>
      {children}
    </select>
  );
}

type Tone = "good" | "warning" | "serious" | "critical" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  good: "border-good/40 bg-good/10 text-[#5fd35f]",
  warning: "border-warning/40 bg-warning/10 text-warning",
  serious: "border-serious/40 bg-serious/10 text-serious",
  critical: "border-critical/50 bg-critical/10 text-[#f07070]",
  neutral: "border-zinc-700 bg-zinc-800/60 text-zinc-400",
};

const TONE_ICON: Record<Tone, string> = { good: "✓", warning: "!", serious: "!", critical: "✕", neutral: "○" };

// Status is never colour alone: every badge carries an icon and a text label.
export function Status({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-medium", TONE_CLASS[tone])}>
      <span aria-hidden>{TONE_ICON[tone]}</span>
      {children}
    </span>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2.5">
      <div className="truncate text-[11px] text-zinc-500">{label}</div>
      <div className="mt-0.5 truncate text-lg font-semibold text-zinc-100">{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-zinc-500">{sub}</div>}
    </div>
  );
}

export function Spinner() {
  return <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-400" aria-label="loading" />;
}

export function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="mt-2 font-mono text-[12px] text-[#f07070]">{error}</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-6 text-center text-[13px] text-zinc-500">{children}</div>;
}
