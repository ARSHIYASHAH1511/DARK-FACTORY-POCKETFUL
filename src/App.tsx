import { useEffect, useState } from "react";
import type { Telemetry } from "./api.ts";
import { Artifacts } from "./Artifacts.tsx";
import { BandRoom } from "./BandRoom.tsx";
import { Harness } from "./Harness.tsx";
import { usePoll } from "./hooks.ts";
import { Invariants } from "./Invariants.tsx";
import { TopBar, type Tab } from "./TopBar.tsx";

const TABS: Tab[] = ["harness", "band", "invariants", "artifacts"];

function tabFromHash(): Tab {
  const h = window.location.hash.replace("#", "") as Tab;
  return TABS.includes(h) ? h : "harness";
}

export function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const telemetry = usePoll<Telemetry>("/api/meta/telemetry", 1000);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const select = (t: Tab) => {
    window.location.hash = t;
    setTab(t);
  };

  return (
    <div className="min-h-full">
      <TopBar tab={tab} onTab={select} telemetry={telemetry.data} onTests={telemetry.refresh} />
      <main className="mx-auto max-w-[1400px] px-5 py-5">
        {telemetry.error && <p className="mb-3 font-mono text-[12px] text-[#f07070]">API unreachable: {telemetry.error}</p>}
        {tab === "harness" && <Harness />}
        {tab === "band" && <BandRoom />}
        {tab === "invariants" && <Invariants />}
        {tab === "artifacts" && <Artifacts />}
      </main>
    </div>
  );
}
