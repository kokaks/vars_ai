/**
 * BOOKING ENGINE (Postgres / Neon version)
 * ----------------------------------------------------------------------------
 * Single source of truth for "can this appointment happen". Both the
 * ElevenLabs tool-call routes AND the PWA's manual-adjustment routes call
 * through here — never write to `appointments` directly anywhere else.
 *
 * Every function here is now async (Postgres via `pg` is async, unlike the
 * original SQLite/better-sqlite3 MVP) — every call site must `await` these.
 * ----------------------------------------------------------------------------
 */
const { DateTime } = require("luxon");
const { query } = require("../db");

async function getShop() {
  const { rows } = await query("SELECT * FROM shop WHERE id = 1");
  return rows[0];
}

async function getBarber(barberId) {
  const { rows } = await query("SELECT * FROM barbers WHERE id = $1 AND active = true", [barberId]);
  return rows[0];
}

async function getService(serviceId) {
  const { rows } = await query("SELECT * FROM services WHERE id = $1 AND active = true", [serviceId]);
  return rows[0];
}

/** Resolve effective duration/price for a barber+service (handles per-barber override). */
async function resolveServiceForBarber(barberId, serviceId) {
  const svc = await getService(serviceId);
  if (!svc) return null;
  const { rows } = await query(
    "SELECT * FROM barber_services WHERE barber_id = $1 AND service_id = $2",
    [barberId, serviceId]
  );
  const override = rows[0];
  return {
    service_id: svc.id,
    label: svc.name,
    duration_minutes: override?.duration_minutes ?? svc.duration_minutes,
    price_amd: override?.price_amd ?? svc.price_amd,
  };
}

/**
 * Convert a shop-local "YYYY-MM-DD" + "HH:MM" pair into a UTC ISO string.
 * The voice agent always passes shop-local wall-clock time (per
 * notes_for_agent in the knowledge base), never a raw offset — this is the
 * one place that assumption gets turned into an absolute instant.
 */
function localToUtc(dateStr, timeStr, shop) {
  const dt = DateTime.fromISO(`${dateStr}T${timeStr}`, { zone: shop.timezone });
  if (!dt.isValid) throw new Error(`Invalid date/time: ${dateStr} ${timeStr} (${dt.invalidReason})`);
  return dt.toUTC().toISO();
}

function utcToLocal(utcVal, shop) {
  // Postgres driver returns TIMESTAMPTZ as a JS Date; DateTime.fromJSDate handles that,
  // while DateTime.fromISO handles the string form (still used internally in a few spots).
  const dt = utcVal instanceof Date ? DateTime.fromJSDate(utcVal, { zone: "utc" }) : DateTime.fromISO(utcVal, { zone: "utc" });
  return dt.setZone(shop.timezone);
}

/**
 * Is `barberId` open (working, not on break, not on time-off) covering the
 * full [startUtc, endUtc) window? Buffer is handled separately in
 * hasConflict — it's a gap requirement against OTHER bookings, not part of
 * whether this window itself is open.
 */
async function isWithinWorkingWindow(barberId, startUtc, endUtc, shop) {
  const barber = await getBarber(barberId);
  if (!barber) return { ok: false, reason: "barber_not_found" };

  const startLocal = utcToLocal(startUtc, shop);
  const endLocal = utcToLocal(endUtc, shop);

  if (startLocal.toISODate() !== endLocal.toISODate()) {
    return { ok: false, reason: "spans_midnight" }; // MVP: disallow, keep it simple
  }

  const dateStr = startLocal.toISODate();
  const weekday = startLocal.weekday % 7; // luxon: 1=Mon..7=Sun -> 0=Sun..6=Sat
  const startHM = startLocal.toFormat("HH:mm");
  const endHM = endLocal.toFormat("HH:mm");

  const dayOffResult = await query(
    `SELECT * FROM barber_time_off WHERE barber_id = $1 AND date = $2 AND start_time IS NULL`,
    [barberId, dateStr]
  );
  if (dayOffResult.rows[0]) return { ok: false, reason: "day_off", detail: dayOffResult.rows[0].reason };

  const partialOffResult = await query(
    `SELECT * FROM barber_time_off
     WHERE barber_id = $1 AND date = $2 AND start_time IS NOT NULL
     AND NOT (end_time <= $3 OR start_time >= $4)`,
    [barberId, dateStr, startHM, endHM]
  );
  if (partialOffResult.rows[0]) return { ok: false, reason: "time_off", detail: partialOffResult.rows[0].reason };

  const hoursResult = await query(
    `SELECT * FROM barber_hours WHERE barber_id = $1 AND weekday = $2`,
    [barberId, weekday]
  );
  const withinHours = hoursResult.rows.some((h) => startHM >= h.start_time && endHM <= h.end_time);
  if (!withinHours) return { ok: false, reason: "outside_working_hours" };

  const breakResult = await query(
    `SELECT * FROM barber_breaks WHERE barber_id = $1 AND (weekday IS NULL OR weekday = $2)`,
    [barberId, weekday]
  );
  const duringBreak = breakResult.rows.find((b) => !(endHM <= b.start_time || startHM >= b.end_time));
  if (duringBreak) return { ok: false, reason: "during_break", detail: duringBreak.label };

  return { ok: true };
}

