// Two-cell label/value row used by the side-detection diagnostic card.
export function Row({ label, value }) {
  return <div className="row"><span className="label">{label}</span><span>{value}</span></div>;
}
