# Barbershop AI Receptionist

A working skeleton: a phone call (or right now, a call through ElevenLabs'
own web interface) can book, reschedule, or cancel a real appointment
through actual guardrail logic, and it shows up live in a PWA a barber can
install on their phone — backed by Postgres on Neon, deployed on Render.

## Current state

| Piece | Status |
|---|---|
| Booking engine (guardrails, timezone, buffers, breaks) | ✅ Built, tested against Postgres |
| Database | ✅ Postgres via Neon — schema auto-creates + seeds on first boot |
| REST API for the PWA | ✅ Working |
| PWA (dashboard, walk-in button, settings, push) | ✅ Working — needs VAPID keys for real push |
| Agent tool webhooks (`/tools/*`) | ✅ Built, regression-tested with curl against Postgres |
| ElevenLabs agent | ✅ You've built this — talking through ElevenLabs' web interface |
| Phone number (Twilio) | ⏸️ Not set up (regional issue) — not required, see below |
| Deployment | ⚙️ `render.yaml` + `docs/deployment-render-neon.md` — deploy this and re-point the agent's tool URLs at it |

## Why no Twilio phone number is fine for now

A tool call from the ElevenLabs agent is just an HTTPS POST — it works
identically whether the conversation came in over a real phone number or
ElevenLabs' web interface. The only real difference is that Twilio would
hand you the caller's phone number automatically; without it, the agent
just asks for the number itself, which the system prompt already does as
literally the first step of every booking flow. `/tools/start_call` treats
`callerPhone` as fully optional for exactly this reason. When a number
becomes available in your region, wiring it in is a few clicks in
ElevenLabs' Telephony settings — nothing here needs to change.

## Why there's no OpenAI key anywhere

The in-call reasoning (understanding the caller, phrasing responses,
judging if something's offensive) runs on whichever LLM you picked inside
the ElevenLabs agent config (GPT-4o-mini/Claude/Gemini) — billed through
your ElevenLabs credits, not a separate OpenAI key. The backend's own
"reasoning" (`services/reasoning.js` — should we recommend a rebooking) is
deliberately deterministic arithmetic, not an LLM call: it computes facts,
the agent phrases them. No external LLM key is needed anywhere in this
backend.

## Deploying

See **`docs/deployment-render-neon.md`** for the full walkthrough:
create the Neon project → copy the pooled connection string → deploy to
Render (Blueprint via `render.yaml`, or manual web service) → set
`DATABASE_URL` (+ optional VAPID keys) → re-point your existing
ElevenLabs agent's tool URLs from localhost/ngrok to the live Render URL.
Nothing about the agent itself needs to change, just the tool base URL.

## Local development

```bash
# Local Postgres, or a Neon dev branch — either works, same code path
cd backend
cp .env.example .env   # fill in DATABASE_URL
npm install
npm start
```

First boot creates the schema and seeds it from
`backend/data/knowledge-base.json` automatically. Visit
`http://localhost:3000/health` to confirm DB connectivity, and
`http://localhost:3000` for the PWA.

### Verified against Postgres (ran these myself before shipping this version)

```
check_availability during working hours   → available: true
check_availability during lunch break     → available: false, reason: during_break, + 3 real alternative slots
book_appointment                          → creates appointment, correctly converts 12:00 Yerevan → 08:00 UTC
double-book same slot                     → correctly rejected as conflict, offers alternatives
lookup_client by phone                    → returns client + upcoming appointments
reschedule_appointment                    → old slot released, new slot booked, linked
walk-in via PWA API                       → books instantly through the same code path as phone bookings
start_call with no phone number           → works (simulates the ElevenLabs web-interface case, no Twilio caller ID)
static PWA serving                        → index.html and app.js both 200
```

## Project layout

```
backend/
  db/schema.sql          — Postgres schema, heavily commented
  db/index.js            — Neon connection pool, auto-schema, auto-seed
  data/knowledge-base.json — shop facts (hours, breaks, services, prices)
  services/booking-engine.js — ALL scheduling logic + guardrails (async/Postgres)
  services/reasoning.js  — deterministic recommendation logic (no LLM)
  services/notification-scheduler.js — polls for due reminders, sends push
  routes/agent-tools.js  — what the ElevenLabs agent calls mid-call
  routes/pwa-api.js      — what the PWA calls
  server.js              — entrypoint (awaits DB init before listening)
pwa/
  index.html / css/style.css / js/app.js — the barber dashboard
  manifest.json / sw.js  — installable + push notifications
docs/
  elevenlabs-agent-setup.md   — system prompt + tool wiring + web-interface notes
  deployment-render-neon.md   — Neon + Render deployment walkthrough
render.yaml               — Render Blueprint
```

## Guardrails implemented and where (unchanged from the original design)

- **Multi-person booking → transfer**: `agent-tools.js` `/tools/book_appointment`
  refuses `partySize > 1`, tells the agent to transfer.
- **Cancel/reschedule too close to start → transfer**: `booking-engine.js`
  `cancelAppointment()`, threshold configurable via
  `shop.cancel_transfer_threshold_minutes` (default 10 min).
- **Barber breaks / closed hours / time off → can't book**:
  `isWithinWorkingWindow()`.
- **Per-barber buffer between appointments**: `hasConflict()` expands the
  requested window by `barber.buffer_minutes` before checking overlap.
- **Timezone handling (Armenia default, GMT+4)**: caller-spoken times
  assumed shop-local, converted once in `localToUtc()`; stored as
  `TIMESTAMPTZ` (UTC) everywhere else.
- **Client mixup prevention**: `get_recommendation` requires a prior
  `lookup_client` match — enforced in the system prompt and by only ever
  taking a resolved `clientId`, never a bare name.
- **Reputation / at-risk flagging**: `maybeFlagAtRisk()`, fully auditable
  via `client_events`.
- **Walk-in vs. phone-booking collision**: both write through the exact
  same `bookAppointment()` function against the exact same table.

## What's deliberately not built yet

- A real phone number (blocked on your region — see above, not a code gap)
- Outbound calling (schema already supports it — `call_logs.direction`)
- Customer categories beyond the reputation tag (`clients.tags` is already
  a free-form list, just needs the rules that set more of them)
- Multi-shop / client-facing browsing app
- A real job queue for notifications (current 30s poller is fine at
  one-shop scale)
