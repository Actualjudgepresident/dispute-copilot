# Dispute Copilot

**An AI copilot that helps small merchants win (or wisely settle) PayPal disputes.**

Small sellers lose disputes they should win: they don't know what evidence PayPal needs, they miss
deadlines, and every lost case costs the item *and* the money. Dispute Copilot watches the merchant's
PayPal disputes, investigates each one with a Claude agent, and proposes a ready-to-send response.
The merchant reviews it and approves with one click.

## What it does

1. **Dispute queue (AG Grid).** Pulls live disputes from the PayPal Disputes API: reason, amount,
   stage, how many days are left to respond, and the copilot's verdict. You can sort and filter by
   any column.
2. **Agent investigation (Claude).** For each dispute, a tool-using agent:
   - reads the live dispute (buyer messages, the evidence PayPal is asking for, which actions are allowed)
   - matches the merchant's own order record (fulfilment, carrier scans, customer emails)
   - checks PayPal shipment tracking and the PayPal transaction record
   - reads the store's shipping, returns and refund policy

   It then returns a decision (**Fight / Settle / Refund**), a win probability, the evidence ranked
   by strength, the gaps to close, and the exact PayPal actions to take, including a drafted message
   to the buyer. You can watch the investigation step by step in the UI.
3. **Human-approved execution.** Nothing is sent until the merchant approves. They can edit the
   message and untick steps, then the server calls PayPal's `send-message`, `provide-evidence`
   (proof of fulfilment with tracking), `make-offer` or `accept-claim`.
4. **Sandbox demo controls.** PayPal's sandbox-only endpoints (`require-evidence`, `adjudicate`)
   let you move a case through its lifecycle without waiting days.

## Tools used

| Tool | How it's used |
|---|---|
| **PayPal Disputes API** | List and read disputes; send messages, provide evidence, make offers, accept claims; sandbox simulators |
| **PayPal Orders v2 + JS SDK** | Test shop (`/shop`) used to create real sandbox purchases to dispute |
| **PayPal Shipment Tracking / Transaction Search** | Evidence sources the agent queries |
| **Claude (Anthropic API, `claude-opus-5-5`)** | Tool-use agent via the official `@anthropic-ai/sdk` tool runner, with adaptive thinking and structured (Zod-validated) recommendations |
| **AG Grid Community** | The dispute queue |

## Run it

Requirements: Node 20+, a free [PayPal Developer](https://developer.paypal.com) account, and an
[Anthropic API key](https://console.anthropic.com).

```bash
git clone <this repo> && cd dispute-copilot
npm install
cp .env.example .env   # then fill in the three keys
npm start              # http://localhost:3000
```

**PayPal setup:**
1. developer.paypal.com → Apps & Credentials (Sandbox) → Create App (Merchant). Copy the Client ID
   and Secret into `.env`.
2. In the app's Features, enable **Transaction search**.
3. Create a dispute to work on. Sign in to https://www.sandbox.paypal.com as your **Personal**
   sandbox account, pay the **Business** account (or buy from `/shop`), then go to the payment →
   *Report a problem*. It shows up in the queue within a few minutes.

**Demo merchant data:** `data/store.json` stands in for the merchant's store backend (orders,
fulfilment and policy). Orders are matched to disputes by seller transaction ID, then by buyer email.
Add an entry with your sandbox transaction ID to see the agent build a case from it.

## Architecture

```
browser (AG Grid + drawer) ──SSE──► server.mjs ──► lib/agent.mjs ──► Claude (tool runner)
                                        │                  │
                                        │                  └─ tools ─► PayPal APIs, data/store.json
                                        └─► lib/paypal.mjs ─► PayPal REST (OAuth client credentials)
```

The PayPal secret and the Anthropic key stay on the server. Buyer messages are treated as untrusted
input, and the agent can only *propose* actions; it can't send anything until the merchant approves.

## License

MIT
