// Dispute Copilot server. Zero-framework Node HTTP: PayPal APIs + Claude agent + static UI.
import "./lib/env.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import * as pp from "./lib/paypal.mjs";
import { analyzeDispute, executeActions, condenseDispute } from "./lib/agent.mjs";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PORT = Number(process.env.PORT || 3000);
const ANALYSES_FILE = path.join(ROOT, "data/analyses.json");

// ---- Analysis store (per dispute: latest recommendation + what was executed) ----
const analyses = fs.existsSync(ANALYSES_FILE) ? JSON.parse(fs.readFileSync(ANALYSES_FILE, "utf8")) : {};
const saveAnalyses = () => fs.writeFileSync(ANALYSES_FILE, JSON.stringify(analyses, null, 2));

// ---- Dispute list, enriched with details (the list endpoint omits due dates and buyers) ----
let listCache = { at: 0, rows: null };
async function disputeRows(force = false) {
  if (!force && listCache.rows && Date.now() - listCache.at < 15_000) return listCache.rows;
  const items = await pp.listDisputes();
  const rows = await Promise.all(items.map(async (item) => {
    const res = await pp.getDispute(item.dispute_id);
    const d = res.ok ? condenseDispute(res.data) : { dispute_id: item.dispute_id, reason: item.reason, status: item.status, amount: item.dispute_amount };
    const a = analyses[item.dispute_id];
    return {
      ...d,
      buyer_name: d.buyer?.name,
      buyer_email: d.buyer?.email,
      item: d.items?.map((i) => i.item_name).join(", "),
      analysis: a ? {
        decision: a.recommendation.decision,
        win_probability: a.recommendation.win_probability,
        headline: a.recommendation.headline,
        analyzed_at: a.analyzed_at,
        executed: a.executed?.length ? a.executed.at(-1) : null,
      } : null,
    };
  }));
  rows.sort((a, b) => (a.seller_response_due || "9").localeCompare(b.seller_response_due || "9"));
  listCache = { at: Date.now(), rows };
  return rows;
}

// ---- HTTP plumbing ----
const sendJson = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
});

const PRODUCT = { name: "The Overstory (paperback)", sku: "BOOK-OVERSTORY", price: "24.00" };
const ID = "([A-Za-z0-9-]+)";

const routes = [
  ["GET", "/api/health", () => ({ ok: true, paypal_env: process.env.PAYPAL_ENV || "sandbox" })],
  ["GET", "/api/disputes", async (_, __, url) => disputeRows(url.searchParams.has("refresh"))],
  ["GET", `/api/disputes/${ID}`, async ([id]) => {
    const r = await pp.getDispute(id);
    if (!r.ok) return [r.status, r.data];
    return { dispute: condenseDispute(r.data), analysis: analyses[id] || null };
  }],
  ["POST", `/api/disputes/${ID}/execute`, async ([id], req) => {
    const { actions } = await readBody(req);
    if (!Array.isArray(actions) || !actions.length) return [400, { error: "No actions to run" }];
    const results = await executeActions(id, actions);
    if (analyses[id]) {
      (analyses[id].executed ||= []).push({ at: new Date().toISOString(), actions: actions.map((a) => a.type), results });
      saveAnalyses();
    }
    listCache.at = 0;
    return { results };
  }],
  ["POST", `/api/disputes/${ID}/simulate`, async ([id], req) => {
    const { kind } = await readBody(req);
    const r = kind === "seller_evidence" ? await pp.simRequireEvidence(id, "SELLER_EVIDENCE")
      : kind === "buyer_evidence" ? await pp.simRequireEvidence(id, "BUYER_EVIDENCE")
      : kind === "seller_favor" ? await pp.simAdjudicate(id, "SELLER_FAVOR")
      : kind === "buyer_favor" ? await pp.simAdjudicate(id, "BUYER_FAVOR")
      : kind === "escalate" ? await pp.escalate(id, "Escalated from Dispute Copilot demo controls")
      : { ok: false, status: 400, data: { message: "Unknown simulation" } };
    listCache.at = 0;
    return [r.ok ? 200 : r.status, { ok: r.ok, status: r.status, message: r.ok ? "Done" : r.data.message || "PayPal rejected this step", details: r.data.details }];
  }],
  ["POST", "/api/orders", () => pp.createOrder(PRODUCT).then((r) => [r.status, r.data])],
  ["POST", `/api/orders/${ID}/capture`, ([id]) => pp.captureOrder(id).then((r) => [r.status, r.data])],
];

// Server-Sent Events: stream the agent's investigation to the browser.
async function streamAnalysis(id, req, res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  let closed = false;
  req.on("close", () => (closed = true));
  try {
    const recommendation = await analyzeDispute(id, (e) => !closed && send(e));
    analyses[id] = { ...(analyses[id] || {}), recommendation, analyzed_at: new Date().toISOString() };
    saveAnalyses();
    listCache.at = 0;
  } catch (err) {
    console.error("analysis failed:", err.message);
  }
  res.end();
}

const STATIC = { "/": "index.html", "/shop": "shop.html", "/app.js": "app.js", "/styles.css": "styles.css" };
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    const sse = url.pathname.match(new RegExp(`^/api/disputes/${ID}/analyze$`));
    if (sse && req.method === "GET") return streamAnalysis(sse[1], req, res);

    for (const [method, pattern, handler] of routes) {
      const m = req.method === method && url.pathname.match(new RegExp(`^${pattern}$`));
      if (!m) continue;
      const out = await handler(m.slice(1), req, url);
      return Array.isArray(out) && typeof out[0] === "number" ? sendJson(res, out[0], out[1]) : sendJson(res, 200, out);
    }

    const file = STATIC[url.pathname];
    if (req.method === "GET" && file) {
      let body = fs.readFileSync(path.join(ROOT, "public", file), "utf8");
      // The client ID is public by design (it ships in every PayPal checkout); the secret never leaves the server.
      if (file === "shop.html") body = body.replace("__CLIENT_ID__", process.env.PAYPAL_CLIENT_ID);
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] });
      return res.end(body);
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message });
  }
}).listen(PORT, () => console.log(`Dispute Copilot on http://localhost:${PORT}`));
