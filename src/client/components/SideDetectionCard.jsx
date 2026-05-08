import { Row } from './Row.jsx';

// Diagnostic card for OSM-based side detection. Renders nothing when
// detection is null (e.g. no coords were sent or whichSide threw).
export function SideDetectionCard({ detection }) {
  if (!detection) return null;
  const sideColor = detection.side === 'odd' ? '#d29922' : detection.side === 'even' ? '#3fb950' : '#8b949e';
  return (
    <div className="card">
      <h3>Side detection</h3>
      <Row label="Side" value={<strong style={{ color: sideColor }}>{detection.side?.toUpperCase() || 'UNKNOWN'}</strong>} />
      {detection.side === 'unknown' && detection.error && <Row label="Reason" value={detection.error} />}
      <Row label="Road" value={detection.road_name || '—'} />
      <Row label="Offset from centerline" value={detection.perpendicular_offset_m != null ? `${detection.perpendicular_offset_m} m` : '—'} />
      <Row label="Cross sign" value={detection.cross_sign != null ? String(detection.cross_sign) : '—'} />
      <Row label="Car-side house #" value={detection.car_house_number ?? '—'} />
      <Row label="Opposite-side house #" value={detection.opposite_house_number ?? '—'} />
      <Row label="OSM way id" value={detection.way_id ?? '—'} />
    </div>
  );
}
