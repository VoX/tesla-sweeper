// Slack Web API helpers — `chat.postMessage` for confirmation + cron DMs.

import { fetchWithTimeout } from '../util/fetch.js';
import { installedBotToken } from '../store/slack-install.js';

// FILE-FIRST token resolution: the install-callback's captured token
// (data/slack-install.json) wins over the SLACK_BOT_TOKEN env fallback.
// Resolved per call so a reinstall is live on the next DM, no restart.
function botToken() {
  return installedBotToken() || process.env.SLACK_BOT_TOKEN || '';
}

// Escape Slack mrkdwn control characters in UNTRUSTED interpolations
// (vehicle names, OSM/Recollect address strings) per Slack's escaping
// rules. Only & < > are special; * _ ~ ` are NOT escapable in Slack and
// at worst toggle formatting inside the substring — acceptable.
export function escapeSlack(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Post a Slack DM via chat.postMessage. Messages render as mrkdwn (the
// planner's *bold action lines* and <links> depend on it — a 2026-05
// mrkdwn:false hardening silently broke every styled DM into literal
// asterisks). Untrusted substrings must be escaped by the CALLER via
// escapeSlack() before interpolation.
export async function postSlackDM(slack_user_id, text) {
  const token = botToken();
  if (!token) return { ok: false, error: 'no Slack bot token (slack-install.json or SLACK_BOT_TOKEN)' };
  // Total function: a network throw (timeout, DNS, Slack outage) must come back
  // as { ok:false } like every other failure — the cron's DM loops sit outside
  // any per-sub try/catch, so an escaped throw aborts every remaining sub's DM.
  let data;
  try {
    const res = await fetchWithTimeout('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: slack_user_id, text }),
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    data = { ok: false, error: e?.message || String(e) };
  }
  if (!data.ok) console.error('[slack-dm] postMessage failed:', data.error);
  return { ok: !!data.ok, error: data.error };
}
