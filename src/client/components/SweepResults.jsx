import { StatusBox } from './StatusBox.jsx';
import { Row } from './Row.jsx';
import { clientToday } from '../lib/date.js';

// Status banner + upcoming-events list + details card. Renders nothing
// until `data` carries a successful sweep check.
export function SweepResults({ data, vehicleName, fullAddr, lat, lng }) {
  if (!data?.found) return null;

  const sides = data.sweep_events?.length
    ? [...new Set(data.sweep_events.map(e => e.side))].map(s => s + ' side').join(' & ')
    : null;

  return (
    <>
      <StatusBox status={data.status} title={data.title} message={data.message} />
      {data.sweep_events?.length > 0 && (
        <div className="card">
          <h3>Upcoming Sweeping Events</h3>
          {data.sweep_events.slice(0, 8).map((evt, i) => {
            const yourSide = evt.side === 'both' || (data.car_side && evt.side === data.car_side);
            const evtDate = new Date(evt.date + 'T12:00:00');
            const todayMid = new Date(clientToday() + 'T12:00:00');
            const daysAway = Math.round((evtDate - todayMid) / 86400000);
            const daysLabel = daysAway === 0 ? 'today' : daysAway === 1 ? 'tomorrow' : `${daysAway} days`;
            return (
              <div className={`event ${yourSide ? 'event-yours' : 'event-other'}`} key={i}>
                <span className="event-date">
                  {evtDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} ({daysLabel})
                  {yourSide && <span className="event-badge">YOUR SIDE</span>}
                </span>
                <span className="event-side">{evt.side} side · {evt.time}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="card">
        <h3>Details</h3>
        <Row label="Address" value={
          // When OSM detection has the car-side road + number, build the
          // address from those (consistent with the server's sweep
          // message). Otherwise fall back to the Recollect place_name.
          data.side_detection?.road_name && data.house_num
            ? `${data.house_num} ${data.side_detection.road_name}`
            : (data.place_name || fullAddr || '')
        } />
        {data.car_side && <Row label="Your Side" value={`${data.car_side}${data.house_num ? ` (#${data.house_num})` : ''}${data.side_source === 'osm' ? ' · OSM-verified' : data.side_source === 'house_parity' ? ' · estimated' : ''}`} />}
        {data.days_until_next != null && <Row label="Next Sweep" value={data.days_until_next === 0 ? 'Today' : data.days_until_next === 1 ? 'Tomorrow' : `In ${data.days_until_next} days`} />}
        {vehicleName && <Row label="Vehicle" value={vehicleName} />}
        {lat != null && <Row label="Coordinates" value={`${lat.toFixed(5)}, ${lng.toFixed(5)}`} />}
        {sides && <Row label="Sweeping Rules" value={`${sides} · ${data.sweep_events[0]?.time}`} />}
        <Row label="Data Source" value="City of Somerville / Recollect" />
      </div>
    </>
  );
}
