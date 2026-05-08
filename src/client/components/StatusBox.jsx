// Headline status banner. Danger gets role=alert + assertive live
// region so screen readers interrupt; the rest get polite status
// updates.
export function StatusBox({ status, title, message }) {
  const icon = { danger: '\u{1F6A8}', warning: '⚠️', safe: '✅', info: 'ℹ️' }[status] || '';
  return (
    <div className={`status-box ${status}`} role={status === 'danger' ? 'alert' : 'status'} aria-live={status === 'danger' ? 'assertive' : 'polite'}>
      <h2>{icon} {title}</h2>
      <p>{message}</p>
    </div>
  );
}
