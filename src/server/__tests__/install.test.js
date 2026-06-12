import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Throwaway data dir BEFORE any import that loads store modules — they
// resolve SWEEPER_DATA_DIR at import time, and users.js migrates at import.
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sweeper-install-test-'));
process.env.SWEEPER_DATA_DIR = DATA_DIR;
process.env.SESSION_HMAC_KEY = 'a'.repeat(64);
process.env.TESLA_CLIENT_ID = 'test-tesla-client';
process.env.TESLA_REDIRECT_URI = 'https://example.invalid/cb';
process.env.SLACK_CLIENT_ID = 'test-slack-client';
process.env.SLACK_CLIENT_SECRET = 'test-slack-secret';
process.env.SLACK_REDIRECT_URI = 'https://example.invalid/slack-cb';
process.env.SLACK_INSTALL_REDIRECT_URI = 'https://example.invalid/install-cb';
process.env.SLACK_TEAM_ID = 'T0TEST';

vi.mock('../util/fetch.js', () => ({ fetchWithTimeout: vi.fn(), UA: 'test-ua' }));
vi.mock('../notifications/cron.js', () => ({
  runNotifications: vi.fn(),
  startNotificationCron: vi.fn(),
  maybeRecoverMissedRun: vi.fn(),
  maybeRecoverMissedDigest: vi.fn(),
}));

const { fetchWithTimeout } = await import('../util/fetch.js');
const { buildApp } = await import('../app.js');

const app = buildApp();
const INSTALL_FILE = join(DATA_DIR, 'slack-install.json');

async function mintInstallState() {
  const res = await request(app).post('/api/slack/oauth/install/start');
  expect(res.status).toBe(200);
  return res.body.state;
}

beforeEach(() => vi.clearAllMocks());

describe('slack bot-install flow', () => {
  it('start mints an authorize URL with client_id + state + bot scopes', async () => {
    const res = await request(app).post('/api/slack/oauth/install/start');
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('https://slack.com/oauth/v2/authorize?');
    expect(res.body.url).toContain('client_id=test-slack-client');
    expect(res.body.url).toContain(`state=${res.body.state}`);
    expect(res.body.url).toContain('scope=chat%3Awrite%2Cim%3Awrite');
  });

  it('callback rejects a missing code', async () => {
    const res = await request(app).get('/api/slack/oauth/install-callback?state=whatever');
    expect(res.status).toBe(400);
  });

  it('callback rejects an unknown state without calling Slack', async () => {
    const res = await request(app).get('/api/slack/oauth/install-callback?code=abc&state=bogus');
    expect(res.status).toBe(400);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('callback refuses a foreign-workspace token and stores nothing', async () => {
    const state = await mintInstallState();
    fetchWithTimeout.mockResolvedValue({ json: async () => ({
      ok: true, access_token: 'xoxb-evil', team: { id: 'T0EVIL', name: 'Evil WS' },
    }) });
    const res = await request(app).get(`/api/slack/oauth/install-callback?code=abc&state=${state}`);
    expect(res.status).toBe(403);
    expect(existsSync(INSTALL_FILE)).toBe(false);
  });

  it('callback exchanges the code, pins the team, persists the bot token, and burns the state', async () => {
    const state = await mintInstallState();
    fetchWithTimeout.mockResolvedValue({ json: async () => ({
      ok: true, access_token: 'xoxb-new', bot_user_id: 'B0NEW',
      team: { id: 'T0TEST', name: 'Test WS' }, scope: 'chat:write,im:write',
    }) });
    const res = await request(app).get(`/api/slack/oauth/install-callback?code=abc&state=${state}`);
    expect(res.status).toBe(200);
    const body = fetchWithTimeout.mock.calls[0][1].body;
    expect(body).toContain('client_secret=test-slack-secret');
    expect(body).toContain('code=abc');
    const saved = JSON.parse(readFileSync(INSTALL_FILE, 'utf8'));
    expect(saved.access_token).toBe('xoxb-new');
    expect(saved.team_id).toBe('T0TEST');
    // state is one-shot — a replayed code must not re-exchange
    const replay = await request(app).get(`/api/slack/oauth/install-callback?code=abc&state=${state}`);
    expect(replay.status).toBe(400);
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });
});
