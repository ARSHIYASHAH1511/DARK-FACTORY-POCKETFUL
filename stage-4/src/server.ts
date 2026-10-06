import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteLedger, quoteFx, toJson, type AsOf, type Route } from "./ledger.ts";
import { HTTP_STATUS, LedgerError, parseAmount } from "./money.ts";

const dbPath = resolve(process.env.LEDGER_DB ?? "data/stage-4.db");
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

function asOfFrom(params: URLSearchParams): AsOf {
  const parse = (name: string) => {
    const raw = params.get(name);
    if (raw === null || raw === "") return undefined;
    if (!/^[0-9]{1,15}$/.test(raw)) throw new LedgerError("VALIDATION", `${name} must be an integer epoch-ms timestamp`);
    return Number(raw);
  };
  return { validAt: parse("as_of_valid"), systemAt: parse("as_of_system") };
}

const MUTATIONS: Record<string, Route> = {
  "POST /accounts": "accounts",
  "POST /mint": "mint",
  "POST /transfer": "transfer",
  "POST /fx": "fx",
  "POST /fund-pool": "fund_pool",
  "POST /holds": "hold",
};

async function mutate(req: IncomingMessage, res: ServerResponse, route: Route, body: Record<string, unknown>) {
  const key = req.headers["idempotency-key"];
  const out = await ledger.submit(route, body, Array.isArray(key) ? "" : key ?? "");
  send(res, out.status, out.body, { "idempotent-replayed": String(out.replayed) });
}

export const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/^\/api\/s4/, "");
    const route = `${req.method} ${path}`;

    const mutation = MUTATIONS[route];
    if (mutation) return await mutate(req, res, mutation, await readJson(req));

    const reverse = req.method === "POST" && path.match(/^\/reverse\/([^/]+)$/);
    if (reverse) {
      await readJson(req);
      return await mutate(req, res, "reverse", { txn_id: decodeURIComponent(reverse[1]) });
    }
    const transition = req.method === "POST" && path.match(/^\/holds\/([^/]+)\/(capture|release)$/);
    if (transition) {
      const body = await readJson(req);
      return await mutate(req, res, transition[2] as Route, { ...body, hold_id: decodeURIComponent(transition[1]) });
    }
    const holdMatch = req.method === "GET" && path.match(/^\/holds\/([^/]+)$/);
    if (holdMatch) return send(res, 200, { ok: true, data: ledger.hold(decodeURIComponent(holdMatch[1])) });
    const history = req.method === "GET" && path.match(/^\/history\/([^/]+)$/);
    if (history) return send(res, 200, { ok: true, data: ledger.history(decodeURIComponent(history[1])) });

    switch (route) {
      case "GET /health":
        return send(res, 200, { ok: true, data: { stage: 4, journal_mode: ledger.journalMode() } });
      case "GET /balances":
        return send(res, 200, { ok: true, data: ledger.balances(asOfFrom(url.searchParams)) });
      case "GET /journal":
        return send(res, 200, { ok: true, data: ledger.journal(Number(url.searchParams.get("limit") ?? 100)) });
      case "GET /holds":
        return send(res, 200, { ok: true, data: ledger.holds() });
      case "GET /fx/quote": {
        const q = url.searchParams;
        const int = (name: string, fallback?: string) => {
          const raw = q.get(name) ?? fallback;
          if (raw === undefined || !/^(0|[1-9][0-9]{0,9})$/.test(raw)) throw new LedgerError("VALIDATION", `${name} must be a non-negative integer`);
          return BigInt(raw);
        };
        const amount = parseAmount(q.get("amount") ?? "");
        const rate = int("rate_bps");
        const fee = int("fee_bps", "0");
        if (rate < 1n || fee > 9_999n) throw new LedgerError("VALIDATION", "rate_bps >= 1 and fee_bps <= 9999 required");
        return send(res, 200, { ok: true, data: { amount, rate_bps: rate, fee_bps: fee, ...quoteFx(amount, rate, fee) } });
      }
      case "GET /timeline":
        return send(res, 200, { ok: true, data: ledger.timeline() });
      case "GET /proof":
        return send(res, 200, { ok: true, data: ledger.proof() });
    }
    send(res, 404, { ok: false, error: { code: "NOT_FOUND", message: route } });
  } catch (err) {
    if (err instanceof LedgerError) return send(res, HTTP_STATUS[err.code], { ok: false, error: { code: err.code, message: err.message } });
    if (err instanceof PayloadTooLarge) {
      res.setHeader("connection", "close");
      return send(res, 413, { ok: false, error: { code: "PAYLOAD_TOO_LARGE", message: `body exceeds ${MAX_BODY_BYTES} bytes` } });
    }
    if (err instanceof SyntaxError) return send(res, 400, { ok: false, error: { code: "VALIDATION", message: "invalid JSON body" } });
    send(res, 500, { ok: false, error: { code: "INTERNAL", message: "internal error" } });
  }
});

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT ?? 3005);
  server.listen(port, () => console.log(`stage-4 ledger listening on :${port} (db: ${dbPath})`));
}
