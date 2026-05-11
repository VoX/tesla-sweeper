import { parseSlackInput } from '../lib/slack-input.js';

// "Daily Slack Pings" panel. Shows the connected sub when one exists
// for this (slack_user_id, vehicle_id) pair, otherwise the Slack
// sign-in flow + manual U-id fallback.
export function NotificationsPanel({ slackUserId, setSlackUserId, hasSlackSession, enabledForThis, notifLoading, notifError, onSlackSignIn, onEnable, onDisable }) {
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>🔔 Daily Slack Pings</h3>
      <p style={{ fontSize: '0.85rem', color: '#8b949e', marginBottom: 12 }}>
        Get a slack DM 1, 2, and 3 days before sweeping. Runs at 12pm ET daily; wakes the car briefly to read its location.
      </p>
      {enabledForThis ? (
        <>
          <p style={{ fontSize: '0.85rem', marginBottom: 12 }}>
            ✅ Enabled for <strong>{enabledForThis.vehicle_name}</strong> — DMs go to <code>{enabledForThis.slack_user_id}</code>
            {enabledForThis.last_check_at && <> · last check {new Date(enabledForThis.last_check_at).toLocaleString()}</>}
          </p>
          <button className="disconnect-btn" onClick={() => onDisable(enabledForThis.id)} disabled={notifLoading}>
            {notifLoading ? 'Disabling...' : 'Disable Notifications'}
          </button>
        </>
      ) : (
        <>
          {slackUserId && hasSlackSession && (
            <p style={{ fontSize: '0.85rem', marginBottom: 12 }}>
              🔐 Signed in as <code>{slackUserId}</code>. Click Enable to subscribe, or sign in as someone else.
            </p>
          )}
          {slackUserId && !hasSlackSession && (
            <p style={{ fontSize: '0.85rem', marginBottom: 12, color: '#d29922' }}>
              ⚠️ Saved Slack id <code>{slackUserId}</code>, but your Slack session has expired. Click <strong>Sign in with Slack</strong> below to refresh it before enabling.
            </p>
          )}
          <button onClick={onSlackSignIn} disabled={notifLoading} style={{ marginBottom: 12 }}>
            {notifLoading ? 'Connecting to Slack...' : (slackUserId && hasSlackSession ? 'Switch slack account' : 'Sign in with Slack')}
          </button>
          <details style={{ marginBottom: 12 }} open={!slackUserId ? false : undefined}>
            <summary style={{ fontSize: '0.8rem', color: '#8b949e', cursor: 'pointer' }}>or paste your slack user id manually</summary>
            <label htmlFor="slack-user-id" style={{ marginTop: 8, display: 'block' }}>Slack User ID or Profile URL</label>
            <input
              id="slack-user-id"
              placeholder="U060NLFUM or paste your slack profile URL"
              value={slackUserId}
              onInput={e => setSlackUserId(parseSlackInput(e.target.value))}
            />
            <p style={{ fontSize: '0.75rem', color: '#8b949e', marginTop: -8, marginBottom: 12 }}>
              Find via Slack profile → ⋮ → Copy member ID.
            </p>
          </details>
          <button onClick={onEnable} disabled={notifLoading || !slackUserId}>
            {notifLoading ? 'Enabling...' : `Enable Daily Notifications${slackUserId ? ` for ${slackUserId}` : ''}`}
          </button>
        </>
      )}
      {notifError && <p style={{ fontSize: '0.85rem', color: '#f85149', marginTop: 8 }}>{notifError}</p>}
    </div>
  );
}
