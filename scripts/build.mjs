// Runs the Vite production build and records the measured duration as evidence.
import { mkdirSync, writeFileSync } from "node:fs";
import { build } from "vite";

const started = performance.now();
await build({ logLevel: "warn" });
const durationMs = Math.round(performance.now() - started);

mkdirSync("evidence", { recursive: true });
writeFileSync(
  "evidence/build.json",
  JSON.stringify({ tool: "vite", duration_ms: durationMs, node: process.version, at: new Date().toISOString() }, null, 2),
);
console.log(`vite build completed in ${durationMs} ms (measured; written to evidence/build.json)`);
