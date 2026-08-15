# Kapture Finance — Collections Voicebot ("Maya")

## Changelog — v1.2: debt data moved out of the static prompt

A second review pass caught a real architectural gap: even though the prompt said
"never disclose debt terms before verification," the loan type, overdue amount, and
DPD were still sitting in the static system prompt's ACCOUNT CONTEXT section from the
start of the call — so the rule was enforced by the model choosing to comply, not by
the data being genuinely absent. That's weaker than what the HLD (Section 2) actually
specifies: "the debt-disclosure system message text does not exist in context until
the tool result flips the state."

Fixed, without needing a custom orchestrator service:

- **`vapi/system_prompt.txt`** — the ACCOUNT CONTEXT section now contains only
  non-sensitive routing info (customer name, account ID, verification method). Loan
  type, overdue amount, and DPD are not written anywhere in the prompt. STATE 2's
  disclosure line now says to use `{product}`, `{overdue_amount}`, `{dpd}` "exactly as
  returned by the tool — never a value you recall from the system prompt, because
  there isn't one."
- **`mock-server/server.js`** — `verify_customer`'s success response now includes
  `product`, `overdue_amount`, and `dpd`. Since Vapi injects tool results into the
  live conversation as they arrive, this means the debt data genuinely does not exist
  in the model's context until a successful verification produces it — not "exists but
  the model was told not to mention it." Verified live: a `verify_customer` call
  returns the three fields on success; a fresh, never-verified account gets no such
  data anywhere in the transcript.

This means the actual Vapi build's information flow now matches the HLD's diagram
(AUTH_PENDING → `verify_customer` success → AUTHENTICATED → debt context becomes
available) rather than the HLD describing a stronger design than the build has. The
remaining gap — that the *rest* of the state machine (branching, retries, the 3-strikes
limit) still lives in one prompt rather than a code-enforced orchestrator — is real and
still documented below; it's a materially smaller gap than the disclosure-content one
this fixes.

Also fixed: the `AUTHENTICATED_CALLS` fallback-key comment previously claimed the
server falls back to `account_id` when Vapi's payload omits `call.id`, but the code
only ever used `call.id` — so the fallback didn't actually exist. `server.js` now
computes a real `authKey = callId || args.account_id` per tool call and uses it
consistently for both recording and checking auth state, so the described behavior and
the actual behavior match. Verified live: a request with no `call.id` for a
never-verified account is blocked; the same account after a fallback-keyed
`verify_customer` success is then allowed.

## Changelog — post-review fixes (v1.1)

A review pass against Vapi's current webhook payload format caught a real
compatibility bug plus three smaller consistency issues. All four are fixed in this
version:

