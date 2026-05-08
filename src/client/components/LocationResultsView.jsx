import { MapView } from './MapView.jsx';
import { SweepResults } from './SweepResults.jsx';
import { SideDetectionCard } from './SideDetectionCard.jsx';

// Shared results view used by Tesla Login + Manual tabs. The two tabs
// differ only in how `pos` is sourced (Tesla API vs. drag) and whether
// the marker is interactive — everything below is identical.
export function LocationResultsView({ pos, draggable, onPinMove, data, vehicleInfo, popupLabel }) {
  return (
    <>
      <MapView
        lat={pos?.lat}
        lng={pos?.lng}
        street={pos?.street}
        segment={data?.side_detection?.segment}
        draggable={draggable}
        onPinMove={onPinMove}
        popupLabel={popupLabel}
      />
      <SweepResults
        data={data}
        vehicleName={vehicleInfo?.name}
        fullAddr={vehicleInfo?.addr}
        lat={pos?.lat}
        lng={pos?.lng}
      />
      <SideDetectionCard detection={data?.side_detection} />
    </>
  );
}
