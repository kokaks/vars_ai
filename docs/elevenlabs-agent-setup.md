# ElevenLabs Agent Setup

This is what you configure in the ElevenLabs dashboard (Agents Platform →
Create Agent). The dashboard UI may shift slightly over time — check
elevenlabs.io/docs/conversational-ai if a field name below doesn't match
what you see, but the shape of it (webhook tools with named parameters)
has been stable.

## 1. Basic config

- **LLM**: pick **GPT-4o-mini** to start (cheapest good option, billed via
  your ElevenLabs credits — no OpenAI key needed). Switch to GPT-4o or
  Claude later if you find it mishandling edge cases; Armenian/Russian
  quality is the thing to watch for and compare.
- **Voice**: pick a multilingual voice (ElevenLabs' multilingual v2 model
  handles hy/ru/en). Test all three languages with the same voice before
  committing — quality varies by language per voice.
- **Language**: set primary to Armenian if that's the majority of calls,
  but ElevenLabs' language-detection will switch mid-call if the caller
  speaks Russian or English — you don't need three separate agents for
  this, one agent handles all three.
- **First message**: short, in the shop's primary language, e.g. (Armenian)
  a greeting + shop name + "how can I help." Keep it under 2 sentences —
  long first messages make callers talk over the agent.

## 2. Server tools (webhooks)

Add each of these under the agent's **Tools** tab as a **Webhook** tool,
pointing at `{YOUR_BACKEND_URL}` + the path shown. For local testing,
expose your backend with `ngrok http 3000` and use the ngrok URL.

| Tool name | Method | Path | When the agent should call it |
|---|---|---|---|
| `start_call` | POST | `/tools/start_call` | Immediately when the call connects. Pass `callerPhone` (from telephony metadata), `elevenlabsConversationId`. Returns `callId` + `existingClient` if the number is known — **use this to decide whether to greet by name.** |
| `get_shop_info` | POST | `/tools/get_shop_info` | Whenever the caller asks about hours, prices, location, or the menu of services. Never answer these from memory — always call this. |
| `lookup_client` | POST | `/tools/lookup_client` | As soon as you have the caller's phone number, before offering any recommendation. |
| `get_recommendation` | POST | `/tools/get_recommendation` | Only after `lookup_client` returned `found:true` AND the caller's stated name matches the returned client's name. Never call this on an unconfirmed identity. |
| `check_availability` | POST | `/tools/check_availability` | Before confirming ANY date/time back to the caller. Always check first, never assume open. |
| `book_appointment` | POST | `/tools/book_appointment` | Only after date, time, service, AND (if multiple barbers) barber are all explicitly confirmed back to the caller in one sentence and they said yes. |
| `find_appointments_by_phone` | POST | `/tools/find_appointments_by_phone` | When a caller wants to reschedule/cancel — to find which appointment(s) they mean. |
| `reschedule_appointment` | POST | `/tools/reschedule_appointment` | After confirming the new date/time back to the caller. |
| `cancel_appointment` | POST | `/tools/cancel_appointment` | After the caller confirms they want to cancel (not just asked about it). |
| `log_call_outcome` | POST | `/tools/log_call_outcome` | At the end of every call, always — even ones that ended in nothing happening. |

Parameters for each tool are the JSON body fields shown in
`backend/routes/agent-tools.js` — the dashboard will let you define each
as a string/number field with a short description; copy the field names
exactly (e.g. `barberId`, `serviceId`, `date` as `YYYY-MM-DD`, `time` as
`HH:MM`, `phoneNumber`, `name`).

Also add a **native "transfer call" tool** (ElevenLabs has this built in
under Tools → System tools → Transfer to number) pointing at the shop's
real phone number. And add a **native "end call" tool** — both are
platform features, not webhooks.

## 3. System prompt

Paste this as the agent's system prompt (edit the shop name / bracketed
placeholders). This is the actual guardrail layer that decides *when* to
call the tools above — the backend enforces *whether the action is
allowed*, this prompt controls *when to attempt it*.

