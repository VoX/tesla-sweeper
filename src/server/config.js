// Side-effect-only: loads .env into process.env. Imported FIRST by
// index.js so transitively-loaded modules see env at module-eval time
// (otherwise SESSION_HMAC_KEY etc. read empty).

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
