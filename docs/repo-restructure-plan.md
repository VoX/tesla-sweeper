# Repo Restructure & Modularization — Plan

## Goal

Three changes, executed in order:

1. **Reorganize**: move all source code under `src/`, split into `src/server/` and `src/client/`. The repo root currently mixes `server.js`, `src/` (client), and `lib/` (shared planner).
2. **Decompose the client**: `src/App.jsx` is 853 lines and contains 7 sub-components plus the orchestrator. Break into per-component files; add vitest component tests for the load-bearing parts.
3. **Decompose the server**: `server.js` is 1071 lines holding HTTP routes + Tesla/Slack/Recollect/Nominatim/Overpass integrations + sweep logic + cron + middleware. Break into modules by responsibility; add tests for the core paths that can be tested without hitting external APIs.

The end state should be one where adding (e.g.) a new sweep-check feature or a new component doesn't require editing a 1000-line file, and where most logic has at least one test guarding it.

## Current state

```
tesla-sweeper/
  server.js                        1071 lines — monolithic backend
  src/
    main.jsx                          5 lines — Preact mount
    App.jsx                         853 lines — client app + 7 inner components
    App.css                          46 lines
    leaflet-loader.js                34 lines — already extracted
  lib/
    notification-planner.js         247 lines — already modular, has tests
    notification-planner.test.js    346 lines
  index.html                                — points at /src/main.jsx
  vite.config.js                            — main entry + custom plugins
  package.json                              — scripts: dev/build/start/preview/test
  docs/                                     — planning docs
```

The planner under `lib/` is the only piece already modularized; everything else is concentrated in two files.

## Constraints

- **Behavior must not change.** Live deployment continues to work after every phase. Each phase compiles, passes existing tests, and the service starts clean.
- **Each phase is independently shippable.** If a phase reveals a problem, we revert just that commit; the rest stay live.
- **No new abstractions for their own sake.** Module boundaries follow existing logical seams (Tesla, Slack, Recollect, etc.); we don't introduce a DI container, a service registry, or a "core/util" grab bag.
- **Public API of `runSweepCheck` and `classifyWeek` is fixed.** Callers (tests, cron, routes) all currently consume their existing shapes — refactoring may move them but must not change argument or return shapes.
- **Test runner stays vitest.** Already installed for the planner; reuse for new server + client tests.
- **Import paths**: ES modules with explicit `.js` / `.jsx` extensions (matches current style and `type:"module"` package).

## Target tree

```
src/
  server/
    index.js                  ── entry — boot, cron registration, app.listen, recovery
    app.js                    ── express app construction + route mounting
    config.js                 ── env loading + constants (TESLA_*, SLACK_*, STUB_*, etc.)
    middleware/
      brotli.js               ── .br pre-compressed-asset serving
      errors.js               ── wrap() async-error helper
    crypto/
      session.js              ── signSession, verifySession
      bearer.js               ── bearerOk
    store/
      subscriptions.js        ── loadStore, saveStore, loadSubs, saveSubs, publicSub, patchSub
    integrations/
      tesla.js                ── teslaTokenExchange, fetchVehicleData, teslaWakeAndPoll, stub helpers
      slack.js                ── postSlackDM
      nominatim.js            ── reverseGeocodeLocation, nominatimFetch (with rate-limit queue)
      overpass.js             ── whichSide + projectPointToSegment + crossSign + haversineMeters
      recollect.js            ── address-suggest + events fetch (extracted from runSweepCheck)
    sweep/
      check.js                ── runSweepCheck (uses integrations + overpass)
    notifications/
      planner.js              ── moved from lib/notification-planner.js
      cron.js                 ── runNotifications, schedule registration, missed-run recovery
    routes/
      vehicles.js             ── POST /api/vehicles, /api/check, /api/reverse-geocode
      oauth.js                ── Tesla + Slack OAuth handlers
      notifications.js        ── /api/notifications/enable, /disable, /status, /run
      probes.js               ── /api/which-side, /api/sweep-check, /healthz
    __tests__/
      planner.test.js         ── moved from lib/
      store.test.js           ── new
      crypto.test.js          ── new
      sweep.test.js           ── new
      notifications-cron.test.js ── new
      routes.test.js          ── new (supertest-based)
  client/
    main.jsx                  ── moved (entrypoint, mounts <App/>)
    App.jsx                   ── orchestrator only (~150 lines: state, tab logic, OAuth callback handling)
    App.css                   ── moved
    leaflet-loader.js         ── moved
    components/
      StatusBox.jsx
      Row.jsx
      MapView.jsx             ── largest extracted chunk
      SideDetectionCard.jsx
      SweepResults.jsx
      LocationResultsView.jsx
      NotificationsPanel.jsx
    lib/
      cache.js                ── readCachedCheck, saveCachedCheck (with v: 1 versioning)
      slack-input.js          ── parseSlackInput
      date.js                 ── clientToday
    __tests__/
      MapView.test.jsx
      LocationResultsView.test.jsx
      NotificationsPanel.test.jsx
      cache.test.js
      slack-input.test.js
```