1. **Webhook parser now matches Vapi's current payload shape.** Vapi's current
   `ServerMessageToolCalls` type carries tool calls under `message.toolCallList`
   (not `message.toolCalls`, which the first draft of `server.js` read exclusively —
   confirmed by inspecting Vapi's public `server-sdk-typescript` type definitions).
   `server.js` now reads `toolCallList` first, falls back to `toolCalls` and
   `toolWithToolCallList[].toolCallList` for older/alternate payload shapes, dedupes
   by tool-call id, and normalizes both the nested (`function.name`/`function.arguments`)
   and flattened (`name`/`arguments`) tool-call shapes, with `arguments` handled as
   either a JSON string or an already-parsed object. Verified against both shapes with
   live curl requests (see `mock-server/server.js` header comment for details) —
   this was the one fix that genuinely could have caused a live-demo failure.
2. **`mark_disposition` now has `CALLBACK_REQUESTED` and `HOSTILE_TERMINATED`**
   in its enum (`vapi/tool_definitions.json`), and the prompt's callback (BRANCH F)
   and abusive-caller paths call those instead of overloading `NO_RESPONSE`, giving
   cleaner disposition analytics.
3. **Pre-verification response wording tightened.** The STATE 0 fallback line no
   longer says "calling from Kapture Finance regarding their account" — it now says
   "For privacy and security, I need to verify that I'm speaking with the intended
   customer before I can discuss the reason for the call," which matches the HLD's
   stricter pre-auth disclosure standard (no lender-product linkage before verification).
4. **Server-side auth enforcement added.** `mock-server/server.js` now tracks
   `call.id → authenticated` in memory and rejects `log_promise_to_pay` and
   `send_payment_link` with `{ success:false, error:"UNAUTHENTICATED" }` if that call
   hasn't produced a successful `verify_customer` first — closing the gap the HLD
   flags (Section 2, implementation note) where auth was previously enforced only by
   the prompt. This is still a mock/in-memory approximation of the HLD's proposed
   orchestrator-level state machine (Section 2.1), not the full production design —
   see *Known limitation* below for what's still missing.

One thing a review pass raised that turned out **not** to be an issue on inspection:
the prompt's already-paid branch (BRANCH B) does state the same 24–48 hour bank
processing line as the HLD — they were already consistent.


AI Delivery Intern take-home: HLD + working Vapi build for an outbound collections
voicebot. This repo contains everything except the live call recording, which you'll
need to capture yourself once the assistant is wired up in your own Vapi account (see
**"What's left for you to do"** below — it needs real Vapi/webhook credentials that
don't exist outside your account).

## Repo layout

```
kapture-collections-voicebot/
├── README.md                         # this file
├── docs/
│   ├── architecture.dot / .png       # pipeline diagram (Graphviz source + rendered)
│   └── state_machine.dot / .png      # conversation state machine diagram
├── vapi/
│   ├── system_prompt.txt             # full Vapi system prompt
│   └── tool_definitions.json         # 5 tool/function schemas for Vapi
├── mock-server/
│   ├── server.js                     # Express webhook implementing all 5 tools
│   ├── package.json
│   └── .env.example
└── tests/
    └── test_cases.json               # 12-case eval matrix (happy path + edge cases)
```

The HLD document (`Kapture_Collections_Voicebot_HLD.docx`) is delivered alongside this
folder, not inside it — it's the Task 1 deliverable and embeds both diagrams from
`docs/`.

## Setup

### 1. Run the mock webhook server
```bash
cd mock-server
npm install
cp .env.example .env      # defaults are fine for local testing
npm start                 # listens on :3000
```

### 2. Expose it publicly (Vapi needs an HTTPS URL it can reach)
```bash
ngrok http 3000
# copy the https://<subdomain>.ngrok-free.app URL it prints
```

### 3. Create the Vapi assistant
1. Log in to the [Vapi dashboard](https://dashboard.vapi.ai) → **Assistants** → **Create Assistant** → **Blank Template**.
2. **Model:** OpenAI `gpt-4o` (or `gpt-4o-mini` to save credits), temperature `0.1`.
3. **Transcriber:** Deepgram, model `nova-2`, language `multi` (needed for the EN/HI bonus).
4. **Voice:** ElevenLabs or Cartesia — pick a calm, professional voice (see *Design choices* below).
5. **First message:** leave blank — the system prompt's STATE 0 line handles the opening so the greeting logic lives in one place.
6. Paste the contents of `vapi/system_prompt.txt` into the assistant's system prompt.
7. Go to **Tools**, import `vapi/tool_definitions.json`, and replace every
   `https://YOUR_WEBHOOK_URL/webhook` with your ngrok URL from step 2.

### 4. Test it
Use Vapi's **Web Call** test button (no phone number needed) and run through the
scenarios in `tests/test_cases.json`. Watch your mock server's console log — every
tool call is printed as it comes in, and `GET http://localhost:3000/log` shows
everything logged so far.

### 5. Record the demo
Loom/OBS, 2–4 minutes, showing:
- One full **happy path** (verify → disclosure → PTP → payment link sent).
- One **edge case** (dispute, wrong-person, or already-paid).

## Design choices

- **Temperature 0.1** — this is a compliance-sensitive flow; low temperature keeps the
  agent close to the scripted branches instead of improvising language around debt
  disclosure.
- **Deepgram Nova-2 / `multi` language** — good telephony accuracy and native
  multilingual support, which the bonus (EN/HI mid-call switch) needs without a
  separate STT-language-detection step.
- **ElevenLabs/Cartesia over a robotic TTS voice** — collections calls already carry
  friction; a warm, natural voice measurably reduces hangups in this kind of flow.
- **Disclosure gating done as content omission, not instruction** — the system prompt
  doesn't just *tell* the model not to mention debt terms pre-verification, the STATE 0/1
  text contains none of that vocabulary at all. An instruction ("don't mention X") is
  something a persuasive caller can talk a model past; the absence of the content
  itself is harder to route around. This is the single most load-bearing design choice
  in the prompt — see the *known limitation* below on how to make it enforced by code
  rather than prompt discipline.
- **One `mark_disposition` call per branch, no exceptions** — every terminal branch in
  the prompt explicitly calls it, so a call log missing a disposition is a bug, not an
  ambiguous outcome.
- **Amount capping in the mock server** (`log_promise_to_pay` caps at the account
  balance) — a deliberate small safety net in code, not just prompt instruction, so a
  hallucinated or manipulated amount can't get logged as a valid PTP above what's owed.

## Known limitation & what I'd improve with more time

**The disclosure gate and the payment-action gate are now both enforced outside the
model's own judgment; the branching logic around them still lives in the prompt.** As
of v1.2: debt data literally isn't in context pre-verification (it arrives only via a
successful `verify_customer` tool result), and `log_promise_to_pay`/`send_payment_link`
are rejected server-side for any call that hasn't verified. So the two most
safety-critical properties — never *know* the debt pre-auth, never *act* on payment
pre-auth — no longer depend on the model behaving. What's left inside the prompt alone:
which branch a given caller utterance maps to, the 3-strikes verification retry count,
and state-transition ordering in general. Vapi's blank-assistant template gives one
system prompt and one tool list for the whole call; there's no built-in per-state
prompt-swapping, so a caller who is unusually persuasive could in principle talk the
model into a wrong branch (e.g. logging a PTP when it should have escalated) — it just
can't get them real debt information or a real payment action without verifying first,
because those specific paths are now backed by server-side checks rather than prompt
discipline alone.

With more time, I'd move the full state machine into a thin middleware service sitting
between Vapi and the LLM (Vapi supports a custom LLM endpoint via `model.url`), so:
- Tool availability is gated per state at the Vapi tool-list level too (not just
  rejected after the fact server-side), e.g. `log_promise_to_pay` literally isn't
  offered to the model until `AUTHENTICATED`.
- State transitions, retries, and the 3-strikes verification limit are tracked in code
  with a real counter, instead of relying on the model to count its own attempts.
- The in-memory `AUTHENTICATED_CALLS` set becomes a real datastore entry so auth state
  survives a server restart and is auditable.

Other things I'd add given more runway:
- Real SMS/WhatsApp dispatch (Twilio/Gupshup) behind `send_payment_link`, with
  short-TTL single-use payment links.
- A real ticketing integration behind `escalate_to_agent` instead of a generated
  ticket ID.
- Automated regression testing of `tests/test_cases.json` against transcripts (e.g. an
  LLM-as-judge pass checking "no debt vocabulary before verified:true" mechanically,
  rather than relying on manual listening).
- Calling-hour enforcement at the outbound campaign/dialer level (per the HLD, this is
  intentionally out of the bot's own scope — the bot shouldn't be the thing deciding
  whether it's allowed to be calling right now).

## Debugging notes (fill in as you test)

Once you run this against a live Vapi call, a few things worth watching for based on
how this class of build typically breaks:
- **Tool-call loop/no-op**: if Vapi says a tool was called but your server never logs
  it, double check the webhook URL was actually updated in all 5 tool entries (it's
  easy to update 4 and miss one) and that ngrok is still running — free ngrok URLs
  rotate on restart.
- **Premature disclosure**: if the model discloses debt before verification during
  testing, it's almost always because the *caller's own phrasing* ("I know I owe
  8499") got echoed back rather than generated — add an explicit rule (already in the
  prompt) that the agent must not confirm or repeat a figure the caller states before
  verification either.
- **PTP date ambiguity**: "Friday" resolves differently depending on when the call
  happens; the mock server doesn't resolve relative dates — that's on the prompt to
  turn into a concrete date before calling the tool. Watch for `ptp_date` values coming
  through as raw text like `"Friday"` and tighten the prompt's date-handling instruction
  if so.
- **Hindi/English switch losing state**: multilingual STT can occasionally
  mis-transcribe short numeric strings (PAN digits) said in Hindi; if `verify_customer`
  is getting called with garbled codes during the bonus test, that's an STT confidence
  issue — see TC-011 in the test matrix, which the prompt already guards against by
  asking for repetition on low-confidence input, but it's worth confirming in practice.

## What's left for you to do

Everything code/prompt/design-side is complete and ready to run. The two things I
can't do on your behalf, because they require your own live accounts and a real phone
call:
1. Create your own free-tier Vapi account, wire up the webhook URL, and place a live
   test call.
2. Record the 2–4 minute demo (happy path + one edge case) and drop the link here
   before submitting.


## 🔗 Live Links

- **Deployed backend (Render):** https://kapture-collections-voicebot-3i4y.onrender.com
- **GitHub repo:** https://github.com/Nithish464/kapture-collections-voicebot

---