// Dispute Copilot dashboard: AG Grid queue + detail drawer with the live agent run.

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (a) => a ? new Intl.NumberFormat("en-US", { style: "currency", currency: a.currency_code || "USD" }).format(+a.value) : "–";

const REASONS = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Item not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Not as described",
  UNAUTHORISED: "Unauthorized",
  CREDIT_NOT_PROCESSED: "Credit not processed",
  DUPLICATE_TRANSACTION: "Duplicate charge",
  INCORRECT_AMOUNT: "Incorrect amount",
  PAYMENT_BY_OTHER_MEANS: "Paid another way",
  CANCELED_RECURRING_BILLING: "Canceled subscription",
  PROBLEM_WITH_REMITTANCE: "Remittance problem",
  OTHER: "Other",
};
const STAGES = { INQUIRY: "Inquiry", CHARGEBACK: "Claim", PRE_ARBITRATION: "Pre-arbitration", ARBITRATION: "Arbitration" };
const STATUS = {
  WAITING_FOR_SELLER_RESPONSE: ["Your move", "pill-warn"],
  WAITING_FOR_BUYER_RESPONSE: ["Waiting on buyer", "pill-info"],
  UNDER_REVIEW: ["PayPal reviewing", "pill-info"],
  RESOLVED: ["Resolved", "pill-plain"],
  OPEN: ["Open", "pill-warn"],
  OTHER: ["Other", "pill-plain"],
};
const DECISION = { FIGHT: ["Fight", "pill-good"], SETTLE: ["Settle", "pill-warn"], REFUND: ["Refund", "pill-bad"] };
const ACTION_LABELS = {
  send_message: "Message the buyer",
  provide_evidence: "Send evidence to PayPal",
  make_offer: "Offer a refund",
  accept_claim: "Accept claim & refund",
};
const TOOL_LABELS = {
  get_dispute: "Read the PayPal dispute",
  lookup_store_order: "Matched the store order",
  get_paypal_tracking: "Checked PayPal shipment tracking",
  get_paypal_transaction: "Pulled the PayPal transaction",
  get_store_policy: "Read the store policy",
  submit_recommendation: "Wrote the recommendation",
};

const daysLeft = (iso) => iso ? Math.ceil((new Date(iso) - Date.now()) / 864e5) : null;
const isOpen = (r) => r.status !== "RESOLVED";

// ---------------------------------------------------------------- Grid

const theme = agGrid.themeQuartz.withParams({
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 13,
  backgroundColor: "var(--surface)",
  foregroundColor: "var(--text)",
  headerBackgroundColor: "var(--surface-2)",
  headerTextColor: "var(--muted)",
  borderColor: "var(--border)",
  rowHoverColor: "var(--surface-2)",
  selectedRowBackgroundColor: "var(--info-bg)",
  accentColor: "var(--accent)",
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  rowHeight: 56,
  headerHeight: 40,
});

