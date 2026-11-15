// Local test run: boots an embedded Postgres (or uses TEST_DATABASE_URL
// when set, e.g. to verify against the production Neon database), starts
// the API on a test port, then exercises every level of the spec with
// real HTTP requests.

process.env.API_KEY = "test-key";
const externalDb = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL =
  externalDb ?? "postgres://postgres:postgres@localhost:55432/postgres";

const EmbeddedPostgres = require("embedded-postgres").default;

async function main() {
  let pg;
  if (!externalDb) {
    pg = new EmbeddedPostgres({
      databaseDir: "./test/pgdata",
      user: "postgres",
      password: "postgres",
      port: 55432,
    });
    await pg.initialise();
    await pg.start();
  }

  const { migrate } = require("../src/db");
  await migrate();

  const app = require("../src/app");
  const server = app.listen(3555);

  const BASE = "http://localhost:3555";
  const KEY = { "X-API-Key": "test-key" };
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${name}\n      ${e.message}`);
    }
  }

  function assert(cond, msg) {
    if (!cond) throw new Error(msg);
  }

  const future = (days, h, m) =>
    new Date(Date.now() + days * 86400_000).toISOString().slice(0, 11) +
    `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;

  async function api(method, path, { body, headers = {} } = {}) {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...KEY, ...headers, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  }

  // Seed slots for the whole run.
  const slots = [
    { id: "s1", provider: "Dr Ade", start: future(1, 9, 0), end: future(1, 9, 30) },
    { id: "s2", provider: "Dr Ade", start: future(1, 10, 0), end: future(1, 10, 30) },
    { id: "s3", provider: "Dr Bisi", start: future(2, 9, 0), end: future(2, 9, 30) },
    { id: "s4", provider: "Dr Bisi", start: future(2, 10, 0), end: future(2, 10, 30) },
    { id: "s5", provider: "Dr Ade", start: future(3, 9, 0), end: future(3, 9, 30) },
    { id: "past", provider: "Dr Ade", start: "2020-01-01T09:00:00Z", end: "2020-01-01T09:30:00Z" },
  ];
  let r = await api("POST", "/reset", { body: { slots } });
  assert(r.status === 200, `reset failed: ${r.status}`);

  // ---- Level 1 ----
  await test("L1 list slots sorted by start", async () => {
    r = await api("GET", "/slots");
    assert(r.status === 200, `status ${r.status}`);
    const starts = r.body.slots.map((s) => s.start);
    assert(starts.join() === [...starts].sort().join(), "not sorted");
    assert(r.body.slots.length === 6, `expected 6 slots, got ${r.body.slots.length}`);
    assert(r.body.slots.every((s) => s.available === true), "slots should start available");
  });

  await test("L1 list slots filtered by provider", async () => {
    r = await api("GET", "/slots?provider=Dr%20Bisi");
    assert(r.body.slots.length === 2, `expected 2, got ${r.body.slots.length}`);
    assert(r.body.slots.every((s) => s.provider === "Dr Bisi"), "wrong provider leaked in");
  });

  let bookingId;
  await test("L1 book a slot -> 201 confirmed", async () => {
    r = await api("POST", "/bookings", { body: { slot_id: "s1", name: "Ada Obi", email: "ada@example.com" } });
    assert(r.status === 201, `status ${r.status} ${JSON.stringify(r.body)}`);
    assert(r.body.status === "confirmed", "not confirmed");
    assert(r.body.id, "no id");
    bookingId = r.body.id;
  });

  await test("L1 booked slot shows unavailable", async () => {
    r = await api("GET", "/slots");
    const s1 = r.body.slots.find((s) => s.id === "s1");
    assert(s1.available === false, "s1 should be unavailable");
  });

  await test("L1 get booking by id", async () => {
    r = await api("GET", `/bookings/${bookingId}`);
    assert(r.status === 200 && r.body.email === "ada@example.com", `got ${r.status}`);
    r = await api("GET", "/bookings/nope");
    assert(r.status === 404 && r.body.error, "404 expected");
  });

  // ---- Level 2 ----
  await test("L2 missing key -> 401", async () => {
    const res = await fetch(BASE + "/slots");
    const b = await res.json();
    assert(res.status === 401 && b.error, `got ${res.status}`);
  });

  await test("L2 wrong key -> 401", async () => {
    const res = await fetch(BASE + "/slots", { headers: { "X-API-Key": "wrong" } });
    assert(res.status === 401, `got ${res.status}`);
  });

  await test("L2 missing/invalid fields -> 400", async () => {
    r = await api("POST", "/bookings", { body: { slot_id: "s2" } });
    assert(r.status === 400, `missing fields: ${r.status}`);
    r = await api("POST", "/bookings", { body: { slot_id: "s2", name: "  ", email: "x@y.com" } });
    assert(r.status === 400, `blank name: ${r.status}`);
    r = await api("POST", "/bookings", { body: { slot_id: "s2", name: "A", email: "not-an-email" } });
    assert(r.status === 400, `bad email: ${r.status}`);
  });

  await test("L2 unknown slot -> 404, started slot -> 400", async () => {
    r = await api("POST", "/bookings", { body: { slot_id: "nope", name: "A", email: "a@b.com" } });
    assert(r.status === 404, `got ${r.status}`);
    r = await api("POST", "/bookings", { body: { slot_id: "past", name: "A", email: "a@b.com" } });
    assert(r.status === 400, `got ${r.status}`);
  });

  await test("L2 trims name and lowercases email", async () => {
    r = await api("POST", "/bookings", { body: { slot_id: "s2", name: "  Grace  ", email: "  GRACE@Example.COM " } });
    assert(r.status === 201, `status ${r.status}`);
    assert(r.body.name === "Grace", `name: '${r.body.name}'`);
    assert(r.body.email === "grace@example.com", `email: '${r.body.email}'`);
  });

  // ---- Level 3 ----
  await test("L3 second booking on same slot -> 409", async () => {
    r = await api("POST", "/bookings", { body: { slot_id: "s1", name: "B", email: "b@example.com" } });
    assert(r.status === 409, `got ${r.status}`);
  });

  await test("L3 simultaneous bookings: exactly one wins", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        api("POST", "/bookings", { body: { slot_id: "s3", name: `P${i}`, email: `p${i}@x.com` } })
      )
    );
    const ok = results.filter((x) => x.status === 201);
    const conflict = results.filter((x) => x.status === 409);
    assert(ok.length === 1 && conflict.length === 7, `201s=${ok.length} 409s=${conflict.length}`);
  });

  let cancelledId;
  await test("L3 cancel frees slot; double cancel -> 409", async () => {
    r = await api("POST", "/bookings", { body: { slot_id: "s4", name: "C", email: "c@example.com" } });
    cancelledId = r.body.id;
    r = await api("DELETE", `/bookings/${cancelledId}`);
    assert(r.status === 200 && r.body.status === "cancelled", `cancel: ${r.status}`);
    r = await api("GET", "/slots");
    assert(r.body.slots.find((s) => s.id === "s4").available === true, "slot not freed");
    // slot is bookable again
    r = await api("POST", "/bookings", { body: { slot_id: "s4", name: "C2", email: "c2@example.com" } });
    assert(r.status === 201, `rebook: ${r.status}`);
    r = await api("DELETE", `/bookings/${cancelledId}`);
    assert(r.status === 409, `double cancel: ${r.status}`);
    r = await api("DELETE", "/bookings/nope");
    assert(r.status === 404, `missing: ${r.status}`);
  });

  // ---- Level 4 ----
  await test("L4 idempotency: replay returns same booking, no duplicate", async () => {
    const body = { slot_id: "s5", name: "Idem", email: "idem@example.com" };
    const h = { "Idempotency-Key": "key-1" };
    const first = await api("POST", "/bookings", { body, headers: h });
    const second = await api("POST", "/bookings", { body, headers: h });
    assert(first.status === 201 && second.status === 201, `statuses ${first.status}/${second.status}`);
    assert(first.body.id === second.body.id, "different booking ids on replay");
    r = await api("GET", "/bookings?email=idem@example.com");
    assert(r.body.bookings.length === 1, `expected 1 booking, got ${r.body.bookings.length}`);
  });

  await test("L4 idempotency: same key, different body -> 422", async () => {
    r = await api("POST", "/bookings", {
      body: { slot_id: "s5", name: "Other", email: "other@example.com" },
      headers: { "Idempotency-Key": "key-1" },
    });
    assert(r.status === 422, `got ${r.status}`);
  });

  await test("L4 concurrent same-key requests: one booking", async () => {
    // race on the already-booked s1: every replay of a 409 must stay a 409
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        api("POST", "/bookings", { body: { slot_id: "s1", name: "Race", email: "race@example.com" }, headers: { "Idempotency-Key": "race-key" } })
      )
    );
    assert(results.every((x) => x.status === 409), `statuses: ${results.map((x) => x.status)}`);
    r = await api("GET", "/bookings?email=race@example.com");
    assert(r.body.bookings.length === 0, "no booking should exist for race email");
  });

  await test("L4 pagination pages through in order", async () => {
    // page-limit user books 3 slots (s4 already booked by C2 — use fresh resets below)
    r = await api("POST", "/reset", { body: { slots } }); // clears all bookings
    const owner = "pager@example.com";
    const ids = [];
    for (const sid of ["s1", "s2", "s3"]) {
      const res = await api("POST", "/bookings", { body: { slot_id: sid, name: "Pager", email: owner } });
      ids.push(res.body.id);
    }
    const page1 = await api("GET", `/bookings?email=${owner}&limit=2`);
    assert(page1.body.bookings.length === 2, `page1 size ${page1.body.bookings?.length} body=${JSON.stringify(page1.body)}`);
    assert(page1.body.bookings[0].id === ids[0], "oldest first violated");
    assert(page1.body.next_cursor !== null, "page1 should have a cursor");
    const page2 = await api("GET", `/bookings?email=${owner}&limit=2&cursor=${page1.body.next_cursor}`);
    assert(page2.body.bookings.length === 1 && page2.body.bookings[0].id === ids[2], "page2 wrong");
    assert(page2.body.next_cursor === null, "last page cursor should be null");
  });

  await test("L4 email match ignores case; bad limit -> 400", async () => {
    r = await api("GET", "/bookings?email=PAGER@EXAMPLE.COM");
    assert(r.status === 200 && r.body.bookings.length === 3, `got ${r.body.bookings?.length}`);
    for (const lim of ["0", "51", "abc", "-1"]) {
      r = await api("GET", `/bookings?email=pager@example.com&limit=${lim}`);
      assert(r.status === 400, `limit=${lim} gave ${r.status}`);
    }
  });

  // ---- Level 5 ----
  await test("L5 6th attempt in a minute -> 429 + Retry-After", async () => {
    await api("POST", "/reset", { body: { slots } });
    const email = "limit@example.com";
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      // each attempt fails validation (no slot_id) but still counts
      const res = await fetch(BASE + "/bookings", {
        method: "POST",
        headers: { ...KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "L", email }),
      });
      statuses.push(res.status);
      if (i === 5) {
        const ra = res.headers.get("Retry-After");
        assert(ra !== null && Number.isInteger(Number(ra)) && Number(ra) > 0, `Retry-After='${ra}'`);
      }
    }
    assert(statuses.slice(0, 5).every((s) => s === 400), `first five: ${statuses}`);
    assert(statuses[5] === 429, `sixth: ${statuses[5]}`);
  });

  await test("L5 other emails unaffected", async () => {
    r = await api("POST", "/bookings", { body: { slot_id: "s1", name: "Other", email: "other@example.com" } });
    assert(r.status === 201, `got ${r.status}`);
  });

  await test("L5 replays do not consume the limit", async () => {
    const email = "replay@example.com";
    const body = { slot_id: "s2", name: "R", email };
    const h = { "Idempotency-Key": "replay-key" };
    let last;
    for (let i = 0; i < 7; i++) last = await api("POST", "/bookings", { body, headers: h });
    assert(last.status === 201, `replay #7 gave ${last.status}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  server.close();
  if (pg) await pg.stop();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
