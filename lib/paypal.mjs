// Thin PayPal REST client (sandbox by default). The secret never leaves the server.

const BASE = process.env.PAYPAL_ENV === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

let cachedToken = null;

/** Keys never contain whitespace. Values pasted into hosting dashboards sometimes drag along
 *  surrounding spaces or the next line of a .env file, so keep only the first token. */
export const cleanKey = (v) => (v || "").trim().split(/\s+/)[0];

async function accessToken() {
  if (cachedToken && cachedToken.exp > Date.now()) return cachedToken.value;
  const PAYPAL_CLIENT_ID = cleanKey(process.env.PAYPAL_CLIENT_ID);
  const PAYPAL_CLIENT_SECRET = cleanKey(process.env.PAYPAL_CLIENT_SECRET);
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) throw new Error("PayPal keys are not set (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`PayPal auth failed: ${data.error_description || res.status}`);
  cachedToken = { value: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 };
  return cachedToken.value;
}

/** JSON request. Returns { status, ok, data } and never throws on HTTP errors. */
export async function paypal(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return parse(res);
}

/** Multipart request with a JSON `input` part, as the Disputes evidence/message endpoints expect. */
async function paypalMultipart(url, input) {
  const form = new FormData();
  form.append("input", new Blob([JSON.stringify(input)], { type: "application/json" }));
  const res = await fetch(`${BASE}${url}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}` },
    body: form,
  });
  return parse(res);
}

async function parse(res) {
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, ok: res.ok, data };
}

const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().replace(/\.\d+Z$/, ".000Z");

// ---- Orders (test shop) -------------------------------------------------

export const createOrder = (product) =>
  paypal("POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [{
      description: product.name,
      amount: {
        currency_code: "USD",
        value: product.price,
        breakdown: { item_total: { currency_code: "USD", value: product.price } },
      },
      items: [{ name: product.name, sku: product.sku, quantity: "1", category: "PHYSICAL_GOODS",
        unit_amount: { currency_code: "USD", value: product.price } }],
    }],
  });

export const captureOrder = (id) => paypal("POST", `/v2/checkout/orders/${id}/capture`);

// ---- Disputes -----------------------------------------------------------

export async function listDisputes() {
  // Without start_time the sandbox sometimes omits fresh disputes, so always pass a window.
  const res = await paypal("GET", `/v1/customer/disputes?page_size=50&start_time=${daysAgo(170)}`);
  return res.ok ? res.data.items || [] : Promise.reject(new Error(`List disputes failed: HTTP ${res.status}`));
}

export const getDispute = (id) => paypal("GET", `/v1/customer/disputes/${id}`);

export const provideEvidence = (id, evidences) =>
  paypalMultipart(`/v1/customer/disputes/${id}/provide-evidence`, { evidences });

export const sendMessage = (id, message) =>
  paypalMultipart(`/v1/customer/disputes/${id}/send-message`, { message });

export const makeOffer = (id, { note, amount, currency = "USD" }) =>
  paypal("POST", `/v1/customer/disputes/${id}/make-offer`, {
    note,
    offer_amount: { currency_code: currency, value: amount },
    offer_type: "REFUND",
  });

export const acceptClaim = (id, { note, amount, currency = "USD" }) =>
  paypal("POST", `/v1/customer/disputes/${id}/accept-claim`, {
    note,
    accept_claim_type: amount ? "PARTIAL_REFUND" : "REFUND",
    ...(amount ? { refund_amount: { currency_code: currency, value: amount } } : {}),
  });

export const escalate = (id, note) => paypal("POST", `/v1/customer/disputes/${id}/escalate`, { note });

// Sandbox-only simulators, used by the demo controls.
export const simRequireEvidence = (id, action) =>
  paypal("POST", `/v1/customer/disputes/${id}/require-evidence`, { action });
export const simAdjudicate = (id, outcome) =>
  paypal("POST", `/v1/customer/disputes/${id}/adjudicate`, { adjudication_outcome: outcome });

// ---- Evidence sources -----------------------------------------------------

export const getTrackers = (transactionId) =>
  paypal("GET", `/v1/shipping/trackers?transaction_id=${encodeURIComponent(transactionId)}`);

export const addTracker = (transactionId, { tracking_number, carrier, status = "SHIPPED" }) =>
  paypal("POST", "/v1/shipping/trackers-batch", {
    trackers: [{ transaction_id: transactionId, tracking_number, status, carrier }],
  });

export const searchTransaction = (transactionId) =>
  paypal("GET", `/v1/reporting/transactions?transaction_id=${encodeURIComponent(transactionId)}` +
    `&start_date=${daysAgo(30)}&end_date=${new Date().toISOString().replace(/\.\d+Z$/, ".000Z")}&fields=all`);

// ---- Webhooks -------------------------------------------------------------

export const DISPUTE_EVENTS = ["CUSTOMER.DISPUTE.CREATED", "CUSTOMER.DISPUTE.UPDATED", "CUSTOMER.DISPUTE.RESOLVED"];

export const listWebhooks = () => paypal("GET", "/v1/notifications/webhooks");

export const createWebhook = (url) =>
  paypal("POST", "/v1/notifications/webhooks", { url, event_types: DISPUTE_EVENTS.map((name) => ({ name })) });

/** Find the webhook registered for this exact URL (so no webhook ID needs configuring). */
export async function findWebhookId(url) {
  const res = await listWebhooks();
  return res.ok ? res.data.webhooks?.find((w) => w.url === url)?.id || null : null;
}

/** Ask PayPal whether a delivery really came from PayPal. */
export async function verifyWebhook(headers, event, webhookId) {
  const res = await paypal("POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: headers["paypal-auth-algo"],
    cert_url: headers["paypal-cert-url"],
    transmission_id: headers["paypal-transmission-id"],
    transmission_sig: headers["paypal-transmission-sig"],
    transmission_time: headers["paypal-transmission-time"],
    webhook_id: webhookId,
    webhook_event: event,
  });
  return res.ok && res.data.verification_status === "SUCCESS";
}
