# Deploying: Neon (database) + Render (backend + PWA)

You already have the ElevenLabs agent built and talking through their web
interface. This doc gets the backend + PWA onto real infrastructure and
then re-points the agent's tools at it — nothing about the agent config
itself changes except the base URL.

## 1. Neon (database)

1. Go to neon.tech, sign in, **New Project**. Pick a region close to you or
   your Render region (matching regions shaves a few ms per query, not
   critical at this scale).
2. Once created, go to **Connection Details**. Select **Pooled connection**
   (not "direct") — this matters: Render's free tier + a normal web
   workload opens/closes connections often, and Neon's pooler (PgBouncer
   under the hood) handles that far better than a direct connection, which
   Neon's direct endpoint can start rejecting under load.
3. Copy the full connection string — it looks like:
   `postgresql://user:password@ep-xxxx-pooler.region.aws.neon.tech/dbname?sslmode=require`
   (note the `-pooler` in the hostname — that confirms you copied the
   pooled one). You'll paste this into Render as `DATABASE_URL`.
4. That's it — you do **not** need to manually run `schema.sql` against
   Neon. The backend calls `ensureSchema()` on every boot (it's just
   `CREATE TABLE IF NOT EXISTS` statements) and seeds the shop/services/
   barber data from `knowledge-base.json` automatically the first time it
   finds an empty `shop` table. First deploy = schema created + seeded in
   one step.

## 2. Render (backend + PWA, same service)

The backend already serves the PWA as static files (see `server.js`), so
one Render web service is all you need — no separate static site.

1. Push this project to a GitHub repo (Render deploys from git).
2. In Render: **New +** → **Blueprint**, point it at the repo. It'll read
   `render.yaml` at the root and propose the `barbershop-ai-backend`
   service — confirm.
   - If you'd rather not use the Blueprint file, create it manually
     instead: **New +** → **Web Service** → your repo → set **Root
     Directory** to `backend`, **Build Command** to `npm install`,
     **Start Command** to `npm start`.
3. In the service's **Environment** tab, add:
   - `DATABASE_URL` — the Neon pooled connection string from step 1.
   - `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — generate locally first:
     ```
     npx web-push generate-vapid-keys
     ```
     paste the two keys in. (Skip this if you don't need push reminders
     yet — the app runs fine without it, reminders just log instead of
     pushing.)
4. Deploy. Watch the logs — on first boot you should see:
   ```
   [startup] connecting to Neon and ensuring schema...
   [db] No shop row found — seeding from knowledge-base.json
   [db] Seed complete.
   [startup] database ready.
   ```
5. Render gives you a URL like `https://barbershop-ai-backend.onrender.com`.
   Visit `https://<your-url>/health` — you should get
   `{"ok":true,"db":"connected",...}`. Then visit the root URL — you should
   see the PWA (empty schedule, since nothing's booked on the live DB yet).
   Install it to your phone from there.

**Free-tier note**: Render's free web services spin down after 15 minutes
of no traffic and take ~30-50s to wake back up on the next request. That
30-50s delay would land right in the middle of a live phone call and read
as dead air to the caller — worth knowing about before you rely on this for
real calls; the paid "Starter" tier removes the spin-down. Fine for
building/testing in the meantime, since you're testing through the
ElevenLabs web interface rather than live calls right now anyway.

## 3. Re-point the ElevenLabs agent's tools at the live URL

You already built the agent and its tools per `docs/elevenlabs-agent-setup.md`,
pointed at wherever you were testing before (localhost/ngrok). Now:

1. In the ElevenLabs dashboard, open your agent → **Tools**.
2. For each of the tool webhooks (`start_call`, `get_shop_info`,
   `lookup_client`, `get_recommendation`, `check_availability`,
   `book_appointment`, `find_appointments_by_phone`,
   `reschedule_appointment`, `cancel_appointment`, `log_call_outcome`),
   edit the URL from your old ngrok/local URL to:
   `https://<your-render-url>.onrender.com/tools/<toolname>`
   — same path, just the new host.
3. Save, then test through the same ElevenLabs web interface you've been
   using. Watch the Render service logs while you talk to it (Render
   dashboard → Logs, or `render logs` CLI) — every tool call the agent
   makes prints there in real time, same as it did locally, so you can
   confirm bookings are actually landing in Neon and not silently failing.

### About not using Twilio

Nothing else needs to change for this. A tool call is just an HTTPS
request regardless of whether the conversation came in over a real phone
number or ElevenLabs' own web widget — `agent-tools.js` already treats
`callerPhone` as optional for exactly this reason (see the comment on
`/tools/start_call`). The one behavioral consequence: without Twilio
there's no automatic caller ID, so the agent has to *ask* for the phone
number itself before it can look the client up — which the system prompt
in `elevenlabs-agent-setup.md` already does as literally step 1 of the
booking flow, so this needed no prompt changes either. If you add a real
phone number later (Twilio, or another provider once one works in your
region), `callerPhone` just starts arriving automatically and the rest of
the flow is unchanged.

## 4. Sanity-check the live system end to end

After re-pointing, do one full pass through the ElevenLabs web interface:
1. Say a name and phone number → confirm the agent asks for these first.
2. Ask about hours/prices → confirm it's pulling from your actual Neon data
   (edit a price via `PUT /api/services/:id` first and confirm the agent's
   answer changes — proves it's not reciting from memory).
3. Book something → check it shows up in the PWA on your phone within
   ~30s (the dashboard polls every 30s).
4. Try to book the same slot again in a fresh test call → confirm it
   offers real alternatives instead of double-booking.
5. Try canceling something you just booked (should work — outside the
   10-min guardrail window) and something you make with a start time a few
   minutes from now (should trigger `transfer_to_barber` instead).

If all five hold up against the live Render+Neon stack, you're at parity
with everything that was verified locally during the original build.