/** Does [startUtc,endUtc) (expanded by buffer) collide with an existing confirmed appointment? */
async function hasConflict(barberId, startUtc, endUtc, shop, excludeAppointmentId = null) {
  const barber = await getBarber(barberId);
  const bufferMin = barber.buffer_minutes ?? shop.default_buffer_minutes;

  const bufferedStart = DateTime.fromISO(startUtc).minus({ minutes: bufferMin }).toISO();
  const bufferedEnd = DateTime.fromISO(endUtc).plus({ minutes: bufferMin }).toISO();

  const { rows } = await query(
    `SELECT * FROM appointments
     WHERE barber_id = $1 AND status = 'confirmed'
     AND id != $2
     AND NOT (end_utc <= $3 OR start_utc >= $4)`,
    [barberId, excludeAppointmentId ?? -1, bufferedStart, bufferedEnd]
  );

  return rows.length > 0 ? rows[0] : null;
}

/**
 * MAIN AVAILABILITY CHECK — call this before ever proposing a slot to a caller.
 */
async function checkAvailability({ barberId, serviceId, dateStr, timeStr }) {
  const shop = await getShop();
  const resolved = await resolveServiceForBarber(barberId, serviceId);
  if (!resolved) return { ok: false, reason: "unknown_service" };

  const startUtc = localToUtc(dateStr, timeStr, shop);
  const endUtc = DateTime.fromISO(startUtc).plus({ minutes: resolved.duration_minutes }).toISO();

  const windowCheck = await isWithinWorkingWindow(barberId, startUtc, endUtc, shop);
  if (!windowCheck.ok) return { ok: false, ...windowCheck, startUtc, endUtc, resolved };

  const conflict = await hasConflict(barberId, startUtc, endUtc, shop);
  if (conflict) return { ok: false, reason: "conflict", conflict, startUtc, endUtc, resolved };

  return { ok: true, startUtc, endUtc, resolved, shop };
}

/**
 * Find next N free slots for a barber+service starting from a given local
 * date/time, scanning forward. Used when the requested time is unavailable
 * so the agent can offer real alternatives instead of guessing.
 */
async function findNextAvailableSlots({ barberId, serviceId, fromDateStr, fromTimeStr = "00:00", count = 3, scanDays = 14 }) {
  const shop = await getShop();
  const resolved = await resolveServiceForBarber(barberId, serviceId);
  if (!resolved) return [];

  const results = [];
  let cursor = DateTime.fromISO(`${fromDateStr}T${fromTimeStr}`, { zone: shop.timezone });
  const stepMinutes = 15;

  for (let day = 0; day < scanDays && results.length < count; day++) {
    const dayStart = day === 0 ? cursor : cursor.startOf("day");
    let probe = dayStart;
    const dayEnd = probe.endOf("day");

    while (probe < dayEnd && results.length < count) {
      const dateStr = probe.toISODate();
      const timeStr = probe.toFormat("HH:mm");
      const check = await checkAvailability({ barberId, serviceId, dateStr, timeStr });
      if (check.ok) {
        results.push({ date: dateStr, time: timeStr, startUtc: check.startUtc });
      }
      probe = probe.plus({ minutes: stepMinutes });
    }
    cursor = cursor.plus({ days: 1 }).startOf("day");
  }
  return results;
}

/**
 * Book an appointment. Re-validates availability immediately before insert.
 * NOTE: under real concurrent load (two calls booking the same slot in the
 * same instant) this has the same narrow race window any check-then-insert
 * pattern does — acceptable for a single-shop MVP; if that ever matters,
 * wrap the check+insert in a single transaction with
 * `SELECT ... FOR UPDATE` on the barber's row.
 */
async function bookAppointment({ barberId, serviceId, dateStr, timeStr, client, source = "ai_call", callId = null }) {
  const check = await checkAvailability({ barberId, serviceId, dateStr, timeStr });
  if (!check.ok) return { ok: false, reason: check.reason, detail: check };

  const clientRow = await upsertClient(client);

  const { rows } = await query(
    `INSERT INTO appointments
      (barber_id, client_id, service_id, service_label, duration_minutes, price_amd,
       start_utc, end_utc, status, source, call_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'confirmed', $9, $10)
     RETURNING id`,
    [
      barberId,
      clientRow.id,
      serviceId,
      check.resolved.label,
      check.resolved.duration_minutes,
      check.resolved.price_amd,
      check.startUtc,
      check.endUtc,
      source,
      callId,
    ]
  );

  const appointmentId = rows[0].id;
  await scheduleReminderNotification(appointmentId);

  return { ok: true, appointmentId, startUtc: check.startUtc, endUtc: check.endUtc, resolved: check.resolved };
}

