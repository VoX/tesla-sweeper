// "Daily Slack Pings" panel. Shows the connected sub when one exists
// for this (slack_user_id, vehicle_id) pair, otherwise the "Sign in
// with Slack" flow. The slack id comes ONLY from that OIDC sign-in —
// there's no manual-entry field (a free-text input here got autofilled
// by password managers and poisoned the id).
export function NotificationsPanel({ slackUserId, hasSlackSession, enabledForThis, notifLoading, notifError, onSlackSignIn, onEnable, onDisable }) {
  // /enable needs a live Slack-OIDC HMAC session, not just a remembered
  // slack id. /disable doesn't — the Tesla session cookie is enough.
  const signedIn = !!slackUserId && hasSlackSession;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>🔔 Daily Slack Pings</h3>
      <p style={{ fontSize: '0.85rem', color: '#8b949e', marginBottom: 12 }}>
        Get slack DMs 3 days and 1 day before sweeping on your side, plus a 7am last call on sweep day. Checks run at noon and 9pm ET (Apr–Dec season); each check briefly wakes the car to read its location.
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
          {signedIn ? (
            <p style={{ fontSize: '0.85rem', marginBottom: 12 }}>
              🔐 Signed in as <code>{slackUserId}</code>. Click Enable to subscribe, or sign in as someone else.
            </p>
          ) : slackUserId ? (
            <p style={{ fontSize: '0.85rem', marginBottom: 12, color: '#d29922' }}>
              ⚠️ Your Slack session has expired (you were <code>{slackUserId}</code>) — sign in with Slack again to enable.
            </p>
          ) : (
            <p style={{ fontSize: '0.85rem', color: '#8b949e', marginBottom: 12 }}>
              Sign in with Slack so I know where to send the DMs — no member-id hunting needed.
            </p>
          )}
          <button onClick={onSlackSignIn} disabled={notifLoading} style={{ marginBottom: 12 }}>
            {notifLoading ? 'Connecting to Slack...' : (signedIn ? 'Switch slack account' : 'Sign in with Slack')}
          </button>
          <button onClick={onEnable} disabled={notifLoading || !signedIn}>
            {notifLoading ? 'Enabling...' : (signedIn ? `Enable Daily Notifications for ${slackUserId}` : 'Enable Daily Notifications')}
          </button>
        </>
      )}
      {notifError && <p style={{ fontSize: '0.85rem', color: '#f85149', marginTop: 8 }}>{notifError}</p>}
    </div>
  );
}
