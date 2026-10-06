// The merchant's store backend: profile + policy (data/store.json) and orders imported from CSV.
// Orders start from data/orders.csv (the demo shop's export); merchants can import their own export,
// which is merged on top by order ID. Column names from common exports are recognised automatically.
import fs from "node:fs";

const PROFILE_FILE = new URL("../data/store.json", import.meta.url);
const SAMPLE_CSV = new URL("../data/orders.csv", import.meta.url);
const IMPORTED_FILE = new URL("../data/imported-orders.json", import.meta.url);
const MAX_ROWS = 2000;

export const loadProfile = () => JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8"));

// ---- CSV ------------------------------------------------------------------

/** RFC 4180-ish parser: quoted fields, escaped quotes, commas/newlines inside quotes, CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== "")) rows.push(row);
  return rows;
}

const csvCell = (v) => (/[",\n]/.test(String(v ?? "")) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ""));

// Our canonical columns, with header aliases seen in Shopify / WooCommerce / generic exports.
export const COLUMNS = {
  order_id: ["order_id", "order", "name", "order number", "order #", "order no", "order_number"],
  paypal_transaction_id: ["paypal_transaction_id", "transaction_id", "transaction id", "payment reference", "payment_reference", "payment id", "_transaction_id", "paypal transaction id"],
  buyer_email: ["buyer_email", "email", "customer email", "billing email", "billing_email", "customer_email"],
  buyer_name: ["buyer_name", "billing name", "shipping name", "customer name", "customer", "billing_first_name"],
  placed_at: ["placed_at", "created at", "order date", "paid at", "date", "order_date", "date created"],
  item: ["item", "lineitem name", "product", "product name", "item name", "title", "line item"],
  sku: ["sku", "lineitem sku", "item sku"],
  qty: ["qty", "quantity", "lineitem quantity", "item quantity"],
  price: ["price", "lineitem price", "item price", "unit price", "item cost"],
  ship_to: ["ship_to", "shipping address", "shipping address1", "shipping_address", "ship to"],
  ship_city: ["shipping city", "ship_city"],
  ship_zip: ["shipping zip", "shipping postcode", "ship_zip"],
  ship_region: ["shipping province", "shipping state", "ship_region"],
  ship_country: ["shipping country", "ship_country"],
  fulfillment_status: ["fulfillment_status", "fulfillment status", "order status", "status", "shipping status"],
  carrier: ["carrier", "shipping carrier", "tracking company", "shipping provider"],
  tracking_number: ["tracking_number", "tracking number", "tracking", "tracking no"],
  shipped_at: ["shipped_at", "fulfilled at", "shipped date", "date shipped", "ship date"],
  delivered_at: ["delivered_at", "delivered date", "date delivered", "delivered at"],
  last_scan: ["last_scan", "last tracking event", "tracking status"],
  customer_emails: ["customer_emails", "emails sent", "customer notifications"],
  notes: ["notes", "note", "internal notes", "packer note", "order notes"],
};

/** Map each canonical column to a header index (or -1). */
function mapHeaders(headers) {
  const norm = headers.map((h) => h.trim().toLowerCase());
  const map = {};
  for (const [key, aliases] of Object.entries(COLUMNS)) map[key] = norm.findIndex((h) => aliases.includes(h));
  return map;
}

/** Turn CSV text into orders (one order per order_id; extra rows add line items). */
export function ordersFromCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("The file has no data rows.");
  if (rows.length - 1 > MAX_ROWS) throw new Error(`Too many rows (max ${MAX_ROWS}).`);
  const map = mapHeaders(rows[0]);
  if (map.order_id < 0) throw new Error("Couldn't find an order ID column (e.g. order_id, Name, Order Number).");
  if (map.paypal_transaction_id < 0 && map.buyer_email < 0) {
    throw new Error("Need a PayPal transaction ID or buyer email column to match orders to disputes.");
  }
  const get = (r, k) => (map[k] >= 0 ? (r[map[k]] ?? "").trim() : "");
  const byId = new Map();
  const warnings = [];
  rows.slice(1).forEach((r, i) => {
    const id = get(r, "order_id");
    if (!id) { warnings.push(`Row ${i + 2}: no order ID, skipped`); return; }
    let o = byId.get(id);
    if (!o) {
      const address = [get(r, "ship_to"), get(r, "ship_city"), [get(r, "ship_region"), get(r, "ship_zip")].filter(Boolean).join(" "), get(r, "ship_country")]
        .filter(Boolean).join(", ");
      o = {
        order_id: id,
        seller_transaction_id: get(r, "paypal_transaction_id") || null,
        buyer_email: get(r, "buyer_email") || null,
        buyer_name: get(r, "buyer_name") || null,
        placed_at: get(r, "placed_at") || null,
        items: [],
        shipping_address: address || null,
        fulfillment: {
          status: (get(r, "fulfillment_status") || "UNKNOWN").toUpperCase().replace(/\s+/g, "_"),
          carrier: get(r, "carrier") || null,
          tracking_number: get(r, "tracking_number") || null,
          shipped_at: get(r, "shipped_at") || null,
          delivered_at: get(r, "delivered_at") || null,
          last_scan: get(r, "last_scan") || null,
        },
        customer_emails: get(r, "customer_emails") || null,
        notes: get(r, "notes") || null,
      };
      byId.set(id, o);
    }
    const title = get(r, "item");
    if (title) o.items.push({ title, sku: get(r, "sku") || null, qty: Number(get(r, "qty") || 1), price: get(r, "price") || null });
  });
  for (const o of byId.values()) {
    const total = o.items.reduce((t, it) => t + (parseFloat(it.price) || 0) * (it.qty || 1), 0);
    o.total = total ? total.toFixed(2) : null;
  }
  const mapped = Object.entries(map).filter(([, i]) => i >= 0).map(([k, i]) => ({ column: k, header: rows[0][i].trim() }));
  return { orders: [...byId.values()], mapped, warnings };
}

