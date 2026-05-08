// `YYYY-MM-DD` for "today" in the user's local timezone — chooses
// the Swedish locale because its short-date format is ISO-compliant
// without a locale-specific date order. Sent to the server as the
// `today_date` parameter for sweep checks.
export function clientToday() {
  return new Date().toLocaleDateString('sv-SE');
}