const columnDefs = [
  {
    headerName: "Dispute", field: "dispute_id", minWidth: 210, flex: 1.4,
    cellRenderer: (p) => `<div style="line-height:1.3;padding-top:9px"><div style="font-weight:600">${esc(p.data.buyer_name || "Buyer")}</div><div class="mono muted">${esc(p.value)}</div></div>`,
  },
  { headerName: "Reason", field: "reason", flex: 1.1, minWidth: 150, valueFormatter: (p) => REASONS[p.value] || p.value },
  { headerName: "Item", field: "item", flex: 1, minWidth: 120 },
  {
    headerName: "Amount", field: "amount", width: 110, type: "rightAligned",
    valueGetter: (p) => +(p.data.amount?.value || 0), valueFormatter: (p) => money(p.data.amount),
  },
  {
    headerName: "Stage", field: "stage", width: 215,
    cellRenderer: (p) => {
      const [label, cls] = STATUS[p.data.status] || [p.data.status, "pill-plain"];
      return `<span class="muted" style="margin-right:6px">${esc(STAGES[p.value] || p.value || "")}</span><span class="pill ${cls}">${esc(label)}</span>`;
    },
  },
  {
    headerName: "Respond by", field: "seller_response_due", width: 130, sort: "asc",
    valueGetter: (p) => p.data.seller_response_due ? daysLeft(p.data.seller_response_due) : null,
    cellRenderer: (p) => {
      if (p.value == null) return `<span class="muted">—</span>`;
      const cls = p.value <= 3 ? "pill-bad" : p.value <= 7 ? "pill-warn" : "pill-plain";
      return `<span class="pill ${cls}">${p.value <= 0 ? "Overdue" : `${p.value} days`}</span>`;
    },
  },
  {
    headerName: "Copilot", field: "analysis", minWidth: 190, flex: 1.2,
    valueGetter: (p) => p.data.analysis?.win_probability ?? -1,
    cellRenderer: (p) => {
      const a = p.data.analysis;
      if (p.data.analyzing) return `<span class="investigating"><span class="spinner"></span> Investigating…</span>`;
      if (!a) return `<button class="btn btn-small" data-analyze="${esc(p.data.dispute_id)}">Run copilot</button>`;
      const [label, cls] = DECISION[a.decision] || [a.decision, "pill-plain"];
      const sent = a.executed ? `<span class="pill pill-plain" title="Actions sent to PayPal">✓ sent</span>` : "";
      return `<span class="pill ${cls}">${label}</span> <span style="font-weight:600;margin:0 6px">${Math.round(a.win_probability)}% win</span>${sent}`;
    },
  },
];

const grid = agGrid.createGrid($("#grid"), {
  theme,
  columnDefs,
  rowData: [],
  defaultColDef: { sortable: true, resizable: true, filter: true, suppressHeaderMenuButton: true },
  rowSelection: { mode: "singleRow", checkboxes: false, enableClickSelection: true },
  getRowId: (p) => p.data.dispute_id,
  onCellClicked: (e) => {
    const analyze = e.event.target.closest?.("[data-analyze]");
    openDrawer(e.data.dispute_id, { autorun: !!analyze });
  },
  overlayNoRowsTemplate: "<span></span>",
  domLayout: "autoHeight",
});

// ---------------------------------------------------------------- Data

let rows = [];

