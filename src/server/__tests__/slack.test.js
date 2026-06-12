import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// slack.js now imports the install store (→ store/users.js, which
// migrates at import time) — point it at a throwaway dir first.
process.env.SWEEPER_DATA_DIR = mkdtempSync(join(tmpdir(), 'sweeper-slack-test-'));

// postSlackDM must be a TOTAL function: every failure mode — including a
// thrown fetch (timeout, DNS, Slack outage) — comes back as { ok:false },
// because the cron's DM loops sit outside any per-sub try/catch and an
// escaped throw aborts every remaining sub's DM (fat-review finding).
vi.mock('../util/fetch.js', () => ({ fetchWithTimeout: vi.fn() }));

const { fetchWithTimeout } = await import('../util/fetch.js');
const { postSlackDM } = await import('../integrations/slack.js');
const { saveInstall } = await import('../store/slack-install.js');

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
});

describe('postSlackDM', () => {
  it('returns ok:false instead of throwing when fetch rejects', async () => {
    fetchWithTimeout.mockRejectedValue(new Error('ECONNRESET'));
    await expect(postSlackDM('U123', 'hi')).resolves.toEqual({ ok: false, error: 'ECONNRESET' });
  });

  it('returns ok:false on a Slack-level error response', async () => {
    fetchWithTimeout.mockResolvedValue({ json: async () => ({ ok: false, error: 'invalid_auth' }) });
    const out = await postSlackDM('U123', 'hi');
    expect(out).toEqual({ ok: false, error: 'invalid_auth' });
  });

  it('returns ok:true on success', async () => {
    fetchWithTimeout.mockResolvedValue({ json: async () => ({ ok: true }) });
    const out = await postSlackDM('U123', 'hi');
    expect(out.ok).toBe(true);
  });

  // LAST in the file: saveInstall writes data/slack-install.json into this
  // suite's data dir, and the file would shadow the env token for any
  // case that runs after it.
  it('prefers the installed token over the SLACK_BOT_TOKEN env fallback', async () => {
    saveInstall({ access_token: 'xoxb-installed' });
    fetchWithTimeout.mockResolvedValue({ json: async () => ({ ok: true }) });
    await postSlackDM('U123', 'hi');
    expect(fetchWithTimeout.mock.calls[0][1].headers.Authorization).toBe('Bearer xoxb-installed');
  });
});