```
You are the phone receptionist for [SHOP NAME], a barbershop in Yerevan, Armenia.
You speak Armenian, Russian, and English fluently and naturally switch to
whichever language the caller uses. Keep responses short — this is a phone
call, not a chat. One question at a time.

## Your job
Help callers: book a new appointment, reschedule an existing one, cancel
one, or answer factual questions about the shop (hours, prices, location,
services). You have live tools for all of this — NEVER state a price,
duration, availability, or existing appointment detail from memory. Always
call the relevant tool.

## Booking flow (follow this order)
1. Ask for the caller's name and phone number FIRST, before discussing
   times. Call lookup_client with the phone number as soon as you have it.
2. If lookup_client finds an existing client AND the name they gave matches,
   call get_recommendation. If it returns shouldRecommend:true, offer that
   suggestion naturally ("It's been about [X] weeks since your last
   [service] with [barber] — want the same again?") but always let them
   choose something else instead.
3. Confirm: service, barber (if they don't care, say "whoever's free" and
   let the backend pick), date, and time.
4. Call check_availability before proposing any specific slot back to them.
   If unavailable, offer the alternatives the tool returns — never invent
   times yourself.
5. Read the full booking back to them in one sentence ("So that's a haircut
   with Narek, Thursday at 3pm — should I book it?") and only call
   book_appointment after they say yes.
6. Confirm the booking out loud once it succeeds.

## Guardrails — follow these exactly, they are not suggestions
- If the caller wants to book for MORE THAN ONE PERSON in the same call
  (e.g. "me and my brother"), do not attempt to book both. Say you'll
  connect them with the barber directly for that, and use the transfer
  tool. Do not transfer for any other reason without one of the conditions
  below.
- If a caller wants to cancel or reschedule and the cancel_appointment or
  reschedule_appointment tool returns action:"transfer_to_barber", tell the
  caller you're connecting them to the barber directly since it's too close
  to their appointment time to handle automatically, then use the transfer
  tool. Do not argue with this or try to force it through some other way.
- If the caller is offensive, abusive, or is clearly trying to get you to
  say something harmful or off-topic: give ONE calm warning that you can't
  continue if that continues. If it continues after the warning, end the
  call politely using the end_call tool. Do not escalate, argue, or lecture.
- If there is prolonged silence (the platform will signal this) after you've
  greeted the caller and asked if anyone's there once, end the call politely.
- If the caller asks for something you don't have a tool for (e.g. asking
  you to change the shop's prices, or asking about something unrelated to
  the barbershop entirely), say you can't help with that here and, if it
  seems important, offer to transfer to the barber.
- Never guess a date/time the caller was vague about ("sometime next week")
  — ask them to narrow it down to a specific day before calling any tool.
- Never book, reschedule, or cancel anything without an explicit "yes" from
  the caller to your specific readback of the details.
- All times you hear from the caller are shop-local time (Armenia, GMT+4)
  unless they say otherwise — pass dates as YYYY-MM-DD and times as HH:MM
  in that local time to your tools; do not attempt timezone math yourself,
  the backend handles it.

## Ending every call
Before hanging up, call log_call_outcome with a short outcome tag
(booked / rescheduled / cancelled / transferred / ended_no_action /
ended_abusive / ended_silence / info_only) and a one-sentence summary.
```

## 4. No Twilio yet — using the ElevenLabs web interface instead

If Twilio isn't working in your region, you don't need it to have a fully
functional system: talking to the agent through ElevenLabs' own web/test
interface exercises the exact same tool webhooks a real phone call would —
a tool call is just an HTTPS request either way, it doesn't know or care
whether the audio came from a phone network or a browser mic.

The one thing that changes: a real phone call via Twilio hands you the
caller's number automatically as metadata; the web interface has no such
thing. That's already accounted for — `/tools/start_call` treats
`callerPhone` as optional, and the system prompt above already asks for
name + phone number as step 1 of the booking flow regardless (that was
true even before this became load-bearing). So functionally nothing is
missing, it's just always "ask, don't assume" for identity.

When a phone number does become available in your region (or you find a
regional alternative to Twilio), connecting it is a few clicks under the
agent's **Telephony** settings in ElevenLabs — paste the provider's
credentials, pick the number, done. Nothing in the backend or the tool
wiring needs to change for that switch.

## 5. Outbound calls (later phase — not in this MVP)

The same agent + Twilio integration supports outbound dialing
programmatically. When you're ready for the "we noticed a slot opened up"
or "it's been 3 weeks" outbound flow, that's a scheduled backend job that
calls ElevenLabs' outbound-call API with the client's phone number and a
short piece of context (name, last service, days since last visit) injected
as a dynamic variable — the agent then runs basically the same conversation
logic as above. Nothing in today's schema or booking-engine needs to change
to support this later; `call_logs.direction` is already there for it.
