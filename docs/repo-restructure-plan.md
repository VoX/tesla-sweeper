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

**`src/server/package.json`** (Phase 1.2 — `vitest` only; `supertest` lands in 3a, `happy-dom` is client-only):

```json
{
  "name": "@tesla-sweeper/server",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "index.js",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "node --watch index.js",
    "start": "node index.js",
    "test": "vitest run"
  },
  "dependencies": { "express": "^4.21.0", "node-cron": "^4.2.1" },
  "devDependencies": { "vitest": "^4.1.5" }
}
```

`engines.node: >=22` pins because `node --watch` graduated from experimental in Node 22 LTS. `supertest` is added in Phase 3a, not here, so the workspace is still installable before tests are written.

**`src/client/package.json`** (Phase 1.2 — `vitest` only; `happy-dom` lands in 5a):

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
    "vitest": "^4.1.5"
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

**1.3 — Path adjustments inside moved files** (every `__dirname`-relative path needs review; missing one silently writes/reads to the wrong place):

`src/server/index.js`:
- Line ~7: planner import becomes `'./notifications/planner.js'` (was `./lib/notification-planner.js`).
- Line ~13 (`.env` loader): change `join(__dirname, '.env')` → `join(__dirname, '..', '..', '.env')`. Currently the try/catch swallows ENOENT silently, so a missed patch produces an empty-secrets server that boots but rejects every Tesla/Slack call — verify in 1.4.
- Line ~111 (`SUBS_FILE`): change `join(__dirname, 'data', 'subscriptions.json')` → `join(__dirname, '..', '..', 'data', 'subscriptions.json')`. Same for the `data/` dir mkdirSync.
- Line ~983 (brotli middleware `dist/` lookup): patch.
- Line ~988 (`express.static(join(__dirname, 'dist'))`): patch.
- Line ~989 (SPA catch-all `sendFile(join(__dirname, 'dist', 'index.html'))`): patch.
- (After phase 2c, `SUBS_FILE` lives in `src/server/store/subscriptions.js` — that's `__dirname + '../../../data/...'` from there. Phase 2c must update accordingly. Same applies to anything else that ends up in a deeper nested module.)

`src/client/index.html`:
- Line ~13: `<script type="module" src="/src/main.jsx">` → `<script type="module" src="./main.jsx">` (drop the leading slash; the file is now a sibling).

`src/client/vite.config.js`:
- Add `root: '.'` (explicit, since the config now sits inside the new client root).
- Add `build: { outDir: '../../dist', emptyOutDir: true }`. The `emptyOutDir: true` is **required** because Vite refuses to clear an outDir that sits outside `root` without it; without the flag, stale artifacts would accumulate.
- **Patch the `brotliPrecompress` plugin**: current implementation reads `join(process.cwd(), 'dist')`, which after the move resolves to `src/client/dist/` (wrong). Either (a) capture the resolved path via the `configResolved` hook and use `config.build.outDir`, or (b) switch to `path.resolve(__dirname, '..', '..', 'dist')`. (b) is simpler and matches the `outDir` we just declared.
- The `inlineMainCss` plugin reads from the in-memory `bundle` map and writes via the `transformIndexHtml` hook — no path arithmetic. Confirmed unaffected.

`src/server/__tests__/planner.test.js`:
- Update import path `'./notification-planner.js'` → `'../notifications/planner.js'`.

**1.4 — Verification checklist** (all must be green before proceeding to Phase 2):
1. `rm -rf node_modules package-lock.json src/*/node_modules` then `npm install` from root — succeeds, lockfile rebuilt, no peer-dep warnings, no nested `node_modules` polluting commits (check `git status`).
2. `npm test` from root — planner tests pass (vitest in the server workspace).
3. `npm run build` from root — `dist/` emits at repo root with `.br` siblings; brotli files are non-empty (`ls -la dist/assets/*.br`).
4. `npm run start` from root in a fresh shell — server boots, no `[boot] SESSION_HMAC_KEY unset` warning (confirms `.env` loaded), no `[store] parse failed` (confirms `data/` resolved), no 404 on the SPA catch-all (confirms `dist/` resolved).
5. `curl localhost:20040/healthz` — 200 with `{ok, last_run_at, last_digest_run_at, sub_count}`.
6. `curl https://claw.bitvox.me/sweeper/` — 200, HTML body references `./assets/...` paths that resolve.
7. Browser smoke: page renders, map renders, OAuth start button initiates the Tesla redirect.

If any step fails, revert the phase-1 commits and re-plan the failing piece. Don't proceed to Phase 2 until 1.4 is green.

**1.5 — Systemd unit update** (deployment-only; tracked in CLAUDE.local.md):

Two viable forms — pick exactly one and commit alongside the move so a `git revert` of the move also reverts the unit-file change atomically:

```ini
# Option A — invoke node directly, anchor cwd at repo root
WorkingDirectory=/home/ec2-user/projects/tesla-sweeper
ExecStart=/usr/bin/node src/server/index.js
```

```ini
# Option B — invoke npm via workspace
WorkingDirectory=/home/ec2-user/projects/tesla-sweeper
ExecStart=/usr/bin/npm run start -w @tesla-sweeper/server
```

Both leave `WorkingDirectory` at repo root so the `__dirname + '../../...'` arithmetic patched in 1.3 reaches `data/` and `dist/` correctly. **Option A is recommended** — fewer moving parts, no implicit `npm` dependency in the boot path. Option B is useful only if a future hook needs to run as part of the start command.

After editing the unit: `systemctl --user daemon-reload && systemctl --user restart tesla-sweeper.service`. Watch `journalctl --user -u tesla-sweeper -f` for the boot lines.

**Rollback**: `git revert <move-commit>`, restore the prior unit file from systemd's last-known-good (or from CLAUDE.local.md history), `daemon-reload`, restart.

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

All test files live in `src/server/__tests__/` (matches the planner test moved in Phase 1).

- **3a** Add `supertest` to `src/server/package.json` devDeps + `npm install`. No vitest config needed for server-only tests; default `environment: 'node'` is correct.
- **3b** `__tests__/store.test.js` — atomic write, corruption-aside, patchSub re-read pattern.
- **3c** `__tests__/crypto.test.js` — HMAC sign/verify happy + tampered + expired + missing-key.
- **3d** `__tests__/sweep.test.js` — mock `nominatim.js` + `recollect.js` + `overpass.js` modules; assert end-to-end output shape and message templates for each sweep-status branch.
- **3e** `__tests__/routes.test.js` — supertest against `app.js`. Mock external integrations. Cover `/api/check` 401 path, `/api/notifications/enable` HMAC gate, `/api/notifications/run` bearer gate, `/healthz` shape. **Depends on Phase 2j+2k landing first** — `app.js` must exist and export the constructed Express app for supertest to import. Don't author 3e until 2k is committed.
- **3f** `__tests__/notifications-cron.test.js` — runNotifications with stub vehicle path, mode validation throw, single-flight cross-mode throw, last_dm_date dedup. Mock `postSlackDM` + tesla/recollect modules.

3a-3d can land in parallel with Phase 2 once their respective module is extracted. 3e specifically gates on 2k. Aim for every server module to have at least one test file. Skip 100% coverage chasing.

### Phase 4 — Client decomposition

Each subphase = one commit, with `npm run build` + visual smoke test in the browser before moving on. The target tree's "App.jsx ~150 lines" assumes Phase 4 is complete; until then App.jsx remains its full ~853 lines.

- **4a** `src/client/lib/{cache,slack-input,date}.js`
- **4b** `src/client/components/{StatusBox,Row}.jsx` (smallest)
- **4c** `src/client/components/MapView.jsx` (largest non-orchestrator chunk)
- **4d** `src/client/components/SideDetectionCard.jsx`, `SweepResults.jsx`
- **4e** `src/client/components/LocationResultsView.jsx` (imports 4c + 4d)
- **4f** `src/client/components/NotificationsPanel.jsx`
- **4g** Final orchestrator pass on `App.jsx` — by this point most components have been moved out, but App.jsx still contains imports + state + tab routing + OAuth callback handling. The 4g commit deletes any now-dead inline component definitions, re-organizes imports, and confirms App.jsx is ~150 lines as targeted. Keep `App.css` whole; per-component CSS-split is **out of scope** unless a component naturally has lots of one-off styles.

### Phase 5 — Client tests

All test files live in `src/client/__tests__/`.

- **5a** Add `happy-dom` to `src/client/package.json` devDeps. Add a `test` config block to `src/client/vite.config.js` (no separate `vitest.config.js` needed; vitest reads vite's config when colocated) with `test: { environment: 'happy-dom' }` so component tests resolve the DOM.
- **5b** `__tests__/cache.test.js` — versioning, expiry, malformed JSON.
- **5c** `__tests__/slack-input.test.js` — parses `<@U…|name>` markup, raw `U…`, mention-text, fallback.
- **5d** `__tests__/MapView.test.jsx` — renders given coords, popup label appears, draggable mode wires onPinMove.
- **5e** `__tests__/LocationResultsView.test.jsx` — gates on data presence, renders sweep + side-detection sub-cards.
- **5f** `__tests__/NotificationsPanel.test.jsx` — wires Slack sign-in, slack-id validation, enable/disable buttons.

### Phase 6 — Final cleanup

**6.1 — Doc sweep** (one commit covering all docs):
- `README.md`: update line ~7 (mentions `server.js`), Stack section (~36-38), npm-script examples (~44-55) — replace with workspace-aware commands (`npm install`, `npm run dev`, `npm run build`, `npm run test`).
- `CLAUDE.md`: update line ~7 (`server.js`), line ~8 (`src/App.jsx`, `src/leaflet-loader.js`), line ~86 (`src/leaflet-loader.js` reference), lines ~87-88 (vite plugin locations), lines ~113-117 (npm scripts).
- `CLAUDE.local.md`: line ~14 (`node server.js`), line ~37 (`lib/notification-planner.js` reference), line ~48 (build+restart command), line ~53 (`npm test … planner only` — will run all workspace tests now), and the systemd unit snippet from Phase 1.5.
- `docs/notification-scenarios.md`: every reference to `lib/notification-planner.js` and `server.js` needs updating to the new paths (`src/server/notifications/planner.js`, `src/server/index.js` or the specific module from Phase 2).
- `docs/stub-vehicle-plan.md`: same — references to `server.js` (lines ~23, ~63, ~76, ~96, ~166, ~220) and `src/App.jsx` (lines ~167, ~221).
- Grep gate: `grep -rE 'lib/notification-planner|^server\.js|src/App\.jsx' README.md CLAUDE.md CLAUDE.local.md docs/` returns nothing stale.

**6.2 — Done checklist** (must be all-green to call the restructure complete):
1. `npm install && npm run build && npm test` clean from root.
2. No `lib/` directory at repo root; no top-level `server.js`; no top-level `vite.config.js` or `index.html`.
3. `src/server/index.js` is ≤ 50 lines (entry only — config load, app build, cron start, listen, recover).
4. `src/client/App.jsx` is ~150 lines (orchestrator; no inline component definitions).
5. Every server module (`store`, `crypto/*`, `integrations/*`, `sweep/check`, `notifications/{planner,cron}`, `routes/*`) has at least one test file.
6. Every client component file (`components/*.jsx`, `lib/*.js`) used by the load-bearing flows has at least one test file (smoke tests for the rest are okay).
7. `systemctl --user restart tesla-sweeper.service` succeeds; `/healthz` returns 200; `journalctl --user -u tesla-sweeper -f` shows no startup warnings.
8. Browser smoke at the live URL: page renders, OAuth start works, manual-tab pin drag triggers a sweep check, side-detection card populates.

**6.3 — Tag** (optional): `git tag v2.0.0-restructure` so the boundary between pre/post-restructure is marked in history.

## Live deployment migration (operator runbook)

1. **Pre-pull**:
   ```bash
   sudo systemctl --user --full -l status tesla-sweeper.service       # capture current unit
   cp data/subscriptions.json data/subscriptions.json.pre-restructure  # backup
   ```
2. **Pull + install**:
   ```bash
   git pull origin main
   rm -rf node_modules package-lock.json src/*/node_modules
   npm install
   npm run build
   ```
3. **Update systemd unit** (Phase 1.5, Option A recommended):
   ```bash
   systemctl --user edit --full tesla-sweeper.service   # replace ExecStart, keep WorkingDirectory at repo root
   systemctl --user daemon-reload
   ```
4. **Restart + verify**:
   ```bash
   systemctl --user restart tesla-sweeper.service
   journalctl --user -u tesla-sweeper -f                # watch boot lines
   curl localhost:20040/healthz                          # 200 with last_run_at populated
   ```
5. **Rollback path** (if anything's wrong):
   ```bash
   git revert HEAD          # revert the move commit
   systemctl --user edit --full tesla-sweeper.service   # restore prior ExecStart
   systemctl --user daemon-reload
   systemctl --user restart tesla-sweeper.service
   cp data/subscriptions.json.pre-restructure data/subscriptions.json   # if needed
   ```

The shared host runs `tinyclaw.service` and other bot units alongside `tesla-sweeper.service`; only the sweeper unit is touched.

## Test strategy details

- **External APIs are never hit in tests.** All Tesla / Recollect / Nominatim / Overpass / Slack calls go through their respective integration module, which tests mock with vitest's `vi.mock()` or by passing dependency-injected fetchers.
- **Real fixtures:** capture one real Recollect events response, one real Overpass response, into `__tests__/fixtures/`. Use them in `sweep/check.test.js` so the test exercises the full parser.
- **Supertest** for routes — start the express app in-process, no port binding. Faster than nock-based.
- **No snapshot tests.** Snapshots invite "update the snapshot to make it pass" failure mode.
- **Coverage target: ~70% on critical paths** (sweep, planner, store, crypto, routes), no target on glue code.

## Risks / out-of-scope

- **CSS split** is explicitly out of scope. `App.css` stays whole at first; per-component CSS modules can come later if a component grows large enough to need them.
- **`src/shared/` workspace** is explicitly NOT being created. Values like `STUB_VEHICLE_ID`, default coords, `sweep_event` shape, and the status enum stay duplicated between client and server. Deduplication is a follow-up if the duplication starts hurting.
- **Build pipeline changes**: with `index.html` + `vite.config.js` now under `src/client/`, Vite's `root` becomes `src/client/` (declared explicitly per 1.3). `build.outDir: '../../dist'` keeps the artifact at the repo root; `emptyOutDir: true` is required to opt into clearing an outDir outside `root`. Validated in Phase 1.4.
- **`__dirname` paths**: server modules currently use `dirname(fileURLToPath(import.meta.url))` for `.env`, `data/`, and three `dist/` call sites (brotli middleware + static + SPA catch-all). After the move, `__dirname = src/server/`, so they need a `../..` prefix. **After Phase 2c**, `SUBS_FILE` lives in `src/server/store/subscriptions.js` and needs `../../../data/...` (three levels). Phase 1.3 enumerates the four lines in `index.js`; phase 2c re-validates the deeper nesting.
- **`process.cwd()` vs `__dirname`**: cwd under `npm run start -w` is `src/server/`. Code that reads `./data/...` (cwd-relative) would resolve into `src/server/data/`. Current code uses `__dirname` exclusively, so we're safe — but if a future module ever introduces a cwd-relative path, it'll silently write to the wrong place. Convention noted in CLAUDE.md after the move.
- **Brotli plugin path is currently `process.cwd()`-based** (vite.config.js:~47 uses `join(process.cwd(), 'dist')`, not `__dirname`). Phase 1.3 patches this to `path.resolve(__dirname, '..', '..', 'dist')` (or the resolved `outDir` from a `configResolved` hook). The `inlineMainCss` plugin reads from the in-memory bundle map and writes via `transformIndexHtml` — no path arithmetic, unaffected.
- **Workspace install gotchas**: the first `npm install` after wiring workspaces re-resolves the entire dep tree against the new manifests. Compatible deps hoist to root `node_modules/`; incompatible ones live in the workspace's `node_modules/`. Lockfile is regenerated. The root `.gitignore` already has `node_modules/` (matches at any depth) so nested `node_modules/` won't slip into commits. Acceptable for a single-developer repo; no point preserving the old lockfile.
- **CI**: there is no CI configured today — no `.github/workflows`, no `.gitlab-ci.yml`. Nothing to migrate. If CI is added later, it should `cd` to repo root and run `npm install && npm run build && npm test`.
- **Symlink trickery**: tempting but rejected. The repo restructure is the point; no compatibility shims at the old paths.
- **Stub vehicle test plan** + **notification scenarios doc** stay in `docs/` and don't move. Phase 6.1 updates path references inside them.
- **Nothing in `data/`, `dist/`, `keys/`, `node_modules/` moves.**
- **Live state migration**: none required. The on-disk `data/subscriptions.json` schema is unchanged.
- **Systemd unit**: `ExecStart` updated per Phase 1.5; `WorkingDirectory` stays at repo root so `__dirname` arithmetic reaches `data/` and `dist/`.

## Net diff estimate

- Phase 1: ~9 file moves + 3 new package.json files + lockfile regen + ~25 lines of path edits + brotli plugin patch + systemd unit update. 1-2 commits.
- Phase 2: 11 commits (2a-2k), ~1100 lines of `server.js` redistributed (no code changes besides moves + import wiring). New per-module overhead ~50 lines (export statements, file headers).
- Phase 3: 6 commits (3a-3f), ~6 new test files, ~400-600 lines of test code total.
- Phase 4: 7 commits (4a-4g), ~850 lines of `App.jsx` redistributed. Same new-file overhead ~30 lines.
- Phase 5: 6 commits (5a-5f), ~6 new test files, ~300-400 lines.
- Phase 6: 1-2 commits — doc sweep + optional tag.

Total: 32-34 commits, additive surface ~1500 lines (mostly tests). Lockfile diff is large but ephemeral (regen artifact).

## Suggested execution cadence

If shipped in one sitting: ~4-6 hours of focused work. The natural breakpoints are after phases 1, 2, 3, 4. A reasonable split is "phase 1+2 today, phase 3 next session, phase 4+5 the session after that, phase 6 to wrap." Each phase is independently revertable; prefer a clean break over a rushed phase 5.
