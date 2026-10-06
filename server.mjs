// Dispute Copilot server. Zero-framework Node HTTP: PayPal APIs + Claude agent + static UI.
import "./lib/env.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import * as pp from "./lib/paypal.mjs";
import { cleanKey } from "./lib/paypal.mjs";
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
      analyzing: runs.has(item.dispute_id),
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
  noticeNewDisputes(rows);
  return rows;
}

// Sandbox dispute webhooks are unreliable, so polling also detects new disputes and treats them
// exactly like a CUSTOMER.DISPUTE.CREATED webhook. Whichever arrives first wins.
let knownDisputes = null;
function noticeNewDisputes(rows) {
  if (!knownDisputes) { knownDisputes = new Set(rows.map((r) => r.dispute_id)); return; }
  for (const r of rows) {
    if (knownDisputes.has(r.dispute_id)) continue;
    knownDisputes.add(r.dispute_id);
    broadcast({ type: "dispute_event", event_type: "CUSTOMER.DISPUTE.CREATED", dispute_id: r.dispute_id, amount: r.amount, reason: r.reason, source: "poll" });
    if (AUTO_ANALYZE && !analyses[r.dispute_id]) startAnalysis(r.dispute_id);
  }
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
  ["GET", "/api/health", () => ({
    ok: true,
    paypal_env: process.env.PAYPAL_ENV || "sandbox",
    webhook: { url: WEBHOOK_URL, registered: !!webhookId, auto_analyze: AUTO_ANALYZE, recent_deliveries: recentDeliveries },
    // Presence and length only (never values) to debug hosting config.
    keys: Object.fromEntries(["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "ANTHROPIC_API_KEY"].map((k) => {
      const raw = process.env[k] || "";
      const v = cleanKey(raw);
      return [k, raw ? {
        length: v.length,
        had_extra_text: raw !== v,
        // Real keys only use letters, digits, "-" and "_"; anything else means extra text was pasted.
        unexpected_chars: [...new Set(v.replace(/[A-Za-z0-9_-]/g, ""))].join("") || null,
        contains_key_name: /PAYPAL|ANTHROPIC|SECRET|CLIENT/.test(v),
      } : "missing"];
    })),
  })],
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

// ---- Analysis runs -------------------------------------------------------
// A run can be started by a browser or by a webhook; any number of browsers can watch it live.
// Guard the Claude bill on a public demo: one run per dispute at a time, and an hourly cap.
const MAX_RUNS_PER_HOUR = Number(process.env.MAX_RUNS_PER_HOUR || 30);
const runs = new Map(); // dispute_id -> { events: [], watchers: Set<fn> }
let runTimes = [];

function startAnalysis(id) {
  if (runs.has(id)) return runs.get(id);
  runTimes = runTimes.filter((t) => Date.now() - t < 3600_000);
  if (runTimes.length >= MAX_RUNS_PER_HOUR) return null;
  runTimes.push(Date.now());

  const run = { events: [], watchers: new Set() };
  runs.set(id, run);
  broadcast({ type: "analysis_started", dispute_id: id });
  const emit = (e) => { run.events.push(e); for (const w of run.watchers) w(e); };

  analyzeDispute(id, emit)
    .then((recommendation) => {
      analyses[id] = { ...(analyses[id] || {}), recommendation, analyzed_at: new Date().toISOString() };
      saveAnalyses();
      broadcast({ type: "analysis_done", dispute_id: id, decision: recommendation.decision, win_probability: recommendation.win_probability });
    })
    .catch((err) => {
      console.error("analysis failed:", err.message);
      broadcast({ type: "analysis_failed", dispute_id: id });
    })
    .finally(() => {
      listCache.at = 0;
      runs.delete(id);
      for (const w of run.watchers) w(null); // end of stream
    });
  return run;
}

// SSE: stream one dispute's investigation (joining a run already in progress if there is one).
function streamAnalysis(id, req, res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const run = startAnalysis(id);
  if (!run) {
    res.write(`data: ${JSON.stringify({ type: "error", message: "Demo limit reached for this hour. Try again later." })}\n\n`);
    return res.end();
  }
  const watcher = (e) => (e ? res.write(`data: ${JSON.stringify(e)}\n\n`) : res.end());
  run.events.forEach(watcher);
  run.watchers.add(watcher);
  req.on("close", () => run.watchers.delete(watcher));
}

