import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/preact';
import { SweepResults } from '../components/SweepResults.jsx';

afterEach(cleanup);

describe('SweepResults', () => {
  it('renders nothing when data.found is false', () => {
    const { container } = render(<SweepResults data={{ found: false }} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders status banner + details for a happy result', () => {
    const data = {
      found: true,
      status: 'warning',
      title: 'Sweeping Tomorrow',
      message: 'Move tonight',
      sweep_events: [{ date: '2026-05-15', side: 'even', time: '8:00 AM - 12:00 PM' }],
      car_side: 'even',
      house_num: 12,
      side_detection: { road_name: 'Harvard Street' },
      days_until_next: 1,
      place_name: '12 Harvard St',
    };
    render(<SweepResults data={data} vehicleName="KitlaDos" lat={42.385} lng={-71.108} />);
    expect(screen.getByText('Sweeping Tomorrow', { exact: false })).toBeTruthy();
    expect(screen.getByText('Move tonight')).toBeTruthy();
    expect(screen.getByText('12 Harvard Street')).toBeTruthy();
    expect(screen.getByText('Tomorrow')).toBeTruthy();
    expect(screen.getByText('KitlaDos')).toBeTruthy();
  });

  it('shows YOUR SIDE badge on matching events', () => {
    const data = {
      found: true, status: 'warning', title: 'Tomorrow', message: 'm',
      sweep_events: [{ date: '2026-05-15', side: 'even', time: '8AM' }],
      car_side: 'even',
    };
    render(<SweepResults data={data} />);
    expect(screen.getByText('YOUR SIDE')).toBeTruthy();
  });
});
