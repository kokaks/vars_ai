/**
 * DATABASE LAYER — Neon Postgres
 * ----------------------------------------------------------------------------
 * Exports a `query(text, params)` helper (not a raw pool) so every call
 * site stays a one-liner and we have a single place to log slow queries
 * later. All query methods elsewhere in the app are async now (this is the
 * main thing that changed vs. the SQLite MVP — every db call needs `await`).
 * ----------------------------------------------------------------------------
 */
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy your Neon connection string (with ?sslmode=require) into your .env / Render env vars."
  );
}

// Neon requires SSL; a local/self-hosted Postgres (used for testing this
// migration) typically doesn't have it configured at all. Rather than a
// separate env var, just detect it from the connection string so the exact
// same code runs locally and against Neon without edits.
const needsSsl = /sslmode=require|neon\.tech/.test(connectionString);
const pool = new Pool({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
});

pool.on("error", (err) => {
  console.error("[db] unexpected pool error", err);
});

async function query(text, params) {
  return pool.query(text, params);
}

/** Runs schema.sql (idempotent — every statement is CREATE TABLE IF NOT EXISTS). */
async function ensureSchema() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");
  await pool.query(schema);
}

/** Seeds from knowledge-base.json ONLY if the shop table is empty — safe to call on every boot. */
async function ensureSeed() {
  const { rows } = await pool.query("SELECT id FROM shop WHERE id = 1");
  if (rows.length > 0) {
    console.log("[db] shop row already exists — skipping seed");
    return;
  }

  console.log("[db] No shop row found — seeding from knowledge-base.json");
  const kbPath = path.join(__dirname, "..", "data", "knowledge-base.json");
  const kb = JSON.parse(fs.readFileSync(kbPath, "utf8"));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO shop (id, name, timezone, address, phone_number, languages,
         min_cancel_notice_minutes, cancel_transfer_threshold_minutes,
         default_reminder_lead_minutes, default_buffer_minutes, max_reschedules_before_flag)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        kb.shop.name,
        kb.shop.timezone,
        kb.shop.address,
        kb.shop.phone_number,
        kb.shop.languages.join(","),
        kb.guardrails.min_cancel_notice_minutes,
        kb.guardrails.cancel_transfer_threshold_minutes,
        kb.guardrails.default_reminder_lead_minutes,
        kb.guardrails.default_buffer_minutes,
        kb.guardrails.max_reschedules_before_flag,
      ]
    );

    for (let i = 0; i < kb.services.length; i++) {
      const s = kb.services[i];
      await client.query(
        `INSERT INTO services (name, name_hy, name_ru, duration_minutes, price_amd, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [s.name, s.name_hy || null, s.name_ru || null, s.duration_minutes, s.price_amd, i]
      );
    }

    for (const b of kb.barbers) {
      const barberResult = await client.query(
        `INSERT INTO barbers (name, phone_number, buffer_minutes) VALUES ($1, $2, $3) RETURNING id`,
        [b.name, b.phone_number || null, b.buffer_minutes ?? null]
      );
      const barberId = barberResult.rows[0].id;

      for (const h of b.hours || []) {
        await client.query(
          `INSERT INTO barber_hours (barber_id, weekday, start_time, end_time) VALUES ($1, $2, $3, $4)`,
          [barberId, h.weekday, h.start, h.end]
        );
      }
      for (const br of b.breaks || []) {
        await client.query(
          `INSERT INTO barber_breaks (barber_id, weekday, start_time, end_time, label) VALUES ($1, $2, $3, $4, $5)`,
          [barberId, br.weekday ?? null, br.start, br.end, br.label || "Break"]
        );
      }
    }

    await client.query("COMMIT");
    console.log("[db] Seed complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function init() {
  await ensureSchema();
  await ensureSeed();
}

module.exports = { query, pool, init };
