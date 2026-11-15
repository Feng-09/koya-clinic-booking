// Clinic booking API — all routes live here.
//
// Levels:
//   1  list slots, book a slot, look up a booking
//   2  X-API-Key auth + input validation
//   3  no double-booking (database-enforced), cancellation
//   4  Idempotency-Key header + cursor pagination
//   5  rate limiting: 5 attempts per email per minute

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { pool } = require("./db");
const { checkRateLimit, clearRateLimits } = require("./rateLimit");

const app = express();
app.use(express.json());
app.use(require("cors")());
app.use(express.static(path.join(__dirname, "..", "public"))); // the web page

const API_KEY = process.env.API_KEY || "dev-key";

const isValidEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const err = (res, status, message) => res.status(status).json({ error: message });

// Hands the browser its API key so the page can call the API.
app.get("/config.js", (req, res) => {
  res.type("text/javascript").send(`window.API_KEY = ${JSON.stringify(API_KEY)};`);
});

// ---- Level 2: every request needs the API key --------------------------

app.use((req, res, next) => {
  if (req.get("X-API-Key") !== API_KEY) {
    return err(res, 401, "missing or invalid API key");
  }
  next();
});

// Malformed JSON bodies become a 400 instead of a crash.
app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400) {
    return err(res, 400, "invalid JSON body");
  }
  next(error);
});

// ---- Level 1: replace all slots ----------------------------------------

app.post("/reset", async (req, res) => {
  const { slots } = req.body ?? {};
  if (!Array.isArray(slots)) return err(res, 400, "body must be { slots: [...] }");

  for (const s of slots) {
    if (!s || typeof s.id !== "string" || typeof s.provider !== "string") {
      return err(res, 400, "each slot needs id, provider, start and end");
    }
    if (Number.isNaN(Date.parse(s.start)) || Number.isNaN(Date.parse(s.end))) {
      return err(res, 400, "slot start and end must be ISO date-times");
    }
  }

  // A reset is a clean slate: bookings, remembered idempotency keys and
  // rate-limit counters all go.
  await pool.query("DELETE FROM bookings");
  await pool.query("DELETE FROM idempotency_keys");
  await pool.query("DELETE FROM slots");
  clearRateLimits();

  for (const s of slots) {
    await pool.query(
      "INSERT INTO slots (id, provider, start, \"end\") VALUES ($1, $2, $3, $4)",
      [s.id, s.provider, s.start, s.end]
    );
  }
  res.json({ message: "done" });
});

// ---- Level 1: list slots ------------------------------------------------

app.get("/slots", async (req, res) => {
  const { provider } = req.query;
  const result = await pool.query(
    `SELECT s.id, s.provider, s.start, s."end",
            NOT EXISTS (
              SELECT 1 FROM bookings b
              WHERE b.slot_id = s.id AND b.status = 'confirmed'
            ) AS available
       FROM slots s
       ${provider ? "WHERE s.provider = $1" : ""}
       ORDER BY s.start ASC, s.id ASC`,
    provider ? [provider] : []
  );
  res.json({ slots: result.rows });
});

// ---- Levels 1-5: book a slot -------------------------------------------

app.post("/bookings", async (req, res) => {
  const idemKey = req.get("Idempotency-Key");
  const bodyHash = crypto.createHash("sha256").update(JSON.stringify(req.body ?? {})).digest("hex");

  // Level 4: a seen key replays its stored response (same status, same
  // booking id) and never creates a second booking.
  if (idemKey) {
    const seen = await pool.query("SELECT * FROM idempotency_keys WHERE key = $1", [idemKey]);
    if (seen.rows.length > 0) {
      const record = seen.rows[0];
      if (record.body_hash !== bodyHash) {
        return err(res, 422, "Idempotency-Key reused with a different body");
      }
      return res.status(record.status_code).json(record.response);
    }
  }

  // Resolve the request normally, remembering the exact outcome so a
  // retry can replay it.
  const outcome = await createBooking(req.body);

  if (idemKey) {
    await pool.query(
      `INSERT INTO idempotency_keys (key, body_hash, status_code, response)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO NOTHING`,
      [idemKey, bodyHash, outcome.status, outcome.body]
    );
    // A racing duplicate insert loses the race and gets the winner's response.
    const stored = await pool.query("SELECT * FROM idempotency_keys WHERE key = $1", [idemKey]);
    const record = stored.rows[0];
    if (record.status_code === 429 && outcome.headers) {
      res.set(outcome.headers);
    }
    return res.status(record.status_code).json(record.response);
  }

  if (outcome.headers) res.set(outcome.headers);
  res.status(outcome.status).json(outcome.body);
});

