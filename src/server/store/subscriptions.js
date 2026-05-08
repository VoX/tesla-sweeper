// On-disk subscription store. Holds Tesla refresh_tokens (mode 0600,
// never logged). Atomic write via temp+rename; corrupt files moved
// aside instead of silently nuked.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// store/ lives at src/server/store/, so the data/ dir is three up.
const SUBS_DIR = join(__dirname, '..', '..', '..', 'data');
const SUBS_FILE = join(SUBS_DIR, 'subscriptions.json');

mkdirSync(SUBS_DIR, { recursive: true, mode: 0o700 });

export function loadStore() {
  let raw;
  try { raw = readFileSync(SUBS_FILE, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { subscriptions: [] };
    throw e;
  }
  try { return JSON.parse(raw); }
  catch (e) {
    const aside = `${SUBS_FILE}.corrupt.${Date.now()}`;
    try { renameSync(SUBS_FILE, aside); } catch {}
    console.error(`[store] parse failed, moved aside to ${aside}: ${e.message}`);
    return { subscriptions: [] };
  }
}

export function saveStore(store) {
  const tmp = SUBS_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, SUBS_FILE);
}

export function loadSubs() { return loadStore().subscriptions || []; }
export function saveSubs(subs) { const s = loadStore(); s.subscriptions = subs; saveStore(s); }

export function publicSub(s) {
  return { id: s.id, slack_user_id: s.slack_user_id, vehicle_name: s.vehicle_name,
    vehicle_id: s.vehicle_id, created_at: s.created_at, last_check_at: s.last_check_at };
}

// Re-loads the store so concurrent /enable or /disable during a cron
// run isn't clobbered. Drops the patch if the sub was disabled mid-run.
// Logs a warning so a rotated-then-lost refresh_token (user disabled
// between rotation and patch) is at least visible in the journal.
export function patchSub(subId, patch) {
  const store = loadStore();
  const sub = (store.subscriptions || []).find(s => s.id === subId);
  if (!sub) {
    console.warn(`[store] patchSub: sub ${subId} not found (disabled mid-cron?), patch dropped: ${Object.keys(patch).join(',')}`);
    return;
  }
  Object.assign(sub, patch);
  saveStore(store);
}
