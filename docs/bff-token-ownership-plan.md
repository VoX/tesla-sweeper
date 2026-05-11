# BFF Token Ownership — Migration Plan

## Goal

Move Tesla refresh-token ownership entirely to the server. The SPA stops storing
or transmitting any Tesla token; it carries only a session cookie.

**One canonical refresh_token per user**, owned by the server, used by both the
SPA-driven request paths AND the daily notification cron through the same
helper. No two stores rotating in parallel; no client-side rotation logic.

This eliminates the rotation collision that exists today, where the SPA and the
server independently rotate the same refresh_token and silently invalidate each
other's copy.

## Why now

### The bug, concretely

Tesla Fleet API rotates refresh_tokens on every exchange — the old one is
revoked the moment a new one is issued. Today, both the SPA and the server end
up holding the same refresh_token after enrollment, and they rotate it
independently:

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

### Symptom inventory

- Subscribed user opens the SPA after a few days → "refresh failed" toast,
  has to re-OAuth even though notifications are still flowing.
- Subscribed user actively uses the SPA → notifications silently start
  failing. After 3 days, a stuck-sub DM lands.
- New enroll → SPA appears to work but its stored token is already dead. Any
  refresh attempt the SPA makes fails until the user re-OAuths.

### Pre-existing related bugs (incidentally fixed by this migration)

These were surfaced while planning the migration; fixes ride along.

- `routes/oauth.js:42` `/api/oauth/app/refresh` omits `client_secret`. The
  refresh-token grant for confidential clients requires it. Works today only
  because Tesla's first-party client config tolerates it; not guaranteed.
  This route is deleted in this migration, so the bug evaporates — but the
  new `getTeslaAccess` helper MUST include `client_secret` on its refresh
  exchanges (call out explicitly in phase 2).
- `notifications.js:51` `/enable` exchanges the user's refresh_token to
  validate it, then continues with the loop. A crash between exchange and
  the eventual `saveSubs` call loses the rotated token entirely. Fixed
  by routing the validation through `getTeslaAccess`, which persists
  before returning.
- Cron / route handlers don't differentiate `invalid_grant` (real revocation)
  from 5xx / network blip. A single Tesla 502 mass-invalidates today. Fixed
  by classifying refresh-failure responses (see phase 2).

## Target architecture

The server is the **sole owner** of every Tesla token. One canonical
refresh_token per user, in one store, accessed via one helper.

```
┌─ Browser (SPA) ─────────┐         ┌─ Server (express) ──────────────┐
│  localStorage: nothing  │         │                                 │
│  cookie:                │ <─────> │  data/users.json (single store):│
│    session=<id>;        │  HTTPS  │    {                            │
│    HttpOnly; Secure;    │  +cookie│      id: "<user uuid>",         │
│    SameSite=Lax         │         │      session_cookie_id: "<32B>",│
└─────────────────────────┘         │      refresh_token: "<tesla>",  │
                                    │      access_token: "<tesla>",   │
            ┌─ Cron (in same proc) ─┐│      access_expires_at: ts,    │
            │ noon ET, walks         ││      slack_user_id?: "U...",  │
            │ subscribed users       ││      vehicle_id?: "...",      │
            │ via getTeslaAccess(id) ││      vehicle_name?: "...",    │
            └────────────────────────┘│      consecutive_failures: 0, │
                                    │      last_check_at, ...         │
                                    │    }                            │
                                    │                                 │
                                    │  getTeslaAccess(userId):        │
                                    │    used by cron AND every       │
                                    │    SPA-driven route. Single     │
                                    │    code path. In-process        │
                                    │    single-flight per userId.    │
                                    └─────────────────────────────────┘
```

### One record per user, two orthogonal feature flags

A user record can be in any of four states:

| `session_cookie_id` set? | `slack_user_id` + `vehicle_id` set? | Meaning |
|--|--|--|
| yes | yes | logged in + subscribed |
| yes | no | logged in only (browsing, hasn't subscribed) |
| no | yes | subscribed only (cron keeps DMing; user logged out but still wants pings) |
| no | no | dead record, prune candidate |

The cron iterates records where the slack/vehicle fields are set, regardless
of cookie state. The SPA-driven routes look up records by `session_cookie_id`.
Logout clears the cookie field; disable clears the slack/vehicle fields. When
both are clear, the record is pruned on the next daily prune pass.

### One code path for SPA + cron

```js
// src/server/integrations/tesla-auth.js
async function getTeslaAccess(userId)
//   1. Load user record. 404 if not found.
//   2. If access_token cached + expires_at > now+2min → return cached.
//   3. Else exchange refresh_token (with client_secret), classify response:
//      - 200: persist {access_token, refresh_token, expires_at}, return token.
//      - 4xx invalid_grant: persist {refresh_invalidated_at: now}, throw RevokedError.
//      - other 4xx (invalid_request, invalid_client): throw ConfigError (don't invalidate).
//      - 5xx / network: don't persist, throw TransientError. Caller retries.
//   4. In-process single-flight: per-userId Map of in-flight refresh promises so
//      two callers in the same tick share one Tesla round-trip.
```

Both callers go through this helper:

- **SPA route**: middleware reads cookie → `userId` → `getTeslaAccess(userId)` → uses access_token to call Tesla.
- **Cron**: iterates subscribed user records → `getTeslaAccess(record.id)` → uses access_token.

Same helper, same rotation logic, same single-flight, same retry classification.
**No duplicated token-handling code anywhere.**

## Implementation phases

Each phase is independently shippable, with backwards-compat coexistence so
existing flows don't break mid-migration.

### Phase 1 — Schema migration: subscriptions.json → users.json

Rename `data/subscriptions.json` → `data/users.json` and add the new fields.
Existing records gain default values:

```json
// before:
{ "subscriptions": [{ "id":"...", "slack_user_id":"...", "vehicle_id":"...",
                       "vehicle_name":"...", "refresh_token":"..." }] }

// after:
{ "users": [{ "id":"...", "session_cookie_id": null,
              "refresh_token": "...", "access_token": null,
              "access_expires_at": null,
              "slack_user_id":"...", "vehicle_id":"...", "vehicle_name":"...",
              "consecutive_failures":0, ... existing fields preserved
              }] }
```

A startup migration in `src/server/store/users.js` reads the old file if
present, transforms in-place, writes the new file, leaves the old file
renamed to `.subscriptions.json.pre-bff` as a safety net.

The new module exports the same surface plus a couple of helpers:
`loadStore`, `saveStore`, `loadUsers`, `loadUserById`, `loadUserBySession`,
`loadUserBySlackId`, `patchUser`, `createUser`, `deleteUser`, `pruneOrphaned`.

### Phase 2 — `getTeslaAccess` helper + retry classification

New module: `src/server/integrations/tesla-auth.js`. Implements the helper
described above. **Includes `client_secret` on every refresh exchange** (fixes
the carry-forward bug from `oauth.js:42`).

Refresh-failure classification (Tesla returns RFC 6749 error codes in the
JSON body):

```js
// status 200 → success
// status 4xx body.error === 'invalid_grant' → revoked, persist refresh_invalidated_at
// status 4xx other → ConfigError, log loudly, don't touch token
// status 5xx or network throw → TransientError, don't touch token, caller retries
```

Caller-side retry policy (in `getTeslaAccess`): up to 3 attempts on
TransientError with 500ms between, then propagate. Matches the overpass
retry pattern.

### Phase 3 — Convert cron to use `getTeslaAccess`

`src/server/notifications/cron.js` currently inline-exchanges via
`teslaTokenExchange` at line 49 and persists via `patchSub` at line 54.
Replace with:

```js
const access = await getTeslaAccess(user.id);
// access is the cached or freshly-rotated token, persistence already happened
const headers = { Authorization: `Bearer ${access}`, ... };
const locData = await fetchVehicleData(headers, user.vehicle_id);
```

The crash-mid-rotation bug fixes itself — `getTeslaAccess` persists before
returning, so the rest of the cron loop can crash without losing the rotation.

Stub-vehicle short-circuit unchanged.

### Phase 4 — Add session cookie machinery

Add `cookie-parser` middleware in `src/server/app.js`.

New module: `src/server/store/sessions.js` is **not** added — sessions are a
field on the user record, not a separate store.

Add session helpers in `src/server/util/session.js`:
```js
mintSessionCookieId()   // crypto.randomBytes(32).toString('base64url')
readSessionCookie(req)  // req.cookies.session
setSessionCookie(res, id)   // Set-Cookie: session=...; HttpOnly; Secure;
                            //   SameSite=Lax; Path=/sweeper/; Max-Age=2592000
clearSessionCookie(res)
```

`SameSite=Lax` rather than `Strict`: Strict drops the cookie on the OAuth
return-redirect from `auth.tesla.com`, breaking the callback. Lax preserves
the cookie on top-level navigations including OAuth redirects, while still
blocking cross-origin POST attacks. Path is scoped to `/sweeper/` so other
apps on `claw.bitvox.me` don't see the cookie.

### Phase 5 — New auth endpoints

```
POST /api/session/create
  body: { code, state }   # tesla OAuth code, server-side state
  effect: exchange code → tokens, find-or-create user record by tesla user id
          (extracted from id_token claims), bind session_cookie_id, set cookie
  response: 200, body: { vehicles: [...] }  # SPA needs the list anyway

POST /api/session/destroy
  cookie: session=<id>
  effect: clear session_cookie_id on the user record (sub fields preserved
          if present), clear cookie
  response: 204

GET /api/session/me
  cookie: session=<id>
  response: { authenticated: bool, slack_user_id: string|null,
              vehicle_id: string|null, vehicle_name: string|null }
  # Lightweight bootstrap for the SPA on mount.
```

Existing `/api/oauth/app/start` stays (mints state + builds Tesla URL). The
existing `/api/oauth/app/callback` is replaced by `/api/session/create` —
they do the same thing except the new one binds a cookie and the old one
returned tokens to the SPA.

`/api/oauth/app/refresh` is **deleted** — no caller will exist.

**User identity matching**: when a user re-OAuths after logout (or on a new
device), `/session/create` extracts the tesla account id from the OIDC
`id_token` claims, looks up an existing user record by that, and reuses it
(replacing `refresh_token` + `session_cookie_id` with the new values).
This way one tesla account always maps to one record, no duplicates.

If the id_token doesn't include a stable account id (Tesla's OIDC
implementation may vary), fallback is to use the access_token to call
`/api/1/users/me` and key on that response. Confirm during phase 5.