async function loadQueue(force = false) {
  try {
    const res = await fetch(`/api/disputes${force ? "?refresh" : ""}`);
    if (!res.ok) throw new Error((await res.json()).error || res.status);
    rows = await res.json();
  } catch (err) {
    $("#updated").textContent = `Couldn't reach PayPal: ${err.message}`;
    return;
  }
  grid.setGridOption("rowData", rows);
  // Cells like "Investigating…" / "✓ sent" depend on more than the sort value, so redraw them.
  grid.refreshCells({ force: true, columns: ["analysis"] });
  $("#empty").hidden = rows.length > 0;
  $("#grid").style.display = rows.length ? "" : "none";
  renderKpis();
  $("#updated").textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function renderKpis() {
  const open = rows.filter(isOpen);
  const sum = (list) => list.reduce((t, r) => t + +(r.amount?.value || 0), 0);
  const usd = (n) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
  const winnable = open.filter((r) => r.analysis?.decision === "FIGHT");
  $("#k-open").textContent = open.length;
  $("#k-risk").textContent = usd(sum(open));
  $("#k-due").textContent = open.filter((r) => { const d = daysLeft(r.seller_response_due); return d != null && d <= 7; }).length;
  $("#k-win").textContent = open.some((r) => r.analysis) ? `${usd(sum(winnable))}` : "–";
}

// ---------------------------------------------------------------- Drawer

let current = null; // { dispute, analysis }

function setDrawer(open) {
  $("#drawer").classList.toggle("open", open);
  $("#scrim").classList.toggle("open", open);
  $("#drawer").setAttribute("aria-hidden", String(!open));
}
$("#close").onclick = $("#scrim").onclick = () => setDrawer(false);
document.addEventListener("keydown", (e) => e.key === "Escape" && setDrawer(false));

async function openDrawer(id, { autorun = false } = {}) {
  setDrawer(true);
  $("#d-id").textContent = id;
  $("#d-title").textContent = "Loading…";
  $("#d-body").innerHTML = "";
  const res = await fetch(`/api/disputes/${id}`);
  current = await res.json();
  if (!res.ok) { $("#d-title").textContent = "Couldn't load dispute"; return; }
  renderDrawer();
  if (autorun || !current.analysis) runCopilot();
}

function renderDrawer() {
  const d = current.dispute;
  const [statusLabel, statusCls] = STATUS[d.status] || [d.status, "pill-plain"];
  const due = daysLeft(d.seller_response_due);
  const lastBuyerMsg = (d.buyer_messages || []).filter((m) => m.posted_by === "BUYER").at(-1);
  $("#d-title").textContent = `${REASONS[d.reason] || d.reason} · ${money(d.amount)}`;

  $("#d-body").innerHTML = `
    <div class="card">
      <h3>Case</h3>
      <div class="facts">
        <div><div class="fact-label">Buyer</div><div class="fact-value">${esc(d.buyer?.name || "—")}</div></div>
        <div><div class="fact-label">Item</div><div class="fact-value">${esc(d.items?.map((i) => i.item_name).join(", ") || "—")}</div></div>
        <div><div class="fact-label">Stage</div><div class="fact-value">${esc(STAGES[d.stage] || d.stage)}</div></div>
        <div><div class="fact-label">Status</div><div class="fact-value"><span class="pill ${statusCls}">${esc(statusLabel)}</span></div></div>
        <div><div class="fact-label">Respond by</div><div class="fact-value">${d.seller_response_due ? `${new Date(d.seller_response_due).toLocaleDateString()} (${due} days)` : "—"}</div></div>
        <div><div class="fact-label">Seller protection</div><div class="fact-value">${esc(d.seller_protection === "NOT_ELIGIBLE" ? "Not eligible" : "Eligible")}</div></div>
      </div>
      ${lastBuyerMsg ? `<div class="quote">“${esc(lastBuyerMsg.content)}” <span class="muted">— buyer</span></div>` : ""}
      ${d.outcome ? `<div class="result ok">Outcome: ${esc(d.outcome.outcome_code)}</div>` : ""}
    </div>

    <div class="card" id="copilot">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h3 style="margin:0">Copilot</h3>
        <button class="btn btn-ghost btn-small" id="rerun">Re-run analysis</button>
      </div>
      <div id="copilot-body" style="margin-top:12px"></div>
    </div>

    <details class="card">
      <summary>Sandbox demo controls</summary>
      <p class="muted" style="margin-top:0">These use PayPal's sandbox-only endpoints to move the case along, the way PayPal would in production.</p>
      <div class="sim">
        <button class="btn btn-ghost btn-small" data-sim="escalate">Escalate to claim</button>
        <button class="btn btn-ghost btn-small" data-sim="seller_evidence">PayPal requests seller evidence</button>
        <button class="btn btn-ghost btn-small" data-sim="seller_favor">PayPal rules for seller</button>
        <button class="btn btn-ghost btn-small" data-sim="buyer_favor">PayPal rules for buyer</button>
      </div>
      <div id="sim-result"></div>
    </details>`;

  $("#rerun").onclick = () => runCopilot();
  document.querySelectorAll("[data-sim]").forEach((b) => (b.onclick = () => simulate(b.dataset.sim, b)));
  if (current.analysis) renderRecommendation(current.analysis.recommendation, current.analysis.executed);
}

// ---------------------------------------------------------------- Agent run (SSE)

let source = null;

function runCopilot() {
  const id = current.dispute.dispute_id;
  source?.close();
  $("#rerun").disabled = true;
  $("#copilot-body").innerHTML = `
    <div class="muted" style="display:flex;gap:8px;align-items:center;margin-bottom:10px"><div class="spinner"></div> Investigating with Claude…</div>
    <ul class="log" id="log"></ul>`;
  const log = $("#log");
  const pending = {};
  const add = (html, cls = "") => {
    const li = document.createElement("li");
    li.className = cls;
    li.innerHTML = html;
    log.append(li);
    return li;
  };

  source = new EventSource(`/api/disputes/${id}/analyze`);
  source.onmessage = (msg) => {
    const e = JSON.parse(msg.data);
    if (e.type === "thinking") {
      add(`<div class="dot">✦</div><div class="think">${esc(e.text.split("\n")[0].slice(0, 220))}</div>`);
    } else if (e.type === "tool") {
      if (e.name === "submit_recommendation") return;
      pending[e.name] = add(`<div class="dot"><div class="spinner"></div></div><div>${esc(TOOL_LABELS[e.name] || e.name)}…</div>`);
    } else if (e.type === "tool_result") {
      const li = pending[e.name] || add("");
      li.className = e.ok ? "ok" : "fail";
      li.innerHTML = `<div class="dot">${e.ok ? "✓" : "!"}</div><div>${esc(TOOL_LABELS[e.name] || e.name)} <span class="muted">— ${esc(e.summary)}</span></div>`;
    } else if (e.type === "done") {
      source.close();
      current.analysis = { recommendation: e.recommendation, analyzed_at: new Date().toISOString() };
      const trail = log.outerHTML;
      renderRecommendation(e.recommendation, null, trail);
      loadQueue(true);
    } else if (e.type === "error") {
      source.close();
      $("#rerun").disabled = false;
      add(`<div class="dot">!</div><div class="result err">${esc(e.message)}</div>`, "fail");
    }
  };
  source.onerror = () => { source.close(); $("#rerun").disabled = false; };
}

function renderRecommendation(r, executed, trail = "") {
  $("#rerun").disabled = false;
  const [label, cls] = DECISION[r.decision] || [r.decision, "pill-plain"];
  const color = r.win_probability >= 65 ? "var(--good)" : r.win_probability >= 40 ? "var(--warn)" : "var(--bad)";
  const done = executed?.length ? executed.at(-1) : null;

  $("#copilot-body").innerHTML = `
    ${trail ? `<details style="margin-bottom:12px"><summary class="muted" style="cursor:pointer">How the copilot investigated</summary><div style="margin-top:8px">${trail}</div></details>` : ""}
    <div class="rec-top">
      <div class="gauge" style="--p:${r.win_probability};--gauge-color:${color}"><span>${Math.round(r.win_probability)}%</span></div>
      <div>
        <div style="margin-bottom:4px"><span class="pill ${cls}">Recommend: ${label}</span> <span class="muted">chance to win if contested</span></div>
        <div class="headline">${esc(r.headline)}</div>
      </div>
    </div>
    <ul class="bullets">${r.reasoning.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>

    <h3 style="margin-top:16px">Evidence found</h3>
    <div class="chips">${r.evidence.map((e) => `<div class="chip s-${e.strength}"><b>${e.strength}</b>${esc(e.label)} <span class="muted">· ${esc(e.source)}</span></div>`).join("")}</div>
    ${r.gaps.length ? `<h3 style="margin-top:16px">Gaps to close</h3><ul class="bullets" style="margin-top:0">${r.gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>` : ""}

    <h3 style="margin-top:16px">Proposed response</h3>
    <div id="actions">${r.actions.map((a, i) => `
      <label class="action">
        <input type="checkbox" data-i="${i}" checked>
        <div>
          <div class="action-title">${i + 1}. ${esc(ACTION_LABELS[a.type] || a.type)}</div>
          ${a.type === "provide_evidence" ? `<div class="action-meta">${esc(a.evidence_type || "OTHER")}${a.tracking_number ? ` · ${esc(a.carrier || "")} ${esc(a.tracking_number)}` : ""}</div>` : ""}
          ${a.amount ? `<div class="action-meta">Amount: $${esc(a.amount)}${a.offer_type === "REFUND_WITH_RETURN" ? " · refund after the item is returned" : ""}</div>` : ""}
          ${a.message != null ? `<textarea data-msg="${i}">${esc(a.message)}</textarea>` : ""}
        </div>
      </label>`).join("")}
    </div>
    <div class="approve-row">
      <button class="btn" id="approve">Approve &amp; send to PayPal</button>
      <span class="muted">Nothing is sent until you approve.</span>
    </div>
    <div id="exec-result">${done ? execSummary(done.results) : ""}</div>`;

  $("#approve").onclick = () => approve(r);
}

function execSummary(results) {
  return results.map((x) => x.ok
    ? `<div class="result ok">✓ ${esc(ACTION_LABELS[x.type] || x.type)} — sent to PayPal</div>`
    : `<div class="result err">✕ ${esc(ACTION_LABELS[x.type] || x.type)} — ${esc(x.error)}</div>`).join("");
}

async function approve(r) {
  const actions = r.actions
    .map((a, i) => ({ ...a, message: document.querySelector(`[data-msg="${i}"]`)?.value ?? a.message }))
    .filter((_, i) => document.querySelector(`[data-i="${i}"]`).checked);
  if (!actions.length) return;
  const btn = $("#approve");
  btn.disabled = true;
  btn.innerHTML = `<div class="spinner"></div> Sending…`;
  const res = await fetch(`/api/disputes/${current.dispute.dispute_id}/execute`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actions }),
  });
  const data = await res.json();
  $("#exec-result").innerHTML = data.results ? execSummary(data.results) : `<div class="result err">${esc(data.error)}</div>`;
  btn.disabled = false;
  btn.textContent = "Approve & send to PayPal";
  loadQueue(true);
}

