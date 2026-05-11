# BFF Token Ownership — Migration Plan

## Goal

Move Tesla refresh-token ownership entirely to the server. The SPA stops storing
or transmitting any Tesla token; it just carries a session cookie.

This eliminates the rotation collision that exists today, where the SPA and the
server independently rotate the same refresh_token and silently invalidate each
other's copy.

## Why now

### The current bug, concretely

Tesla Fleet API rotates refresh_tokens on every exchange — the old one is
revoked the moment a new one is issued. Today, both the SPA and the server hold
the same refresh_token after enrollment:

1. User OAuths in the SPA. Tesla returns `RT0`. SPA stashes it in
   `localStorage['tesla_tokens']`.
2. SPA POSTs `RT0` to `/api/notifications/enable`. Server exchanges it
   (rotates → `RT1`) and persists `RT1` to `subscriptions.json`.
3. **At this exact moment, SPA's localStorage holds `RT0` — already revoked.**
4. ~8h later, SPA's access_token expires. SPA calls
   `/api/oauth/app/refresh` with `RT0`. Tesla 401s. SPA shows
   "refresh failed", user must re-OAuth.

Even ignoring the enroll-time collision, ongoing operation has the same shape:
whichever side rotates first poisons the other's stored copy.

The cron only refreshes once per day (noon ET). The SPA refreshes whenever the
user opens the page after a token expires (~every 8h of active use). If the SPA
beats the cron to a refresh, the cron's stored token is dead the next morning;
its `runNotifications` errors out for that sub, three days later the stuck-DM
fires.

### Symptom inventory

- Subscribed user opens the SPA after a few days → "refresh failed" toast,
  has to re-OAuth even though notifications are still flowing.
- Subscribed user actively uses the SPA → notifications silently start
  failing. After 3 days, a stuck-sub DM lands.
- New enroll → SPA appears to work but its stored token is already dead. Any
  refresh attempt the SPA makes fails until the user re-OAuths.

## Target architecture

The server is the **sole owner** of every Tesla token. The SPA carries only a
server-issued session cookie.

```
┌─ Browser (SPA) ──────────┐         ┌─ Server (express) ──────────────┐
│  localStorage: nothing   │         │  sessions/<id>.json:            │
│    tesla-related         │         │    refresh_token (Tesla)        │
│  cookie:                 │ <─────> │    access_token  (Tesla, cached)│
│    session=<HMAC>;       │  HTTPS  │    access_expires_at            │
│    HttpOnly; Secure;     │  +cookie│    slack_user_id (optional)     │
│    SameSite=Strict       │         │    created_at, last_seen_at     │
└──────────────────────────┘         │                                 │
                                     │  subscriptions.json:            │
                                     │    refresh_token (sub-owned;    │
                                     │      separate from session,     │
                                     │      survives logout)           │
                                     │                                 │
                                     │  getTeslaAccess(sessionId|subId)│
                                     │    → access_token, refreshing   │
                                     │      from refresh_token if      │
                                     │      cached access has expired  │
                                     └─────────────────────────────────┘
```

Two distinct stores because they have different lifecycles:

- **Sessions** are interactive — created by OAuth, destroyed by logout, expire
  after N days of inactivity. Used by SPA-driven calls.
- **Subscriptions** are background — created by `/api/notifications/enable`,
  destroyed by `/api/notifications/disable`, refreshed daily by the cron
  whether the user is logged in or not.

A session and a subscription that belong to the same user hold two independent
refresh_tokens. They rotate independently and never collide because they're
never used in parallel against the same Tesla account state — Tesla allows
multiple active refresh_tokens per OAuth grant.

(If this assumption turns out false in practice, the fallback is to make the
sub copy the session's token at enroll time and keep them shared — which is
just today's problem moved to the cron, and we're back where we started. Need
to confirm with a quick experiment in phase 1.)

## Implementation phases

Each phase is independently shippable, with feature flags or coexistence so
nothing breaks mid-migration. Existing users keep working through every phase.

### Phase 1 — Verify Tesla allows two active refresh_tokens per grant

**Spike, ~30 min.** Manually OAuth twice in two browser windows; confirm both
returned refresh_tokens stay valid in parallel through one rotation each.

