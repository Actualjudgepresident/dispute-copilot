// Register this app's PayPal webhook for dispute events.
// Usage: node scripts/register-webhook.mjs https://your-app.onrender.com
import "../lib/env.mjs";
import { createWebhook, findWebhookId } from "../lib/paypal.mjs";

const base = (process.argv[2] || process.env.PUBLIC_URL || "").replace(/\/$/, "");
if (!base.startsWith("https://")) {
  console.error("Pass your public https URL, e.g. node scripts/register-webhook.mjs https://your-app.onrender.com");
  process.exit(1);
}
const url = `${base}/api/webhooks/paypal`;
const existing = await findWebhookId(url);
if (existing) {
  console.log(`Already registered: ${existing} -> ${url}`);
} else {
  const res = await createWebhook(url);
  if (!res.ok) {
    console.error(`PayPal refused (HTTP ${res.status}):`, res.data.message, res.data.details?.[0]?.description || "");
    process.exit(1);
  }
  console.log(`Registered ${res.data.id} -> ${url} for ${res.data.event_types.map((e) => e.name).join(", ")}`);
}
