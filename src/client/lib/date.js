// `YYYY-MM-DD` for "today" in the user's local timezone — chooses
// the Swedish locale because its short-date format is ISO-compliant
// without a locale-specific date order. Sent to the server as the
// `today_date` parameter for sweep checks.
export function clientToday() {
  return new Date().toLocaleDateString('sv-SE');
}

// True when the user's local clock has passed noon. Sent to the
// server as `past_noon` so sweep-check can decide whether today's
// sweeping window is already over.
export function pastNoon() {
  return new Date().getHours() >= 12;
}
