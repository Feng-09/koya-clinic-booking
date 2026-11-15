# Koya Clinic booking API

A clinic appointment booking API plus a small web page that uses it, built
for the Koya Cohort 4 assessment (Task 1).

## Stack

- **Node.js + Express** — the API and the static web page
- **PostgreSQL** (Neon) — storage; the double-booking protection is a
  database partial unique index, so it holds even for simultaneous requests

## Run it

```bash
npm install
cp .env.example .env   # fill in API_KEY and DATABASE_URL
npm start
```

Then open http://localhost:3000 for the web page.

## Test it

The test suite boots an embedded Postgres, starts the app, and exercises
every level of the spec over real HTTP:

```bash
npm test
```

## How it works

| Level | What guarantees it |
| --- | --- |
| 1 — slots, booking, lookup | `/reset`, `/slots`, `POST /bookings`, `GET /bookings/:id` |
| 2 — auth + validation | `X-API-Key` middleware; field/email/slot validation in `createBooking` |
| 3 — no double booking | partial unique index `one_confirmed_booking_per_slot` + `ON CONFLICT` → 409; cancel via `DELETE` frees the slot |
| 4 — idempotency + pagination | `idempotency_keys` table stores status+response per key; cursor pagination by booking `seq` |
| 5 — rate limiting | sliding window of 5 attempts per email per minute in `rateLimit.js`, `Retry-After` on 429 |

## Deploy

Any Node host + Postgres works. `api/index.js` is the serverless entry
point used by Vercel: import the repo, then set `API_KEY`, `DATABASE_URL`
and `DATABASE_SSL=true` as environment variables.