async function createBooking(body) {
  const rawEmail = typeof body?.email === "string" ? body.email.trim() : "";

  // Level 5: every attempt counts, even ones that fail validation.
  const retryAfter = checkRateLimit(rawEmail.toLowerCase());
  if (retryAfter !== null) {
    return { status: 429, headers: { "Retry-After": retryAfter }, body: { error: "too many attempts, try again later" } };
  }

  // Level 2: required, non-empty fields and a valid email. Trim the
  // strings and store the email lower case.
  const slotId = typeof body?.slot_id === "string" ? body.slot_id.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email = rawEmail.toLowerCase();

  if (!slotId) return { status: 400, body: { error: "slot_id is required" } };
  if (!name) return { status: 400, body: { error: "name is required" } };
  if (!email || !isValidEmail(email)) return { status: 400, body: { error: "a valid email is required" } };

  const slot = await pool.query("SELECT * FROM slots WHERE id = $1", [slotId]);
  if (slot.rows.length === 0) return { status: 404, body: { error: "slot not found" } };

  if (Date.parse(slot.rows[0].start) <= Date.now()) {
    return { status: 400, body: { error: "this slot has already started" } };
  }

  // Level 1/3: insert; the partial unique index turns a race between two
  // simultaneous requests into one 201 and one 409.
  const booking = {
    id: crypto.randomUUID(),
    slot_id: slotId,
    name,
    email,
    status: "confirmed",
    created_at: new Date().toISOString(),
  };

  try {
    await pool.query(
      `INSERT INTO bookings (id, slot_id, name, email, status, created_at)
       VALUES ($1, $2, $3, $4, 'confirmed', $5)`,
      [booking.id, slotId, name, email, booking.created_at]
    );
  } catch (e) {
    if (e.code === "23505") {
      return { status: 409, body: { error: "slot already booked" } };
    }
    throw e;
  }

  return { status: 201, body: booking };
}

// ---- Level 4: list a person's bookings (cursor pagination) -------------

app.get("/bookings", async (req, res) => {
  const { email, cursor } = req.query;
  const limit = req.query.limit === undefined ? 10 : Number(req.query.limit);

  if (typeof email !== "string" || !email.trim()) {
    return err(res, 400, "email query parameter is required");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return err(res, 400, "limit must be an integer between 1 and 50");
  }

  // The cursor is the seq of the last booking the client saw.
  const afterSeq = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isInteger(afterSeq) || afterSeq < 0) {
    return err(res, 400, "invalid cursor");
  }

  const result = await pool.query(
    `SELECT id, slot_id, name, email, status, created_at, seq
       FROM bookings
      WHERE email = $1 AND seq > $2
      ORDER BY seq ASC
      LIMIT $3`,
    [email.trim().toLowerCase(), afterSeq, limit + 1] // fetch one extra to detect a next page
  );

  const rows = result.rows.slice(0, limit);
  const hasMore = result.rows.length > limit;
  res.json({
    bookings: rows,
    next_cursor: hasMore ? String(rows[rows.length - 1].seq) : null,
  });
});

// ---- Level 1: look up a booking -----------------------------------------

app.get("/bookings/:id", async (req, res) => {
  const result = await pool.query(
    "SELECT id, slot_id, name, email, status, created_at FROM bookings WHERE id = $1",
    [req.params.id]
  );
  if (result.rows.length === 0) return err(res, 404, "booking not found");
  res.json(result.rows[0]);
});

// ---- Level 3: cancel a booking ------------------------------------------

app.delete("/bookings/:id", async (req, res) => {
  const existing = await pool.query(
    "SELECT status FROM bookings WHERE id = $1",
    [req.params.id]
  );
  if (existing.rows.length === 0) return err(res, 404, "booking not found");
  if (existing.rows[0].status === "cancelled") {
    return err(res, 409, "booking already cancelled");
  }

  const result = await pool.query(
    `UPDATE bookings SET status = 'cancelled'
      WHERE id = $1
      RETURNING id, slot_id, name, email, status, created_at`,
    [req.params.id]
  );
  res.json(result.rows[0]);
});

module.exports = app;
