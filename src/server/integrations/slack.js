// Slack Web API helpers — `chat.postMessage` for confirmation + cron DMs.

const FETCH_TIMEOUT = 12000;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';

function fetchWithTimeout(url, options = {}) {
  return fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), ...options });
}

// Post a Slack DM via chat.postMessage. mrkdwn:false defangs any
// `<...>`/`*...*` chars that slipped in from user-supplied vehicle
// names or Nominatim address strings — DMs render plain text.
export async function postSlackDM(slack_user_id, text) {
  if (!SLACK_BOT_TOKEN) return { ok: false, error: 'SLACK_BOT_TOKEN not configured' };
  const res = await fetchWithTimeout('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel: slack_user_id, text, mrkdwn: false }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) console.error('[slack-dm] postMessage failed:', data.error);
  return { ok: !!data.ok, error: data.error };
}
