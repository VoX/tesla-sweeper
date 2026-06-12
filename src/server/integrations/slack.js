// Slack Web API helpers — `chat.postMessage` for confirmation + cron DMs.

import { fetchWithTimeout } from '../util/fetch.js';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';

// Post a Slack DM via chat.postMessage. mrkdwn:false defangs any
// `<...>`/`*...*` chars that slipped in from user-supplied vehicle
// names or Nominatim address strings — DMs render plain text.
export async function postSlackDM(slack_user_id, text) {
  if (!SLACK_BOT_TOKEN) return { ok: false, error: 'SLACK_BOT_TOKEN not configured' };
  // Total function: a network throw (timeout, DNS, Slack outage) must come back
  // as { ok:false } like every other failure — the cron's DM loops sit outside
  // any per-sub try/catch, so an escaped throw aborts every remaining sub's DM.
  let data;
  try {
    const res = await fetchWithTimeout('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: slack_user_id, text, mrkdwn: false }),
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    data = { ok: false, error: e?.message || String(e) };
  }
  if (!data.ok) console.error('[slack-dm] postMessage failed:', data.error);
  return { ok: !!data.ok, error: data.error };
}
