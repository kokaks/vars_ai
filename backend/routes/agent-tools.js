/**
 * AGENT TOOL ENDPOINTS
 * ----------------------------------------------------------------------------
 * Each of these is registered as a "Server Tool" (webhook) on the ElevenLabs
 * agent. Works identically whether the conversation came in over a real
 * phone number or ElevenLabs' own web/test interface — a tool call is just
 * an HTTPS POST either way. The one real difference: over the phone,
 * Twilio metadata gives you the caller's number automatically; through the
 * web interface there is no such metadata, so the agent has to ASK for the
 * phone number itself (the system prompt already does this first thing,
 * per the booking flow) rather than it arriving with start_call.
 *
 * Every guardrail lives here in code, not in the prompt — a prompt can be
 * argued with by a clever caller, code can't.
 * ----------------------------------------------------------------------------
 */
const express = require("express");
const router = express.Router();
const { query } = require("../db");
const engine = require("../services/booking-engine");
const reasoning = require("../services/reasoning");

// Small helper so every route doesn't need its own try/catch boilerplate —
// errors get logged AND returned as JSON so the agent can react gracefully
// ("something went wrong, let me try that again") instead of the call
// silently hanging.
function asyncRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[tools] error in ${req.path}:`, err);
      res.status(500).json({ error: "internal_error", message: err.message });
    }
  };
}

// ---------------------------------------------------------------------------
// shop / services / barbers info — lets the agent answer factual questions
// (hours, prices, location) from LIVE data, never from its own memory.
// ---------------------------------------------------------------------------
router.post("/tools/get_shop_info", asyncRoute(async (req, res) => {
  const shop = await engine.getShop();
  const servicesResult = await query("SELECT * FROM services WHERE active = true ORDER BY sort_order");
  const barbersResult = await query("SELECT id, name FROM barbers WHERE active = true");
  res.json({ shop, services: servicesResult.rows, barbers: barbersResult.rows });
}));

// ---------------------------------------------------------------------------
// identify client by phone (agent should call this FIRST, per spec, before
// any recommendation logic, to avoid cross-client mixups). Since calls may
// come through the ElevenLabs web interface with no caller-ID, the agent
// always collects the phone number verbally and passes it here explicitly —
// this route doesn't care where the number came from.
// ---------------------------------------------------------------------------
router.post("/tools/lookup_client", asyncRoute(async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: "phoneNumber required" });

  const clientResult = await query("SELECT * FROM clients WHERE phone_number = $1", [phoneNumber]);
  const client = clientResult.rows[0];
  if (!client) return res.json({ found: false });

  const upcomingResult = await query(
    `SELECT * FROM appointments WHERE client_id = $1 AND status = 'confirmed' AND start_utc > now()
     ORDER BY start_utc ASC`,
    [client.id]
  );

  res.json({ found: true, client, upcomingAppointments: upcomingResult.rows });
}));

// ---------------------------------------------------------------------------
// recommendation — ONLY call after lookup_client confirmed a match (name +
// phone), per the flawless-matching requirement in the spec.
// ---------------------------------------------------------------------------
router.post("/tools/get_recommendation", asyncRoute(async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: "clientId required" });
  res.json(await reasoning.getBookingRecommendation(clientId));
}));

// ---------------------------------------------------------------------------
// availability check + alternatives
// ---------------------------------------------------------------------------
router.post("/tools/check_availability", asyncRoute(async (req, res) => {
  const { barberId, serviceId, date, time } = req.body;
  const result = await engine.checkAvailability({ barberId, serviceId, dateStr: date, timeStr: time });

  if (result.ok) return res.json({ available: true });

  const alternatives = await engine.findNextAvailableSlots({
    barberId,
    serviceId,
    fromDateStr: date,
    fromTimeStr: time,
    count: 3,
  });
  res.json({ available: false, reason: result.reason, alternatives });
}));

// ---------------------------------------------------------------------------
// book — GUARDRAIL: multi-person bookings are refused here and the agent is
// told to transfer, matching "don't transfer for no reason" — this IS one.
// ---------------------------------------------------------------------------
router.post("/tools/book_appointment", asyncRoute(async (req, res) => {
  const { barberId, serviceId, date, time, phoneNumber, name, partySize, callId } = req.body;

  if (partySize && Number(partySize) > 1) {
    return res.json({
      ok: false,
      action: "transfer_to_barber",
      reason: "multi_person_booking",
      message: "Multiple people in one booking needs the barber directly.",
    });
  }

  const result = await engine.bookAppointment({
    barberId,
    serviceId,
    dateStr: date,
    timeStr: time,
    client: { phoneNumber, name },
    source: "ai_call",
    callId: callId || null,
  });

  if (!result.ok && result.reason === "conflict") {
    const alternatives = await engine.findNextAvailableSlots({ barberId, serviceId, fromDateStr: date, fromTimeStr: time, count: 3 });
    return res.json({ ok: false, reason: result.reason, alternatives });
  }

  res.json(result);
}));

// ---------------------------------------------------------------------------
// reschedule — guardrail (too-close-to-start) surfaces as action:transfer_to_barber
// ---------------------------------------------------------------------------
router.post("/tools/reschedule_appointment", asyncRoute(async (req, res) => {
  const { appointmentId, newDate, newTime, newBarberId, newServiceId } = req.body;
  const result = await engine.rescheduleAppointment({
    appointmentId,
    newDateStr: newDate,
    newTimeStr: newTime,
    newBarberId,
    newServiceId,
  });
  res.json(result);
}));

// ---------------------------------------------------------------------------
// cancel — guardrail (too-close-to-start) surfaces as action:transfer_to_barber
// ---------------------------------------------------------------------------
router.post("/tools/cancel_appointment", asyncRoute(async (req, res) => {
  const { appointmentId, reason } = req.body;
  const result = await engine.cancelAppointment({ appointmentId, reason });
  res.json(result);
}));

// ---------------------------------------------------------------------------
// find appointment(s) for a caller so the agent can offer "which one?" when
// a client has more than one, before reschedule/cancel.
// ---------------------------------------------------------------------------
router.post("/tools/find_appointments_by_phone", asyncRoute(async (req, res) => {
  const { phoneNumber } = req.body;
  const clientResult = await query("SELECT * FROM clients WHERE phone_number = $1", [phoneNumber]);
  const client = clientResult.rows[0];
  if (!client) return res.json({ found: false });
  const apptResult = await query(
    `SELECT a.*, b.name as barber_name FROM appointments a
     JOIN barbers b ON b.id = a.barber_id
     WHERE a.client_id = $1 AND a.status = 'confirmed' AND a.start_utc > now()
     ORDER BY a.start_utc ASC`,
    [client.id]
  );
  res.json({ found: true, appointments: apptResult.rows });
}));

// ---------------------------------------------------------------------------
// log_call_outcome — the agent calls this at the end of every call so
// call_logs is always populated even for calls that ended in silence,
// abuse, or a transfer.
// ---------------------------------------------------------------------------
router.post("/tools/log_call_outcome", asyncRoute(async (req, res) => {
  const {
    callId, direction, callerPhone, clientId, languageDetected,
    outcome, transferReason, transcriptSummary, elevenlabsConversationId,
  } = req.body;

  if (callId) {
    await query(
      `UPDATE call_logs SET outcome = $1, transfer_reason = $2, transcript_summary = $3, ended_at = now()
       WHERE id = $4`,
      [outcome, transferReason || null, transcriptSummary || null, callId]
    );
    return res.json({ ok: true, callId });
  }

  const { rows } = await query(
    `INSERT INTO call_logs (direction, caller_phone, client_id, language_detected, outcome,
       transfer_reason, transcript_summary, elevenlabs_conversation_id, ended_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     RETURNING id`,
    [
      direction || "inbound",
      callerPhone || null,
      clientId || null,
      languageDetected || null,
      outcome || null,
      transferReason || null,
      transcriptSummary || null,
      elevenlabsConversationId || null,
    ]
  );
  res.json({ ok: true, callId: rows[0].id });
}));

// ---------------------------------------------------------------------------
// start_call — call this as soon as the conversation begins, so we have a
// callId to attach the eventual booking + outcome to.
//
// callerPhone is OPTIONAL here on purpose: with Twilio it would arrive
// automatically from telephony metadata, but calls placed through the
// ElevenLabs web/test interface have no caller ID at all. In that case just
// call this with no callerPhone (or leave it out entirely) — the agent
// asking for the phone number later, then calling lookup_client with it
// explicitly, is what actually identifies the client either way.
// ---------------------------------------------------------------------------
router.post("/tools/start_call", asyncRoute(async (req, res) => {
  const { callerPhone, elevenlabsConversationId, direction } = req.body;

  let client = null;
  if (callerPhone) {
    const clientResult = await query("SELECT * FROM clients WHERE phone_number = $1", [callerPhone]);
    client = clientResult.rows[0] || null;
  }

  const { rows } = await query(
    `INSERT INTO call_logs (direction, caller_phone, client_id, elevenlabs_conversation_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [direction || "inbound", callerPhone || null, client?.id || null, elevenlabsConversationId || null]
  );
  res.json({ callId: rows[0].id, existingClient: client });
}));

module.exports = router;
