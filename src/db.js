// Database connection and schema.
//
// Uses node-postgres (pg). DATABASE_URL points at Postgres — Neon in
// production, embedded-postgres when running the tests locally.

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon (and other serverless Postgres) need TLS.
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slots (
      id       TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      start    TIMESTAMPTZ NOT NULL,
      "end"    TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id         TEXT PRIMARY KEY,
      slot_id    TEXT NOT NULL REFERENCES slots(id),
      name       TEXT NOT NULL,
      email      TEXT NOT NULL,
      status     TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      seq        BIGSERIAL
    );

    -- Level 3: the database itself forbids two confirmed bookings on one
    -- slot, so even simultaneous requests can't both succeed.
    CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
      ON bookings (slot_id) WHERE status = 'confirmed';

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key          TEXT PRIMARY KEY,
      body_hash    TEXT NOT NULL,
      status_code  INT NOT NULL,
      response     JSONB NOT NULL
    );
  `);
}

module.exports = { pool, migrate };
