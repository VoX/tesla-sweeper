import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/preact';
import { SideDetectionCard } from '../components/SideDetectionCard.jsx';

afterEach(cleanup);

describe('SideDetectionCard', () => {
  it('renders nothing when detection is null', () => {
    const { container } = render(<SideDetectionCard detection={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders the diagnostic rows for a successful OSM result', () => {
    const detection = {
      side: 'even', road_name: 'Harvard Street',
      perpendicular_offset_m: 4.6, cross_sign: -1,
      car_house_number: 12, opposite_house_number: 9, way_id: 12345,
    };
    render(<SideDetectionCard detection={detection} />);
    expect(screen.getByText('EVEN')).toBeTruthy();
    expect(screen.getByText('Harvard Street')).toBeTruthy();
    expect(screen.getByText('4.6 m')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
  });

  it('shows the error reason when side is unknown', () => {
    const detection = { side: 'unknown', error: 'Overpass 504' };
    render(<SideDetectionCard detection={detection} />);
    expect(screen.getByText('UNKNOWN')).toBeTruthy();
    expect(screen.getByText('Overpass 504')).toBeTruthy();
  });
});
