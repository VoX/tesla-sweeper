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

## Workspace layout (npm workspaces)

The root `package.json` becomes a [workspace coordinator](https://docs.npmjs.com/cli/v8/using-npm/workspaces); each of `src/server/` and `src/client/` gets its own `package.json` declaring only the deps it actually uses. `npm install` at the root installs everything, hoisting common deps (vitest, etc.) to the top-level `node_modules/`.

**Why workspaces vs one root `package.json`:**
- Client deps (`preact`, `leaflet`, `vite`, `@preact/preset-vite`) and server deps (`express`, `node-cron`) stop sharing a manifest. Easier to spot what's pulling what.
- A future "split deploy" (publishing the planner module, or shipping a separate API artifact) becomes trivial — each workspace is already self-describing.
- Per-workspace test runs (`npm test -w @tesla-sweeper/server`) make CI sharding easy when/if we add CI.

**Root `package.json`:**

```json
{
  "name": "tesla-sweeper",
  "private": true,
  "type": "module",
  "workspaces": ["src/server", "src/client"],
  "scripts": {
    "dev": "concurrently -k -n srv,cli -c blue,magenta \"npm run dev -w @tesla-sweeper/server\" \"npm run dev -w @tesla-sweeper/client\"",
    "build": "npm run build -w @tesla-sweeper/client",
    "start": "npm run start -w @tesla-sweeper/server",
    "test": "npm run test --workspaces --if-present"
  },
  "devDependencies": { "concurrently": "^9.0.0" }
}
```

**`src/server/package.json`:**

```json
{
  "name": "@tesla-sweeper/server",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "index.js",
  "scripts": {
    "dev": "node --watch index.js",
    "start": "node index.js",
    "test": "vitest run"
  },
  "dependencies": { "express": "^4.21.0", "node-cron": "^4.2.1" },
  "devDependencies": { "vitest": "^4.1.5", "supertest": "^7.0.0" }
}
```

**`src/client/package.json`:**

```json
{
  "name": "@tesla-sweeper/client",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": { "preact": "^10.29.1", "leaflet": "^1.9.4" },
  "devDependencies": {
    "vite": "^5.4.0",
    "@preact/preset-vite": "^2.10.5",
    "vitest": "^4.1.5",
    "happy-dom": "^15.0.0"
  }
}
```

`vite.config.js` and `index.html` move into `src/client/` (Vite runs from there). `vite.config.js` sets `build.outDir: '../../dist'` so the server still serves a top-level `dist/` — the brotli middleware path stays unchanged. The brotli `closeBundle` plugin moves alongside.

The server reads `data/subscriptions.json` and the brotli `.br` files from `dist/` via paths anchored on `process.cwd()`, which stays the repo root regardless of which workspace ran (because `npm run start -w server` invokes the script with cwd = `src/server/` — so we either swap to `__dirname`-relative paths anchored at `src/server/index.js` and walking `../../dist/`, or pin `cwd` in the systemd unit file). Phase 1 picks the `__dirname`-relative version since it's portable.

**Single `package-lock.json` at root.** npm workspaces share one lockfile; each workspace's `node_modules/` is symlinked into the hoisted store.

## Target tree

```
package.json                  ── root: workspaces declaration + orchestration scripts
package-lock.json             ── single lockfile for the workspace
src/
  server/
    package.json              ── @tesla-sweeper/server: express, node-cron, vitest, supertest
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
    package.json              ── @tesla-sweeper/client: preact, leaflet, vite, vitest, happy-dom
    vite.config.js            ── moved from root; build.outDir = '../../dist'
    index.html                ── moved from root; references main.jsx
    main.jsx                  ── entrypoint, mounts <App/>
    App.jsx                   ── orchestrator only (~150 lines: state, tab logic, OAuth callback handling)
    App.css
    leaflet-loader.js
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

`lib/` at repo root is removed (planner moves to `src/server/notifications/`). Vite config + `index.html` follow the client into `src/client/`. The `dist/` build artifact still emits at the repo root (`build.outDir: '../../dist'`) so the server's path resolution doesn't change.

## Phases

Each phase = one commit (or a tight series of commits, all of which leave the build green). Live restart only on phases that touch server runtime (1, 2, 6).

### Phase 1 — Skeleton move + workspace setup (no decomposition)

Files move into the new tree and the root `package.json` becomes a workspace coordinator. No code is split yet. Verify `npm install`, `npm run build`, `npm run start`, and `npm test` all still work end-to-end.

**1.1 — Move files** (one commit):
- `git mv server.js → src/server/index.js`
- `git mv src/App.jsx → src/client/App.jsx`
- `git mv src/main.jsx → src/client/main.jsx`
- `git mv src/App.css → src/client/App.css`
- `git mv src/leaflet-loader.js → src/client/leaflet-loader.js`
- `git mv index.html → src/client/index.html`
- `git mv vite.config.js → src/client/vite.config.js`
- `git mv lib/notification-planner.js → src/server/notifications/planner.js`
- `git mv lib/notification-planner.test.js → src/server/__tests__/planner.test.js`
- `rmdir lib/`

**1.2 — Workspace package layout** (same commit or follow-up):
- Author `src/server/package.json` (express, node-cron, vitest, supertest, scripts: `start`, `dev`, `test`).
- Author `src/client/package.json` (preact, leaflet, vite, @preact/preset-vite, vitest, happy-dom, scripts: `dev`, `build`, `preview`, `test`).
- Rewrite root `package.json`: `private: true`, `workspaces: ["src/server", "src/client"]`, scripts that fan out (`dev` via `concurrently`, `build` → client only, `start` → server only, `test` via `--workspaces --if-present`). Keep `concurrently` as the only root devDep.
- `rm package-lock.json && npm install` from repo root — npm rebuilds the lockfile against the new workspace structure.

**1.3 — Path adjustments inside moved files:**
- `src/server/index.js`:
  - Update planner import: `'./notifications/planner.js'` (was `./lib/notification-planner.js`).
  - Replace path resolution that uses `__dirname + 'data/...'` with paths relative to the repo root via `__dirname + '../../data/...'` and the same for `dist/`. The server is invoked from `src/server/` (npm workspace cwd) but the runtime uses `__dirname` which now resolves to `src/server/`.
- `src/client/index.html`:
  - Already references `src/main.jsx` — update to `./main.jsx` (it's now a sibling).
- `src/client/vite.config.js`:
  - Add `build: { outDir: '../../dist' }`.
  - The `inlineMainCss` and `brotliPrecompress` plugins keep their logic — `closeBundle` walks `dist/` from the same working dir.
- `src/server/__tests__/planner.test.js`:
  - Update import path from `'./notification-planner.js'` to `'../notifications/planner.js'`.

**1.4 — Verification:**
1. `npm install` (root) — succeeds, no peer-dep warnings.
2. `npm test` (root) — runs planner tests (`vitest run` inside server workspace).
3. `npm run build` (root) — emits `dist/` at repo root.
4. `systemctl --user restart tesla-sweeper.service` — service starts clean.
5. `curl localhost:20040/healthz` — 200 with the expected JSON shape.
6. Browse `claw.bitvox.me/sweeper/` — page renders, map loads, OAuth start works.

**1.5 — Systemd unit update (deployment-only, lives in CLAUDE.local.md):**
The systemd `ExecStart` changes from `/usr/bin/node server.js` to `/usr/bin/npm run start --prefix /home/ec2-user/projects/tesla-sweeper` (or simpler: `/usr/bin/node src/server/index.js`). `WorkingDirectory` stays at the repo root.

If anything in 1.4 fails, revert and re-plan the failing piece. Don't proceed to phase 2 until 1.4 is green.

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

- **3a** Add `supertest` to `src/server/package.json` devDeps. `vitest` already declared in 1.2.
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

- **5a** Add `happy-dom` to `src/client/package.json` devDeps. Author `src/client/vitest.config.js` (or `test` block in `vite.config.js`) with `environment: 'happy-dom'` so JSX/DOM tests resolve.
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
- **Build pipeline changes**: with `index.html` + `vite.config.js` now under `src/client/`, Vite's `root` becomes `src/client/`. `build.outDir: '../../dist'` keeps the artifact at the repo root so the server's brotli middleware path doesn't change. Validated in Phase 1.4.
- **`__dirname` paths**: server modules currently use `dirname(fileURLToPath(import.meta.url))` for `data/` and `dist/`. After the move, `__dirname = src/server/`, so they need a `../..` prefix. Phase 1.3 patches them; missing one would silently write/read state to the wrong place.
- **`process.cwd()` vs `__dirname`**: when `npm run start -w @tesla-sweeper/server` is invoked, npm sets cwd to `src/server/`. Anything that read `./data/...` (cwd-relative) would now look in `src/server/data/`. Audit during 1.3 — current code uses `__dirname`, so we're safe, but a future add could regress. Document the convention in CLAUDE.md.
- **Workspace install gotchas**: the first `npm install` after wiring workspaces re-resolves the entire dep tree against the new manifests. Compatible deps hoist to root `node_modules/`; incompatible ones live in the workspace's `node_modules/`. Lockfile is regenerated. Acceptable for a single-developer repo; no point preserving the old lockfile.
- **Symlink trickery**: tempting but rejected. The repo restructure is the point; no compatibility shims at the old paths.
- **Stub vehicle test plan** + **notification scenarios doc** stay in `docs/` and don't move.
- **Nothing in `data/`, `dist/`, `keys/`, `node_modules/` moves.**
- **Live state migration**: none required. The on-disk `data/subscriptions.json` schema is unchanged.
- **Systemd unit**: `ExecStart` and `WorkingDirectory` need a one-line update — captured in CLAUDE.local.md as part of phase 1 deployment notes.

## Net diff estimate

- Phase 1: ~9 file moves + 3 new package.json files + lockfile regen + ~20 lines of path edits. One commit (or two — workspace setup as a follow-up if the move commit is already large).
- Phase 2: ~11 commits, ~1100 lines of `server.js` redistributed (no code changes besides moves + import wiring). New per-module overhead ~50 lines (export statements, file headers).
- Phase 3: ~6 new test files, ~400-600 lines of test code total.
- Phase 4: ~7 commits, ~850 lines of `App.jsx` redistributed. Same new-file overhead ~30 lines.
- Phase 5: ~6 new test files, ~300-400 lines.
- Phase 6: docs touch-ups, ~50 lines net.

Total: ~24-25 commits, additive surface ~1500 lines (mostly tests). Lockfile diff is large but ephemeral (regen artifact).

## Suggested execution cadence

If shipped in one sitting: ~4-6 hours of focused work. The natural breakpoints are after phases 1, 2, 3, 4. A reasonable split is "phase 1+2 today, phase 3 next session, phase 4+5 the session after that, phase 6 to wrap." Each phase is independently revertable; prefer a clean break over a rushed phase 5.