/** Find-or-create client by phone number. Name is updated if it changed (people correct it). */
async function upsertClient({ phoneNumber, name, preferredLanguage }) {
  if (phoneNumber) {
    const { rows } = await query("SELECT * FROM clients WHERE phone_number = $1", [phoneNumber]);
    const existing = rows[0];
    if (existing) {
      if (name && name !== existing.name) {
        await query("UPDATE clients SET name = $1 WHERE id = $2", [name, existing.id]);
        existing.name = name;
      }
      return existing;
    }
  }
  const { rows } = await query(
    "INSERT INTO clients (phone_number, name, preferred_language, tags) VALUES ($1, $2, $3, 'new') RETURNING *",
    [phoneNumber || null, name || "Unknown", preferredLanguage || null]
  );
  return rows[0];
}

/**
 * CANCELLATION GUARDRAIL
 * Returns one of:
 *  - { ok:true } : cancelled cleanly
 *  - { ok:false, action:'transfer_to_barber', reason:'too_close_to_appointment' }
 *      when inside cancel_transfer_threshold_minutes of start — the AI
 *      should NOT silently cancel a near-time appointment, it hands off to
 *      a human instead.
 */
async function cancelAppointment({ appointmentId, reason }) {
  const shop = await getShop();
  const { rows } = await query("SELECT * FROM appointments WHERE id = $1", [appointmentId]);
  const appt = rows[0];
  if (!appt) return { ok: false, reason: "not_found" };
  if (appt.status !== "confirmed") return { ok: false, reason: "not_cancellable", status: appt.status };

  const now = DateTime.utc();
  const start = DateTime.fromJSDate(appt.start_utc, { zone: "utc" });
  const minutesUntil = start.diff(now, "minutes").minutes;

  if (minutesUntil < shop.cancel_transfer_threshold_minutes) {
    return {
      ok: false,
      action: "transfer_to_barber",
      reason: "too_close_to_appointment",
      minutesUntil,
      barberId: appt.barber_id,
    };
  }

  await query(
    "UPDATE appointments SET status = 'cancelled', cancel_reason = $1, updated_at = now() WHERE id = $2",
    [reason || null, appointmentId]
  );

  const eventType = minutesUntil < shop.min_cancel_notice_minutes ? "late_cancel" : "early_cancel";
  await logClientEvent(appt.client_id, appointmentId, eventType, { minutes_before: minutesUntil });

  await query("UPDATE notifications SET sent = true WHERE appointment_id = $1 AND sent = false", [appointmentId]);

  return { ok: true, minutesUntil, eventType };
}

/**
 * RESCHEDULE = guardrail-checked cancel of old slot + fresh
 * availability-checked booking of new slot, linked via
 * rescheduled_from_id. If the OLD appointment is too close to start, this
 * hits the same transfer guardrail as cancel.
 */
async function rescheduleAppointment({ appointmentId, newDateStr, newTimeStr, newBarberId, newServiceId }) {
  const { rows } = await query("SELECT * FROM appointments WHERE id = $1", [appointmentId]);
  const appt = rows[0];
  if (!appt) return { ok: false, reason: "not_found" };

  const barberId = newBarberId || appt.barber_id;
  const serviceId = newServiceId || appt.service_id;

  const availabilityCheck = await checkAvailability({ barberId, serviceId, dateStr: newDateStr, timeStr: newTimeStr });
  if (!availabilityCheck.ok) return { ok: false, reason: availabilityCheck.reason, detail: availabilityCheck };

  const cancelResult = await cancelAppointment({ appointmentId, reason: "rescheduled" });
  if (!cancelResult.ok) return cancelResult; // may be the transfer_to_barber guardrail

  const clientResult = await query("SELECT * FROM clients WHERE id = $1", [appt.client_id]);
  const clientRow = clientResult.rows[0];
  const bookResult = await bookAppointment({
    barberId,
    serviceId,
    dateStr: newDateStr,
    timeStr: newTimeStr,
    client: { phoneNumber: clientRow?.phone_number, name: clientRow?.name },
    source: appt.source,
  });
  if (!bookResult.ok) return bookResult;

  await query("UPDATE appointments SET rescheduled_from_id = $1 WHERE id = $2", [appointmentId, bookResult.appointmentId]);
  await logClientEvent(appt.client_id, appointmentId, "reschedule", {});

  await maybeFlagAtRisk(appt.client_id);

  return { ok: true, newAppointmentId: bookResult.appointmentId };
}