`lib/` at repo root is removed (planner moves to `src/server/notifications/`). `vite.config.js`, `index.html`, `package.json` stay at root and update their paths.

## Phases

Each phase = one commit (or a tight series of commits, all of which leave the build green). Live restart only on phases that touch server runtime (1, 2, 6).

### Phase 1 — Skeleton move (no decomposition)

Smallest first commit. Just move files into the new tree without splitting them. Verify `npm run build`, `npm test`, and `node src/server/index.js` all still work.

- Create `src/server/` and `src/client/` dirs.
- `git mv server.js → src/server/index.js`
- `git mv src/App.jsx → src/client/App.jsx`
- `git mv src/main.jsx → src/client/main.jsx`
- `git mv src/App.css → src/client/App.css`
- `git mv src/leaflet-loader.js → src/client/leaflet-loader.js`
- `git mv lib/notification-planner.js → src/server/notifications/planner.js` (with subdir creation)
- `git mv lib/notification-planner.test.js → src/server/__tests__/planner.test.js`
- Update relative imports inside the moved files (mostly the planner import path in `index.js`).
- Update `package.json` `start` script: `node src/server/index.js`
- Update `package.json` `test` script: `vitest run src/server src/client`
- Update `index.html` `src/main.jsx` reference to `src/client/main.jsx`
- Update `vite.config.js` if needed (`root` stays at repo root)

**Checkpoints:** build, run tests, restart service, hit `/healthz`, hit `/sweeper/`.

### Phase 2 — Server decomposition

Subphases (each = one commit):

- **2a** `middleware/{brotli,errors}.js` — easiest, isolated, small.
- **2b** `crypto/{session,bearer}.js` — pure, easily testable.
- **2c** `store/subscriptions.js` — disk-IO module (loadStore, saveStore, etc.)
- **2d** `integrations/tesla.js`, `integrations/slack.js`
- **2e** `integrations/nominatim.js` (with rate-limit queue intact)
- **2f** `integrations/overpass.js` (whichSide + geometry helpers)
- **2g** `integrations/recollect.js` (extract from runSweepCheck, give it a `fetchSweepEvents(address, after, before)` shape)
- **2h** `sweep/check.js` (runSweepCheck moved, now consumes 2g + 2f)
- **2i** `notifications/cron.js` (runNotifications + cron registration + recovery helpers)
- **2j** `routes/{vehicles,oauth,notifications,probes}.js` — split handlers; `app.js` mounts them
- **2k** `index.js` cleanup — final entry should be ~30 lines: load config, build app via `app.js`, register cron, listen, recover

**Checkpoint after each subphase:** build green, planner tests still pass, `/healthz` returns 200 after restart.

### Phase 3 — Server tests

- **3a** Add `supertest` + dev dep. `vitest` already present.
- **3b** `store.test.js` — atomic write, corruption-aside, patchSub re-read pattern.
- **3c** `crypto.test.js` — HMAC sign/verify happy + tampered + expired + missing-key.
- **3d** `sweep/check.test.js` — mock `nominatim.js` + `recollect.js` + `overpass.js` modules; assert end-to-end output shape and message templates for each sweep-status branch.
- **3e** `routes.test.js` — supertest against `app.js`. Mock external integrations. Cover `/api/check` 401 path, `/api/notifications/enable` HMAC gate, `/api/notifications/run` bearer gate, `/healthz` shape.
- **3f** `notifications-cron.test.js` — runNotifications with stub vehicle path, mode validation throw, single-flight cross-mode throw, last_dm_date dedup. Mock `postSlackDM` + tesla/recollect modules.

Aim for every server module to have at least one test file. Skip 100% coverage chasing.

### Phase 4 — Client decomposition

Subphases (each = one commit, build + visual smoke test):

