// Koya Clinic web page.
//
// Talks to the booking API served from the same origin: /config.js gives
// us the API key, then it's plain fetch() calls per the API contract.

const api = (path, options = {}) =>
  fetch(path, {
    ...options,
    headers: {
      "X-API-Key": window.API_KEY,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

const fmt = (iso) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const $ = (sel) => document.querySelector(sel);

function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 4000);
}

// ---- Slots ---------------------------------------------------------------

async function loadSlots() {
  const { status, body } = await api("/slots");
  if (status !== 200) {
    $("#slot-list").innerHTML = `<p class="error">Couldn't load slots (${status}).</p>`;
    return;
  }

  const list = $("#slot-list");
  list.innerHTML = "";
  for (const slot of body.slots) {
    const card = document.createElement("div");
    card.className = "card" + (slot.available ? "" : " taken");
    card.innerHTML = `
      <strong>${slot.provider}</strong>
      <span>${fmt(slot.start)} – ${fmt(slot.end)}</span>
      <button ${slot.available ? "" : "disabled"}>
        ${slot.available ? "Book" : "Booked"}
      </button>`;
    if (slot.available) {
      card.querySelector("button").addEventListener("click", () => openModal(slot));
    }
    list.appendChild(card);
  }
}

// ---- Booking modal ---------------------------------------------------------

let pendingSlot = null;
let pendingKey = null;

function openModal(slot) {
  pendingSlot = slot;
  // One idempotency key per modal session: retries of the same submission
  // replay instead of creating a second booking.
  pendingKey = crypto.randomUUID();
  $("#modal-slot").textContent = `${slot.provider} · ${fmt(slot.start)}`;
  $("#modal-error").textContent = "";
  $("#booking-modal").classList.remove("hidden");
}

function closeModal() {
  pendingSlot = null;
  pendingKey = null;
  $("#booking-modal").classList.add("hidden");
}

async function confirmBooking() {
  const name = $("#f-name").value;
  const email = $("#f-email").value;
  const { status, body } = await api("/bookings", {
    method: "POST",
    headers: { "Idempotency-Key": pendingKey },
    body: JSON.stringify({ slot_id: pendingSlot.id, name, email }),
  });

  if (status === 201) {
    closeModal();
    toast(`Booked! Confirmation id: ${body.id}`);
    loadSlots();
  } else {
    $("#modal-error").textContent = body?.error ?? `Request failed (${status}).`;
  }
}

// ---- My bookings ------------------------------------------------------------

let pageCursors = { current: null, next: null };
const cursorHistory = [];

async function loadBookings(email, cursor) {
  const qs = new URLSearchParams({ email, limit: "5" });
  if (cursor) qs.set("cursor", cursor);
  const { status, body } = await api(`/bookings?${qs}`);

  if (status === 400) {
    $("#lookup-msg").textContent = body?.error ?? "Invalid request.";
    return;
  }

  if (cursor && pageCursors.current !== cursor) cursorHistory.push(pageCursors.current);
  pageCursors = { current: cursor, next: body.next_cursor };

  const list = $("#booking-list");
  list.innerHTML = "";
  $("#lookup-msg").textContent =
    body.bookings.length === 0 ? "No bookings found for that email." : "";
  $("#pager").classList.toggle("hidden", !(cursorHistory.length > 0 || pageCursors.next));

  for (const b of body.bookings) {
    const card = document.createElement("div");
    card.className = "card" + (b.status === "cancelled" ? " taken" : "");
    card.innerHTML = `
      <strong>${b.status === "confirmed" ? "Confirmed" : "Cancelled"}</strong>
      <span>${b.slot_id} · booked ${fmt(b.created_at)}</span>
      <span class="muted small">${b.id}</span>
      ${b.status === "confirmed" ? '<button class="danger">Cancel</button>' : ""}`;
    const cancelBtn = card.querySelector("button");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => cancelBooking(b.id, email));
    }
    list.appendChild(card);
  }
}

async function cancelBooking(id, email) {
  const { status, body } = await api(`/bookings/${id}`, { method: "DELETE" });
  if (status === 200) {
    toast("Booking cancelled.");
    loadBookings(email, pageCursors.current);
    loadSlots();
  } else {
    toast(body?.error ?? `Couldn't cancel (${status}).`, true);
  }
}

// ---- Wiring -----------------------------------------------------------------

$("#modal-cancel").addEventListener("click", closeModal);
$("#modal-confirm").addEventListener("click", confirmBooking);
$("#lookup-form").addEventListener("submit", (e) => {
  e.preventDefault();
  loadBookings($("#lookup-email").value.trim().toLowerCase(), null);
});
$("#next-page").addEventListener("click", () => {
  if (pageCursors.next) loadBookings($("#lookup-email").value.trim().toLowerCase(), pageCursors.next);
});
$("#prev-page").addEventListener("click", () => {
  const prev = cursorHistory.pop();
  loadBookings($("#lookup-email").value.trim().toLowerCase(), prev);
});

loadSlots();
