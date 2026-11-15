# Video walkthrough script (~4.5 minutes)

Record your screen with the live site and your code editor side by side.
Speak naturally — these lines are a guide, not a script to read word for
word. Aim for 4–4.5 minutes; it's fine to be under 5.

---

## 1. Intro (0:00 – 0:25)

**Show:** the deployed site, https://koya-clinic-booking-tife.vercel.app

> "Hi, I'm [name], and this is my clinic booking API for the Koya
> assessment. It's a Node and Express API backed by Postgres on Neon,
> deployed on Vercel, plus this web page that talks to it. Let me show
> you the page first, then walk through the code."

## 2. Demo the web page (0:25 – 1:45)

**Show:** scroll the slot list.

> "So this is the clinic page. All these appointment slots come from the
> API's GET /slots endpoint — you can see each provider and time, and
> whether the slot is still available."

**Show:** click **Book** on a slot, fill in a name and email, confirm.

> "Booking is a POST to /bookings with the slot id, my name and email.
> The server validates everything, saves the booking as confirmed, and
> the slot flips to 'Booked' — the page just re-fetches /slots, and the
> API now reports it as unavailable."

**Show:** scroll to "My bookings", type the email, **Look up**.

> "Down here I can look up my bookings by email — that's GET /bookings
> with pagination. Here's the booking I just made. The card shows the
> doctor and the appointment date and time, so it works as a reminder,
> along with when I booked it and the confirmation id."

**Show:** click **Cancel**, then the slot list showing the freed slot.

> "And cancelling is a DELETE on the booking id. It marks the booking
> cancelled and immediately frees the slot, so someone else can book
> it. You can see it went back to 'Book' up here."

## 3. Code walkthrough (1:45 – 4:00)

**Show:** repo in your editor, `src/` folder.

> "Okay, quick tour of the code. It's a small Express app — the routes
> all live in `src/app.js`, the database setup is `src/db.js`, and the
> rate limiter is its own tiny module."

**Show:** `src/db.js`.

> "Starting with the database. I have three tables: slots, bookings, and
> a table that remembers idempotency keys. The important line in this
> whole project is this unique index: one confirmed booking per slot. The
> *database* enforces that two people can never hold the same slot — even
> if two requests arrive at the exact same moment, one insert wins and
> the other gets a constraint violation that I turn into a 409. App-level
> checks can't promise that, because both requests could pass the check
> before either inserts. The database can."

**Show:** `src/app.js`, the auth middleware near the top.

> "In `app.js`, everything first passes through this middleware: every
> request needs the X-API-Key header or it gets a 401. Then the booking
> route itself."

**Show:** the `POST /bookings` handler.

> "For bookings, three things happen in order. First, idempotency: if
> there's an Idempotency-Key header, I hash the body and look it up. A
> seen key with the same body replays the stored response — same status,
> same booking id, no second booking. Same key with a different body is a
> 422. I store the response for every outcome, so even a retry of a
> failed request replays correctly. Second, the rate limiter — I'll show
> that file in a second. Third, validation: required fields, email
> format, the slot has to exist and not have started — those give 400s
> and a 404. Then the insert, and the unique index I mentioned turns a
> race into a 409."

**Show:** `src/rateLimit.js`.

> "`rateLimit.js` is the level-five piece. It's a sliding window: for
> each email I keep the timestamps of the last minute of attempts, and
> if there are already five, the next one gets a 429 with a Retry-After
> header — calculated from when the oldest attempt expires. Failed
> attempts count too, because I record the attempt before validating."

**Show:** the `GET /bookings` handler in `src/app.js`.

> "For listing a person's bookings, the query filters by lowercased
> email, orders by an auto-incrementing sequence, and the cursor is just
> the sequence number of the last booking you saw — I fetch one extra row
> to know whether there's a next page, and return `next_cursor: null` on
> the last one."

**Show:** `api/index.js` briefly.

> "And `api/index.js` is the Vercel entry point — it runs the migrations
> once per cold start and hands off to the Express app. The web page in
> `public/` is plain HTML and JavaScript that calls these same endpoints."

## 4. Closing (4:00 – 4:30)

**Show:** the README or the repo root.

> "Everything's covered by an automated test suite — twenty-one checks
> that boot a real Postgres and hit every level of the spec over HTTP —
> and the repo's on GitHub. Links are in the form. Thanks for watching!"

---

## Recording tips

- Book one slot and leave it booked during the demo, so "My bookings"
  shows a confirmed booking when you look it up.
- If you cancel in the demo, re-book something afterward so the page
  doesn't end on an empty state — or just leave the cancel for last.
- The demo slots run through mid-December, so they stay valid well past
  the cohort start on December 7. If you ever need them refreshed before
  you submit, tell me and I'll reseed.
- Don't redeploy or change env vars after submitting — the rules ask
  for the deployment to stay untouched.
