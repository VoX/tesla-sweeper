// Side-effect-only module: loads .env into process.env. Imported FIRST
// by src/server/index.js so every transitively-loaded integration
// (slack, tesla, crypto/session, etc.) sees the env at module-eval
// time. Without this, the .env loader was running AFTER the env-reading
// modules — every restart printed `[boot] SESSION_HMAC_KEY unset` even
// though the key was on disk.

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

try {
  for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

export const REPO_ROOT_PATH = REPO_ROOT;