async function simulate(kind, btn) {
  btn.disabled = true;
  const res = await fetch(`/api/disputes/${current.dispute.dispute_id}/simulate`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }),
  });
  const data = await res.json();
  btn.disabled = false;
  $("#sim-result").innerHTML = data.ok
    ? `<div class="result ok">PayPal accepted it. The case updates in a few seconds.</div>`
    : `<div class="result err">${esc(data.message)}${data.details?.[0]?.description ? ` — ${esc(data.details[0].description)}` : ""}</div>`;
  if (data.ok) setTimeout(async () => {
    const r = await fetch(`/api/disputes/${current.dispute.dispute_id}`);
    if (r.ok) { const fresh = await r.json(); current.dispute = fresh.dispute; renderDrawer(); }
    loadQueue(true);
  }, 3000);
}

// ---------------------------------------------------------------- Store orders (CSV import)

const FULFIL = {
  DELIVERED: ["Delivered", "pill-good"], DIGITAL_DELIVERED: ["Delivered (digital)", "pill-good"],
  IN_TRANSIT: ["In transit", "pill-info"], SHIPPED: ["Shipped", "pill-info"], FULFILLED: ["Fulfilled", "pill-info"],
  UNFULFILLED: ["Not shipped", "pill-warn"], PENDING: ["Pending", "pill-warn"], UNKNOWN: ["Unknown", "pill-plain"],
};

