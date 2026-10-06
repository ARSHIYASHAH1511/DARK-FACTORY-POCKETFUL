import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { Ledger, LedgerError, SYSTEM_RESERVE, type Entry } from "./ledger.ts";
import { HTTP_STATUS } from "./money.ts";

export const ledger = new Ledger();

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

// Money goes over the wire as decimal strings.
const json = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json(body));
}

const wireEntry = (e: Entry) => ({ entry_id: e.entryId, txn_id: e.txnId, account_id: e.accountId, currency: "USD", amount: e.amount });

let txnSeq = 0;
const nextTxnId = () => `s1-${Date.now()}-${++txnSeq}`;

export const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname.replace(/^\/api\/s1/, "")}`;
    switch (route) {
      case "GET /health":
        return send(res, 200, { ok: true, data: { stage: 1 } });
      case "POST /accounts": {
        const { account_id } = await readJson(req);
        const account = ledger.openAccount(account_id as string);
        return send(res, 201, { ok: true, data: { account_id: account.accountId, currency: "USD", created_at: account.createdAt } });
      }
      case "POST /mint": {
        const { account_id, amount } = await readJson(req);
        const txnId = nextTxnId();
        return send(res, 201, { ok: true, data: { txn_id: txnId, entries: ledger.mint(txnId, account_id as string, amount).map(wireEntry) } });
      }
      case "POST /transfer": {
        const { from, to, amount } = await readJson(req);
        const txnId = nextTxnId();
        return send(res, 201, { ok: true, data: { txn_id: txnId, entries: ledger.transfer(txnId, from as string, to as string, amount).map(wireEntry) } });
      }
      case "GET /balances":
        return send(res, 200, { ok: true, data: ledger.balances().map((b) => ({ account_id: b.accountId, currency: "USD", balance: b.balance })) });
      case "GET /journal":
        return send(res, 200, { ok: true, data: [...ledger.journal()].reverse().slice(0, Number(url.searchParams.get("limit") ?? 100)).map(wireEntry) });
      case "GET /proof":
        return send(res, 200, {
          ok: true,
          data: {
            per_currency: { USD: ledger.trialBalance() },
            unbalanced_txns: ledger.unbalancedTxns(),
            entry_count: ledger.entryCount(),
            txn_count: ledger.txnCount(),
            schema_has_balance: false,
            reserve: SYSTEM_RESERVE,
          },
        });
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
  const port = Number(process.env.PORT ?? 3002);
  server.listen(port, () => console.log(`stage-1 ledger listening on :${port}`));
}
