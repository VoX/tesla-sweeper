# Tesla Sweeper — Improvement Proposals

**Date:** 2026-06-12 · **Method:** 9-dimension parallel agent review (ultracode, ~865k subagent tokens, 76 raw findings) followed by an operator verification pass — every load-bearing claim below marked VERIFIED was checked against the actual code/config by hand. Commissioned by VoX.

**Scope reality check:** this is a personal tool with two users on a shared box. Findings are calibrated to that — the bar is "prevents a ticket, doesn't lose a token, doesn't embarrass us", not enterprise readiness.

---

## Operator triage — the short list

### A. Verified bugs — fix now, all small

1. **Every styled cron DM renders broken** — planner writes Slack mrkdwn (`*bold*`, `:emoji:`, `<links>`), `postSlackDM` sends `mrkdwn:false` (my May hardening). Kit's sweep alerts show literal asterisks/angle-brackets. Fix: `mrkdwn:true` + escape only the untrusted substrings (vehicle name, addresses). _(product)_
2. **Rate-limit bypass via X-Forwarded-For spoofing** — `ratelimit.js` trusts the FIRST XFF hop; Caddy appends the real client IP LAST. Take the last entry. _(security, my bug)_
3. **`/api/reverse-geocode` has no rate limit** — missed it while limiting its two siblings in the same file; floods share the cron's own Nominatim queue. One line. _(security, my miss)_
4. **No season gate** — the cron force-wakes the car daily Jan–Mar for a sweeping season that runs Apr 1–Dec 31, and sends ~13 pointless winter digests. Calendar-gate the per-sub loop. _(product)_
5. **Failure classes flattened** — `RevokedError/ConfigError/TransientError` all feed one streak counter and one "re-enable at sweeper.bitvox.me" DM; a transient Tesla/OSM outage tells kit to redo OAuth for nothing. Class-aware streaks: re-auth DM only for revoked/config, operator DM for transient. _(product + arch, same fix)_
6. **`/healthz` is write-only** — nothing polls it, so the DM-health fields shipped this week alert nobody. **Action accepted: tinyclaw adds it to her daily morning-rounds cron** — no sweeper changes needed. _(hosting)_

### B. Product decisions for VoX + kit (design-level, not bugs)

- **The noon snapshot is the weak link** (two P1s): a car that's out at noon = silent no-DM day; there's no day-of last call before the 8AM sweep. Endorsed shape: move/add an **evening (~9pm) run** with plan-aware dedup, plus a **7am day-of check gated to event days only**. Battery cost stays flat if paired with the season gate.
- **`/sweep` slash command** — on-demand "am I safe parked here?" from Slack at the actual decision moment. The sub record already binds slack_user_id → vehicle; the dedicated Slack app makes the signing-secret flow clean. Also the natural mitigation for the noon-snapshot gaps.
- **DM cadence**: 3 near-identical DMs per event (days 3/2/1). Cheapest fix: days 3 + 1 with distinct framing ("heads-up" vs "LAST CALL").
- **ICS export** as a DM-independent backup channel — the DM path has already failed silently once in this app's short life.

### C. Hardening & ops (when convenient)

- **Backup posture** (owner call, repeated from fat review but now with the full set): the unrecoverable files are `data/users.json`, `data/slack-install.json`, `.env`, **and `keys/private-key.pem`** (Tesla command-signing key, single copy, born Apr 19). One nightly age-encrypted tarball to anywhere off-box closes it.
- `MemoryMax=` on the unit — shared box with real OOM precedent (dweller, 2026-05-28).
- Boot-recovery crash-loop: `Restart=on-failure` + boot-time recovery can hammer OSM with cold caches in a loop; add `RestartSec`/backoff or a recovery cooldown file.
- Deploy is an undocumented two-step building into live `dist/`; document the order, or build-to-temp-then-swap.
- BFF session cookie has no server-side expiry (signed value valid until explicit logout); stamp `minted_at` on the record and reject after ~30d.
- Version visibility: no tags, everything 1.0.0, no build identity in `/healthz`. Stamp a git short-hash at build/deploy.
- vite 5 (EOL) vs vitest-4-bundled vite 8 alignment — known item, now with the concrete upgrade path from the repo reviewer.
- Minimal CI: one ~15-line workflow (npm ci + test + build) — pays for itself the first time a green local lies.

### D. Docs & repo hygiene

- **README cold-start is broken**: references a `.env.example` that never existed; env table + token sections still describe the pre-BFF world.
- **Committed `CLAUDE.md` is stale on ~7 load-bearing claims** including the security model (VERIFIED — it predates the BFF migration). Agents (me included) read these files as ground truth; this one actively misleads.
- Plan docs in `docs/` need lifecycle headers (SHIPPED/SUPERSEDED + date); CLAUDE.local.md ops table still points at legacy `subscriptions.json` and a failing list-subscriptions one-liner.
- `engines` only declared in the server workspace — declare at root so old node fails fast.

### E. Tests — the three that matter (reviewer-named, operator-endorsed)

1. **`parseSweepFlags`** — the only parser of live Recollect data, zero tests, every suite mocks it. The arch finding on silent-SAFE schema drift lands exactly here; fixture-test it against captured real payloads, and make zero-events-parsed distinguishable from no-sweeping.
2. **`maybeRecoverMissedRun`/`maybeRecoverMissedDigest`** — the missed-noon safety net has never been executed by a test.
3. **DM-failure bookkeeping** — nothing proves `last_dm_error` is written or a failed DM retries next day; this is the regression test for the May silent-breakage incident.
- Also: the BigInt-id test is vacuous (mock uses a precision-safe id); client `--passWithNoTests` turns "zero tests collected" green; cron tests derive 'today' from the real clock at module scope (DST/timezone flake).

### F. UX & visual — quick wins vs needs-a-decision

