// Accept either a raw slack user id (U060NLFUM) or a pasted slack URL
// (https://app.slack.com/team/U..., /user_profile/U..., slack://user?id=U...)
// and return the extracted U-id. Pass-through if input doesn't look URL-y.
export function parseSlackInput(value) {
  const v = value.trim();
  if (!v.includes('/') && !v.includes('?')) return v;
  // Try the URL-shape patterns first; fall back to any U-id token in
  // the string for newer Slack web URLs that don't match the legacy
  // /team/ /user_profile/ /?id= shapes.
  const m = v.match(/(?:\/(?:team|user_profile)\/|[?&]id=)(U[A-Z0-9]+)/)
    || v.match(/\b(U[A-Z][A-Z0-9]+)\b/);
  return m ? m[1] : v;
}
