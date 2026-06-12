import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Throwaway data dir BEFORE store-loading imports (users.js migrates at
// import time).
process.env.SWEEPER_DATA_DIR = mkdtempSync(join(tmpdir(), 'sweeper-cmd-test-'));
process.env.SESSION_HMAC_KEY = 'a'.repeat(64);
process.env.SLACK_SIGNING_SECRET = 'test-signing-secret';
process.env.SLACK_CLIENT_ID = 'test-slack-client';
process.env.SLACK_CLIENT_SECRET = 'test-slack-secret';
process.env.SLACK_REDIRECT_URI = 'https://example.invalid/slack-cb';
process.env.TESLA_CLIENT_ID = 'test-tesla-client';
process.env.TESLA_REDIRECT_URI = 'https://example.invalid/cb';

vi.mock('../util/fetch.js', () => ({ fetchWithTimeout: vi.fn(), UA: 'test-ua' }));
vi.mock('../notifications/cron.js', () => ({
  runNotifications: vi.fn(),
  startNotificationCron: vi.fn(),
  maybeRecoverMissedRun: vi.fn(),
  maybeRecoverMissedDigest: vi.fn(),
  todayInET: () => '2026-07-01',
  planDmKey: vi.fn(),
  checkSubNow: vi.fn(),
}));

const { fetchWithTimeout } = await import('../util/fetch.js');
const { checkSubNow } = await import('../notifications/cron.js');
const { verifySlackSignature, formatCommandResult } = await import('../routes/slack-command.js');
const { buildApp } = await import('../app.js');
const { createUser, blankUser, deleteUser } = await import('../store/users.js');

const app = buildApp();
const SECRET = 'test-signing-secret';

// Build a signed slash-command POST the way Slack does: form body, v0
// HMAC over `v0:<ts>:<raw body>`.
function signedPost(fields, { ts = Math.floor(Date.now() / 1000), secret = SECRET, sigOverride } = {}) {
  const body = new URLSearchParams(fields).toString();
  const sig = sigOverride ?? ('v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex'));
  return request(app)
    .post('/api/slack/command')
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .set('x-slack-request-timestamp', String(ts))
    .set('x-slack-signature', sig)
    .send(body);
}

beforeEach(() => vi.clearAllMocks());

describe('verifySlackSignature', () => {
  const mk = (over = {}) => {
    const ts = '1750000000';
    const rawBody = 'command=%2Fsweep&user_id=U1';
    const signature = 'v0=' + createHmac('sha256', SECRET).update(`v0:${ts}:${rawBody}`).digest('hex');
    return verifySlackSignature({
      signingSecret: SECRET, signature, timestamp: ts, rawBody, nowMs: 1750000000 * 1000, ...over,
    });
  };

  it('accepts a valid signature inside the window', () => expect(mk()).toBe(true));
  it('rejects a tampered body', () => expect(mk({ rawBody: 'command=%2Fsweep&user_id=U2' })).toBe(false));
  it('rejects a stale timestamp (replay)', () => expect(mk({ nowMs: (1750000000 + 600) * 1000 })).toBe(false));
  it('rejects a wrong-length signature without throwing', () => expect(mk({ signature: 'v0=dead' })).toBe(false));
  it('rejects when the secret is unconfigured', () => expect(mk({ signingSecret: '' })).toBe(false));
});

describe('POST /api/slack/command', () => {
  it('401s an unsigned request', async () => {
    const r = await request(app).post('/api/slack/command')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('command=%2Fsweep&user_id=U1');
    expect(r.status).toBe(401);
    expect(checkSubNow).not.toHaveBeenCalled();
  });

  it('401s a request signed with the wrong secret', async () => {
    const r = await signedPost({ command: '/sweep', user_id: 'U1' }, { secret: 'wrong-secret' });
    expect(r.status).toBe(401);
  });

  it('tells a user with no subscription where to sign up', async () => {
    const r = await signedPost({ command: '/sweep', user_id: 'U0NOBODY', response_url: 'https://hooks.slack.com/commands/T0/B0/xyz' });
    expect(r.status).toBe(200);
    expect(r.body.text).toContain('No sweeper subscription');
    expect(checkSubNow).not.toHaveBeenCalled();
  });

  it('acks immediately and posts the check result to response_url', async () => {
    const u = createUser(blankUser({ slack_user_id: 'U0KIT', vehicle_id: '42', vehicle_name: 'KitlaDos' }));
    checkSubNow.mockResolvedValue({
      ok: true, found: true, status: 'warning', title: 'Sweeping Tomorrow — YOUR Side',
      message: 'Sweeping TOMORROW on your side. Move tonight.',
      vehicle_name: 'KitlaDos', address: '12 Harvard St', plan: null,
    });
    fetchWithTimeout.mockResolvedValue({ json: async () => ({}) });
    const r = await signedPost({ command: '/sweep', user_id: 'U0KIT', response_url: 'https://hooks.slack.com/commands/T0/B0/xyz' });
    expect(r.status).toBe(200);
    expect(r.body.text).toContain('checking');
    // The async tail posts to response_url — give the microtask queue a beat.
    await vi.waitFor(() => expect(fetchWithTimeout).toHaveBeenCalled());
    const [url, opts] = fetchWithTimeout.mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/commands/T0/B0/xyz');
    expect(JSON.parse(opts.body).text).toContain('Sweeping Tomorrow');
    deleteUser(u.id);
  });
});

describe('formatCommandResult', () => {
  it('escapes untrusted strings in failures', () => {
    expect(formatCommandResult({ ok: false, error: 'bad <thing> & stuff' }))
      .toContain('bad &lt;thing&gt; &amp; stuff');
  });

  it('renders a clear all-clear for found:false outside coverage', () => {
    const t = formatCommandResult({ ok: true, found: false, message: 'This location is in Cambridge, outside coverage.', address: '1 Main St' });
    expect(t).toContain(':white_check_mark:');
    expect(t).toContain('Cambridge');
  });

  it('uses the rotating light for danger status', () => {
    const t = formatCommandResult({ ok: true, found: true, status: 'danger', title: 'MOVE YOUR CAR', message: 'now', vehicle_name: 'T' });
    expect(t).toContain(':rotating_light:');
    expect(t).toContain('MOVE YOUR CAR');
  });
});