**Quick wins (S each):** clear manual-tab errors on tab switch (they currently leak into the Tesla tab); stop double-reporting via toast+inline; fix the ~2.2:1 contrast on other-side schedule text; badge stale cached positions with their age; fix the sign-out toast pointing at a panel that no longer exists; add apple-touch-icon (a parking tool lives on phone home screens); stop using link-blue for headings; de-triplicate the three identical full-width green buttons.
**Needs an owner taste call:** desktop layout anchoring (content floats in a void at 1280px), tab renaming ('Tesla Login'/'Manual' → destination names), emoji-as-iconography on an OAuth trust page, dark map tiles vs the bright default OSM embed, surfacing the Slack-pings pitch above the fold (it IS the product and it's invisible on first visit).

### Explicitly downgraded by operator (with reasons)

- *Slack HMAC token in GET query* — neither express nor Caddy logs URLs on this box; leak surface is the user's own browser history. Move to a header opportunistically.
- *Tesla id_token unverified `sub`* — same transport-trust model the Slack handler had; claims checks are cheap symmetry, not urgent.
- *Playwright e2e* — reviewer himself concluded skip it; a supertest contract test covers the actual risk (client↔server drift). Agreed.
- */healthz info disclosure* — `sub_count: 2` and slack error strings; accepted exposure at this scale.

---

## What's genuinely good (so we don't refactor it away)

- The planner's scenario taxonomy is genuine domain modeling, not naive alerting: same-day-stagger, tight-flip, imminent-opposite, opposite-already-swept (src/server/notifications/planner.js classifyWeek + docs/notification-scenarios.md) — DMs tell the user WHERE to move and HOW LONG they're safe ('Move to ODD by Tue night, then back by Thu evening'), which is the actual job of an odd/even-flip parking assistant. _(product)_
- Honest-UX disclosure throughout: when the exact address isn't in Recollect and a same-parity neighbor's schedule is substituted, the DM footer says so (planner.js footer() nearestNote; check.js nearestSameSideAddress) — the system never silently presents inferred data as ground truth, and unknown-side plans punt to the app instead of guessing. _(product)_
- Operational self-awareness unusual for a 2-user tool, visibly shaped by a real postmortem: boot-time missed-run/missed-digest recovery (cron.js maybeRecoverMissedRun/Digest), per-sub failure streaks with cooldown-limited stuck DMs, and DM-delivery health tracked separately from check health in /healthz (verified live: last_dm_success_at/last_dm_error fields present). _(product)_
- The manual pin-drag tab is a smart zero-auth value path: anyone can check any Somerville address through the exact same sweep+side pipeline as the Tesla flow, doubling as a permanent QA surface for the OSM side-detection logic. _(product)_
- The slow-wake UX is genuinely well handled: the 7s timer flips 'Checking...' to 'Waking your car... (up to 60s)' (App.jsx:399-410), and post-OAuth it pre-announces '✅ Connected — waking your car (up to 60s)...' — exactly the right treatment for Tesla's worst latency case, and the waking semantics (never silently wake on passive page load, only on explicit click or fresh OAuth) respect the battery. _(ux)_
- The check cache is correctness-aware in a way most apps never bother with: cacheBasis() stamps day + am/pm so a cached verdict can't survive past the noon sweeping boundary (cache.js), instead of a naive TTL that would happily show last night's 'safe' at 7am on sweep day. _(ux)_
- Error copy on the Slack-enable path is preflighted into instructions instead of opaque 403s — 'Your Slack session expired (or you haven't signed in this visit). Click "Sign in with Slack"... then Enable' (App.jsx:179-194) names the exact recovery action, and the panel distinguishes signed-in / expired-session / never-signed-in states with distinct copy (NotificationsPanel.jsx). _(ux)_
- Solid accessibility bones where they count: danger StatusBox gets role=alert + aria-live=assertive while lesser statuses stay polite (StatusBox.jsx), tabs carry role/aria-selected with focus-visible styles throughout (App.css), the error box is dismissible with an aria-label, and the 390px layout is a clean single column with full-width 44px+ touch targets and no horizontal scroll. _(ux)_
- Disciplined, coherent dark palette: the whole UI is built from GitHub-dark tokens (#0d1117/#161b22/#30363d/#8b949e/#58a6ff/#238636/#f85149/#d29922) and the status-box system (App.css:18-21) uses proper bg/border/text triads per severity — the color system itself needs no rework, only role separation for blue. _(visual)_
- The stylesheet is a single tight 47-line App.css that Vite inlines into index.html (verified live) — zero render-blocking CSS request, system font stack, no webfont bloat; first paint is essentially free. _(visual)_
- Leaflet is lazy-loaded behind page-load + idle callback with a retry-friendly cache and a styled in-place error fallback (leaflet-loader.js, MapView.jsx:79-87) — the 152KB map chunk never taxes the landing view, and a chunk 404 degrades gracefully instead of blanking the card. _(visual)_
- Mobile composition is genuinely good: at 390px (sweeper-ui-mobile.png) the column, tabs, CTA and footer all sit correctly with no overflow, plus viewport-fit=cover and theme-color matching the page background — the phone experience (the one that matters for this tool) already looks intentional. _(visual)_
- The Tesla token broker (src/server/integrations/tesla-auth.js) is genuinely well-engineered for this scale: per-user single-flight dedupes cron-vs-browser refreshes, the RevokedError/ConfigError/TransientError taxonomy is correct, the rotated refresh_token is persisted before returning, and caching the access_token in users.json (not just memory) means restarts and crash loops don't churn refresh-token rotations — a real strand-prevention property. _(arch)_
- The JSON store is race-safe by construction, not by luck: every read-modify-write in store/users.js (patchUser/createUser/saveStore/pruneOrphaned) is fully synchronous with no await inside, so it's atomic under single-threaded node, and patchUser re-loads to avoid clobbering cross-await staleness from the cron's long run loop. Atomic temp+fsync+rename plus directory fsync, corrupt-file move-aside, and the fail-loud legacy migration show consistent care for token durability. _(arch)_
- Boot ordering quietly prevents the classic double-instance disaster: startNotificationCron and the recovery calls only run inside the successful listen() callback (src/server/index.js:19-28), so an accidentally hand-started second copy dies on EADDRINUSE before it can double-DM or fight the systemd instance over refresh-token rotation; the sequential await of run-then-digest recovery also correctly respects runNotifications' cross-mode single-flight. _(arch)_
- Operational lessons are encoded in the architecture, not just in memory: DM-delivery health is tracked separately from check health (the May 2026 rotated-Slack-token failure mode), postSlackDM is total so one network throw can't abort remaining subs' DMs, and the DM footer discloses when a neighbor's schedule is being substituted for an unindexed address — honest failure surfacing all the way to the end user. _(arch)_
- Comment quality is genuinely exceptional — comments carry the why, not the what: OSM rate-limit compliance rationale (src/server/integrations/nominatim.js:1-8), crash-on-uncaught justification (src/server/index.js:12-14), the cache-basis day/noon staleness reasoning (src/client/lib/cache.js:10-13), and security tradeoffs argued inline (routes/oauth.js:118-122, routes/session.js:37-50). A new maintainer can reconstruct design intent from the source alone. _(code)_
- Disciplined layering for an app this small: routes → integrations → store/util holds almost everywhere, and the RevokedError/ConfigError/TransientError taxonomy in integrations/tesla-auth.js:29-38 gives routes and cron one shared failure classification instead of scattered status-code matching — the two boundary slips called out above stand out precisely because the rest is clean. _(code)_
- Error-shape and fetch discipline is uniform: every endpoint returns { detail }, the single client wrapper (src/client/lib/api.js) attaches .status so callers branch on 401 without string-matching, and every outbound call goes through fetchWithTimeout (src/server/util/fetch.js) so no integration can hang the process. _(code)_
- Test seams are explicit and honest: _resetInFlight (tesla-auth.js:148), _resetSideCache (overpass.js:176), _resetStateStore (oauth-state.js:36), and the SWEEPER_DATA_DIR override are all labeled as test hooks rather than left as mysterious exports, and most server modules stay under 100 lines with one job each. _(code)_
- Secrets hygiene is genuinely clean and verified deep: .gitignore covers .env/data/keys/dist/CLAUDE.local.md, `git log --all --diff-filter=A` across .env, data/*, keys/*, *.pem returns nothing (no secret has EVER been committed), and on-disk modes are right (.env 0600, keys/private-key.pem 0600, data/ 0700 with 0600 files). _(repo)_
- The workspace layout is textbook for the size: one root lockfileVersion-3 lockfile, deps placed exactly where used (express/node-cron/cookie-parser in server, preact/leaflet in client, shared vitest+concurrently hoisted at root), root scripts fan out cleanly, and `npm ls` resolves with zero invalid/missing entries. _(repo)_
- Commit history is unusually disciplined for a personal tool: scoped imperative messages with explicit review-fold commits ('fat review: harden DM path...', 'fold 2+2 review findings...'), clean working tree, main in sync with origin. _(repo)_
- Why-comments at decision points are excellent — the root vitest.config.js header documents the exact failure mode it prevents, src/server/config.js explains its import-order contract, and store/slack-install.js records the May 2026 shared-token breakage that motivated the file-first design. The repo explains itself even where the README has drifted. _(repo)_
- Deployment fundamentals are verifiably right: server binds 127.0.0.1:20040 explicitly (index.js:19) behind Caddy with HSTS; .env is 600, data/ is 700 with 600 files, keys/private-key.pem is 600; linger is enabled and the unit is enabled, so it survives reboots and logouts. _(hosting)_
- Crash semantics are deliberate and coherent end-to-end: uncaughtException exits 1 into Restart=on-failure/RestartSec=5, store writes are atomic open+fsync+rename, and boot runs missed-run/missed-digest recovery with an explicit cross-mode overlap guard (index.js:25-28) — a restart at 12:30pm doesn't eat the day's notification. _(hosting)_
- Log discipline is genuinely good for journald-only: tagged breadcrumbs ([cron] per-run summary with dm_sent/dm_dup/dm_fails counts, [vehicles], [store], [fallback]) on a persistent journal currently retaining back to mid-April (~2 months, 127MB user journal under default caps) — incident archaeology actually works here. _(hosting)_
- There is already a real automated daily ops loop on this box (morning-rounds at 10:00 UTC: service is-active, endpoint status codes including the 308 redirect contract, cert expiry, disk/memory; plus a separate daily patch-survey job that correctly classifies node updates as restart-sensitive) — unusual maturity for a 2-user tool, and it gives every monitoring suggestion above a free place to live. _(hosting)_
- planner.test.js is genuinely excellent: all nine classification classes, precedence rules (same-day-stagger over both-sides over triple-flip), odd/even symmetry, the dispatch window table, and DM copy regression tests — including a named real-world case ('the VoX case') and a documented pre-fix bug reproduction (triple-flip anchor, lines 175-184). _(tests)_
- Server HTTP tests run the real express app against a real on-disk store in throwaway tmpdirs (session-routes.test.js, routes.test.js, install.test.js) and hit the security edges that matter: forged/tampered cookies, cross-record disable attempts, replayed one-shot OAuth states, foreign-workspace install tokens, type-tagged state confusion between the Tesla and Slack flows. _(tests)_
- The suite functions as an incident ledger: tests encode why they exist (slack.test.js's postSlackDM-totality rationale from a review finding, crypto.test.js's bit-flip flake explanation with the exact 1/16 failure odds of the old approach, routes.test.js's NaN-cache-pollution note). That discipline is rare at any scale, let alone a two-user tool. _(tests)_
- Consistent, deliberate mock seams: external HTTP is mocked at exactly one boundary (util/fetch.js or globalThis.fetch) while the integration logic itself gets real tests (overpass side-cache + retry + don't-cache-unknown, nominatim house-number normalization for two-family/range/suffix formats, recollect cross-municipality filtering). _(tests)_
- Solid BFF token hygiene: the Tesla refresh_token never leaves the server, the browser holds only an HttpOnly+Secure+SameSite=Lax signed opaque cookie (util/session.js), and response DTOs redact tokens (publicUser in store/users.js, /session/me in routes/session.js return only slack_user_id/vehicle fields). Logout best-effort revokes the refresh_token at Tesla when no sub needs it. _(security)_
- Clean XSS posture across the SPA: zero dangerouslySetInnerHTML/innerHTML anywhere in src/client, the Leaflet popup builds DOM via createTextNode/textContent so attacker-controlled OSM/Recollect street strings can't break out (components/MapView.jsx:56-62), and Slack DMs are posted with mrkdwn:false to defang user-supplied vehicle names/addresses (integrations/slack.js:30). _(security)_
- Careful crypto/auth primitives: constant-time comparison with explicit byte-length guards on both the bearer check (crypto/bearer.js) and HMAC verify (crypto/session.js), a typed one-shot OAuth `state` registry with TTL + hard cap (util/oauth-state.js), the Slack id_token pins iss+aud+exp, and the install flow enforces a workspace team pin (routes/oauth.js:88, SLACK_TEAM_ID confirmed set). _(security)_
- Good secrets-at-rest discipline: .env, data/ (users.json, slack-install.json) and keys/ are all gitignored and the live files are mode 0600 owner-only; the only store/* file in git is source, not data. On-disk writes are atomic with temp+fsync+rename plus a directory fsync, and corrupt files are moved aside rather than nuked (store/users.js). _(security)_

---

## Appendix — full findings by dimension

Raw reviewer output, lightly deduplicated, with operator notes where I verified or disagreed. Severity P0–P3 · Effort S/M/L · Confidence h/m/l.

### Product design

#### [P1·M·h] Daily check samples car location at noon — the worst time to predict where it sleeps tonight; off-Somerville days are silently skipped

The whole notification pipeline keys off wherever the car is at exactly 12:00 ET (src/server/notifications/cron.js:194). If the car is at an office, garage, or anywhere outside Somerville at noon, src/server/sweep/check.js:29-31 returns found:false, which sets ok:true/plan:null in cron.js:112-115 — no DM, no failure counted, consecutive_failures resets, totally silent. Tickets are issued for where the car parks OVERNIGHT (sweeping is 8AM-12PM), so any commute/errand routine turns sweep-eve into a no-DM day with zero trace. Same hole hits the Sunday 8PM digest: car out at dinner = that week's digest silently skipped, no retry. Note last_dm_date dedup (cron.js:125) is date-only, so a naive second run can't correct a stale plan either.

**Suggestion:** Add an evening run (~21:00 ET, cars are home) alongside or instead of noon in startNotificationCron, and make the dedup key plan-aware (date + plan class + primaryEvent.date instead of bare last_dm_date) so the evening run re-DMs only when the plan actually changed. Also retry once at 21:00 when the noon run got found:false for a sub.

> **Operator note (tinyclaw):** Sound product critique; the silent found:false skip is real (check.js → ok:true/plan:null). Scheduling is an owner call — evening run + plan-aware dedup is the shape I'd endorse.

#### [P1·M·h] No morning-of last call — the final warning lands ~20h before the fine window, then nothing

shouldDispatchPlan (src/server/notifications/planner.js:77-82) only fires at daysUntilPrimary 1-3; there is no daysUntilPrimary===0 path anywhere, and by the noon cron the 8AM-12PM sweep is already over. So the entire 'do not get a $50 ticket' product rests on kit reading and acting on a single DM sent at noon the previous day. Miss it, or move the car back to the wrong side overnight, and the system stays mute while the sweeper rolls past at 8AM. The interactive SPA has a day-of 'MOVE YOUR CAR' state (check.js:106-107) — the push channel, the one that matters, doesn't.

**Suggestion:** Add a ~7:00 ET cron entry with a day-of dispatch class: re-locate the car, and DM ':rotating_light: sweep starts 8AM TODAY on your side' only if it is still on the swept side. To avoid a daily 7AM wake, persist the next-event date per sub at the previous evening's run and only run the 7AM check for subs with an event today.

> **Operator note (tinyclaw):** Real gap, pairs with the evening-run change. Day-of 7am check gated to event-days only (as suggested) avoids a daily extra wake.

#### [P2·S·h] All DM formatting is dead on arrival: planner writes mrkdwn, postSlackDM sends mrkdwn:false

formatPlanDM/formatWeeklyDigest (src/server/notifications/planner.js:100-155) lead every message with bold action verbs (*Park off-street Tue, Jun 16.*), :warning:/:broom: emoji, and <https://sweeper.bitvox.me/> links — but src/server/integrations/slack.js:30 sets mrkdwn:false (deliberately, per the comment at slack.js:13-15, to defang user-supplied vehicle/address strings). With mrkdwn off, Slack renders the asterisks, colons, and angle-bracket link syntax as literal characters. The carefully designed scannable hierarchy — bold action first, metadata footer in italics — is exactly the product here, and none of it renders.

**Suggestion:** Re-enable mrkdwn and instead escape only the untrusted substrings (vehicleName, address, nearestNote) per Slack's rules (& < > → &amp; &lt; &gt;) in footer()/formatPlanDM before interpolation. Verify with one test DM.

> **Operator note (tinyclaw):** VERIFIED in code — planner.js interpolates *bold*/:emoji:/<links> into every head/footer; slack.js sends mrkdwn:false (my own May hardening). Every styled DM kit has received renders with literal asterisks and angle brackets. Top pick: smallest fix, biggest daily-visible win. Note the fix MUST keep escaping untrusted substrings (vehicle name, addresses) — that was the point of mrkdwn:false.

#### [P2·M·h] No on-demand 'am I safe parked here?' from Slack — the highest-value moment has the most friction

The decision moment is 6-10PM while parking, on a phone. Today the only paths are the SPA Tesla flow (needs a live BFF session; 401 dumps you back through full Tesla OAuth — App.jsx:136-145) or the manual pin-drag tab. There is no Slack-side trigger at all: routes/ has only oauth/notifications/probes/session/vehicles, and the dedicated Slack app is outbound-only chat.postMessage (src/server/integrations/slack.js). The plumbing for a slash command is 90% built: server is public behind Caddy, the sub record already binds slack_user_id → refresh_token → vehicle_id, and runSweepCheck is a pure function.

**Suggestion:** Add POST /api/slack/command verifying the Slack signing secret, look up the caller's sub by slack_user_id, run locate→reverseGeocode→runSweepCheck, and reply with the existing status/title/message strings. Register it as /sweep on the dedicated app. This also mitigates both P1s (user can self-serve a fresh check after the noon snapshot went stale).

#### [P2·S·h] Cron wakes the Tesla 365 days a year — including Jan–Mar when Somerville sweeping is off — and sends 13 'clear all week' winter digests

There is no season gate anywhere in src/server (grep for season/April finds nothing outside the SPA footer, App.jsx:640). The daily noon run and Sunday digest call fetchVehicleData, which force-wakes a sleeping car (src/server/integrations/tesla.js:87-97) — every day, all winter, to learn nothing. classifyWeek with zero events still returns a plan ({class:'safe'}), so formatWeeklyDigest (planner.js:148-150) DMs 'clear all week — nothing to do' every Sunday January through March. Daily forced wakes cost real battery and prevent deep sleep on a car that has nothing to fear until April 1.

**Suggestion:** Calendar-gate runNotifications (skip the Tesla wake/locate Jan 1–Mar 31; America/New_York month check at the top of the per-sub loop), replace winter digests with one 'sweeping season starts Apr 1 — back on duty then' DM in late March. In-season, skip the forced wake when the vehicle list reports state=asleep AND the last persisted result shows next sweep >3 days out (an asleep car hasn't driven anywhere).

> **Operator note (tinyclaw):** VERIFIED there is no season gate. Cheap fix, real battery cost. Endorsed as-is.

#### [P2·S·h] Stuck-sub DM prescribes 'Re-enable at sweeper.bitvox.me' for every failure class, even ones re-auth can't fix

After 3 consecutive failures the user gets ':warning: ... failing for N runs ... Re-enable at <https://sweeper.bitvox.me/>' (src/server/notifications/cron.js:155-156) regardless of cause. But getTeslaAccess already classifies failures into RevokedError/ConfigError/TransientError (src/server/integrations/tesla-auth.js:32-38), and the cron comment at cron.js:53-57 acknowledges all three flow into the same streak. A 3-day Overpass or Tesla-fleet outage tells kit to redo two OAuth flows that will change nothing; meanwhile the actual operator (VoX) only finds out via journalctl. Wrong audience, wrong remedy.

**Suggestion:** Persist the error class (e.name) into last_result in the per-sub catch, and only send the re-authorize DM for RevokedError/ConfigError streaks. For TransientError streaks, DM the operator's Slack id (env OPERATOR_SLACK_ID) instead — 'sub X failing on <class> for N runs' — and leave the user alone.

> **Operator note (tinyclaw):** VERIFIED — one generic streak counter + one generic DM for all three error classes (cron.js:96-156). Endorsed; pairs with the arch finding on RevokedError.

#### [P3·M·m] Up to 3 identical DMs per sweep event with no ack/mute — alert-fatigue trains the user to skim the one DM that matters

shouldDispatchPlan fires at days 3, 2, and 1 (planner.js:77-82), deduped only within a day (cron.js:125), so every sweep event yields three near-identical noon DMs and there is no way to say 'handled, stop'. Somerville sweeps each side roughly twice a month in season — that's a steady drip of repeats with the same action text. For a 2-user tool this is tolerable, but the failure mode is exactly the dangerous one: the day-1 DM (the one that prevents the ticket) reads identically to the day-3 one the user already dismissed twice.

**Suggestion:** Either drop the cadence to days 3 and 1 with distinct framing ('heads-up' vs 'LAST CALL: tomorrow 8AM'), which is a 5-line change in shouldDispatchPlan/formatPlanDM — or, if the Slack command endpoint from the /sweep finding lands, add a 'handled ✓' block-action button that sets muted_event_date on the sub and is checked before dispatch.

#### [P3·S·h] Third-user onboarding has an invisible hard wall (Slack workspace membership) plus a 30-minute two-OAuth ordering trap, none of it documented

A hypothetical third Somerville Tesla owner must (1) be invited into the one Slack workspace where the dedicated app is installed — OIDC sign-in and postSlackDM are both bound to it, so DMs are impossible otherwise; (2) complete Tesla OAuth AND Slack OIDC in the same browser visit, in the right order, because the enable gate needs a live ~30-min Slack HMAC session (App.jsx:181-194 catches the failure but only after the fact). Neither prerequisite appears in README.md. The one-sub-per-slack_user_id rule (routes/notifications.js:13-14) is a fine scope cut at n=2, but the workspace coupling is the actual adoption ceiling and worth stating out loud as a product decision.

**Suggestion:** Add a 'what a new user needs' section to README.md: workspace invite first, then Tesla OAuth, then Slack sign-in + Enable within 30 minutes; note the one-workspace and one-sub-per-Slack-account constraints explicitly so 'can my friend use this?' has a written answer.

#### [P3·M·m] No DM-independent backup channel (ICS export) despite the DM path having already failed silently once

The May 2026 shared-token rotation silently killed every DM while checks kept succeeding — the code itself memorializes this (cron.js:164-167). The product's only delivery channel is still that same Slack DM path. A street side's Apr-Dec sweep schedule for a fixed address is static data the server already fetches (recollect.js fetchSweepEvents); exporting it as an .ics from the manual tab ('add this address's sweep days to your calendar', VALARM the evening before + 7AM day-of) gives a zero-runtime-dependency second channel that keeps working through any token/cron/EC2 outage, and works for non-Tesla household members too.

**Suggestion:** Add GET /api/ical?place_id=…&side=… generating a VCALENDAR from fetchSweepEvents over Apr 1–Dec 31 with two VALARMs per event, plus an 'Export calendar' button on the manual tab's result card.

### UX & interaction

#### [P2·S·h] Slack pings — the app's actual product — are buried below the fold and absent from the first-visit pitch

The daily DM is why this app exists, but a new user can't see it. Logged out (desktop screenshot), the pitch is only 'Check if your car needs to move' — no mention of notifications. Logged in, NotificationsPanel renders AFTER LocationResultsView (App.jsx:586-598), i.e. below map (250px) + coords + status box + events card + details card + side-detection card. On a 390px phone after a check that's ~3 screens down. The code itself admits this: the comment at App.jsx:174-177 says the inline error 'is often below the fold'. Worse, the enable-success toast with the test-DM hint ('check slack for the test ping', App.jsx:208-213) renders in the top-of-page status slot (App.jsx:570) — the user who just clicked Enable at the bottom never sees whether the test DM worked.

**Suggestion:** Move <NotificationsPanel> above <LocationResultsView> (it's compact when enabled: one ✅ line + Disable button), or add a one-line status chip next to the Check button ('🔔 daily pings: off — set up'). Add a 'Daily Slack reminders 1/2/3 days before sweeping' line to the logged-out screen copy at App.jsx:603.

#### [P2·S·h] Toast channel is dim grey text at the top of the page: invisible when scrolled, never announced, and duplicates inline errors

showToast (App.jsx:47-51) renders into the .oauth-status slot (App.jsx:570) — 0.85rem #8b949e grey (App.css:42), auto-clears in 5s, no aria-live. Error toasts ('❌ ' + msg, App.jsx:177) get the same dim grey, not red. Anyone below the fold (which is where every notification action happens, see previous finding) sees nothing; screen readers hear nothing. Meanwhile notifFail double-posts: persistent red inline text right under the button the user just clicked (NotificationsPanel.jsx:46) PLUS the 5s toast at the top they can't see — the duplication serves nobody since clicking Enable means the panel is on-screen.

**Suggestion:** Make the toast a position:fixed bottom-of-viewport element with role="status" aria-live="polite", styled by kind (error=red). Then drop the toast half of notifFail (App.jsx:177) — keep inline-only for panel errors, toast-only for non-co-located feedback (sign-out, test-DM result).

#### [P2·S·h] Manual-tab errors never clear and leak into the Tesla tab

handleManualPinMove's catch does setError(e.message) (App.jsx:378) but the function never clears `error` on a subsequent successful probe — only reset() (Tesla-tab check) or the manual × dismiss does. One transient Nominatim hiccup leaves a permanent red error box claiming failure while fresh, correct results render above it. And because the error box lives outside both tabpanels (App.jsx:632-637), a manual-tab geocode error stays on screen after switching to the Tesla tab, where it reads as a problem with the car check. Raw e.message also surfaces server `detail` strings verbatim (api.js handleRes), e.g. 'API error' with no hint which tab/action produced it.

**Suggestion:** Either call setError('') at the top of handleManualPinMove (App.jsx:364) so success replaces failure, or split into a manualError state rendered inside the manual tabpanel — the second also fixes the cross-tab leak.

#### [P2·S·h] Manual tab is drag-only: no tap-to-place, no address search, no 'use my location' — rough on a phone

The manual screenshot shows a 250px-tall map at zoom 17 covering ~4 blocks. The ONLY input is dragging the marker (MapView.jsx:47-52 wires dragend exclusively). To test an address across town on a 390px phone you must: pan, precision-grab the ~25px marker (which fights map-pan gestures on touch), drag, wait 300ms debounce, repeat. There is no forward-geocode search box, no map-click-to-move, no geolocation button — even though the instruction copy says 'Drag the pin to test any Somerville address' (App.jsx:614). Also the pin is keyboard-inaccessible, making the entire manual tab unusable without a pointer.

**Suggestion:** Cheapest 90% fix: in MapView.jsx, when draggable, add map.on('click', e => { markerRef.current.setLatLng(e.latlng); onPinMoveRef.current?.(e.latlng.lat, e.latlng.lng); }) next to the dragend wiring, and change the copy to 'tap the map or drag the pin'. A 'use my location' button via navigator.geolocation is the next-best S add.

#### [P3·S·h] OAuth state-mismatch path shows debug internals and strands valid sessions on the Connect screen

App.jsx:492-495: the user-facing copy is literally `OAuth state mismatch (slack=${!!slackState}, tesla=${!!teslaState}). Try again.` — 'slack=false, tesla=true' is developer telemetry, not an instruction. This path triggers in real situations (callback URL restored from history, tab duplicated mid-flow, in-app browser returning in a fresh context — sessionStorage is per-tab). Worse, the branch sets authChecked and returns WITHOUT calling checkSession(), so a user whose `session` cookie is perfectly valid gets dumped on the logged-out Connect screen with a cryptic error, even though GET /api/session/me would have logged them straight in.

**Suggestion:** In the mismatch branch, call checkSession() first and only show an error if it comes back unauthenticated; change the copy to 'Sign-in didn't complete (the link may have opened in a different tab). Click Connect Tesla Account to try again.'

#### [P3·M·h] reset() wipes the on-screen verdict before slow operations — blank screen for up to 60s during a wake, total loss on session expiry

handleCheckCar (App.jsx:395-411) calls reset() up front, so re-checking a sleeping car clears map + status + events and leaves only a button reading 'Waking your car... (up to 60s)' — the user stares at an empty page for a minute when they could be re-reading the still-mostly-valid previous result. Same pattern on session expiry: handleAuthExpired (App.jsx:136-145) calls reset() + clearCachedCheck(), so a 401 mid-session destroys the sweep verdict the user was reading and replaces it with grey '⚠️ Session expired' — but the verdict ('move your car by Thursday') didn't stop being true when the cookie died.

**Suggestion:** Stale-while-revalidate: in handleCheckCar, don't reset() — keep prior results rendered (optionally at reduced opacity with a 'refreshing…' note) and swap when new data lands. In handleAuthExpired, keep sweepData/mapPos rendered beneath the re-connect prompt instead of reset().

#### [P3·S·h] Raw Slack member IDs used as primary UI text — right after promising 'no member-id hunting'

NotificationsPanel.jsx renders 'DMs go to U061GUNS2' (line ~18), '🔐 Signed in as U061GUNS2' (line ~30), and a button labeled 'Enable Daily Notifications for U061GUNS2' (line ~44) — while the empty-state copy on the same card says 'no member-id hunting needed'. The human-readable name IS available: the OIDC callback returns data.name and App.jsx:475 uses it once in a 5-second toast, then throws it away.

**Suggestion:** Persist the name next to the id (localStorage tesla_slack_user_name, set in the slack callback .then at App.jsx:467-476; server could also store it on the sub record so enabledForThis carries vehicle_name-style display). Render the name as primary with the U-id in a title attribute or small secondary text.

#### [P3·S·h] Sign-out toast directs users to a panel that no longer exists

logout() shows 'Signed out. Your noon notifications are still active — use the Notifications panel to turn them off.' (App.jsx:158). But NotificationsPanel only renders when loggedIn && vehicles?.length > 0 (App.jsx:587), and logout just set loggedIn=false — the panel vanished in the same frame the toast told the user to go use it. Actually disabling now requires a full Tesla OAuth round-trip, which is exactly what someone disconnecting wanted to avoid. Note the server already accepts Slack-HMAC-only proof on /disable, so a logged-out disable path is feasible.

**Suggestion:** Minimum: reword to 'sign back in with Tesla to turn them off.' Better: confirm-before-signout ('keep daily pings on? [keep] [also disable]') in logout(), or render a slimmed disable-only panel on the logged-out screen when a live slack_session exists.

#### [P3·S·h] Other-side event text fails contrast hard (~2.2:1) — and the dimmed info is the schedule itself

App.css:35 sets .event-other .event-side to #484f58 on the #161b22 card — computed contrast 2.18:1 (WCAG AA needs 4.5:1 at 0.85rem). App.css:33 sets .event-yours .event-side to #f8514999, 60%-alpha red over the #2d0a0a highlight — also well under AA. These cells carry 'odd side · 8am-12pm', i.e. which side and when — exactly what someone parked on the 'other' side checks to plan the swap. On a phone outdoors this text is functionally invisible.

**Suggestion:** Bump #484f58 → #8b949e (the established muted color, 5.5:1 on #161b22) at App.css:35, and #f8514999 → #f85149cc at App.css:33. The visual hierarchy (yours-vs-other) survives via the red background + badge.

#### [P3·S·h] A 6-hour-old cached car position renders identically to a live check

autoCheckOnLoad (App.jsx:315-320) hydrates from a cache up to 6h old (cache.js CHECK_CACHE_MS). The basis stamp (day + am/pm) smartly invalidates the sweep VERDICT across the noon boundary, but the car POSITION can still be hours stale within the same half-day — if the car moved at 9am, a 11am page load shows the 7am spot with full confidence: same map, same status box, zero freshness cue. cache.js already stores and returns the `at` timestamp; App.jsx just never renders it.

**Suggestion:** When hydrating from cache, render a small line near the map/vehicleInfo: 'position as of 9:14 AM — Check My Car to refresh' using cached.at (it's already in the object returned by readCachedCheck). One conditional <div> in the loggedIn branch.

### Graphic design

#### [P2·S·h] Logged-in view stacks three identical full-width green primary buttons — no action hierarchy

App.css:13 styles every <button> as the full-width green primary (#238636, 1rem, 600 weight). In the logged-in state the page renders 'Check My Car' (App.jsx:584), 'Sign in with Slack' (NotificationsPanel.jsx:42), and 'Enable Daily Notifications' (NotificationsPanel.jsx:45) all in that same style, stacked within one viewport. The one true primary action per state (Check My Car, or Enable once Slack is signed in) is visually indistinguishable from secondary ones. Only Disconnect/Disable escape via .disconnect-btn. The screenshots show the logged-out state, but the code is unambiguous.

**Suggestion:** Add a `.btn-secondary { background: transparent; color: #c9d1d9; border: 1px solid #30363d; }` rule to App.css (mirror of .disconnect-btn minus the red) and apply it to the Slack sign-in/'Switch slack account' button in NotificationsPanel.jsx:42. Keep green for exactly one button per view.

#### [P2·S·h] Desktop layout floats unanchored: footer sits at ~y330 of a 900px viewport, content reads as fragments on a void

In /tmp/sweeper-ui-desktop.png the 560px content column ends a third of the way down and the footer (App.css:45) hugs the content, leaving ~570px of flat #0d1117 below it. body has min-height:100vh (App.css:2) but nothing uses that height — the page looks unfinished rather than minimal. The 600px max-width column itself is fine for a single-task tool; the problem is vertical composition, not width.

**Suggestion:** Three lines in App.css: `body { display: flex; flex-direction: column; }`, `.container { flex: 1 0 auto; width: 100%; display: flex; flex-direction: column; }`, `footer { margin-top: auto; }` so the footer pins to the viewport bottom. Optionally add `@media (min-width: 768px) { .container { padding-top: 48px; } }` so the card sits intentionally rather than flush-top.

#### [P2·S·h] No PNG/apple-touch-icon — iOS home-screen install (the natural use of a parking tool) gets no icon

index.html:8 ships only a data:URI SVG emoji favicon (🧹). Verified identical on the live site. iOS Safari does not use SVG data-URI favicons and there is no apple-touch-icon, so kit saving sweeper.bitvox.me to his phone home screen — the most likely daily entry point for 'do I need to move the car' — gets a grey screenshot tile instead of an icon. Also a brand mismatch: favicon is a broom 🧹 while the h1 (App.jsx:547) and tab use a car 🚗.

**Suggestion:** Add a 180×180 PNG apple-touch-icon and a 32×32 PNG favicon to src/client/ (one generated broom-or-car mark on the #0d1117 background), then `<link rel="apple-touch-icon" href="/apple-touch-icon.png">` + `<link rel="icon" type="image/png" ...>` in index.html. Pick one glyph (broom or car) and use it in both favicon and h1.

#### [P2·S·h] Emoji-as-iconography is inconsistent, redundant with the color system, and undercuts trust on an OAuth page

Emoji appear as UI chrome throughout: h1 🚗 (App.jsx:547), tab icons 🚗/🗺️ (App.jsx:8-11), card header 🔔 (NotificationsPanel.jsx:13), status icons 🚨⚠️✅ℹ️ (StatusBox.jsx:5), plus ✅/❌/🔐/⚠️ prefixes baked into status strings (App.jsx:144, 279, 475, 511-526). The status boxes already encode severity with border/bg/text color triads (App.css:18-21), so the emoji is redundant there, and rendering varies by platform (Windows/Android emoji look nothing like the screenshots). For a page whose main CTA is handing over Tesla account access, emoji-dense chrome reads hobbyist.

**Suggestion:** Smallest high-value cut: remove emoji from the two tab labels (App.jsx:8-11) and the h1; in StatusBox.jsx drop the emoji and rely on the existing colored border (or add a `::before` 8px colored dot via the status class). Keep at most the toast-string emoji — those are transient. No SVG icon system needed at this scale.

#### [P3·S·h] Link-blue #58a6ff doubles as heading color — h1 and card headers read as links

App.css:4 sets h1 to #58a6ff and App.css:26 sets .card h3 to the same blue at 0.9rem — smaller than button text (1rem). The same blue is the interactive color for links (App.css:46), active tab (App.css:8), and focus rings. Result: the page title and section headers look clickable, and real links have no distinct identity. Section headers ('Details', 'Side detection', 'Upcoming Sweeping Events') carry almost no hierarchy weight at 0.9rem blue.

**Suggestion:** In App.css set `h1 { color: #e6edf3; }` and restyle card headers as dashboard section labels: `.card h3 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #8b949e; }`. Blue stays exclusively interactive (links, active tab, focus).

#### [P3·S·h] Flat type scale: value-prop copy, helper text, tabs, rows, and the footer disclaimer are all the same 0.85rem grey

Nearly every text element is 0.85rem #8b949e: .subtitle (App.css:5), .tab (7), label (10), rows (27), .error (37), .oauth-status (42), plus the inline-styled explainer paragraphs (App.jsx:603, NotificationsPanel.jsx:14). The line that sells the product ('Sign in with your Tesla account to locate your car...') is typographically identical to the legal-ish footer disclaimer. On the desktop screenshot the eye gets h1 → green button and skips everything between.

**Suggestion:** One step is enough: render the landing explainer (App.jsx:603) at 0.95rem in body color #c9d1d9 instead of 0.85rem #8b949e, and leave true helper/meta text at 0.85rem grey. Two tiers of small text instead of one.

#### [P3·S·h] Repeated muted-text inline styles across 10+ JSX sites; the vehicle <select> re-implements input styling inline and loses the focus ring

The object `{fontSize:'0.85rem', color:'#8b949e', marginBottom:...}` is hand-copied at App.jsx:572, 603, 615, 618; NotificationsPanel.jsx:14, 19, 30, 34, 38, 50; LocationResultsView.jsx:21; SideDetectionCard.jsx values. Worse, the vehicle picker (App.jsx:577) clones the entire `input` rule inline but misses `input:focus-visible` (App.css:12) and the 16px bottom margin, so it's the only form control with no visible keyboard-focus ring and different spacing. LocationResultsView.jsx:21 also uses off-palette #888 instead of #8b949e.

**Suggestion:** Add to App.css: `.muted { font-size: 0.85rem; color: #8b949e; }`, `.coords { font-size: 0.72rem; color: #8b949e; font-family: monospace; text-align: center; }`, and extend the existing input rules to `input, select { ... }` (lines 11-12). Replace the inline objects with the classes; delete the select's inline style entirely.

#### [P3·S·h] Map embed is the brightest element on the page — default light OSM tiles + white Leaflet controls clash with the dark theme

Visible in /tmp/sweeper-ui-manual.png: the 250px map (App.css:24) is a near-white rectangle in an otherwise #0d1117 page, with Leaflet's default white zoom buttons and white attribution strip (MapView.jsx:44 uses stock tile.openstreetmap.org tiles, leaflet.css untouched). The 1px #30363d border can't contain that much luminance contrast; everything around the map loses visual weight.

**Suggestion:** Two CSS-only additions to App.css, no tile-provider change: `.map-container .leaflet-tile { filter: brightness(0.75) saturate(0.85); }` (mild dim, street labels stay readable — avoid the full invert trick) and `.leaflet-control-zoom a, .leaflet-control-attribution { background: #161b22 !important; color: #c9d1d9 !important; }`. Keep the green/red overlay polylines as-is; they read well on dimmed tiles.

#### [P3·S·h] Tesla OAuth CTA has zero point-of-action trust signal

The landing card's only reassurance is 'Sign in with your Tesla account to locate your car...' (App.jsx:603) and a GitHub link buried in the footer. For a third-party site requesting Tesla account access, there is nothing at the button explaining that auth happens on auth.tesla.com and the password never touches this server — which is true under the BFF model and is exactly the claim that builds trust. With a 2-person user base this is minor, but it's one sentence.

**Suggestion:** Add a 0.75rem muted line directly under the 'Connect Tesla Account' button (App.jsx:604): 'Sign-in happens on auth.tesla.com — your password never touches this server. Open source on GitHub.' with the GitHub link inline, reusing footer link styling.

#### [P3·S·m] Tab labels mislabel their content: 'Tesla Login' names the auth step, not the destination; 'Manual' is opaque

TABS at App.jsx:8-11. Once signed in, the 'Tesla Login' tab contains the car check, results, and notification settings — the label describes only its empty state. 'Manual' tells a first-time visitor nothing ('manual' what?); the explanation only appears after clicking through (App.jsx:614). With two tabs and ~560px of width each on desktop, there's room for labels that describe content.

**Suggestion:** Rename in App.jsx:8-11 to 'My Car' and 'Any Address' (or 'Check by Pin'). No structural change; labels describe the destination in both signed-in and signed-out states.

### Architecture & failure modes

#### [P1·S·h] Noon run is one-shot per day: missed-run recovery only evaluates at process boot, never in-day

maybeRecoverMissedRun() (src/server/notifications/cron.js:236-247) is called exactly once, from the listen callback in src/server/index.js:25-28. If the 12:00 ET run itself fails (Tesla 5xx during all 3 retry attempts, Nominatim down, Slack unreachable), last_run_at is deliberately not advanced (cron.js:171-176) — but nothing ever re-reads that predicate until the next service restart. Concrete scenarios that lose a whole day's warnings: (a) EC2 reboot finishing at 11:50 ET — boot recovery is skipped by the hourET<12 gate (cron.js:241), and if the 16:00 UTC cron run then fails transiently there is no retry until tomorrow; (b) box rebooted at 13:00 with the unit lacking After=network-online.target — recovery fires into a not-yet-up network, every sub fails in seconds, process stays healthy, no retry; (c) a node-cron v4 matcher-walker mis-arm across a DST transition silently skips the noon fire (the Runner heartbeat logs 'missed execution' but does NOT execute it — verified in node_modules/node-cron/dist/esm/scheduler/runner.js heartBeat). The 1-day-before warning for a next-morning sweep is the last chance to avoid the $50 ticket; tomorrow-noon is after the sweep. This deepens the known DST item: whatever node-cron 4.2.1 does at transitions, there is no in-day safety net.

**Suggestion:** Add a cheap hourly guard cron, e.g. cron.schedule('5 13-23 * * *', () => maybeRecoverMissedRun()?.catch(log), {timezone:'America/New_York'}) plus the digest equivalent — the predicates are already idempotent and date-deduped (last_run_at date check + per-sub last_dm_date), so re-evaluating them hourly converts boot races, noon-outage failures, and DST/cron-library glitches into 'recovered within the hour'. Pair with the stub fix (next finding) so partial failures actually retrigger.

#### [P1·S·h] RevokedError is flattened into the generic failure counter — user learns their Tesla auth died 3 days later

tesla-auth.js builds a precise taxonomy (RevokedError on invalid_grant at src/server/integrations/tesla-auth.js:118-124 — definitive, permanent, requires re-OAuth), but the cron's per-sub catch (src/server/notifications/cron.js:92-95) discards the class and only increments consecutive_failures. With STUCK_FAIL_THRESHOLD=3 (cron.js:18) and exactly one run per day, the stuck-sub DM fires on day 3. Failure scenario: kit changes his Tesla password on a Tuesday; sweeps are Friday; the 3-day/2-day/1-day warnings due Tue/Wed/Thu all silently fail; the 'notifications have been failing' DM arrives Friday noon — after the ticket. Once revoked, getTeslaAccess short-circuits on refresh_invalidated_at (tesla-auth.js:53-55) so the sub fails every day forever; nothing auto-disables or escalates faster despite the error being known-permanent on the first occurrence.

**Suggestion:** In the per-sub catch, special-case `e instanceof RevokedError` (import it from tesla-auth.js): send the re-authorize DM immediately on first occurrence, gated by a one-shot flag (reuse last_dm_error_at or add revoked_dm_sent) instead of waiting for the 3-run threshold. Keep the threshold for TransientError. Optionally treat ConfigError the same but DM VoX/the operator instead of the user, since the user can't fix invalid_client.

> **Operator note (tinyclaw):** VERIFIED, same root as the product stuck-sub finding — fix both together: class-aware streak handling + operator-vs-user DM routing.

#### [P2·S·h] The live stub subscription keeps last_run_at//healthz green even when the only real Tesla sub is hard-down

Deepens the known STUB_VEHICLE_ENABLED item with a concrete monitoring consequence: data/users.json currently holds two subs — kit's real car ('KitlaDos') and the stub ('Test Vehicle', vehicle_id 999999999999999, subscribed and DMing daily; verified live). The stub path skips Tesla entirely (cron.js:42-51), so it virtually always succeeds. The run-health predicate `results.some(r => r.ok)` (cron.js:171-176) is therefore permanently satisfied: if kit's refresh token is revoked or the Tesla Fleet API is down for a week, /healthz last_run_at stays fresh and any outside monitoring on it stays green. The only remaining signal for the real sub is the 3-day stuck DM (previous finding) sent to kit, not the operator. The stub doubles as a useful daily canary for the Recollect/Nominatim/Slack chain — the problem is purely that it poisons the one ops freshness signal.

**Suggestion:** Exclude stub subs from the success predicate (`results.some(r => r.ok && !isStubVehicle(r.vehicle_id))` — or track real and stub freshness separately), and add a per-sub health field to /healthz (src/server/routes/probes.js:31-43), e.g. max_consecutive_failures and oldest real-sub last-ok timestamp, so a dead real sub is visible in one curl.

#### [P2·M·h] Recollect/Nominatim schema drift fails silent-SAFE: 'no events parsed' is indistinguishable from 'no sweeping scheduled'

parseSweepFlags (src/server/integrations/recollect.js:36-53) keeps only flags whose name contains 'sweeping' (lowercased) and derives side from case-sensitive 'EVEN'/'ODD' substrings of the raw name. If Recollect renames flags, changes casing, or restructures the events payload (fetchSweepEvents already guesses between bare-array and {events}), every event silently drops → runSweepCheck returns status 'safe' / 'No sweeping events found in the next 30 days' (src/server/sweep/check.js:125-127) → classifyWeek returns class 'safe' → zero DMs, zero consecutive_failures, /healthz fully green. Same end-state if Nominatim retags Somerville's admin boundary so geo.city stops matching 'somerville' (check.js:29-31). The user is silently unprotected for the rest of the season with every dashboard green — the most dangerous failure shape this app has, because its whole job is the alert.

**Suggestion:** Add a zero-events canary: in the daily run, when a sub is found but sweep_events.length===0 during the posted Somerville sweeping season (roughly Apr 1–Dec 31), increment a persisted zero_events_streak in the store; expose it on /healthz and DM the operator (VoX's slack id) once it crosses ~7 consecutive days. Also make the ODD/EVEN match case-insensitive while in there.

#### [P2·M·h] Asleep car at noon: single 60s wake attempt, failure burns the entire day's check for that sub

Answering the wake-semantics question concretely: yes, the noon cron wakes the car — fetchVehicleData gets 408, POSTs wake_up, polls 12×5s (src/server/integrations/tesla.js:24-41, 87-97). Battery cost is the unavoidable price of a fresh location and is the correct trade (caching the last location when asleep would be wrong — the car can drive and re-park between checks), so daily wakes are fine. The weaknesses: (1) the 60s ceiling is one-shot — a car in deep sleep that takes 90-120s to come online (common after multi-day parking) throws 'Vehicle did not wake within 60s', the per-sub catch swallows it, and there is no second attempt until tomorrow noon — exactly the multi-day-parked-on-a-sweep-street case the app exists for; (2) a wake_up non-2xx (tesla.js:28-31) returns false and gets reported with the same misleading 'did not wake within 60s' message, hiding 401/429 root causes from the logs and the stuck-DM.

**Suggestion:** For the cron path, extend the poll budget (24×5s) and add one end-of-run re-attempt for subs that failed specifically on wake timeout (the run loop already collects per-sub results to drive this). Distinguish the wake_up HTTP failure in the thrown message ('wake_up returned 429' vs timeout) so the stuck-DM and journal are diagnosable.

#### [P2·S·h] Boot recovery + Restart=on-failure can crash-loop forever, hammering OSM with cold caches each iteration

index.js exits on any uncaughtException (src/server/index.js:15) and the unit (~/.config/systemd/user/tesla-sweeper.service) has Restart=on-failure, RestartSec=5 with systemd's default StartLimitIntervalSec=10s/Burst=5 — at 5s+ spacing the start limit never trips, so a deterministic crash inside maybeRecoverMissedRun (which runs on every boot when past noon with a stale last_run_at, cron.js:236-247) restarts and re-runs recovery indefinitely. Each iteration starts with empty in-memory Nominatim/Overpass caches (the in-memory state that actually matters on restart — rate-limit buckets and the oauth-state registry are harmless to lose), so every loop fires fresh reverse-geocode + up to 3 Overpass queries + Recollect lookups: a sustained automated query loop against Nominatim, whose usage policy explicitly bans faulty repeating clients — an IP/UA block there takes down geocoding for the legitimate runs too. The persisted access_token cache in users.json does protect against refresh-token rotation churn here (good), and per-sub last_dm_date bounds DM spam to ~1 duplicate, but the service never converges and nothing alerts. The unit also lacks Wants=/After=network-online.target, making the boot-recovery-into-dead-network scenario in finding 1 more likely after a box reboot.

**Suggestion:** In the unit: add StartLimitIntervalSec=600, StartLimitBurst=5 (so a tight crash loop parks the service instead of spinning), plus Wants=network-online.target / After=network-online.target. Belt-and-braces in code: persist last_recovery_attempt_at in the store and skip boot recovery if it is <15 minutes old.

#### [P3·S·h] A missed weekly digest is unrecoverable — recovery window is Sunday 20:00-24:00 ET only, and /api/notifications/run can't fire weekly mode

maybeRecoverMissedDigest (src/server/notifications/cron.js:252-264) requires weekday==='Sun' && hour>=20, so a service down from Sunday 19:00 to Monday morning skips that week's digest permanently (the code comment claims the recovery prevents exactly this 'skips that week forever' mode, but only covers the boot-lands-back-inside-Sunday-evening case). The manual escape hatch doesn't exist either: POST /api/notifications/run (src/server/routes/notifications.js:152-157) calls runNotifications() with no mode parameter, so the operator cannot trigger a weekly digest by hand — the bearer-token endpoint is daily-only.

**Suggestion:** Accept {mode:'daily'|'weekly'} in the /run body (validate against the same two values runNotifications already enforces), and widen the digest recovery predicate to 'last_digest_run_at predates the most recent Sunday 20:00 ET' with a ~24h grace window so a Monday-morning boot still sends the week's schedule.

### Code organization

#### [P2·M·h] App.jsx is a 645-line god component: 20 useState + 4 useRef, all flows interleaved

/home/ec2-user/projects/tesla-sweeper/src/client/App.jsx holds every piece of client state in one component: Tesla session (loggedIn, authChecked, vehicles, selectedVehicle, oauthStatus), Slack notifications (slackUserId, subscriptions, notifLoading, notifError), manual tab (manualPos, manualSweepData, manualLoading), toast machinery, and check flow (loading, waking, error, sweepData, vehicleInfo, mapPos). 20 useState calls total. The worst single unit is the mount/OAuth-callback effect at lines 443-543: ~100 lines dispatching between Slack and Tesla return flows, in .then/.catch/.finally style while the rest of the file is async/await (a nested `async (data)` inside .then at 504, fire-and-forget .then at 531). Also SLACK_ID_RE is defined inside the component body (line 93), recreated per render.

**Suggestion:** Extract four hooks into src/client/hooks/: useToast() (transientToast + timer, lines 45-51), useManualProbe() (lines 63-87, 354-393), useSlackNotifications() (lines 93-131, 161-236, 427-438 + the Slack branch of the callback effect), useTeslaSession() (lines 58-59, 136-159, 248-348, 395-425 + the Tesla branch). Inside the callback effect, lift each flow into named async functions completeSlackOAuth(code,state) / completeTeslaOAuth(code,state) so the effect is a 15-line dispatcher. Move SLACK_ID_RE to module scope. App.jsx drops to ~250 lines of layout.

#### [P2·M·h] runNotifications has outgrown its shape: 160-line closure doing five jobs via an 18-field ad-hoc object

/home/ec2-user/projects/tesla-sweeper/src/server/notifications/cron.js lines 24-188: one IIFE performs (1) per-sub check+geocode+sweep+plan (38-117), (2) daily DM dispatch (119-131), (3) weekly digest dispatch (132-145), (4) stuck-sub alerting (150-160), and (5) store health bookkeeping (162-184), communicating through a mutable `out` object that accumulates ~18 undeclared fields (sub_id, battery_level, address, found, days_until_next, status, title, message, car_side, sweep_events, side_detection, nearest_note, ok, error, consecutive_failures, last_dm_error_at, last_dm_date, last_digest_date, plan, dm_sent, dm_error, dm_skipped, digest_*, error_dm_sent). The daily loop (123-131) and weekly loop (136-144) are near-mirrors differing only in dedup field, formatter, and result-key names. The two cron.schedule callbacks (194-207, 209-219) also duplicate the summary-logging pattern.

**Suggestion:** Split into named top-level functions: checkSub(sub, todayET) returning the result object, dispatchDMs(results, todayET, {dedupField, format, sentKey, skipKey}) used by both daily and weekly, sendStuckAlerts(results), and persistRunHealth(results, mode). runNotifications becomes a ~25-line orchestrator that keeps the existing single-flight wrapper. Each piece then becomes unit-testable without the current full-pipeline mock setup in __tests__/notifications-cron.test.js.

#### [P2·M·h] Route layer does raw third-party calls: Tesla revoke + /users/me live in routes/session.js, Slack token exchanges in routes/oauth.js

/home/ec2-user/projects/tesla-sweeper/src/server/routes/session.js violates the otherwise-clean routes→integrations boundary twice: resolveTeslaAccountId (lines 51-80) fetches `${TESLA_BASE}/api/1/users/me` directly, and /session/destroy (147-155) posts to TESLA_REVOKE_URL — a constant defined at session.js:30 that duplicates the fleet-auth host already hardcoded in integrations/tesla.js:6 and integrations/tesla-auth.js:16 (three copies of the same base URL). Revoke especially belongs in tesla-auth.js, which by its own header 'owns refresh-token rotation' — rotation and revocation are the same lifecycle. Similarly /home/ec2-user/projects/tesla-sweeper/src/server/routes/oauth.js does both raw Slack exchanges inline (oauth.v2.access at 72-82, openid.connect.token at 104-114) while integrations/slack.js exists for exactly this.

**Suggestion:** Move resolveTeslaAccountId and a new revokeRefreshToken(token) into integrations/tesla-auth.js, exporting a single TESLA_AUTH_BASE from there and deleting the duplicate constants in tesla.js:6 and session.js:30. Add slackOAuthInstallExchange(code) and slackOpenIdTokenExchange(code) to integrations/slack.js; routes/oauth.js keeps only state validation, claim checks, and response shaping.

#### [P3·S·h] Dead exports with actively misleading comments: STUB_REFRESH_TOKEN and loadUserBySlackId

/home/ec2-user/projects/tesla-sweeper/src/server/integrations/tesla.js:15 exports STUB_REFRESH_TOKEN with the comment 'sentinel persisted in subscriptions.json; cron branches on it' — both claims are stale: subscriptions.json is the pre-BFF legacy file (renamed .pre-bff by store/users.js:112) and the cron now branches on vehicle_id (cron.js:42-48 explicitly documents 'formerly token-based'). No production code imports it; the only grep hit is a test mock that defines its own copy (notifications-cron.test.js:16). /home/ec2-user/projects/tesla-sweeper/src/server/store/users.js:141 exports loadUserBySlackId with zero callers anywhere including tests. Stale comments that contradict the current design are worse than no comments in a codebase whose comments are otherwise this load-bearing.

**Suggestion:** Delete both exports. The test mock at notifications-cron.test.js:16 already supplies its own constant so nothing breaks. If a future feature needs slack-id lookup, the one-liner is trivial to re-add.

#### [P3·S·h] /api/check re-implements the resolveAccess helper defined 20 lines above it

/home/ec2-user/projects/tesla-sweeper/src/server/routes/vehicles.js defines resolveAccess() (lines 38-43: cookie → user → getTeslaAccess → mapTeslaAccessError) but /api/check inlines the identical sequence at lines 57-68 because it also needs the cookieUser record for the vehicle_id fallback (line 58). Result: the 401/'Not signed in' response and the getTeslaAccess try/catch+mapping exist twice in the same file, and the stub short-circuit ordering subtlety (auth check deferred until after the stub branch) is easy to break when touching either copy.

**Suggestion:** Change resolveAccess to return { user, accessToken } (null after responding, as now). /api/vehicles destructures accessToken; /api/check destructures both. For the stub-ordering case, split it: resolveUser(req,res) then brokerAccess(user,res) so /api/check can run the stub short-circuit between the two. Deletes ~10 duplicated lines and keeps the error mapping in one place.

#### [P3·S·h] JWT-claims decode hand-rolled twice with the same crash mode

/home/ec2-user/projects/tesla-sweeper/src/server/routes/oauth.js:123 and /home/ec2-user/projects/tesla-sweeper/src/server/routes/session.js:55 both do JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()). The validation policies on top differ deliberately (Slack pins iss/aud, Tesla doesn't — both documented), but the decode itself is identical, and both share the failure mode that a malformed token (missing dot, bad base64url) throws a generic TypeError/SyntaxError. session.js guards with try/catch + a 3-segment precheck; oauth.js:123 has neither, so a malformed id_token surfaces as the wrap() 502 'Upstream service error' instead of a descriptive 'bad id_token'.

**Suggestion:** Add decodeJwtClaims(token) to src/server/util/ (split-check, base64url decode, JSON.parse, throw a tagged descriptive error). Both routes call it; each keeps its own claim-validation policy. oauth.js gets the missing malformed-token guard for free.

#### [P3·S·h] App URL hardcoded in three message sites despite an existing APP_URL constant

/home/ec2-user/projects/tesla-sweeper/src/server/notifications/planner.js:6 defines APP_URL = 'https://sweeper.bitvox.me/', but the literal is re-hardcoded in cron.js:156 (stuck-sub DM), routes/notifications.js:102 (confirmation DM), and routes/vehicles.js:28 (RevokedError detail). This URL has already changed once in this app's life (the May 2026 BFF migration moved it to sweeper.bitvox.me), and a future move would leave three user-facing messages pointing at a dead origin while planner DMs are correct.

**Suggestion:** Export APP_URL from src/server/config.js (optionally env-overridable, defaulting to the current value) and import it in planner.js, cron.js:156, routes/notifications.js:102, and routes/vehicles.js:28. util/fetch.js:7's UA string can interpolate it too.

#### [P3·S·h] Client duplication: auth-reset block and vehicle-list adoption logic each exist twice

In /home/ec2-user/projects/tesla-sweeper/src/client/App.jsx, handleAuthExpired (136-145) and logout (147-159) duplicate the same 7-line teardown (setLoggedIn(false), setVehicles(null), setSelectedVehicle(null), setSubscriptions(null), autoCheckedRef.current=false, clearCachedCheck(), reset()) differing only in the final status/toast. Separately, the vehicle-list adoption rule ('one vehicle → auto-select; stale selectedVehicle not in list → clear') is implemented in fetchVehicles (257-262) and again in the session/create .then handler (507-509); if the rule changes (e.g. preferring the subscribed vehicle), one site will drift.

**Suggestion:** Extract resetAuthState() called by both handleAuthExpired and logout, and adoptVehicleList(vlist) used by fetchVehicles and the OAuth-return path. Natural to do as part of the useTeslaSession() extraction (see the App.jsx finding) but worth doing even standalone.

#### [P3·S·h] DATA_DIR resolution duplicated across the two store modules

/home/ec2-user/projects/tesla-sweeper/src/server/store/users.js:24 and /home/ec2-user/projects/tesla-sweeper/src/server/store/slack-install.js:15 each independently compute `process.env.SWEEPER_DATA_DIR || join(__dirname, '..', '..', '..', 'data')` with their own __dirname derivation. The path math is relative-depth-fragile: moving either file (or adding a store/ subfolder) silently points one store at a different data dir than the other — and slack-install.js would fail quietly (loadInstall catches everything and returns null, killing DMs with only the 'no Slack bot token' error).

**Suggestion:** Export a single DATA_DIR from store/users.js (it already owns writeAtomic, which slack-install.js imports) or from a tiny store/paths.js, keeping the SWEEPER_DATA_DIR env override as the test seam. slack-install.js imports it alongside writeAtomic.

#### [P3·S·h] check.js banner messages hardcode '8AM-12PM' while real event times are parsed and available

/home/ec2-user/projects/tesla-sweeper/src/server/sweep/check.js hardcodes the string '8AM-12PM' in three message templates (lines 104, 107, 116), while the actual per-event window is already parsed from Recollect flag names into e.time by parseSweepFlags (/home/ec2-user/projects/tesla-sweeper/src/server/integrations/recollect.js:43-48) and is shown correctly in the events list and the 'You're Good' message (line 124). If Somerville ever posts a non-8-to-noon window (the flag-name regex explicitly supports arbitrary hours), the status banner will state the wrong hours while the list below it is right. Same class of issue as the past_noon flag, which assumes the window always ends at 12:00.

**Suggestion:** Replace the literals with the relevant event's parsed time: sweepingToday[0].time at lines 104/107 and sweepingTomorrow[0].time at line 116 (falling back to '8AM-12PM' if time is empty). Leave past_noon semantics alone — that's a separate, documented assumption.

### Repo & project hygiene

#### [P2·S·h] Committed CLAUDE.md is a month stale and wrong on ~7 load-bearing claims, including the security model

/home/ec2-user/projects/tesla-sweeper/CLAUDE.md was last committed 2026-05-11 (e183fb4); 15 structural commits have landed since. Verified-wrong claims: line 11 names `store/subscriptions.js` (actual: src/server/store/users.js + slack-install.js); line 21 lists `lib/slack-input.js` (deleted in 6ba59b1); line 25 says storage is `data/subscriptions.json`; lines 64-67 say Tesla tokens live in localStorage with client-side refresh (the BFF migration removed this — src/client/main.jsx:8 actively deletes the legacy `tesla_tokens` key, api.js is cookie-based); line 72 documents `/api/notifications/enable` taking `refresh_token` in the body (dropped in 0fcf487); lines 87-88 say the Slack bot identity 'is shared with the host (tinyclaw). Splitting to a dedicated app would...' when the split already shipped (12b865e, file-first token in data/slack-install.json); lines 97/146 reference editing subscriptions.json. Since this repo is developed agent-first, CLAUDE.md is injected into every session as ground truth — it currently teaches the pre-BFF token flow the migration existed to kill.

**Suggestion:** One doc pass: fix the seven sections above (Architecture file map, Storage, Token storage, enable/disable/status request shapes incl. the new Tesla-cookie proof on /status+/disable, Slack DM identity, stub cleanup paths). Then adopt the rule that any commit renaming files or changing auth flow touches CLAUDE.md in the same commit.

> **Operator note (tinyclaw):** VERIFIED the file is committed and predates the BFF migration. Agent's specifics spot-checked. Cheap fix with high confusion-prevention value given agents (me included) read it as ground truth.

#### [P2·S·h] README cold-start is broken: references a .env.example that has never existed, and the env table + token sections are pre-BFF

/home/ec2-user/projects/tesla-sweeper/README.md line 54 says `cp .env.example .env`, but `.env.example` is not in the tree and `git log --all -- .env.example` is empty — it never existed. The env table (lines 71-83) is missing SLACK_SIGNING_SECRET, SLACK_INSTALL_REDIRECT_URI, and SLACK_TEAM_ID (all present in the prod .env and required by the new install flow), and presents SLACK_BOT_TOKEN as the DM mechanism when resolution is now file-first from data/slack-install.json with env only as fallback (src/server/integrations/slack.js:10). Line 106 'Tokens are stored in localStorage for session persistence' and line 114 'Refresh tokens live in data/subscriptions.json' are both pre-migration. Future-VoX cold-starting on a new box (or kit standing up a twin) reconstructs 15 env vars from a stale table.

**Suggestion:** Commit a real .env.example listing all 15 variable names with placeholder values and one-line comments (verify the list against `grep -rho 'process.env.[A-Z_]*' src/server | sort -u`), fix line 54's promise, refresh the env table, and rewrite the localStorage/subscriptions.json sentences to match the BFF model.

#### [P2·M·h] Prod client builds on EOL vite 5 while tests and the preact preset resolve to vite 8 in the same tree (deepens known alignment item)

`npm ls vite` shows the split concretely: src/client's declared `vite ^5.4.0` installs nested at src/client/node_modules/vite@5.4.21 (EOL line), while vitest@4.1.5, @vitest/mocker, AND @preact/preset-vite@2.10.5's own vite dependency all dedupe to hoisted node_modules/vite@8.0.11. So `npm run build` bundles with vite 5 but `npm test` transforms client code through vite 8 — tests exercise a different bundler major than production output, and any vite-5-only behavior is invisible to tests (and vice versa). The unblock is cheaper than the open item implies: @preact/preset-vite@2.10.5's peer range is '2.x || ... || 8.x' (verified in node_modules), so no preset upgrade is needed.

**Suggestion:** Bump src/client/package.json `vite` to ^8, `npm install`, then smoke the two custom plugins in src/client/vite.config.js across the major (the closeBundle brotli writer and the transformIndexHtml CSS inliner — the file's own comment history shows these hooks are bundle-lifecycle-sensitive) and diff a fresh dist/ against the current one before deploying.

#### [P3·S·h] Shipped plan docs in docs/ carry no lifecycle status and describe dead reality in present tense

docs/bff-token-ownership-plan.md marks only Phase 0 'DONE' even though all 8 phases shipped (commit 0fcf487 is literally titled 'phase 8'); its 'The bug, concretely' section describes a localStorage rotation collision that no longer exists. docs/repo-restructure-plan.md still says 'server.js is 1071 lines' and 'App.jsx is 853 lines' (both long since decomposed); tab-refactor-plan.md and stub-vehicle-plan.md are similarly executed-but-unmarked. A cold reader — including a future agent session told to consult docs/ — cannot distinguish plan from current truth, which is the exact drift class the repo's CLAUDE.md problem (finding 1) already demonstrates.

**Suggestion:** Add a one-line header to each shipped plan: 'STATUS: shipped <date>, see commit <sha> — kept as historical record; code is the source of truth', or move the four completed plans to docs/archive/. docs/notification-scenarios.md stays as-is (it's referenced as the live planner spec by CLAUDE.local.md).

#### [P3·S·h] CLAUDE.local.md ops runbook contains a list-subscriptions command that fails and a stale test description

/home/ec2-user/projects/tesla-sweeper/CLAUDE.local.md line 59: 'List subscriptions | cat data/subscriptions.json | jq' — that file no longer exists (data/ holds users.json + slack-install.json, and the same doc's own 'State on disk' section at line 21 says so). Line 63: 'Run unit tests | npm test (vitest, planner only)' — there are 21 test files across both workspaces now. This is the doc that gets grepped mid-incident; the one command most likely to be run while debugging a notification problem is the one that errors.

**Suggestion:** Change line 59 to `cat data/users.json | jq` and line 63 to drop '(planner only)'. Worth a 60-second consistency skim of the rest while in there since it was edited as recently as Jun 12.

#### [P3·S·h] No way to tell which commit is actually live: zero tags, all versions frozen at 1.0.0, /healthz has no build identity

`git tag -l` is empty, all three package.json files sit at 1.0.0 permanently, and the deploy flow ('npm run build && systemctl --user restart' per CLAUDE.local.md) serves whatever the worktree held at build time. The live /healthz (verified: returns ok/last_run_at/last_digest_run_at/last_dm_success_at/last_dm_error/sub_count) carries no commit sha, so after a week like this one (5 hardening commits) confirming 'is the cookie-proof change actually deployed?' requires inferring from dist/ mtimes. With two operators and agent-driven pushes, drift between HEAD and the running process is the realistic failure.

**Suggestion:** In src/server/index.js, resolve the sha once at boot (`execSync('git rev-parse --short HEAD')` in a try/catch, fallback 'unknown') and add a `commit` field to the /healthz payload. Tags/semver are not worth maintaining at this scale — skip them.

#### [P3·S·h] Minimal CI spec that pays for itself (deepens known no-CI item): one ~15-line workflow gating npm ci + test + build

The repo lives at github.com/VoX/tesla-sweeper with no .github/ directory. Three concrete, already-observed failure classes a single workflow would catch: (1) lockfile desync — `npm ci` fails hard where local `npm install` silently mutates; (2) config-divergent test invocation — the root vitest.config.js header comment documents exactly the class of 'all 19 client tests fail depending on how vitest is invoked' breakage that a pinned CI invocation freezes; (3) the vite 5→8 bump (finding 3) and any future dep move needs a green gate that isn't 'an agent ran tests in its own sandbox'. At this commit volume the run cost is ~1 minute on the free private-repo Actions tier. Anything beyond this (lint, coverage, deploy automation) is over-tooling for two users.

**Suggestion:** Add .github/workflows/ci.yml: on push+PR → actions/checkout@v4, actions/setup-node@v4 with node-version 22 and cache npm, then `npm ci`, `npm test`, `npm run build`. Nothing else.

#### [P3·S·h] Node version contract only declared in the server workspace; root install on old node fails late instead of early

src/server/package.json declares engines node>=22 but the root and client package.json files do not, there is no .nvmrc, and npm without engine-strict only warns on engines anyway. The prod box runs v22.22.3 so this never bites in place — it bites exactly in the cold-start-elsewhere scenarios that are real for this project (new box rebuild, kit standing up a parallel install): `npm install && npm run dev` on node 18/20 proceeds and then dies at runtime on node-22-isms instead of failing at install.

**Suggestion:** Add `"engines": {"node": ">=22"}` to the root /home/ec2-user/projects/tesla-sweeper/package.json and commit a one-line `.nvmrc` containing `22`; optionally add `engine-strict=true` in a committed .npmrc to turn the warning into a hard stop.

### Hosting & operations

#### [P1·S·h] Nothing polls /healthz — the DM-health fields shipped this week are write-only

Verified: live https://sweeper.bitvox.me/healthz returns {ok, last_run_at, last_dm_success_at, last_dm_error, sub_count}, but no consumer exists. No crontab (crontab binary isn't even installed on the box), no scheduler job, and the existing daily automated health pass (/home/ec2-user/claude-discord/tinyclaw/scripts/morning-rounds.md, section 6) only checks `systemctl --user is-active tesla-sweeper.service` and that https://sweeper.bitvox.me/ returns 200 — a wedged node-cron, a stale last_run_at, or a failing Slack DM path all pass both checks. The app's entire job is the DM; a silent DM failure means kit's car gets towed while the service reports green. Live data right now: last_dm_success_at=null, last_dm_error=null — unverifiable whether the DM path has worked since the fields shipped.

**Suggestion:** Add 3 lines to morning-rounds.md section 6 (the loop already runs daily at 10:00 UTC): `curl -s https://sweeper.bitvox.me/healthz` then flag yellow/red if (a) ok != true, (b) last_run_at older than 30h (catches any missed noon run regardless of cause — DST, node-cron bug, wedge), (c) last_dm_error non-null, (d) `systemctl --user show tesla-sweeper -p NRestarts` > 0. Zero new infrastructure; this is the cheapest real monitoring available on this box.

> **Operator note (tinyclaw):** Accepted as my action item: I will add a sweeper /healthz check (assert ok:true and last_dm_error null, alert VoX otherwise) to my existing daily morning-rounds cron — zero sweeper code needed.

#### [P1·M·h] Backup gap is bigger than 'users.json': the full unrecoverable set is users.json + slack-install.json + .env + keys/private-key.pem, and the box has no backup mechanism at all

Deepens the known open item. All four credential files are gitignored (verified in /home/ec2-user/projects/tesla-sweeper/.gitignore: `data/`, `.env`, `keys/`), single copy, same EBS volume. No cron daemon exists for ec2-user, no ~/backups dir, no backup systemd timer found. Loss ranking: keys/private-key.pem (mode 600, the Tesla vehicle-command key) is the worst — recreating it requires re-pairing the virtual key with the physical car, i.e. kit standing next to the Tesla; .env loss means re-issuing the Slack app creds and Tesla client config; users.json loss means kit re-doing the OAuth dance (the server owns the canonical refresh_token per the BFF model, so there is no client-side copy to recover from). EBS snapshot policy is unverifiable from the box (IMDS blocked in my sandbox), so assume none.

**Suggestion:** Add a systemd user timer (the box's established pattern — no cron available): tesla-sweeper-backup.timer, daily, running `tar czf ~/backups/tesla-sweeper/$(date +%F).tgz -C ~/projects/tesla-sweeper data .env keys && chmod 600 ~/backups/tesla-sweeper/*.tgz` plus a `find -mtime +14 -delete` rotation. The store's atomic rename writes make file-copy backups consistent. That covers fat-finger/corruption; for box loss, add one `aws s3 cp` line to a private bucket (aws CLI is at /usr/bin/aws — verify credentials/instance role first) or confirm an EBS snapshot schedule exists in the AWS console.

> **Operator note (tinyclaw):** VERIFIED keys/private-key.pem exists (Tesla Fleet command-signing key, gitignored, single copy). The four-file restore set framing is right; posture remains an owner call.

#### [P2·S·h] No memory limit on the unit, on a shared box with a real OOM precedent

Verified via `systemctl --user show tesla-sweeper`: MemoryHigh=infinity, MemoryMax=infinity, no CPUQuota. The unit file (/home/ec2-user/.config/systemd/user/tesla-sweeper.service) sets nothing. This 16GB box has previously been thrashed to unusability by one runaway node process (duplicate dweller instance, 2026-05-28), and tesla-sweeper shares it with multiple bots and game servers. Sweeper currently uses 33MB — but it holds in-process caches (nominatim reverse/side caches) and an unbounded leak would degrade every co-tenant before anyone notices. The protection is asymmetric: one line buys containment, and at 33MB steady-state a 512M ceiling is 15x headroom.

**Suggestion:** Add to [Service] in tesla-sweeper.service: `MemoryHigh=256M` and `MemoryMax=512M` (kernel reclaims at 256M, OOM-kills only sweeper at 512M, systemd restarts it via the existing Restart=on-failure). While in the file, change `Restart=on-failure` to `Restart=always` — uncaughtException exits 1 so on-failure covers crashes today, but always also covers any future clean-exit path for free. `systemctl --user daemon-reload && systemctl --user restart tesla-sweeper`.

#### [P2·S·h] Deploy is an undocumented-order two-step by hand with no post-deploy verification, building into the live dist/

Deploy per CLAUDE.local.md line 58 is `npm run build && systemctl --user restart tesla-sweeper.service`, run manually in the production working tree (which is also the dev tree — origin is github.com/VoX/tesla-sweeper but the service runs whatever is checked out/edited). Two gaps verified: (1) nothing confirms the service actually came back healthy after restart — a bad deploy at 1pm is invisible until the next morning-rounds pass (or until kit misses a DM); (2) vite builds with emptyOutDir:true (src/client/vite.config.js:79) directly into the dist/ the live Express process is serving, so during the build window the old server serves a half-empty dist, and any browser tab open across a deploy 404s on lazy-loaded hashed chunks (the leaflet chunk). For 2 users (2) is cosmetic, but (1) is the difference between 'deploy verified' and 'deploy assumed'.

**Suggestion:** Add scripts/deploy.sh: `set -euo pipefail; npm test; npm run build; systemctl --user restart tesla-sweeper; sleep 2; curl -fsS localhost:20040/healthz | grep -q '"ok":true'` — and update the CLAUDE.local.md ops table to point at it. One file, removes the forgotten-build and silent-bad-restart failure modes in one move.

#### [P3·S·h] Missed-run recovery is boot-only — a skipped cron fire with the process still up is never recovered

Deepens the known DST item. src/server/notifications/cron.js: maybeRecoverMissedRun()/maybeRecoverMissedDigest() run only from index.js at startup (index.js:25-28). node-cron 4.x with timezone:'America/New_York' should handle DST, but if a fire is ever skipped while the process stays alive (node-cron tz edge, event-loop stall during the noon window, clock weirdness), nothing re-fires until the next restart — and restarts are rare (NRestarts=0, the unit runs for weeks). The recovery functions are already idempotent (they no-op when last_run_at is today in ET, cron.js:241-244), so they are safe to call repeatedly; they're just never called.

**Suggestion:** In startNotificationCron() (cron.js:193), add an hourly self-heal: `setInterval(() => { maybeRecoverMissedRun()?.catch?.(...); }, 60*60*1000)` chained sequentially with the digest recovery (same cross-mode-overlap rule as the boot path). Combined with the healthz last_run_at age check from the morning-rounds finding, this closes both the detect and the repair half of the DST/skipped-fire question.

#### [P3·S·h] Runbook drift in CLAUDE.local.md: ops table still points at legacy subscriptions.json

CLAUDE.local.md line 59: 'List subscriptions | cat data/subscriptions.json | jq' — the store migrated to data/users.json (documented correctly 40 lines earlier in the same file). Worse, per line 31 the server deliberately refuses to start if a subscriptions.json is present but unparseable — so an operator following the stale runbook line during an incident is poking at a file whose mere existence is a startup landmine. Incident runbooks are exactly the doc that must not lie; this file is the only ops reference for the service.

**Suggestion:** Fix the table row to `cat data/users.json | jq` (and sweep the rest of the ops table against current reality — it predates the users.json migration). Five-minute edit.

#### [P3·S·m] Port 20040 is pinned in two places with no box-wide registry; a squatted port becomes an infinite silent 5s crash-loop

PORT=20040 is hardcoded in both the unit file (Environment=PORT=20040) and /etc/caddy/Caddyfile:7. The 200xx convention range is filling up — live listeners verified at 20010, 20020, 20021, 20030, 20040, 20050 — and at least three autonomous agents deploy services on this box. If sweeper is stopped during maintenance and another deploy grabs 20040, the restart hits EADDRINUSE → uncaughtException → exit(1) → Restart=on-failure every 5s forever (no StartLimit configured, and with RestartSec=5 the default 5-in-10s limiter mathematically never trips). Detection waits for the next morning rounds.

**Suggestion:** Create /home/ec2-user/projects/PORTS.md listing the 200xx assignments (20010, 20020, 20021, 20030, 20040=tesla-sweeper, 20050=endllmless, ...) and reference it from each project's CLAUDE.local.md so every agent that deploys here checks it. Optionally add `StartLimitIntervalSec=120` + `StartLimitBurst=10` + `OnFailure=` later, but the registry is the actual fix.

### Test suite

#### [P1·S·h] parseSweepFlags — the only parser of live Recollect data — has zero tests; every suite mocks it (highest-value missing test #1)

src/server/integrations/recollect.js:36-53 (parseSweepFlags) is the load-bearing translator from Recollect's raw event flags to the {date, side, time} shape that sweep/check.js, the planner, and every DM verdict are built on. It contains real parsing logic: a `(\d{1,2})(AM|PM)_(\d{1,2})(AM|PM)` time regex, EVEN/ODD substring detection, and a silent fallback to side:'both' (which triggers the aggressive both-sides-flag plan class) when neither token matches. Yet __tests__/recollect.test.js only covers suggestAddress filtering, and sweep.test.js:7-11 and routes.test.js:38-42 both vi.mock it. A refactor that breaks the regex or the EVEN/ODD detection ships green and fails only at noon ET in kit's DMs. Same file: fetchSweepEvents' array-vs-{events:[]} dual shape handling (recollect.js:30) is also untested.

**Suggestion:** Add a describe('parseSweepFlags') block to src/server/__tests__/recollect.test.js using a fixture captured from the real Somerville events endpoint (one curl, paste the JSON): assert an EVEN flag yields {side:'even', time:'8:00 AM - 12:00 PM'}, an ODD flag yields odd, a non-sweeping flag (trash/recycling) is dropped, events without flags/day are skipped, and a sweeping flag without EVEN/ODD maps to 'both'. The fixture doubles as documentation of the real upstream shape.

> **Operator note (tinyclaw):** Endorsed as the #1 missing test — it is the only parser of live third-party data and the schema-drift finding (arch) lands exactly here.

#### [P1·M·h] maybeRecoverMissedRun / maybeRecoverMissedDigest have zero tests — the missed-noon-DM safety net is unverified (highest-value missing test #2)

src/server/notifications/cron.js:236-264 implements boot-time recovery of a missed noon run / Sunday digest — the guarantee that a service restart between noon and the next cron doesn't silently skip the day kit gets towed. These functions are pure timezone logic (ET hour extraction via Intl, ET-date comparison of last_run_at, Sunday+20h gating) and are referenced in tests only as vi.fn() mocks (routes.test.js:55-56, install.test.js:24-25). Nobody asserts they fire when they should, or stay quiet when they shouldn't. The UTC-server/ET-comparison seam (last_run_at stored as UTC ISO, compared as ET date) is exactly where a DST or off-by-one bug would hide — note the suite has no vi.setSystemTime/useFakeTimers anywhere (verified by grep), so no time-dependent path in the codebase is pinned.

**Suggestion:** Add a describe block in src/server/__tests__/notifications-cron.test.js using vi.setSystemTime: (a) 13:00 ET with store.last_run_at = yesterday → returns the runNotifications promise; (b) 11:00 ET same store → returns null; (c) 13:00 ET with last_run_at = today-05:00Z (early-UTC-morning = yesterday evening ET edge) → fires; (d) Sunday 21:00 ET with last_digest_run_at = last Sunday → digest fires; Monday → null. loadStore is already mocked in that file.

#### [P1·S·h] DM-failure bookkeeping (the May 2026 silent-breakage defense) is untested: nothing proves last_dm_error gets written or that a failed DM retries next day (highest-value missing test #3)

cron.js:168-184 writes store.last_dm_success_at / store.last_dm_error — the fields /healthz just gained this week specifically because rotated Slack tokens once killed DMs for weeks while checks stayed green. notifications-cron.test.js never exercises postSlackDM returning {ok:false}: it never asserts (1) dm_sent=false + dm_error propagate to results, (2) last_dm_date is NOT patched on failure (cron.js:130 — this is what makes tomorrow retry instead of dedup-skipping), (3) store.last_dm_error gets the timestamped error string, (4) the saveStore gate at :171 fires on a dm-attempts-only run. Also untested in the same file: the daily dm_skipped='already-sent-today' dedup branch (:125 — only the weekly twin is tested at test line 167-177) and the stuck-sub DM threshold+24h-cooldown block (:150-160).

**Suggestion:** In notifications-cron.test.js add: postSlackDM.mockResolvedValue({ok:false, error:'invalid_auth'}) → assert results[0].dm_sent===false, no patchUser call containing last_dm_date, and saveStore called with store.last_dm_error matching /invalid_auth/. Add a daily-dedup case (sub with last_dm_date=todayET → dm_skipped, postSlackDM not called with the plan DM) and a stuck-sub case (consecutive_failures:3, last_dm_error_at 25h ago → warning DM sent + last_dm_error_at patched; 1h ago → suppressed).

#### [P2·S·h] Fetch-router mock uses a precision-safe vehicle id, so the 'BigInt-safe id stringification' it claims to cover is untestable — and the underlying code can't actually be safe

session-routes.test.js:58 stubs the Tesla vehicle list with id 1234567890123456 (~1.2e15, below Number.MAX_SAFE_INTEGER 9.007e15), and routes.test.js:299-301 says BigInt-safe stringification coverage lives there. But listVehicles (src/server/integrations/tesla.js:66-82) does String(v.id) AFTER res.json() — String() cannot restore precision JSON.parse already lost, despite the comment at tesla.js:61-63 claiming this handles 16-digit ids above MAX_SAFE_INTEGER. Tesla's API ships id_s (string) precisely for this; the code ignores it. If kit's real id is above 2^53, /api/check would target a corrupted id. The mock's safe id means the test suite structurally cannot catch this; it green-lights a comment that is wrong.

**Suggestion:** Change tesla.js:77 to id: v.id_s ?? String(v.id), then make the fixture honest: give the mocked vehicle id_s:'9007199254740995' alongside id: 9007199254740996 (the rounded double) and assert /api/vehicles returns '9007199254740995'. One-line code change, two-line test change.

#### [P2·M·h] Client: the Tesla OAuth return path and the core check/cache flow in App.jsx are untested (the Slack OAuth return is — the asymmetry is backwards)

App.test.jsx covers mount probes, the Slack callback return, and enable-button gating — good tests. But App.jsx's biggest, most-branching logic has zero coverage: (1) the Tesla OAuth return (App.jsx:492-543): session/create success → single-vehicle auto-wake-check, state-mismatch error (:493), and the 400 → 'Sign-in setup expired' mapping (:534); (2) checkVehicle (:266-304): check → reverse-geocode → sweep-check chaining, the no-street fallback card, the not-found → setError branch, and saveCachedCheck on success; (3) autoCheckOnLoad (:310-324): cache hydration via readCachedCheck and — most consequentially for the one real Tesla on this system — the v.state==='online' gate that prevents passive page loads from waking/draining kit's car; (4) handleAuthExpired on a 401 (:136-145). The existing routes-mock pattern in App.test.jsx supports all of these with no new infrastructure.

**Suggestion:** Add 3 tests to src/client/__tests__/App.test.jsx: (a) tesla_oauth_state in sessionStorage + ?code= → session/create called, vehicles rendered, check fired for a single online vehicle; (b) cached check present (seed localStorage via saveCachedCheck) + authenticated session → sweep results render with NO /api/check fetch call; (c) vehicles=[{state:'asleep'}] on mount → assert /api/check is never called (the no-silent-wake guarantee).

#### [P2·S·h] --passWithNoTests in the client test script turns 'vitest collected zero client tests' into a green build

src/client/package.json test script is `vitest run --passWithNoTests`. That flag predates the 8 client test files that now exist; today its only effect is masking the failure mode where a config regression stops client tests being discovered at all. This materially deepens the known vite-5/vitest-4 alignment item: the most likely symptom of a future major-version mismatch is exactly 'client project collects nothing' (the root vitest.config.js comment at lines 1-7 documents that client tests already fail wholesale without the right config wiring), and with no CI there is no test-count diff to notice. `npm test` would silently shrink from ~21 files to 13.

**Suggestion:** Delete --passWithNoTests from src/client/package.json. If a no-tests state is ever legitimate again, that's the moment to re-add it deliberately.

#### [P3·M·h] Determinism: notifications-cron.test derives 'today' from the real clock at module scope; tesla-auth retry tests pay real backoff sleeps; OAuth state TTL never exercised

(1) notifications-cron.test.js:43-47 computes todayET and the sweep-event fixture dates at import time, while runNotifications recomputes todayET at call time (cron.js:36) — a suite that straddles ET midnight fails the last_dm_date assertion (:151) and the weekly-dedup case (:170). Rare, but it's the classic unreproducible flake. (2) tesla-auth.test.js retry cases (:136-165) run against the real RETRY_BACKOFF_MS=500 (tesla-auth.js:25), adding ~1.5s of wall sleep per run. (3) The 10-minute state TTL (util/oauth-state.js:30) and the cap-overflow → null mint (:21) are untested — install.test.js covers replay and unknown state but not expiry, which is the remaining install-flow edge. All three resolve with the same tool the suite currently never uses: vi.useFakeTimers/setSystemTime.

**Suggestion:** Pin the clock with vi.setSystemTime in notifications-cron.test.js (then derive todayET from the pinned value); wrap the tesla-auth retry tests in fake timers (advanceTimersByTimeAsync(500)); add one consumeState-after-11-minutes expiry case to install.test.js or a new oauth-state test.

#### [P3·M·h] The wake-and-poll path (408 → wake_up → 12×5s poll) has no test despite being the app's longest, most user-visible failure mode

src/server/integrations/tesla.js:24-41 (teslaWakeAndPoll) and the 408 branch of fetchVehicleData (:90-94) are untested; session-routes.test.js only feeds the happy 200 vehicleDataResponse. The 60s wake UX in App.jsx and the cron's per-sub error handling both depend on this path's exact behavior (false → 'Vehicle did not wake within 60s' throw). It only runs in production when the car is actually asleep — i.e., it's exercised least when it matters most.

**Suggestion:** Add a tesla.test.js using fake timers: fetchVehicleData mock-fetch sequence [408, wake_up 200, poll asleep, poll online, vehicle_data 200] → resolves with data; and [408, wake_up 200, 12× asleep] → rejects /did not wake/. Pure module, fetchWithTimeout is already the established mock seam.

#### [P3·M·m] E2E smoke verdict: skip playwright; the unmet risk is client↔server contract drift, which a cheap supertest contract test covers

Asked-for assessment: a playwright rig against the stub vehicle is poor value here — the stub Tesla flow still requires a real OAuth session cookie, the manual tab requires live Nominatim/Recollect, and the maintenance cost of a browser harness for two users exceeds its catch-rate. The real uncovered seam is contract drift: App.test.jsx mocks fetch wholesale (App.test.jsx:14-26) and server tests use supertest, so a renamed response field (e.g. vehicles[].is_stub, session/me's slack_user_id) leaves both suites green while the deployed SPA breaks. The deploy-time backstop that does exist (/healthz, public probe endpoints) is manual.

**Suggestion:** Instead of playwright: one vitest file that boots buildApp() via supertest and asserts the handful of response shapes the client actually destructures (session/me keys, vehicles[].{id,name,state,is_stub}, sweep-check.{found,status,title,sweep_events}, notifications/status.subscriptions[].{id,vehicle_id}) against a shared fixture imported by App.test.jsx's routes mock — drift then breaks one suite or the other. Optionally keep a 3-line curl smoke (GET /healthz, POST /api/sweep-check with a fixed address) as a post-deploy habit.

### Security (fresh pass)

#### [P2·S·h] /api/reverse-geocode is an unauthenticated, unrate-limited Nominatim proxy — flooding it can starve the cron's own geocode

In src/server/routes/vehicles.js:92-102 the `/api/reverse-geocode` handler validates lat/lng then calls `reverseGeocodeLocation` directly — it never reads the session cookie (the `readSessionCookie`/`loadUserBySession` calls at lines 39 and 57 belong to `resolveAccess` and `/api/check`, not this route) and has no `rateLimit(...)` wrapper. The 'rate limits on probe endpoints' fix landed on `/api/which-side` and `/api/sweep-check` (probes.js:12,20) but missed this one, even though it is the most open of the three: anonymous, no body limit beyond the global 10kb, and it hits OSM Nominatim. All Nominatim traffic shares one process-wide 1 req/sec queue with a 30s/~30-deep saturation cap (integrations/nominatim.js:28-40). An attacker curling `/api/reverse-geocode` with distinct coordinates (each a cache miss) at >1/s pushes `nextSlot` ~30s into the future; the daily noon cron's own `reverseGeocodeLocation` call (notifications/cron.js:66) then either blocks or throws 'Nominatim queue saturated'. That surfaces as 'No street resolved' → the sub's check fails → after 3 runs a stuck-sub DM fires. Sustained flooding also risks the app's fixed User-Agent/IP getting OSM-banned per their usage policy.

**Suggestion:** Wrap `/api/reverse-geocode` in `rateLimit({ perMinute: 12 })` exactly like the two probe routes in probes.js, and ideally require the session cookie (the SPA already sends it with `credentials:'include'`) since only logged-in/manual-tab flows legitimately call it.

> **Operator note (tinyclaw):** VERIFIED — I rate-limited which-side and sweep-check in the fat review and missed reverse-geocode in the same file. Same one-line fix.

#### [P2·S·h] Per-IP rate limit is bypassable by spoofing X-Forwarded-For (code trusts the first segment; Caddy appends the real IP last)

middleware/ratelimit.js:13-14 keys the token bucket on `(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim()` — the FIRST entry of XFF. The sweeper Caddy block (/etc/caddy/Caddyfile) is a plain `reverse_proxy localhost:20040` with no `trusted_proxies` and no XFF stripping, so Caddy's default behavior applies: it preserves any client-supplied X-Forwarded-For and APPENDS the real peer IP to the end. A client sending `X-Forwarded-For: <random>` therefore arrives at Node as `<random>, <realIP>`, and the limiter reads `<random>`. Rotating that value every request yields a fresh bucket each time — a complete bypass of the 12/min limits on /which-side and /sweep-check (and of any limit added to /reverse-geocode). The trustworthy value is the LAST segment, which only Caddy can set.

**Suggestion:** In ratelimit.js use the last hop instead of the first: `const xff=(req.headers['x-forwarded-for']||'').split(',').map(s=>s.trim()).filter(Boolean); const ip = xff.length ? xff[xff.length-1] : (req.socket.remoteAddress||'?');` — or set `app.set('trust proxy', 1)` in app.js and key on `req.ip`. With exactly one trusted proxy hop, the last XFF element is the unspoofable client IP.

> **Operator note (tinyclaw):** VERIFIED my own bug — ratelimit.js takes .split(',')[0]; Caddy APPENDS the real client IP, so the last element is the trustworthy one. Fix: take the last entry.

#### [P3·M·m] BFF session cookie never expires server-side — the signed value is valid until logout/re-OAuth, and pruneOrphaned explicitly skips logged-in records

crypto/session.js:40-58 `signOpaque`/`verifyOpaque` bake NO expiry into the cookie: the value is just `${sid}.${hmac}` and `verifyOpaque` accepts it forever. The file header claims lifetime is bounded by 'the cookie's Max-Age and the user record's last_seen_at prune' — but neither actually bounds a logged-in session. Max-Age is client-side advisory (an attacker holding the raw signed value just keeps sending it past 30 days), and `pruneOrphaned` (store/users.js:179-192) only deletes records where `!session_cookie_id` — a record with a live `session_cookie_id` is never pruned no matter how stale `last_seen_at` is, and no route re-checks `last_seen_at` on inbound requests. So a captured `session` cookie (HttpOnly+Secure narrows the surface to local malware / device theft, not network/JS) grants indefinite BFF access to the Tesla account (location + the full /api/vehicles,/check surface) until the user manually logs out or re-OAuths (which does rotate the sid — good). The comment describes a control that doesn't fire.

**Suggestion:** Bake an exp into the opaque token (`signOpaque(`${sid}.${expMs}`)` and reject in `verifyOpaque` when expired), or add a request-time idle check / nightly job that nulls `session_cookie_id` on records whose `last_seen_at` is older than the intended 30 days even when a cookie is bound, and bump `last_seen_at` on session reads.

#### [P3·S·l] Tesla id_token `sub` is trusted as the account identity key with no signature AND no aud/iss check — asymmetric with the hardened Slack handler

routes/session.js:51-80 `resolveTeslaAccountId` decodes the Tesla id_token payload and returns `claims.sub` (the find-or-create key for the whole user record / refresh_token) after checking only `exp`. It deliberately skips iss/aud (the comment cites Tesla's undocumented issuer string). Skipping the JWT signature is defensible per OIDC since the token arrives directly from Tesla's token endpoint over TLS — but the Slack callback right next door (routes/oauth.js:124-126) still pins both `iss==='https://slack.com'` and `aud===SLACK_CLIENT_ID` as defense-in-depth against a response-shape regression or an upstream proxy injecting a foreign token. The Tesla path has no equivalent floor, so a bug that mixed up token responses could bind a session/record to an attacker-influenced `sub`.

**Suggestion:** Mirror the Slack handler's audience pin: after parsing claims, also require `claims.aud === TESLA_CLIENT_ID` (Tesla's id_token sets `aud` to the requesting client_id) before trusting `sub`. iss can stay unpinned given it's undocumented; aud alone closes the asymmetry.

> **Operator note (tinyclaw):** Partially mitigated by transport trust (token came directly from Tesla over TLS in the same exchange — identical model to the Slack handler before its claims checks). Adding iss/aud/exp checks is cheap symmetry; keep P3.

#### [P3·S·l] Slack HMAC session token is sent as a GET query parameter on /api/notifications/status

App.jsx `fetchSubscriptions` (lines 161-172) puts the live 30-min HMAC bearer into the query string: `get('notifications/status?'+params)` with `params.set('slack_session', ...)`, and routes/notifications.js:130-148 reads it from `req.query`. Credentials in URLs are a known leak class — they land in any access log, proxy log, or APM that records request lines. Today the practical surface is small (the sweeper Caddy block has no `log` directive, the token lives in sessionStorage not the address bar, and same-origin fetch Referer doesn't carry the fetch URL), so this is defense-in-depth, not an active leak. But the moment Caddy logging or any request-logging middleware is turned on, every status poll writes a replayable (30-min) Slack session token to disk.

**Suggestion:** Move `slack_session` out of the query string: send it as an `Authorization`/custom header on the GET, or convert /status to a POST with the token in the JSON body (the cookie fallback path already works without it). Keeps it out of URLs/logs.

> **Operator note (tinyclaw):** DOWNGRADE in practice: neither express nor Caddy logs request URLs on this box, so the leak surface is essentially browser history on the user's own machine. Move to a header someday when touching the route; not urgent.

#### [P3·S·h] /healthz returns raw last_dm_error strings and sub_count with no auth

routes/probes.js:31-43 serves `/healthz` unauthenticated with `last_dm_error` echoed verbatim (`${timestamp}: ${slack API error}`), plus `sub_count` and the run timestamps. For a 2-user app this is near-harmless (no PII/tokens, the Slack error codes like `channel_not_found` aren't secret), and an ops probe wants to be curl-able — but it does broadcast subscriber count and internal failure detail to anyone. Listed here for completeness against the /healthz dimension; it is genuinely low.

**Suggestion:** Either leave it (acceptable) or reduce `last_dm_error` to a coarse boolean/age in the public response and keep the verbose string behind the existing NOTIFICATIONS_RUN_TOKEN bearer if you want full detail.
