// Kapture Collections Voicebot — Mock Webhook Server
// Vapi "API Request" tools send the configured JSON body directly to the
// tool's own URL (no "message.toolCallList" wrapper — that wrapper is only
// used by Vapi's older/legacy "Function" tool + assistant-server webhook
// flow, not by the "API Request" tool type used here). Each of the 5 tools
// is registered in Vapi with its own URL path (e.g. /webhook/verify_customer),
// so this server exposes one route per tool and reads the plain JSON body
// directly as that tool's arguments.
//
// Run:   npm install   &&   node server.js
// Expose locally:   ngrok http 3000
// Vapi tool URLs should be:
//   https://<ngrok-subdomain>.ngrok-free.dev/webhook/verify_customer
//   https://<ngrok-subdomain>.ngrok-free.dev/webhook/log_promise_to_pay
//   https://<ngrok-subdomain>.ngrok-free.dev/webhook/send_payment_link
//   https://<ngrok-subdomain>.ngrok-free.dev/webhook/escalate_to_agent
//   https://<ngrok-subdomain>.ngrok-free.dev/webhook/mark_disposition

const express = require("express");
const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// In-memory "database" for this mock — one seeded account.
// ---------------------------------------------------------------------------
const ACCOUNTS = {
  "ACC-88392": {
    customer_name: "Rahul Sharma",
    valid_codes: ["1234", "1995"], // last-4 PAN or birth year, either accepted
    product: "personal loan",
    balance: 8499,
    dpd: 12,
  },
};

// Call log — every disposition, PTP, and escalation gets appended here.
const CALL_LOG = [];

// Server-side auth state, keyed by account_id.
//
// ⚠️ TEST-ONLY, NOT PRODUCTION-SAFE: Vapi's "API Request" tool type does not
// send a call/session id in the request body, only whatever parameters the
// tool schema defines — so there is no per-call identifier available to key
// on here. account_id is the only thing every one of our 5 tools has in
// common, so it's used as the auth key. This means two different concurrent
// callers for the same account would share one auth state. That's fine for
// this single-account take-home demo; a production build would need Vapi's
// assistant-server webhook (which does include call.id) or a custom LLM
// backend to get a real per-call session id to key on instead.
//
// This is still what closes the "auth is prompt-only" gap for this demo: a
// tool that discloses or acts on debt cannot succeed for an account that
// hasn't passed verify_customer in THIS server's memory, regardless of what
// the model claims.
const AUTHENTICATED_ACCOUNTS = new Set();

function maskName(name) {
  if (!name) return name;
  const parts = name.split(" ");
  return parts.map((p, i) => (i === 0 ? p : p[0] + "*".repeat(Math.max(p.length - 1, 1)))).join(" ");
}

// Speech-to-text often transcribes spoken digits with spaces or commas
// ("12 34", "1, 2, 3, 4") instead of a clean "1234". Strip everything that
// isn't a digit before comparing against the stored codes, so the caller
// saying the digits naturally on a phone call still verifies correctly.
function normalizeCode(code) {
  return String(code || "").replace(/\D/g, "");
}

// ---------------------------------------------------------------------------
// Routes — one per tool, matching each tool's Request URL in Vapi
// ---------------------------------------------------------------------------

app.post("/webhook/verify_customer", (req, res) => {
  const args = req.body || {};
  console.log(`[tool-call] verify_customer`, args);

  const account = ACCOUNTS[args.account_id];
  const normalizedCode = normalizeCode(args.verification_code);
  const ok = !!account && account.valid_codes.includes(normalizedCode);

  if (ok) AUTHENTICATED_ACCOUNTS.add(args.account_id);

  const result = ok
    ? {
        verified: true,
        message: "Identity verified successfully.",
        customer_name: account.customer_name,
        // Debt-specific fields are deliberately ONLY returned here, on a
        // successful verification — they are never present in the Vapi
        // system prompt. This is what makes the disclosure gate actually
        // state-enforced rather than "the model was told not to say it":
        // if verification fails or hasn't happened, this data plainly does
        // not exist anywhere in the model's context yet.
        product: account.product,
        overdue_amount: account.balance,
        dpd: account.dpd,
      }
    : { verified: false, message: "Verification failed. Code did not match our records." };

  console.log(`[result] verify_customer ->`, result.verified ? "VERIFIED" : "FAILED");
  return res.status(200).json(result);
});