async function logClientEvent(clientId, appointmentId, eventType, detail) {
  if (!clientId) return;
  await query(
    `INSERT INTO client_events (client_id, appointment_id, event_type, detail) VALUES ($1, $2, $3, $4)`,
    [clientId, appointmentId, eventType, JSON.stringify(detail || {})]
  );
}

/** Simple reputation model: count late_cancel/reschedule/no_show events in last 90 days. */
async function maybeFlagAtRisk(clientId) {
  const shop = await getShop();
  const cutoff = DateTime.utc().minus({ days: 90 }).toISO();
  const { rows } = await query(
    `SELECT COUNT(*) as n FROM client_events
     WHERE client_id = $1 AND event_type IN ('late_cancel','reschedule','no_show') AND created_at >= $2`,
    [clientId, cutoff]
  );
  const n = Number(rows[0].n);

  const clientResult = await query("SELECT * FROM clients WHERE id = $1", [clientId]);
  const client = clientResult.rows[0];
  const tags = new Set((client.tags || "").split(",").filter(Boolean));

  if (n >= shop.max_reschedules_before_flag) {
    tags.add("at_risk");
    const score = Math.max(0, 100 - n * 15);
    await query("UPDATE clients SET tags = $1, reputation_score = $2 WHERE id = $3", [[...tags].join(","), score, clientId]);
    return { flagged: true, count: n, score };
  }
  return { flagged: false, count: n };
}

/** WALK-IN: instantly occupy a slot starting now with no client contact required. */
async function registerWalkIn({ barberId, serviceId, name = "Walk-in" }) {
  const shop = await getShop();
  const now = DateTime.now().setZone(shop.timezone);
  const dateStr = now.toISODate();
  const timeStr = now.toFormat("HH:mm");

  const result = await bookAppointment({
    barberId,
    serviceId,
    dateStr,
    timeStr,
    client: { phoneNumber: null, name },
    source: "walkin",
  });

  if (!result.ok) return result;

  const soon = DateTime.fromISO(result.endUtc).plus({ minutes: 30 }).toISO();
  const { rows } = await query(
    `SELECT * FROM appointments WHERE barber_id = $1 AND status = 'confirmed'
     AND start_utc > $2 AND start_utc <= $3 ORDER BY start_utc ASC LIMIT 1`,
    [barberId, result.endUtc, soon]
  );
  const nextAppt = rows[0];

  let advisory = null;
  if (nextAppt) {
    const minutesGap = DateTime.fromJSDate(nextAppt.start_utc).diff(DateTime.fromISO(result.endUtc), "minutes").minutes;
    advisory = {
      nextAppointmentId: nextAppt.id,
      minutesGap: Math.round(minutesGap),
      message:
        minutesGap < 10
          ? `Next booked client in ${Math.round(minutesGap)} min — this walk-in is tight, your call.`
          : `Next booked client in ${Math.round(minutesGap)} min — should be fine.`,
    };
  }

  return { ...result, advisory };
}

async function scheduleReminderNotification(appointmentId) {
  const shop = await getShop();
  const { rows } = await query("SELECT * FROM appointments WHERE id = $1", [appointmentId]);
  const appt = rows[0];
  const barber = await getBarber(appt.barber_id);
  const leadMin = barber.notification_lead_minutes ?? shop.default_reminder_lead_minutes;
  const sendAt = DateTime.fromJSDate(appt.start_utc).minus({ minutes: leadMin }).toISO();

  let client = null;
  if (appt.client_id) {
    const clientResult = await query("SELECT * FROM clients WHERE id = $1", [appt.client_id]);
    client = clientResult.rows[0];
  }
  const localTime = utcToLocal(appt.start_utc, shop).toFormat("h:mm a");

  const payload = {
    title: `${client?.name || "Client"} — ${localTime}`,
    body: `${appt.service_label}${client?.tags?.includes("returning") ? " (returning client)" : ""}`,
  };

  await query(
    `INSERT INTO notifications (barber_id, appointment_id, type, send_at_utc, payload) VALUES ($1, $2, 'appointment_reminder', $3, $4)`,
    [appt.barber_id, appointmentId, sendAt, JSON.stringify(payload)]
  );
}

module.exports = {
  getShop,
  getBarber,
  resolveServiceForBarber,
  localToUtc,
  utcToLocal,
  checkAvailability,
  findNextAvailableSlots,
  bookAppointment,
  upsertClient,
  cancelAppointment,
  rescheduleAppointment,
  registerWalkIn,
  logClientEvent,
  maybeFlagAtRisk,
};