### Phase 6 — Convert tesla-touching routes to session auth

For each existing route taking a `token` body field:

- `POST /api/vehicles` — body becomes `{}`. Read cookie → `getTeslaAccess(userId)` → call Tesla.
- `POST /api/check` — body becomes `{ vehicle_id? }`. Same. Stub-vehicle short-circuit unchanged.
- `POST /api/reverse-geocode` — no auth needed (public Nominatim wrapper). No change.
- `POST /api/notifications/enable` — body becomes `{ vehicle_id, vehicle_name, slack_user_id, slack_session }`. Pulls refresh_token from the user record (already there from `/session/create`). Sets the slack/vehicle fields on the same record. Slack HMAC session is still required for the confused-deputy gate.
- `POST /api/notifications/disable` — clears the slack/vehicle fields on the user record. HMAC-gated.
- `POST /api/notifications/run` — unchanged (bearer-token cron debug).
- `GET /api/notifications/status` — unchanged.

**Multi-vehicle scenario** (R1 P2 #7): `/enable` now writes the slack/vehicle
fields onto the existing user record. If the user enables for vehicle A then
later enables for vehicle B, the second call overwrites the first. **One
sub per user**, deliberately. Multi-vehicle support is a separate feature and
out of scope (see Out of scope).

**Backwards compat for one release**: each tesla-touching route accepts EITHER
a session cookie OR a `token` body field. Cookie wins. This lets the SPA
migrate independently of the server.

After SPA migration ships and a couple of weeks pass with no fallback hits in
logs, remove the `token` body acceptance.

### Phase 7 — SPA migration

In `src/client/`:

- Drop `localStorage['tesla_tokens']` entirely. Add a one-time
  `localStorage.removeItem('tesla_tokens')` cleanup in `main.jsx` for
  hygiene.
- Drop the `refreshToken` callback (`App.jsx:225`) and the 60s polling
  effect (`App.jsx:228-249`). Both become server concerns.
- OAuth callback handler (`App.jsx:423`): instead of POSTing `{code}` to
  `/api/oauth/app/callback`, POST `{code, state}` to `/api/session/create`.
  Response sets the session cookie via Set-Cookie header. SPA records
  "logged in" state from the response body (vehicles list).
- Add `/api/session/me` call on mount to detect existing session.
- All existing API calls drop the `token` body field. They include the
  cookie automatically (same-origin).
- Add `credentials: 'include'` to every `fetch` call in `lib/api.js` so the
  cookie rides along (required for fetch even on same-origin in some browser
  configurations).
- Logout button calls `/api/session/destroy`, then SPA clears its in-memory
  state.
- 401 handling: on any 401 with `{ session_expired: true }`, redirect to OAuth start.

The `tokens` state object goes away. The `transientToast` + `oauthStatus`
split stays. The Slack session HMAC flow is unchanged (orthogonal to tesla).

### Phase 8 — Remove the backwards-compat `token` body acceptance

After ~2 weeks with no fallback hits in logs, remove the `token` body field
support from every route. Update tests.

Delete the `.subscriptions.json.pre-bff` safety-net file from disk.

## Concrete file changes (estimate)

| File | New / Modified | Lines (rough) |
|------|----------------|---------------|
| `src/server/store/users.js` (renamed from subscriptions.js, schema migration) | MODIFIED | +60 / -10 |
| `src/server/integrations/tesla-auth.js` | NEW | ~80 |
| `src/server/util/session.js` | NEW | ~30 |
| `src/server/routes/session.js` | NEW | ~80 |
| `src/server/app.js` | mount session router + `cookie-parser` | +5 |
| `src/server/routes/vehicles.js` | session auth, drop body token (with compat) | ~30 changes |
| `src/server/routes/notifications.js` | drop refresh_token from /enable body, write to user record | ~30 changes |
| `src/server/routes/oauth.js` | delete `/api/oauth/app/refresh`; keep start, redirect callback to /session/create | -25 |
| `src/server/notifications/cron.js` | replace inline exchange with `getTeslaAccess` | ~15 changes |
| `src/client/App.jsx` | drop tokens state + refreshToken + polling effect; switch endpoints; cookie-aware fetch | -80 / +20 |
| `src/client/lib/api.js` | add `credentials: 'include'` | +1 line per call |
| Tests (users + tesla-auth + session routes + retry classifier) | NEW | ~200 |
| `package.json` | add `cookie-parser` dep | +1 |

Net: roughly +400 / -130 lines. ~6-8 hours of focused work spread across
phases 1-8.

## Test plan

New tests:

- `users.test.js` — schema migration from old `subscriptions.json`, atomic
  write, find-or-create by tesla account id, bind/clear cookie, prune
  orphaned records.
- `tesla-auth.test.js` — cached access_token returned within 2min window;
  expiry triggers refresh; refresh failure classification (200 / invalid_grant
  / 5xx); concurrent callers single-flight (no double rotation); retry
  policy (3 attempts on transient).
- `session-routes.test.js` — `/api/session/create` sets cookie correctly,
  matches existing user by tesla account id, `/me` returns correct shape,
  `/destroy` clears cookie + session field but preserves sub fields.

Update existing:

- `routes.test.js` `/api/vehicles` and `/api/check` switch to cookie-based
  auth in primary tests; keep one `token`-body assertion until phase 8 to
  cover the compat path.
- `notifications-cron.test.js` swap `teslaTokenExchange` mocks for
  `getTeslaAccess` mocks.

## Risks + rollback

**Risk: Tesla refresh_token rotation race between cron + an active SPA
request.** Both go through `getTeslaAccess` with in-process single-flight per
user-id, so two simultaneous calls share one Tesla round-trip. As long as
they're in the same Node process (which they are — cron runs in-process), no
collision. If we ever split the cron into a separate process, the helper
needs to grow file-based locking — call out in the helper's comment so a
future maintainer doesn't lose context.

**Risk: SameSite=Lax + OAuth redirect.** Lax sends the cookie on top-level
GET navigations from cross-origin (which Tesla's redirect IS), so the SPA
boots with the cookie present. Verified during phase 4 by manual OAuth.

**Risk: Cookie path scoping.** Cookie set with `Path=/sweeper/` so other
apps on `claw.bitvox.me` (cowgame, transcripts, etc.) don't see it. SPA is
served from `/sweeper/` so the cookie scope matches.

**Risk: User identity matching for find-or-create.** If Tesla's OIDC
id_token doesn't include a stable user id, falls back to `/api/1/users/me`
in phase 5. Confirm during implementation; if neither works, fall back to a
"create new record per OAuth, prune duplicates daily" model.

**Risk: Refresh-failure mass-invalidation during a Tesla outage.** Mitigated
by phase 2's retry classification — only `invalid_grant` invalidates; 5xx
retries 3× then leaves the record intact for the next attempt. Without this
fix, a 502 wave would nuke every record.

**Risk: Tesla grant expiry at 90 days regardless of rotation.** A user
record's refresh_token can age out even with daily rotation. After expiry,
all refresh attempts return `invalid_grant` and the record gets the
`refresh_invalidated_at` flag. UX: the SPA shows "session expired, re-login"
on next page load; the cron's stuck-DM fires after 3 consecutive failures
(existing flow). **Add a server log line whenever a refresh hits
`invalid_grant`** so we can grep for "users about to need re-OAuth."

**Risk: Migration breaks existing logged-in browsers.** Phase 6's
backwards-compat (cookie OR body token) covers this. Existing SPAs keep
working until they pull the new bundle.

**Risk: Session store grows unbounded.** Daily prune pass drops records
where `session_cookie_id` is null AND slack/vehicle fields are empty AND
`last_seen_at > 30d`. Should stay under a few KB at our scale.

**Rollback story.** Each phase is independently revertable:
- Phase 1 (schema rename): the `.pre-bff` safety-net file is preserved; restore by `mv` and revert the commit.
- Phase 2-4 (new modules + cookie infra): orphan code, no impact on existing flows.
- Phase 5 (new endpoints): new routes, no callers yet.
- Phase 6 (backwards-compat routes): existing SPAs keep working via body token.
- Phase 7 (SPA migration): if it goes wrong, revert the one frontend commit and rebuild.
- Phase 8 (remove compat): if removed too eagerly, restore from git.

## Out of scope

- **Multi-vehicle subscription per user.** Today's `subscriptions.json`
  technically supports it (one row per `(slack_user_id, vehicle_id)` pair).
  The new `users.json` collapses to one sub per user; enrolling a second
  vehicle overwrites the first. Restoring multi-vehicle is a separate
  feature — make `vehicle_id`/`vehicle_name`/etc into an array or a
  per-vehicle subdoc. Won't change the token model.
- **Server-side encryption-at-rest of session/refresh tokens.** Filesystem
  mode 0600 + ec2-user ownership matches today's protection.
- **Server-side state-store reuse across processes.** Single-flight is in-
  process only. Adding a second process (separate cron worker, web cluster,
  etc.) requires file/db locking. Document in the helper.
- **Stable user identity if Tesla's OIDC id_token lacks a user id.** Falls
  back to `/api/1/users/me` lookup; if that also fails, accept duplicate
  records and prune later.
- **Audit logging.** Worth adding a basic `[session] created/destroyed/
  refreshed/invalidated` log line in phase 4-5, but a structured audit log
  with retention is out of scope.

## Phase ordering rationale

1. Phase 1 (schema migration) lays the data shape; everything else depends on it.
2. Phases 2-4 are additive — no caller changes, modules accumulate.
3. Phase 3 (cron uses `getTeslaAccess`) is the smallest behavior change and surfaces any helper bugs early.
4. Phase 5 (new endpoints) adds new routes without removing old ones.
5. Phase 6's coexistence (cookie OR body) is the key risk-reducer.
6. Phase 7 is the only phase that touches user-visible behavior, reversible from a single commit.
7. Phase 8 is cleanup, post-observation.

If at any phase the plan starts feeling wrong, we stop. The codebase keeps
the new modules around as orphans and the existing flow keeps working.
