import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import jsonLang from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import { useEffect, useMemo, useState } from "react";
import { api } from "./api.ts";
import { usePoll } from "./hooks.ts";
import { Button, Card, Empty, Input, Spinner, cx } from "./ui.tsx";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("json", jsonLang);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("python", python);
hljs.registerLanguage("xml", xml);

function languageOf(path: string): string | null {
  const name = path.split("/").pop() ?? "";
  if (name === "Dockerfile") return "dockerfile";
  const ext = name.split(".").pop()?.toLowerCase();
  return (
    { ts: "typescript", tsx: "typescript", mjs: "typescript", js: "typescript", json: "json", md: "markdown", sh: "bash", py: "python", html: "xml", css: null } as Record<string, string | null>
  )[ext ?? ""] ?? null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function Artifacts() {
  const { data: files } = usePoll<string[]>("/api/meta/files", 0);
  const [selected, setSelected] = useState<string>("stage-2/src/ledger.ts");
  const [filter, setFilter] = useState("");
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (files && !files.includes(selected) && files[0]) setSelected(files[0]);
  }, [files, selected]);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    api.get<{ content: string }>(`/api/meta/file?path=${encodeURIComponent(selected)}`).then((res) => {
      if (cancelled) return;
      if (res.ok) setContent(res.data.content);
      else setError(res.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const groups = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const f of (files ?? []).filter((f) => f.toLowerCase().includes(filter.toLowerCase()))) {
      const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".";
      out.set(dir, [...(out.get(dir) ?? []), f]);
    }
    return [...out.entries()].sort(([a], [b]) => (a === "." ? -1 : b === "." ? 1 : a.localeCompare(b)));
  }, [files, filter]);

  const highlighted = useMemo(() => {
    if (content === null) return "";
    const lang = languageOf(selected);
    return lang ? hljs.highlight(content, { language: lang, ignoreIllegals: true }).value : escapeHtml(content);
  }, [content, selected]);

  async function copy() {
    if (content === null) return;
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  const lines = content?.split("\n").length ?? 0;
  return (
    <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <Card title={`Repository files${files ? ` (${files.length})` : ""}`}>
        <Input placeholder="Filter files…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="mt-3 max-h-[640px] overflow-auto pr-1">
          {!files ? (
            <Empty><Spinner /></Empty>
          ) : (
            groups.map(([dir, list]) => (
              <div key={dir} className="mb-2">
                <div className="px-1 pb-0.5 font-mono text-[11px] text-zinc-500">{dir}/</div>
                {list.map((f) => (
                  <button
                    key={f}
                    onClick={() => setSelected(f)}
                    className={cx(
                      "block w-full truncate rounded px-2 py-0.5 text-left font-mono text-[12px]",
                      f === selected ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
                    )}
                  >
                    {f.split("/").pop()}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </Card>
      <Card
        title={<span className="font-mono">{selected}</span>}
        action={
          <div className="flex items-center gap-3">
            <span className="num text-[11px] text-zinc-500">{lines} lines</span>
            <Button className="h-7 px-2 text-[12px]" onClick={copy} disabled={content === null}>
              {copied ? "Copied ✓" : "Copy"}
            </Button>
          </div>
        }
      >
        {error ? (
          <p className="font-mono text-[12px] text-[#f07070]">{error}</p>
        ) : content === null ? (
          <Empty><Spinner /></Empty>
        ) : (
          <div className="max-h-[680px] overflow-auto">
            <pre className="font-mono text-[12px] leading-[1.6]">
              <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
            </pre>
          </div>
        )}
      </Card>
    </div>
  );
}