const ordersGrid = agGrid.createGrid($("#orders-grid"), {
  theme,
  rowData: [],
  domLayout: "autoHeight",
  getRowId: (p) => p.data.order_id,
  defaultColDef: { sortable: true, resizable: true, filter: true, suppressHeaderMenuButton: true },
  columnDefs: [
    { headerName: "Order", field: "order_id", width: 160,
      cellRenderer: (p) => `<b>${esc(p.value)}</b>${p.data.source === "imported" ? ` <span class="pill pill-info">imported</span>` : ""}` },
    { headerName: "Buyer", field: "buyer_name", flex: 1, minWidth: 130 },
    { headerName: "Items", flex: 1.6, minWidth: 180, valueGetter: (p) => p.data.items.map((i) => (i.qty > 1 ? `${i.qty}× ` : "") + i.title).join(", ") },
    { headerName: "Total", field: "total", width: 100, type: "rightAligned", valueGetter: (p) => +(p.data.total || 0), valueFormatter: (p) => (p.data.total ? `$${p.data.total}` : "–") },
    { headerName: "Fulfilment", width: 150, valueGetter: (p) => p.data.fulfillment.status,
      cellRenderer: (p) => { const [l, c] = FULFIL[p.value] || [p.value, "pill-plain"]; return `<span class="pill ${c}">${esc(l)}</span>`; } },
    { headerName: "Tracking", flex: 1.2, minWidth: 170, valueGetter: (p) => [p.data.fulfillment.carrier, p.data.fulfillment.tracking_number].filter(Boolean).join(" ") || "—",
      cellClass: "mono" },
    { headerName: "PayPal txn", field: "seller_transaction_id", width: 170, cellClass: "mono", valueFormatter: (p) => p.value || "—" },
    { headerName: "Dispute", field: "linked_dispute", width: 170,
      cellRenderer: (p) => (p.value ? `<span class="pill pill-warn">${esc(p.value)}</span>` : `<span class="muted">—</span>`) },
  ],
  onCellClicked: (e) => e.data.linked_dispute && openDrawer(e.data.linked_dispute),
});