// ---- Live updates for every open dashboard --------------------------------
const clients = new Set();
function broadcast(e) {
  for (const res of clients) res.write(`data: ${JSON.stringify(e)}\n\n`);
}
function streamEvents(req, res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(`data: ${JSON.stringify({ type: "hello", running: [...runs.keys()] })}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
}
// Background check for new disputes (cheap: one list call plus details for each dispute).
setInterval(() => disputeRows(true).catch((err) => console.warn("poll failed:", err.message)), 60_000);

// Keep idle connections open through proxies (Render closes silent streams).
setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 25_000);

// ---- PayPal webhooks --------------------------------------------------------
// Render sets RENDER_EXTERNAL_URL automatically; elsewhere set PUBLIC_URL.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
const WEBHOOK_URL = PUBLIC_URL ? `${PUBLIC_URL}/api/webhooks/paypal` : null;
let webhookId = process.env.PAYPAL_WEBHOOK_ID || null;
const AUTO_ANALYZE = process.env.AUTO_ANALYZE !== "false";
const seenEvents = new Set(); // PayPal retries deliveries; handle each event once
const recentDeliveries = []; // last few deliveries, shown in /api/health for debugging
const logDelivery = (d) => { recentDeliveries.unshift({ at: new Date().toISOString(), ...d }); recentDeliveries.length = Math.min(recentDeliveries.length, 10); };

async function handleWebhook(req, res) {
  const event = await readBody(req).catch(() => null);
  if (!event?.event_type) return sendJson(res, 400, { error: "Bad payload" });

  webhookId ||= WEBHOOK_URL ? await pp.findWebhookId(WEBHOOK_URL) : null;
  const verified = webhookId && await pp.verifyWebhook(req.headers, event, webhookId);
  logDelivery({ event_type: event.event_type, dispute_id: event.resource?.dispute_id, verified: !!verified });
  if (!verified) {
    console.warn(`webhook ${event.id} (${event.event_type}) failed signature verification - ignored`);
    return sendJson(res, 400, { error: "Signature verification failed" });
  }
  sendJson(res, 200, { received: true }); // acknowledge fast; work happens after

  if (seenEvents.has(event.id)) return;
  seenEvents.add(event.id);
  const id = event.resource?.dispute_id;
  console.log(`webhook ${event.event_type} ${id || ""}`);
  listCache.at = 0;
  broadcast({
    type: "dispute_event",
    event_type: event.event_type,
    dispute_id: id,
    summary: event.summary,
    amount: event.resource?.dispute_amount,
    reason: event.resource?.reason,
  });
  if (id && AUTO_ANALYZE && event.event_type === "CUSTOMER.DISPUTE.CREATED" && !analyses[id] && !knownDisputes?.has(id)) {
    // Simulator events carry made-up dispute IDs; only investigate disputes PayPal can return.
    if ((await pp.getDispute(id)).ok) {
      knownDisputes?.add(id);
      startAnalysis(id);
    }
  }
}

const STATIC = { "/": "index.html", "/shop": "shop.html", "/app.js": "app.js", "/styles.css": "styles.css" };
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    const sse = url.pathname.match(new RegExp(`^/api/disputes/${ID}/analyze$`));
    if (sse && req.method === "GET") return streamAnalysis(sse[1], req, res);
    if (url.pathname === "/api/events" && req.method === "GET") return streamEvents(req, res);
    if (url.pathname === "/api/webhooks/paypal" && req.method === "POST") return handleWebhook(req, res);

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
      if (file === "shop.html") body = body.replace("__CLIENT_ID__", cleanKey(process.env.PAYPAL_CLIENT_ID));
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] });
      return res.end(body);
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message });
  }
}).listen(PORT, async () => {
  console.log(`Dispute Copilot on http://localhost:${PORT}`);
  if (WEBHOOK_URL && !webhookId) {
    webhookId = await pp.findWebhookId(WEBHOOK_URL).catch(() => null);
    console.log(webhookId ? `PayPal webhook ${webhookId} -> ${WEBHOOK_URL}` : `No PayPal webhook registered for ${WEBHOOK_URL} (run scripts/register-webhook.mjs)`);
  }
});
