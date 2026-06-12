// /sweep slash command — on-demand "am I safe parked here?" from Slack,
// at the actual decision moment (parking, evening, on a phone).
//
// Slack POSTs application/x-www-form-urlencoded with a v0 HMAC signature
// over the RAW body. We ack within Slack's 3s window immediately (a
// locate can take ~60s if the car is asleep) and deliver the real result
// via the payload's response_url afterwards.
//
// Identity: the command's user_id is asserted by Slack and the signature
// proves the request came from our app's workspace install — that's the
// same trust level as the OIDC-verified slack_user_id on the sub record,
// so a simple lookup is sufficient (no extra session needed).

import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { loadSubscribedUsers } from '../store/users.js';
import { fetchWithTimeout } from '../util/fetch.js';
import { escapeSlack } from '../integrations/slack.js';
import { rateLimit } from '../middleware/ratelimit.js';
import { checkSubNow, todayInET } from '../notifications/cron.js';
import { formatPlanDM, shouldDispatchPlan } from '../notifications/planner.js';

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || '';
const SIGNATURE_WINDOW_S = 300;

export const slackCommandRouter = express.Router();

// Verify Slack's request signature: v0=
// HMAC_SHA256(signing_secret, "v0:<timestamp>:<raw body>").
// Returns false (never throws) on any malformed input.
export function verifySlackSignature({ signingSecret, signature, timestamp, rawBody, nowMs }) {
  if (!signingSecret || !signature || !timestamp || rawBody == null) return false;
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowMs / 1000 - ts) > SIGNATURE_WINDOW_S) return false; // replay window
  const base = `v0:${timestamp}:${rawBody}`;
  const expected = 'v0=' + createHmac('sha256', signingSecret).update(base).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}

// Compose the slash-command result from a completed check.
export function formatCommandResult(out) {
  if (!out.ok) {
    return `:warning: check failed: ${escapeSlack(out.error || 'unknown error')}. Try again in a minute, or use <https://sweeper.bitvox.me/>.`;
  }
  if (!out.found) {
    // Outside Somerville / address not indexed — out.message says which.
    return `:white_check_mark: ${escapeSlack(out.message || 'No sweeping data for this location.')}\n_${escapeSlack(out.address || '')}_`;
  }
  const icon = out.status === 'danger' ? ':rotating_light:' : out.status === 'warning' ? ':warning:' : ':white_check_mark:';
  let text = `${icon} *${escapeSlack(out.title || 'Sweep check')}*\n${escapeSlack(out.message || '')}`;
  // When the planner has actionable advice in the dispatch window, append
  // the same plan DM the cron would send — one consistent voice.
  if (out.plan && shouldDispatchPlan(out.plan)) {
    text += `\n\n${formatPlanDM({ vehicleName: out.vehicle_name, address: out.address, plan: out.plan, nearestNote: out.nearest_note })}`;
  } else {
    text += `\n_${escapeSlack(out.vehicle_name || '')}${out.address ? ` · ${escapeSlack(out.address)}` : ''}_`;
  }
  return text;
}

// Capture the raw body for signature verification while still getting
// parsed form fields. Mounted route-locally — the global express.json
// ignores x-www-form-urlencoded so there's no double-parse.
const formParser = express.urlencoded({
  extended: false,
  limit: '10kb',
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); },
});

slackCommandRouter.post('/api/slack/command', rateLimit({ perMinute: 6 }), formParser, async (req, res) => {
  if (!verifySlackSignature({
    signingSecret: SLACK_SIGNING_SECRET,
    signature: req.get('x-slack-signature'),
    timestamp: req.get('x-slack-request-timestamp'),
    rawBody: req.rawBody,
    nowMs: Date.now(),
  })) {
    return res.status(401).json({ detail: 'bad signature' });
  }

  const { user_id: userId, response_url: responseUrl } = req.body || {};
  const sub = loadSubscribedUsers().find(u => u.slack_user_id === userId);
  if (!sub) {
    return res.json({
      response_type: 'ephemeral',
      text: 'No sweeper subscription for your Slack account — set one up at <https://sweeper.bitvox.me/> (Tesla login → Daily Slack Pings).',
    });
  }
  if (!responseUrl) return res.status(400).json({ detail: 'response_url required' });

  // Ack inside Slack's 3s window; the locate (wake-and-poll can take
  // ~60s) continues in the background and replies via response_url.
  res.json({ response_type: 'ephemeral', text: ':mag: checking where the car is parked (waking it if asleep — up to a minute)…' });

  try {
    const out = await checkSubNow(sub, todayInET());
    await postToResponseUrl(responseUrl, formatCommandResult(out));
  } catch (e) {
    console.error('[slack-command] check failed:', e);
    await postToResponseUrl(responseUrl, `:warning: check crashed: ${escapeSlack(e.message)}`);
  }
});

async function postToResponseUrl(url, text) {
  try {
    // Defense-in-depth: response_url is HMAC-covered so only Slack can set
    // it today, but pin the host anyway — a leaked signing secret must not
    // turn this into an arbitrary-POST primitive.
    if (new URL(url).hostname !== 'hooks.slack.com') {
      console.error('[slack-command] refusing non-Slack response_url host');
      return;
    }
    await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ response_type: 'ephemeral', text }),
    });
  } catch (e) {
    console.error('[slack-command] response_url post failed:', e.message);
  }
}
