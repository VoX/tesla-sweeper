import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/preact';

// Mock the leaflet loader so the test doesn't actually try to import
// leaflet's CSS/runtime — happy-dom can't render the canvas anyway.
vi.mock('../leaflet-loader.js', () => ({
  loadLeaflet: vi.fn(() => new Promise(() => {})), // never resolves
}));

const { MapView } = await import('../components/MapView.jsx');

afterEach(cleanup);

describe('MapView', () => {
  it('renders nothing when lat is null (no coords yet)', () => {
    const { container } = render(<MapView lat={null} lng={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders the map container when coords are supplied', () => {
    const { container } = render(<MapView lat={42.385} lng={-71.108} street="Harvard St" />);
    const mapDiv = container.querySelector('.map-container');
    expect(mapDiv).toBeTruthy();
    expect(mapDiv.getAttribute('aria-label')).toBe('Location map');
  });
});
