/**
 * NOTIFICATION SCHEDULER
 * ----------------------------------------------------------------------------
 * Polls the `notifications` table every 30s for due, unsent rows and pushes
 * them to the barber's PWA via Web Push. This is intentionally a simple
 * poll loop for the MVP (not a cron/queue system) — swap for a proper job
 * queue (BullMQ, etc.) once this needs to run across multiple processes.
 *
 * Requires VAPID keys (generate once with `npx web-push generate-vapid-keys`)
 * set as env vars. Until those are set, this runs in "log only" mode so the
 * rest of the system still works without push configured yet.
 * ----------------------------------------------------------------------------
 */
const { query } = require("../db");
const webpush = require("web-push");

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const pushConfigured = Boolean(VAPID_PUBLIC && VAPID_PRIVATE);

if (pushConfigured) {
  webpush.setVapidDetails("mailto:admin@example.com", VAPID_PUBLIC, VAPID_PRIVATE);
} else {
  console.warn(
    "[notifications] VAPID keys not set — reminders will be logged, not pushed. " +
      "Run `npx web-push generate-vapid-keys` and set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY."
  );
}

async function tick() {
  const { rows: due } = await query(
    `SELECT * FROM notifications WHERE sent = false AND send_at_utc <= now()`
  );

  for (const notif of due) {
    const { rows: barberRows } = await query("SELECT * FROM barbers WHERE id = $1", [notif.barber_id]);
    const barber = barberRows[0];
    const payload = notif.payload || {}; // JSONB column comes back already parsed

    if (pushConfigured && barber?.push_subscription) {
      try {
        await webpush.sendNotification(JSON.parse(barber.push_subscription), JSON.stringify({
          title: payload.title,
          body: payload.body,
          data: { appointmentId: notif.appointment_id, type: notif.type },
        }));
      } catch (err) {
        console.error(`[notifications] push failed for barber ${notif.barber_id}:`, err.message);
      }
    } else {
      console.log(`[notifications] (no push subscription yet) would notify barber ${notif.barber_id}:`, payload);
    }

    await query("UPDATE notifications SET sent = true WHERE id = $1", [notif.id]);
  }
}

function start() {
  tick().catch((err) => console.error("[notifications] tick failed:", err));
  setInterval(() => tick().catch((err) => console.error("[notifications] tick failed:", err)), 30_000);
  console.log("[notifications] scheduler started (30s poll interval)");
}

module.exports = { start };