async function loadOrders() {
  const res = await fetch("/api/store/orders");
  if (res.ok) ordersGrid.setGridOption("rowData", await res.json());
}

$("#csv-file").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const res = await fetch("/api/store/orders/import", { method: "POST", headers: { "Content-Type": "text/csv" }, body: await file.text() });
  const data = await res.json();
  $("#import-result").innerHTML = res.ok
    ? `<div class="result ok">Imported ${esc(file.name)}: ${data.added} new, ${data.updated} updated order(s). Recognised columns: ${esc(data.mapped.map((m) => m.header).join(", "))}${data.warnings.length ? ` · ${data.warnings.length} warning(s)` : ""}</div>`
    : `<div class="result err">${esc(data.error)}</div>`;
  if (res.ok) { await loadOrders(); toast("Orders imported", `${data.added + data.updated} order(s) ready as evidence`, "good"); }
};

$("#reset-orders").onclick = async () => {
  await fetch("/api/store/orders/reset", { method: "POST" });
  $("#import-result").innerHTML = "";
  loadOrders();
};

// ---------------------------------------------------------------- Live updates (PayPal webhooks)

const EVENT_TEXT = {
  "CUSTOMER.DISPUTE.CREATED": "New dispute",
  "CUSTOMER.DISPUTE.UPDATED": "Dispute updated",
  "CUSTOMER.DISPUTE.RESOLVED": "Dispute resolved",
};

function toast(title, body, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.innerHTML = `<div class="toast-title">${esc(title)}</div>${body ? `<div class="toast-body">${esc(body)}</div>` : ""}`;
  $("#toasts").append(el);
  setTimeout(() => el.classList.add("out"), 6000);
  setTimeout(() => el.remove(), 6500);
}

function flashRow(id) {
  setTimeout(() => {
    const node = grid.getRowNode(id);
    if (node) grid.flashCells({ rowNodes: [node], flashDuration: 1500 });
  }, 600);
}

function connectLive() {
  const live = new EventSource("/api/events");
  live.onopen = () => $("#live").classList.add("on");
  live.onerror = () => $("#live").classList.remove("on"); // EventSource reconnects by itself
  live.onmessage = async (msg) => {
    const e = JSON.parse(msg.data);
    if (e.type === "dispute_event") {
      const label = EVENT_TEXT[e.event_type] || e.event_type;
      toast(`${label} from PayPal`, [REASONS[e.reason] || e.reason, e.amount && money(e.amount), e.dispute_id].filter(Boolean).join(" · "),
        e.event_type.endsWith("CREATED") ? "warn" : "info");
      await loadQueue(true);
      flashRow(e.dispute_id);
      if (current?.dispute.dispute_id === e.dispute_id && !e.event_type.endsWith("CREATED")) {
        const r = await fetch(`/api/disputes/${e.dispute_id}`);
        if (r.ok) { current = await r.json(); renderDrawer(); }
      }
    } else if (e.type === "analysis_started" || e.type === "analysis_failed") {
      loadQueue(true);
    } else if (e.type === "analysis_done") {
      const [label] = DECISION[e.decision] || [e.decision];
      toast("Copilot finished", `${e.dispute_id}: ${label} · ${Math.round(e.win_probability)}% chance to win`, "good");
      await loadQueue(true);
      flashRow(e.dispute_id);
    }
  };
}

// ---------------------------------------------------------------- Boot

$("#refresh").onclick = () => loadQueue(true);
loadQueue().then(loadOrders);
connectLive();
setInterval(() => loadQueue(), 60_000); // safety net; webhooks drive updates
