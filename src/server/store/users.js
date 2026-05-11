// On-disk user store. One record per Tesla account. Holds the canonical
// refresh_token (mode 0600, never logged) plus an optional session-cookie
// binding and optional notification-subscription fields. Atomic write via
// temp+fsync+rename; corrupt files moved aside instead of nuked.
//
// BFF migration (docs/bff-token-ownership-plan.md): this replaces the old
// subscriptions.json. A subscription is now a user record with
// slack_user_id + vehicle_id populated; a logged-in browser is a record
// with session_cookie_id populated. Either, both, or neither (the last is
// a prune candidate).

import {
  readFileSync, openSync, writeSync, fsyncSync, closeSync,
  renameSync, mkdirSync, existsSync,
} from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// store/ lives at src/server/store/, so the data/ dir is three up.
// SWEEPER_DATA_DIR overrides for tests so importing this module doesn't
// touch (or migrate) the real data/ dir.
const DATA_DIR = process.env.SWEEPER_DATA_DIR || join(__dirname, '..', '..', '..', 'data');
const USERS_FILE = join(DATA_DIR, 'users.json');
const LEGACY_FILE = join(DATA_DIR, 'subscriptions.json');

mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

// open+write+fsync+close THEN rename so a power-loss between the tmp write
// and the rename can't leave a zero-byte file (which loadStore would treat
// as corrupt and move aside, dropping every record on the floor).
function writeAtomic(path, obj) {
  const tmp = path + '.tmp';
  const fd = openSync(tmp, 'w', 0o600);
  try { writeSync(fd, JSON.stringify(obj, null, 2)); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(tmp, path);
}

// One-time migration: subscriptions.json → users.json. Each old sub
// becomes a user record with the BFF fields defaulted. The old file is
// renamed to .pre-bff as a safety net (not deleted) — restore by mv.
function migrateLegacy() {
  if (existsSync(USERS_FILE) || !existsSync(LEGACY_FILE)) return;
  let legacy;
  try { legacy = JSON.parse(readFileSync(LEGACY_FILE, 'utf8')); }
  catch (e) {
    // Refuse to start rather than silently begin with an empty store —
    // the legacy file holds refresh_tokens that can't be regenerated
    // without the user re-doing OAuth. Move the bad file aside so a
    // retry-restart doesn't loop on the same parse failure, then throw
    // loudly so a human investigates before the empty store cements.
    const aside = `${LEGACY_FILE}.corrupt.${Date.now()}`;
    try { renameSync(LEGACY_FILE, aside); } catch {}
    throw new Error(`[store] legacy subscriptions.json present but unparseable (${e.message}); moved to ${aside}. Inspect/fix and rename it back to subscriptions.json, or re-OAuth each user.`);
  }
  const now = new Date().toISOString();
  const users = (legacy.subscriptions || []).map(sub => ({
    id: sub.id,
    session_cookie_id: null,
    refresh_token: sub.refresh_token,
    access_token: null,
    access_expires_at: null,
    refresh_invalidated_at: null,
    slack_user_id: sub.slack_user_id ?? null,
    vehicle_id: sub.vehicle_id != null ? String(sub.vehicle_id) : null,
    vehicle_name: sub.vehicle_name ?? null,
    consecutive_failures: sub.consecutive_failures || 0,
    created_at: sub.created_at || now,
    last_seen_at: sub.created_at || now,
    last_check_at: sub.last_check_at ?? null,
    last_result: sub.last_result ?? null,
    last_dm_date: sub.last_dm_date ?? null,
    last_digest_date: sub.last_digest_date ?? null,
    last_dm_error_at: sub.last_dm_error_at ?? null,
  }));
  const store = { users };
  if (legacy.last_run_at) store.last_run_at = legacy.last_run_at;
  if (legacy.last_digest_run_at) store.last_digest_run_at = legacy.last_digest_run_at;
  writeAtomic(USERS_FILE, store);
  try { renameSync(LEGACY_FILE, LEGACY_FILE + '.pre-bff'); } catch {}
  console.log(`[store] migrated ${users.length} subscription(s) → users.json`);
}
migrateLegacy();

export function loadStore() {
  let raw;
  try { raw = readFileSync(USERS_FILE, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { users: [] };
    throw e;
  }
  try {
    const s = JSON.parse(raw);
    if (!Array.isArray(s.users)) s.users = [];
    return s;
  } catch (e) {
    const aside = `${USERS_FILE}.corrupt.${Date.now()}`;
    try { renameSync(USERS_FILE, aside); } catch {}
    console.error(`[store] parse failed, moved aside to ${aside}: ${e.message}`);
    return { users: [] };
  }
}

export function saveStore(store) { writeAtomic(USERS_FILE, store); }

export function loadUsers() { return loadStore().users; }
export function loadUserById(id) { return loadUsers().find(u => u.id === id) || null; }
export function loadUserBySession(sid) { return sid ? (loadUsers().find(u => u.session_cookie_id === sid) || null) : null; }
export function loadUserBySlackId(slackId) { return loadUsers().find(u => u.slack_user_id === slackId) || null; }

// The cron's working set: records that have an active notification sub.
export function loadSubscribedUsers() { return loadUsers().filter(u => u.slack_user_id && u.vehicle_id); }

export function createUser(record) {
  const s = loadStore();
  s.users.push(record);
  saveStore(s);
  return record;
}

export function deleteUser(id) {
  const s = loadStore();
  s.users = s.users.filter(u => u.id !== id);
  saveStore(s);
}

// Re-loads so a concurrent write isn't clobbered. Drops the patch if the
// record vanished mid-operation, logging so a rotated-then-lost
// refresh_token is at least visible.
export function patchUser(id, patch) {
  const s = loadStore();
  const u = s.users.find(x => x.id === id);
  if (!u) {
    console.warn(`[store] patchUser: user ${id} not found (deleted concurrently?), patch dropped: ${Object.keys(patch).join(',')}`);
    return;
  }
  Object.assign(u, patch);
  saveStore(s);
}

// Drop dead records: no session cookie AND no subscription AND inactive
// for >maxAgeDays. Returns the count pruned.
export function pruneOrphaned(maxAgeDays = 30) {
  const cutoff = Date.now() - maxAgeDays * 86400000;
  const s = loadStore();
  const before = s.users.length;
  s.users = s.users.filter(u => {
    const orphaned = !u.session_cookie_id && !u.slack_user_id && !u.vehicle_id;
    if (!orphaned) return true;
    const seen = u.last_seen_at ? Date.parse(u.last_seen_at) : 0;
    return seen >= cutoff;
  });
  const pruned = before - s.users.length;
  if (pruned > 0) { saveStore(s); console.log(`[store] pruned ${pruned} orphaned user record(s)`); }
  return pruned;
}

// DTO redactor for the /api/notifications/status endpoint.
export function publicUser(u) {
  return { id: u.id, slack_user_id: u.slack_user_id, vehicle_name: u.vehicle_name,
    vehicle_id: u.vehicle_id, created_at: u.created_at, last_check_at: u.last_check_at };
}

// ── Legacy aliases ─────────────────────────────────────────────────────
// Callers not yet migrated to the new vocabulary. Phase 6 of the BFF plan
// swaps these out; until then routes/notifications + cron use the old
// names against the new schema.
export const loadSubs = loadSubscribedUsers;
export const patchSub = patchUser;
export const publicSub = publicUser;
// saveSubs replaces the subscribed set, keeping non-subscribed records
// (logged-in-only users — none exist until Phase 4, but be correct now).
export function saveSubs(subs) {
  const s = loadStore();
  const others = s.users.filter(u => !(u.slack_user_id && u.vehicle_id));
  s.users = [...others, ...subs];
  saveStore(s);
}
