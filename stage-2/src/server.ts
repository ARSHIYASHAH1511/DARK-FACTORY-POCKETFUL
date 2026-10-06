import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteLedger, toJson, type Route } from "./ledger.ts";
import { runStress } from "./stress-test.ts";

const dbPath = resolve(process.env.LEDGER_DB ?? "data/stage-2.db");
mkdirSync(dirname(dbPath), { recursive: true });
export const ledger = new SqliteLedger(dbPath);

const MAX_BODY_BYTES = 64 * 1024;

class PayloadTooLarge extends Error {}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new PayloadTooLarge();
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new SyntaxError("body must be a JSON object");
  return body;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(toJson(body));
}

let fuzzRunning = false;

const MUTATIONS: Record<string, Route> = { "POST /accounts": "accounts", "POST /mint": "mint", "POST /transfer": "transfer" };

export const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname.replace(/^\/api\/s2/, "")}`;

    const mutation = MUTATIONS[route];
    if (mutation) {
      const key = req.headers["idempotency-key"];
      const out = await ledger.submit(mutation, await readJson(req), Array.isArray(key) ? "" : key ?? "");
      return send(res, out.status, out.body, { "idempotent-replayed": String(out.replayed) });
    }
    switch (route) {
      case "GET /health":
        return send(res, 200, { ok: true, data: { stage: 2, journal_mode: ledger.journalMode() } });
      case "GET /balances":
        return send(res, 200, { ok: true, data: ledger.balances() });
      case "GET /journal":
        return send(res, 200, { ok: true, data: ledger.journal(Number(url.searchParams.get("limit") ?? 100)) });
      case "GET /proof":
        return send(res, 200, { ok: true, data: ledger.proof() });
      case "POST /fuzz": {
        // Single-flight: each run spawns up to 200 isolates, so never overlap runs.
        if (fuzzRunning) return send(res, 429, { ok: false, error: { code: "FUZZ_IN_PROGRESS", message: "a fuzz run is already in progress" } });
        const body = await readJson(req);
        const int = (v: unknown, fallback: number) => (Number.isSafeInteger(v) ? (v as number) : fallback);
        const concurrency = Math.min(200, Math.max(2, Math.floor(int(body.concurrency, 100) / 2) * 2));
        const replays = Math.min(100, Math.max(2, int(body.replays, 50)));
        fuzzRunning = true;
        try {
          return send(res, 200, { ok: true, data: await runStress({ concurrency, replays }) });
        } finally {
          fuzzRunning = false;
        }
      }
    }
    send(res, 404, { ok: false, error: { code: "NOT_FOUND", message: route } });
  } catch (err) {
    if (err instanceof PayloadTooLarge) {
      res.setHeader("connection", "close");
      return send(res, 413, { ok: false, error: { code: "PAYLOAD_TOO_LARGE", message: `body exceeds ${MAX_BODY_BYTES} bytes` } });
    }
    if (err instanceof SyntaxError) return send(res, 400, { ok: false, error: { code: "VALIDATION", message: "invalid JSON body" } });
    send(res, 500, { ok: false, error: { code: "INTERNAL", message: "internal error" } });
  }
});

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT ?? 3003);
  server.listen(port, () => console.log(`stage-2 ledger listening on :${port} (db: ${dbPath})`));
}
