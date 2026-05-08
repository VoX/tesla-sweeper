import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/preact';
import { StatusBox } from '../components/StatusBox.jsx';

afterEach(cleanup);

describe('StatusBox', () => {
  it('renders the title and message', () => {
    render(<StatusBox status="warning" title="Tomorrow" message="Move tonight" />);
    expect(screen.getByText('Tomorrow', { exact: false })).toBeTruthy();
    expect(screen.getByText('Move tonight')).toBeTruthy();
  });

  it('uses role=alert + aria-live=assertive for danger', () => {
    const { container } = render(<StatusBox status="danger" title="Move" message="Now" />);
    const box = container.querySelector('.status-box.danger');
    expect(box?.getAttribute('role')).toBe('alert');
    expect(box?.getAttribute('aria-live')).toBe('assertive');
  });

  it('uses role=status + aria-live=polite for non-danger', () => {
    for (const status of ['warning', 'safe', 'info']) {
      const { container } = render(<StatusBox status={status} title="t" message="m" />);
      const box = container.querySelector(`.status-box.${status}`);
      expect(box?.getAttribute('role')).toBe('status');
      expect(box?.getAttribute('aria-live')).toBe('polite');
    }
  });
});
