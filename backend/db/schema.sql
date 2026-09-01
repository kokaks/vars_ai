-- ============================================================================
-- BARBERSHOP AI RECEPTIONIST — CORE SCHEMA (PostgreSQL / Neon)
-- ============================================================================
-- Migrated from the SQLite MVP schema. Same design principles as before:
--  1. Every appointment snapshots service label/duration/price at booking
--     time — later menu edits never retroactively change past appointments.
--  2. All appointment times stored as TIMESTAMPTZ (UTC under the hood).
--     Display timezone lives on `shop.timezone` and is applied only at the
--     edges (agent tool responses, PWA display), via the `luxon` layer in
--     booking-engine.js — never compared as raw strings here.
--  3. Walk-ins are appointments with source='walkin', same table, same
--     conflict checks — no separate code path that could double-book.
--  4. Reputation is derived from `client_events`, never hand-edited.
-- ============================================================================

CREATE TABLE IF NOT EXISTS shop (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT 'Barbershop',
  timezone TEXT NOT NULL DEFAULT 'Asia/Yerevan',
  address TEXT,
  phone_number TEXT,
  languages TEXT NOT NULL DEFAULT 'hy,ru,en',
  min_cancel_notice_minutes INTEGER NOT NULL DEFAULT 120,
  cancel_transfer_threshold_minutes INTEGER NOT NULL DEFAULT 10,
  default_reminder_lead_minutes INTEGER NOT NULL DEFAULT 15,
  default_buffer_minutes INTEGER NOT NULL DEFAULT 10,
  max_reschedules_before_flag INTEGER NOT NULL DEFAULT 3,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS barbers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone_number TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  buffer_minutes INTEGER,
  push_subscription TEXT,
  notification_lead_minutes INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS barber_hours (
  id SERIAL PRIMARY KEY,
  barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS barber_breaks (
  id SERIAL PRIMARY KEY,
  barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  weekday INTEGER,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  label TEXT DEFAULT 'Break'
);

CREATE TABLE IF NOT EXISTS barber_time_off (
  id SERIAL PRIMARY KEY,
  barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  start_time TEXT,
  end_time TEXT,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS services (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  name_hy TEXT,
  name_ru TEXT,
  duration_minutes INTEGER NOT NULL,
  price_amd INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS barber_services (
  barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  duration_minutes INTEGER,
  price_amd INTEGER,
  PRIMARY KEY (barber_id, service_id)
);

CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  phone_number TEXT UNIQUE,
  name TEXT NOT NULL,
  preferred_language TEXT,
  notes TEXT,
  tags TEXT,
  reputation_score INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS call_logs (
  id SERIAL PRIMARY KEY,
  direction TEXT NOT NULL DEFAULT 'inbound',
  caller_phone TEXT,
  client_id INTEGER REFERENCES clients(id),
  language_detected TEXT,
  outcome TEXT,
  transfer_reason TEXT,
  transcript_summary TEXT,
  elevenlabs_conversation_id TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS appointments (
  id SERIAL PRIMARY KEY,
  barber_id INTEGER NOT NULL REFERENCES barbers(id),
  client_id INTEGER REFERENCES clients(id),
  service_id INTEGER REFERENCES services(id),
  service_label TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  price_amd INTEGER NOT NULL,
  start_utc TIMESTAMPTZ NOT NULL,
  end_utc TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed',
  source TEXT NOT NULL DEFAULT 'ai_call',
  call_id INTEGER REFERENCES call_logs(id),
  rescheduled_from_id INTEGER REFERENCES appointments(id),
  cancel_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_appt_barber_time ON appointments(barber_id, start_utc, end_utc);
CREATE INDEX IF NOT EXISTS idx_appt_client ON appointments(client_id);
CREATE INDEX IF NOT EXISTS idx_appt_status ON appointments(status);

CREATE TABLE IF NOT EXISTS client_events (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  barber_id INTEGER NOT NULL REFERENCES barbers(id),
  appointment_id INTEGER REFERENCES appointments(id),
  type TEXT NOT NULL,
  send_at_utc TIMESTAMPTZ NOT NULL,
  sent BOOLEAN NOT NULL DEFAULT false,
  payload JSONB
);

CREATE INDEX IF NOT EXISTS idx_notif_pending ON notifications(sent, send_at_utc);