export function ordersToCsv(orders) {
  const head = ["order_id", "paypal_transaction_id", "buyer_email", "buyer_name", "placed_at", "item", "sku", "qty", "price", "ship_to",
    "fulfillment_status", "carrier", "tracking_number", "shipped_at", "delivered_at", "last_scan", "customer_emails", "notes"];
  const lines = [head.join(",")];
  for (const o of orders) {
    for (const it of o.items.length ? o.items : [{}]) {
      lines.push([o.order_id, o.seller_transaction_id, o.buyer_email, o.buyer_name, o.placed_at, it.title, it.sku, it.qty, it.price, o.shipping_address,
        o.fulfillment.status, o.fulfillment.carrier, o.fulfillment.tracking_number, o.fulfillment.shipped_at, o.fulfillment.delivered_at,
        o.fulfillment.last_scan, o.customer_emails, o.notes].map(csvCell).join(","));
    }
  }
  return lines.join("\n") + "\n";
}

// ---- Order store -------------------------------------------------------------

let imported = fs.existsSync(IMPORTED_FILE) ? JSON.parse(fs.readFileSync(IMPORTED_FILE, "utf8")) : [];
const sample = () => ordersFromCsv(fs.readFileSync(SAMPLE_CSV, "utf8")).orders.map((o) => ({ ...o, source: "sample" }));

/** All orders: the sample export, overridden/extended by anything the merchant imported. */
export function listOrders() {
  const byId = new Map(sample().map((o) => [o.order_id, o]));
  for (const o of imported) byId.set(o.order_id, { ...o, source: "imported" });
  return [...byId.values()];
}

export function importOrders(csvText) {
  const { orders, mapped, warnings } = ordersFromCsv(csvText);
  const byId = new Map(imported.map((o) => [o.order_id, o]));
  let added = 0, updated = 0;
  for (const o of orders) { byId.has(o.order_id) ? updated++ : added++; byId.set(o.order_id, o); }
  imported = [...byId.values()].slice(-MAX_ROWS);
  fs.writeFileSync(IMPORTED_FILE, JSON.stringify(imported, null, 2));
  return { added, updated, total: listOrders().length, mapped, warnings: warnings.slice(0, 20) };
}

export function resetImported() {
  imported = [];
  fs.rmSync(IMPORTED_FILE, { force: true });
}

/**
 * Find the order behind a dispute. Strongest signal first: PayPal transaction ID, then buyer email
 * with a matching amount, then buyer email alone (flagged as a weak match).
 */
export function findOrder({ seller_transaction_id, buyer_email, amount }) {
  const orders = listOrders();
  const email = buyer_email?.toLowerCase();
  const sameAmount = (o) => amount && o.total && Math.abs(parseFloat(o.total) - parseFloat(amount)) < 0.01;
  let o = seller_transaction_id && orders.find((x) => x.seller_transaction_id === seller_transaction_id);
  if (o) return { found: true, matched_by: "paypal_transaction_id", confidence: "high", order: o };
  const byEmail = email ? orders.filter((x) => x.buyer_email?.toLowerCase() === email) : [];
  o = byEmail.find(sameAmount);
  if (o) return { found: true, matched_by: "buyer_email+amount", confidence: "medium", order: o };
  if (byEmail.length === 1) return { found: true, matched_by: "buyer_email", confidence: "low", order: byEmail[0],
    caution: "Matched on email only; amount differs or is unknown. Verify this is the disputed order." };
  if (byEmail.length > 1) return { found: false, candidates: byEmail.map((x) => ({ order_id: x.order_id, total: x.total, placed_at: x.placed_at })),
    note: "Several orders for this buyer and none match the transaction ID or amount." };
  return { found: false };
}
