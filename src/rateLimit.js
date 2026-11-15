// Level 5: at most 5 booking attempts per email per minute.
// Failed attempts count too, so every request that gets past auth and
// idempotency-replay is recorded here before any validation runs.

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;

// email -> timestamps of that email's recent attempts (oldest first)
const attemptsByEmail = new Map();

// Returns null when the attempt is allowed, or the number of whole
// seconds the client should wait before retrying (for Retry-After).
function checkRateLimit(email) {
  const now = Date.now();
  const recent = (attemptsByEmail.get(email) ?? []).filter((t) => now - t < WINDOW_MS);

  if (recent.length >= MAX_ATTEMPTS) {
    return Math.max(1, Math.ceil((recent[0] + WINDOW_MS - now) / 1000));
  }

  recent.push(now);
  attemptsByEmail.set(email, recent);
  return null;
}

function clearRateLimits() {
  attemptsByEmail.clear();
}

module.exports = { checkRateLimit, clearRateLimits };