- **4a** `client/lib/{cache,slack-input,date}.js`
- **4b** `client/components/{StatusBox,Row}.jsx` (smallest)
- **4c** `client/components/MapView.jsx` (largest non-orchestrator chunk)
- **4d** `client/components/SideDetectionCard.jsx`, `SweepResults.jsx`
- **4e** `client/components/LocationResultsView.jsx` (depends on 4c+4d)
- **4f** `client/components/NotificationsPanel.jsx`
- **4g** `App.jsx` final cleanup — it stays as the orchestrator. Keep `App.css` whole; per-component CSS-split is **out of scope** unless a component naturally has lots of one-off styles.

### Phase 5 — Client tests

- **5a** Set up `happy-dom` environment for vitest (`@vitest/browser` is overkill; `happy-dom` is fine for these components).
- **5b** `lib/cache.test.js` — versioning, expiry, malformed JSON.
- **5c** `lib/slack-input.test.js` — parses `<@U…|name>` markup, raw `U…`, mention-text, fallback.
- **5d** `MapView.test.jsx` — renders given coords, popup label appears, draggable mode wires onPinMove.
- **5e** `LocationResultsView.test.jsx` — gates on data presence, renders sweep + side-detection sub-cards.
- **5f** `NotificationsPanel.test.jsx` — wires Slack sign-in, slack-id validation, enable/disable buttons.

### Phase 6 — Final cleanup

- Verify `find . -path './node_modules' -prune -o -type f \( -name '*.js' -o -name '*.jsx' \) -print | wc -l` and a quick directory tree are sane.
- Update `CLAUDE.md` + `CLAUDE.local.md` to reference the new layout.
- Update `docs/notification-scenarios.md` + `docs/stub-vehicle-plan.md` paths if they cite line numbers that have moved.
- One final build, test run, restart, `/healthz`, sanity-click in browser.
- Optional: tag the commit `v2.0.0-restructure` so we have a marker.

## Test strategy details

- **External APIs are never hit in tests.** All Tesla / Recollect / Nominatim / Overpass / Slack calls go through their respective integration module, which tests mock with vitest's `vi.mock()` or by passing dependency-injected fetchers.
- **Real fixtures:** capture one real Recollect events response, one real Overpass response, into `__tests__/fixtures/`. Use them in `sweep/check.test.js` so the test exercises the full parser.
- **Supertest** for routes — start the express app in-process, no port binding. Faster than nock-based.
- **No snapshot tests.** Snapshots invite "update the snapshot to make it pass" failure mode.
- **Coverage target: ~70% on critical paths** (sweep, planner, store, crypto, routes), no target on glue code.

## Risks / out-of-scope

- **CSS split** is explicitly out of scope. `App.css` stays whole at first; per-component CSS modules can come later if a component grows large enough to need them.
- **Build pipeline changes**: `vite.config.js` may need a `root` adjustment if Vite's default index resolution gets confused by the moved entry. Will validate in Phase 1.
- **Runtime imports**: The brotli middleware reads `dist/<path>.br`; if `dist/` layout changes (it shouldn't — Vite still emits there), the middleware breaks. Verified in Phase 1 checkpoint.
- **Subscription store path**: `data/subscriptions.json` is referenced as a literal path relative to the working directory. Server entry now lives at `src/server/index.js` but `process.cwd()` should still be the repo root — confirmed in Phase 1.
- **Symlink trickery**: tempting but rejected. The repo restructure is the point; no compatibility shims at the old paths.
- **Stub vehicle test plan** + **notification scenarios doc** stay in `docs/` and don't move.
- **Nothing in `data/`, `dist/`, `keys/`, `node_modules/` moves.**
- **Live state migration**: none required. The on-disk `data/subscriptions.json` schema is unchanged.

## Net diff estimate

- Phase 1: ~5 file moves, ~10 lines of import-path edits. One commit.
- Phase 2: ~11 commits, ~1100 lines of `server.js` redistributed (no code changes besides moves + import wiring). New per-module overhead ~50 lines (export statements, file headers).
- Phase 3: ~6 new test files, ~400-600 lines of test code total.
- Phase 4: ~7 commits, ~850 lines of `App.jsx` redistributed. Same new-file overhead ~30 lines.
- Phase 5: ~6 new test files, ~300-400 lines.
- Phase 6: docs touch-ups, ~50 lines net.

Total: ~24 commits, additive surface ~1500 lines (mostly tests).

## Suggested execution cadence

If shipped in one sitting: ~4-6 hours of focused work. The natural breakpoints are after phases 1, 2, 3, 4. A reasonable split is "phase 1+2 today, phase 3 next session, phase 4+5 the session after that, phase 6 to wrap." Each phase is independently revertable; prefer a clean break over a rushed phase 5.