app.post("/webhook/log_promise_to_pay", (req, res) => {
  const args = req.body || {};
  console.log(`[tool-call] log_promise_to_pay`, args);

  // Server-side enforcement of the HLD's auth gate: this tool requires the
  // account to have already produced a successful verify_customer in THIS
  // server's memory. A model that tries to skip straight here gets rejected
  // regardless of what it claims.
  if (!AUTHENTICATED_ACCOUNTS.has(args.account_id)) {
    console.warn(`[blocked] log_promise_to_pay called before verify_customer succeeded for account=${args.account_id}`);
    return res.status(200).json({
      success: false,
      error: "UNAUTHENTICATED",
      message: "This account has not completed identity verification. Call verify_customer successfully before using this tool.",
    });
  }

  const account = ACCOUNTS[args.account_id];

  // Reject rather than silently rewrite the customer's commitment. The
  // HLD's own rule ("PTP amount cannot exceed outstanding balance") is an
  // invariant to enforce, not a value to quietly correct.
  const amount = typeof args.amount === "string" ? parseFloat(args.amount) : args.amount;
  if (account && typeof amount === "number" && !isNaN(amount) && amount > account.balance) {
    console.log(`[result] log_promise_to_pay -> REJECTED (amount exceeds balance)`);
    return res.status(200).json({
      success: false,
      error: "AMOUNT_EXCEEDS_OUTSTANDING",
      message: `Promise amount (${amount}) cannot exceed the outstanding balance (${account.balance}). Ask the customer to confirm a valid amount and call this tool again.`,
      outstanding_balance: account.balance,
    });
  }

  // Enforce that the PTP date is genuinely in the future. The prompt asks
  // the model to capture a future date, but the backend is the
  // authoritative check.
  const parsedDate = new Date(`${args.ptp_date}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (isNaN(parsedDate.getTime())) {
    console.log(`[result] log_promise_to_pay -> REJECTED (invalid date)`);
    return res.status(200).json({
      success: false,
      error: "PTP_DATE_INVALID",
      message: `ptp_date "${args.ptp_date}" is not a valid ISO-8601 date (YYYY-MM-DD). Ask the customer to confirm a specific date and call this tool again.`,
    });
  }
  if (parsedDate <= today) {
    console.log(`[result] log_promise_to_pay -> REJECTED (not future)`);
    return res.status(200).json({
      success: false,
      error: "PTP_DATE_NOT_FUTURE",
      message: `ptp_date "${args.ptp_date}" is not in the future. Ask the customer for a future payment date and call this tool again.`,
    });
  }

  const entry = {
    type: "PTP",
    account_id: args.account_id,
    ptp_id: `PTP-${Math.floor(1000 + Math.random() * 9000)}`,
    ptp_date: args.ptp_date,
    amount: amount,
    logged_at: new Date().toISOString(),
  };
  CALL_LOG.push(entry);
  console.log(`[result] log_promise_to_pay -> SUCCESS`, entry);
  return res.status(200).json({ success: true, ptp_id: entry.ptp_id, confirmed_date: entry.ptp_date, amount: entry.amount });
});

app.post("/webhook/send_payment_link", (req, res) => {
  const args = req.body || {};
  console.log(`[tool-call] send_payment_link`, args);

  if (!AUTHENTICATED_ACCOUNTS.has(args.account_id)) {
    console.warn(`[blocked] send_payment_link called before verify_customer succeeded for account=${args.account_id}`);
    return res.status(200).json({
      success: false,
      error: "UNAUTHENTICATED",
      message: "This account has not completed identity verification. Call verify_customer successfully before using this tool.",
    });
  }

  // Mock dispatch — in production this calls an SMS/WhatsApp provider (e.g. Twilio, Gupshup).
  const result = {
    success: true,
    message: `Payment link sent via ${args.channel} to the registered mobile number for ${args.account_id}.`,
  };
  console.log(`[result] send_payment_link -> SUCCESS`);
  return res.status(200).json(result);
});

app.post("/webhook/escalate_to_agent", (req, res) => {
  const args = req.body || {};
  console.log(`[tool-call] escalate_to_agent`, args);

  const entry = {
    type: "ESCALATION",
    account_id: args.account_id,
    reason: args.reason,
    notes: args.notes || "",
    ticket_id: `TCK-${Math.floor(10000 + Math.random() * 90000)}`,
    logged_at: new Date().toISOString(),
  };
  CALL_LOG.push(entry);
  console.log(`[result] escalate_to_agent -> SUCCESS`, entry);
  return res.status(200).json({ success: true, queued: true, ticket_id: entry.ticket_id });
});

app.post("/webhook/mark_disposition", (req, res) => {
  const args = req.body || {};
  console.log(`[tool-call] mark_disposition`, args);

  const entry = {
    type: "DISPOSITION",
    account_id: args.account_id,
    status: args.status,
    notes: args.notes || "",
    logged_at: new Date().toISOString(),
  };
  CALL_LOG.push(entry);
  console.log(`[disposition] ${maskName(ACCOUNTS[args.account_id]?.customer_name)} -> ${args.status}`);

  // Call is over; clear auth state for this account so the next call starts fresh.
  AUTHENTICATED_ACCOUNTS.delete(args.account_id);

  return res.status(200).json({ success: true, disposition_logged: args.status, timestamp: entry.logged_at });
});

// Simple endpoints to eyeball what's happened during testing.
app.get("/log", (req, res) => res.status(200).json(CALL_LOG));
app.get("/authenticated-accounts", (req, res) => res.status(200).json([...AUTHENTICATED_ACCOUNTS]));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Kapture mock collections webhook server listening on port ${PORT}`);
});