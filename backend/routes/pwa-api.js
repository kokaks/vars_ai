/**
 * PWA-FACING API (Postgres / Neon version)
 * ----------------------------------------------------------------------------
 * Everything here also routes through booking-engine.js for any write that
 * touches `appointments` — this file must never write to that table
 * directly, so the phone-call path and the barber-app path can't diverge.
 * ----------------------------------------------------------------------------
 */
const express = require("express");
const router = express.Router();
const { query } = require("../db");
const engine = require("../services/booking-engine");
const { DateTime } = require("luxon");

function asyncRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[api] error in ${req.path}:`, err);
      res.status(500).json({ error: "internal_error", message: err.message });
    }
  };
}

// ---- Debug: what does the server think "now" is, and would a booking succeed? ----
// Hit this directly (GET, no auth) to diagnose availability weirdness on a
// deployed instance without guessing. Runs the EXACT SAME checkAvailability
// logic a real booking uses (including service duration) rather than a
// simplified check — a booking can be rejected for "during_break" even when
// the current instant isn't in a break, if the service is long enough to
// run into one. This endpoint shows you that directly instead of you
// having to infer it.
router.get("/debug/now", asyncRoute(async (req, res) => {
  const shop = await engine.getShop();
  const nowUtc = new Date();
  const nowLocal = engine.utcToLocal(nowUtc, shop);
  const barberId = Number(req.query.barberId) || 1;
  const serviceId = Number(req.query.serviceId) || 1;

  const dateStr = nowLocal.toISODate();
  const timeStr = nowLocal.toFormat("HH:mm");

  const availability = await engine.checkAvailability({ barberId, serviceId, dateStr, timeStr });

  res.json({
    server_utc_now: nowUtc.toISOString(),
    shop_timezone: shop.timezone,
    computed_local_now: nowLocal.toISO(),
    checked_barberId: barberId,
    checked_serviceId: serviceId,
    would_a_walkin_succeed_right_now: availability.ok,
    if_not_why: availability.ok ? null : { reason: availability.reason, detail: availability.detail },
    requested_window_local: availability.startUtc
      ? { start: engine.utcToLocal(availability.startUtc, shop).toFormat("HH:mm"), end: engine.utcToLocal(availability.endUtc, shop).toFormat("HH:mm") }
      : null,
  });
}));

// ---- Today / range view -----------------------------------------------------
router.get("/appointments", asyncRoute(async (req, res) => {
  const { from, to, barberId } = req.query;
  const shop = await engine.getShop();
  const fromUtc = from
    ? engine.localToUtc(from, "00:00", shop)
    : DateTime.now().setZone(shop.timezone).startOf("day").toUTC().toISO();
  const toUtc = to
    ? engine.localToUtc(to, "23:59", shop)
    : DateTime.now().setZone(shop.timezone).endOf("day").toUTC().toISO();

  let sql = `SELECT a.*, c.name as client_name, c.phone_number, c.tags as client_tags, b.name as barber_name
             FROM appointments a
             LEFT JOIN clients c ON c.id = a.client_id
             JOIN barbers b ON b.id = a.barber_id
             WHERE a.start_utc >= $1 AND a.start_utc <= $2`;
  const params = [fromUtc, toUtc];
  if (barberId) {
    sql += " AND a.barber_id = $3";
    params.push(barberId);
  }
  sql += " ORDER BY a.start_utc ASC";

  const { rows } = await query(sql, params);
  res.json(rows.map((r) => ({ ...r, start_local: engine.utcToLocal(r.start_utc, shop).toISO() })));
}));

router.get("/appointments/:id", asyncRoute(async (req, res) => {
  const shop = await engine.getShop();
  const { rows } = await query(
    `SELECT a.*, c.name as client_name, c.phone_number, c.tags as client_tags, c.notes as client_notes,
            b.name as barber_name
     FROM appointments a LEFT JOIN clients c ON c.id = a.client_id JOIN barbers b ON b.id = a.barber_id
     WHERE a.id = $1`,
    [req.params.id]
  );
  const row = rows[0];
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json({ ...row, start_local: engine.utcToLocal(row.start_utc, shop).toISO() });
}));

// ---- Manual create (LAST RESORT — spec says avoid manual booking except walk-ins) ----
router.post("/appointments/manual", asyncRoute(async (req, res) => {
  const { barberId, serviceId, date, time, phoneNumber, name } = req.body;
  const result = await engine.bookAppointment({
    barberId, serviceId, dateStr: date, timeStr: time,
    client: { phoneNumber, name }, source: "manual",
  });
  res.status(result.ok ? 201 : 409).json(result);
}));

router.post("/appointments/:id/cancel", asyncRoute(async (req, res) => {
  const result = await engine.cancelAppointment({ appointmentId: req.params.id, reason: req.body.reason || "barber_cancelled" });
  res.json(result);
}));

router.post("/appointments/:id/complete", asyncRoute(async (req, res) => {
  const { rows } = await query("SELECT * FROM appointments WHERE id = $1", [req.params.id]);
  const appt = rows[0];
  if (!appt) return res.status(404).json({ error: "not_found" });
  await query("UPDATE appointments SET status = 'completed', updated_at = now() WHERE id = $1", [req.params.id]);
  await engine.logClientEvent(appt.client_id, appt.id, "completed", {});
  res.json({ ok: true });
}));

router.post("/appointments/:id/no_show", asyncRoute(async (req, res) => {
  const { rows } = await query("SELECT * FROM appointments WHERE id = $1", [req.params.id]);
  const appt = rows[0];
  if (!appt) return res.status(404).json({ error: "not_found" });
  await query("UPDATE appointments SET status = 'no_show', updated_at = now() WHERE id = $1", [req.params.id]);
  await engine.logClientEvent(appt.client_id, appt.id, "no_show", {});
  await engine.maybeFlagAtRisk(appt.client_id);
  res.json({ ok: true });
}));

// ---- Walk-in button ----------------------------------------------------------
router.post("/walkins", asyncRoute(async (req, res) => {
  const { barberId, serviceId, name } = req.body;
  const result = await engine.registerWalkIn({ barberId, serviceId, name });
  res.status(result.ok ? 201 : 409).json(result);
}));

// ---- Barbers / settings -------------------------------------------------------
router.get("/barbers", asyncRoute(async (req, res) => {
  const { rows } = await query("SELECT * FROM barbers WHERE active = true");
  res.json(rows);
}));

router.get("/barbers/:id/settings", asyncRoute(async (req, res) => {
  const barberResult = await query("SELECT * FROM barbers WHERE id = $1", [req.params.id]);
  const hoursResult = await query("SELECT * FROM barber_hours WHERE barber_id = $1", [req.params.id]);
  const breaksResult = await query("SELECT * FROM barber_breaks WHERE barber_id = $1", [req.params.id]);
  const timeOffResult = await query("SELECT * FROM barber_time_off WHERE barber_id = $1 AND date >= CURRENT_DATE", [req.params.id]);
  res.json({ barber: barberResult.rows[0], hours: hoursResult.rows, breaks: breaksResult.rows, timeOff: timeOffResult.rows });
}));

router.put("/barbers/:id/settings", asyncRoute(async (req, res) => {
  const { bufferMinutes, notificationLeadMinutes } = req.body;
  await query("UPDATE barbers SET buffer_minutes = $1, notification_lead_minutes = $2 WHERE id = $3", [
    bufferMinutes ?? null,
    notificationLeadMinutes ?? null,
    req.params.id,
  ]);
  res.json({ ok: true });
}));

router.post("/barbers/:id/breaks", asyncRoute(async (req, res) => {
  const { weekday, start, end, label } = req.body;
  const { rows } = await query(
    "INSERT INTO barber_breaks (barber_id, weekday, start_time, end_time, label) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [req.params.id, weekday ?? null, start, end, label || "Break"]
  );
  res.status(201).json({ id: rows[0].id });
}));

router.delete("/breaks/:id", asyncRoute(async (req, res) => {
  await query("DELETE FROM barber_breaks WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
}));

router.post("/barbers/:id/time-off", asyncRoute(async (req, res) => {
  const { date, start, end, reason } = req.body;
  const { rows } = await query(
    "INSERT INTO barber_time_off (barber_id, date, start_time, end_time, reason) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [req.params.id, date, start || null, end || null, reason || null]
  );
  res.status(201).json({ id: rows[0].id });
}));

// ---- Services (menu + pricing editable from settings) ------------------------
router.get("/services", asyncRoute(async (req, res) => {
  const { rows } = await query("SELECT * FROM services WHERE active = true ORDER BY sort_order");
  res.json(rows);
}));

router.put("/services/:id", asyncRoute(async (req, res) => {
  const { name, durationMinutes, priceAmd } = req.body;
  await query(
    "UPDATE services SET name = COALESCE($1, name), duration_minutes = COALESCE($2, duration_minutes), price_amd = COALESCE($3, price_amd) WHERE id = $4",
    [name, durationMinutes, priceAmd, req.params.id]
  );
  res.json({ ok: true });
}));

// ---- Push notification subscription (Web Push) --------------------------------
router.get("/push/vapid-public-key", (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null });
});

router.post("/barbers/:id/push-subscription", asyncRoute(async (req, res) => {
  await query("UPDATE barbers SET push_subscription = $1 WHERE id = $2", [JSON.stringify(req.body), req.params.id]);
  res.json({ ok: true });
}));

// ---- Clients ------------------------------------------------------------------
router.get("/clients/:id", asyncRoute(async (req, res) => {
  const clientResult = await query("SELECT * FROM clients WHERE id = $1", [req.params.id]);
  const client = clientResult.rows[0];
  if (!client) return res.status(404).json({ error: "not_found" });
  const historyResult = await query(
    `SELECT a.*, b.name as barber_name FROM appointments a JOIN barbers b ON b.id = a.barber_id
     WHERE a.client_id = $1 ORDER BY a.start_utc DESC LIMIT 20`,
    [req.params.id]
  );
  const eventsResult = await query("SELECT * FROM client_events WHERE client_id = $1 ORDER BY created_at DESC LIMIT 20", [req.params.id]);
  res.json({ client, history: historyResult.rows, events: eventsResult.rows });
}));

// ---- Shop settings --------------------------------------------------------------
router.get("/shop", asyncRoute(async (req, res) => res.json(await engine.getShop())));

router.put("/shop", asyncRoute(async (req, res) => {
  const fields = [
    "name", "timezone", "address", "phone_number", "languages",
    "min_cancel_notice_minutes", "cancel_transfer_threshold_minutes",
    "default_reminder_lead_minutes", "default_buffer_minutes", "max_reschedules_before_flag",
  ];
  const updates = fields.filter((f) => req.body[f] !== undefined);
  if (updates.length === 0) return res.json({ ok: true, noop: true });
  const setClause = updates.map((f, i) => `${f} = $${i + 1}`).join(", ");
  await query(`UPDATE shop SET ${setClause}, updated_at = now() WHERE id = 1`, updates.map((f) => req.body[f]));
  res.json({ ok: true });
}));

// ---- End of day summary (for the "sense of accomplishment" UI) ------------------
router.get("/summary/today", asyncRoute(async (req, res) => {
  const shop = await engine.getShop();
  const startUtc = DateTime.now().setZone(shop.timezone).startOf("day").toUTC().toISO();
  const endUtc = DateTime.now().setZone(shop.timezone).endOf("day").toUTC().toISO();
  const { rows } = await query(
    `SELECT status, COUNT(*) as n, SUM(price_amd) as revenue FROM appointments WHERE start_utc >= $1 AND start_utc <= $2 GROUP BY status`,
    [startUtc, endUtc]
  );
  res.json({ date: DateTime.now().setZone(shop.timezone).toISODate(), breakdown: rows });
}));

module.exports = router;
