// On-disk record of the Slack app installation — the workspace bot token
// captured by /api/slack/oauth/install-callback. Token resolution in
// integrations/slack.js is FILE-FIRST (this file, then the SLACK_BOT_TOKEN
// env fallback), so a reinstall/rescope is picked up on the next DM with
// zero env edits and zero restarts — and the sweeper no longer dies when a
// shared env token gets rotated elsewhere (the May 2026 silent-DM-breakage
// mode this app split exists to kill).

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { writeAtomic } from './users.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.SWEEPER_DATA_DIR || join(__dirname, '..', '..', '..', 'data');
const INSTALL_FILE = join(DATA_DIR, 'slack-install.json');

export function saveInstall(record) {
  writeAtomic(INSTALL_FILE, { ...record, installed_at: new Date().toISOString() });
}

// Read fresh per call (no cache): the file is tiny, it's read at most a
// handful of times a day (cron + subscribe confirmations), and a fresh
// read means a reinstall takes effect immediately.
export function loadInstall() {
  try { return JSON.parse(readFileSync(INSTALL_FILE, 'utf8')); }
  catch { return null; }
}

export function installedBotToken() {
  const t = loadInstall()?.access_token;
  return (typeof t === 'string' && t) ? t : null;
}