If true: proceed with the plan as written.
If false: scope changes — sessions and subscriptions must share the token,
which means we still have a single-owner constraint and the cron has to be
the only refresher. Doable, but the migration looks different (session
becomes a thin wrapper that asks the cron's store for an access_token).

Document the finding in this doc before proceeding.

### Phase 2 — Server-side session store

Add a new `data/sessions.json` (mode 0600), atomic-write-via-rename like
`subscriptions.json`. Schema:

```json
{
  "sessions": [{
    "id": "<32 base64url bytes>",
    "refresh_token": "<tesla>",
    "access_token": "<tesla, cached>",
    "access_expires_at": "<ISO ts>",
    "slack_user_id": "U060NLFUM",
    "slack_session": "<existing HMAC, optional>",
    "created_at": "<ISO ts>",
    "last_seen_at": "<ISO ts>"
  }]
}
```

New module: `src/server/store/sessions.js` exporting `loadSession(id)`,
`createSession(payload)`, `updateSession(id, patch)`, `deleteSession(id)`,
`pruneInactive(maxAgeDays)`. Same atomic-write + corrupt-aside discipline as
`subscriptions.js`.

Add a `pruneInactive` call to the existing daily cron — drop sessions whose
`last_seen_at` is older than 30 days.

### Phase 3 — `getTeslaAccess(sessionId)` helper

New module: `src/server/integrations/tesla-auth.js` exporting:

```js
async function getTeslaAccess(sessionOrSub)
// Returns { access_token, sessionInvalidated: false }
// If access_expires_at is >2min away, return cached access_token.
// Otherwise refresh: exchange refresh_token, persist new tokens,
//   bump access_expires_at, return new access_token.
// If refresh fails (401), mark session as invalidated and return
//   { sessionInvalidated: true } so the caller can 401 the SPA.
```

In-process serialization (single-flight per session id) so two parallel
requests for the same session don't double-refresh and race.

### Phase 4 — New auth endpoints

```
POST /api/session/create
  body: { code, state }   # tesla OAuth code, server-side state
  effect: exchange code → tokens, mint sessionId, write session record
  response: 200, Set-Cookie: session=<sessionId>; HttpOnly; Secure;
            SameSite=Strict; Max-Age=2592000  (30d)
            body: { vehicles: [...] }  # convenience: SPA needs the list anyway

POST /api/session/destroy
  cookie: session=<id>
  effect: deleteSession(id), instruct browser to clear cookie
  response: 204, Set-Cookie: session=; Max-Age=0

GET /api/session/me
  cookie: session=<id>
  response: { authenticated: bool, slack_user_id: string|null,
              vehicles_cached_at?: ISO ts }
  # Lightweight check the SPA can call on mount to know if a session
  # exists without paying for a tesla round-trip.
```

Existing `/api/oauth/app/start` and `/api/oauth/app/callback` stay for the
OAuth handshake (they already return the `code` to the SPA via the redirect,
which the SPA then POSTs to `/api/session/create`).

`/api/oauth/app/refresh` is **deleted** — no caller will need it.

### Phase 5 — Convert tesla-touching routes to session auth

For each existing route that currently takes a `token` body field, replace
with cookie-based session lookup:

- `POST /api/vehicles` — body becomes `{}`. Server reads cookie → `getTeslaAccess` → calls Tesla. Returns `{ vehicles: [...] }` as before.
- `POST /api/check` — body becomes `{ vehicle_id? }`. Same lookup pattern. Stub-vehicle short-circuit unchanged.
- `POST /api/reverse-geocode` — no auth needed (public Nominatim wrapper, just lat/lng validation). No change.
- `POST /api/notifications/enable` — body becomes `{ vehicle_id, vehicle_name }` only. Pulls refresh_token from session, copies it into the new sub record (the sub keeps its own copy). The HMAC `slack_user_id` + `session` field are still required separately for the confused-deputy gate (slack ownership proof is orthogonal to tesla session).
- `POST /api/notifications/disable` — unchanged (still HMAC-gated by slack session).
- `POST /api/notifications/run` — unchanged (bearer-token auth for cron debug, no tesla session needed).
- `GET /api/notifications/status` — unchanged.

**Backwards compat for one release**: each tesla-touching route accepts EITHER a session cookie OR a `token` body field. If both are present, prefer the cookie. This lets the SPA migrate independently of the server, and lets the cron's standalone `/api/notifications/run` keep working.

After SPA migration ships and a couple of weeks pass with no fallback hits in logs, remove the `token` body acceptance.

### Phase 6 — SPA migration

In `src/client/`:

- Drop `localStorage['tesla_tokens']` entirely. Never read or write it again. Remove the migration code that reads stale entries (or leave a one-time `localStorage.removeItem('tesla_tokens')` cleanup in `main.jsx`).
- Drop the `refreshToken` callback and the 60s polling effect that watches `expires_at`. Both become server concerns.
- OAuth callback handler (`useEffect` at `App.jsx:423`): instead of POSTing `{code}` to `/api/oauth/app/callback`, POST `{code, state}` to `/api/session/create`. Response sets the session cookie. SPA records "logged in" state from the response body (vehicles list).
- Add `/api/session/me` call on mount to detect existing session.
- All existing API calls drop the `token` body field. They include the cookie automatically (same-origin).
- Logout button calls `/api/session/destroy`.
- 401 handling: on any 401 with `{ session_expired: true }`, redirect to OAuth start.

The `tokens` state object goes away. The `transientToast` + `oauthStatus` split stays. The Slack session HMAC flow is unchanged (orthogonal to tesla).

### Phase 7 — Migrate existing subscriptions

Existing subs in `subscriptions.json` already have their own refresh_token —
nothing to migrate on the cron side. They keep working untouched.

Existing browsers with stale `localStorage['tesla_tokens']`: on first load
post-migration, the SPA detects no session cookie and either prompts OAuth
or (nicer) tries `/api/session/me` first to confirm and shows a "log in"
button. Either way, no breakage — the user re-OAuths once.

### Phase 8 — Remove the backwards-compat `token` body acceptance

After ~2 weeks with no fallback hits in logs, remove the `token` body field
support from every route. SPA must use session cookie.

Update tests to match.

## Concrete file changes (estimate)

| File | New / Modified | Lines (rough) |
|------|----------------|---------------|
| `src/server/store/sessions.js` | NEW | ~80 |
| `src/server/integrations/tesla-auth.js` | NEW | ~60 |
| `src/server/routes/session.js` | NEW | ~80 |
| `src/server/app.js` | mount session router + `cookie-parser` middleware | +5 |
| `src/server/routes/vehicles.js` | session auth, drop body token | ~30 changes |
| `src/server/routes/notifications.js` | drop refresh_token from /enable body | ~20 changes |
| `src/server/routes/oauth.js` | delete `/api/oauth/app/refresh`, keep start/callback | -25 |
| `src/server/notifications/cron.js` | optionally use `getTeslaAccess` for code share | +10 / unchanged |
| `src/client/App.jsx` | drop tokens state, drop refreshToken, drop polling effect, switch endpoints | -80 |
| `src/client/lib/api.js` | add `credentials: 'include'` to fetch calls | +1 line per call |
| Tests for sessions, tesla-auth, session routes | NEW | ~150 |
| `docs/bff-token-ownership-plan.md` | NEW (this doc) | (here) |

Net: roughly +250 / -100 lines, plus the doc. ~5-6 hours of focused work
spread across the phases.

## Test plan

New tests (pre-existing tests guard everything else):

- `sessions.test.js` — create/load/update/delete/prune, atomic write, corrupt-aside.
- `tesla-auth.test.js` — cached access_token returned within 2min window;
  expiry triggers refresh; refresh failure marks session invalidated; concurrent
  callers single-flight (no double rotation).
- `session-routes.test.js` — `/api/session/create` sets cookie correctly,
  `/me` returns shape, `/destroy` clears cookie.
- Update `routes.test.js` `/api/vehicles` and `/api/check` to use the new
  cookie-based auth; keep the legacy `token` body assertions until phase 8.

## Risks + rollback

**Risk: Tesla rejects the second active refresh_token.** Mitigation: phase 1
spike. If Tesla enforces single-owner, we collapse sessions and subs into a
shared store with a single canonical refresh_token, and the cron becomes the
sole refresher (sessions just read the shared store).

**Risk: Cookie + CORS pain.** SPA + server are same-origin under
`https://claw.bitvox.me/sweeper/` so CORS doesn't apply. SameSite=Strict +
HttpOnly + Secure cookies are the simple case.

**Risk: Migration breaks existing logged-in browsers.** Phase 5's backwards-
compat (accept either cookie OR body token) covers this — old SPAs keep
working until they refresh and pull the new bundle.

**Risk: Session store grows unbounded.** Mitigated by phase 2's
`pruneInactive(30d)` daily call. Should stay under a few KB at our scale.

**Risk: Stuck single-flight in `getTeslaAccess`.** A hung refresh blocks all
subsequent requests for that session until timeout. Use the existing
`fetchWithTimeout` (12s) and track per-session promises, not a global lock —
one slow user can't starve others.

**Rollback story.** Each phase is independently revertable:
- Phase 2-3 (new modules): orphan code, no impact on existing flows.
- Phase 4 (new endpoints): new routes, no callers yet.
- Phase 5 (backwards-compat routes): existing SPAs keep working via body token.
- Phase 6 (SPA migration): if it goes wrong, revert the one frontend commit and rebuild.
- Phase 8 (remove compat): if removed too eagerly, restore from git.

## Out of scope

- Multi-tesla-account-per-user. Today one session = one refresh_token = one tesla account. Multi-account is a separate feature.
- Single-sign-on across devices. A user with two browsers gets two sessions, each with its own refresh_token. Fine, since Tesla allows multiple grants.
- Server-side encryption-at-rest of session tokens. Filesystem mode 0600 + ec2-user ownership is the same protection refresh_tokens have today in `subscriptions.json`. Add fde or a key wrap if/when we host secrets we're not willing to lose to a single compromised box.

## Phase ordering rationale

Why this order and not "rip the band-aid off":

1. The phase 1 spike is cheap and decides whether the whole plan is viable.
2. Phases 2-4 are additive — old code keeps working, new code accumulates.
3. Phase 5's coexistence (cookie OR body) is the key risk-reducer — it lets SPA and server migrate on independent timelines.
4. Phase 6 is the only phase that touches user-visible behavior, and it's reversible from a single commit.
5. Phase 8 is cleanup, low-risk, after observation confirms no fallback.

If at any phase the plan starts feeling wrong, we stop. The codebase keeps the
new modules around as orphans and the existing flow keeps working.
