import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';
import { NotificationsPanel } from '../components/NotificationsPanel.jsx';

afterEach(cleanup);

const base = {
  slackUserId: '', hasSlackSession: false, enabledForThis: null,
  notifLoading: false, notifError: '',
  onSlackSignIn: () => {}, onEnable: () => {}, onDisable: () => {},
};

describe('NotificationsPanel', () => {
  it('shows the enabled state with vehicle name + slack id', () => {
    render(<NotificationsPanel {...base} hasSlackSession enabledForThis={{ id: 's1', vehicle_name: 'KitlaDos', slack_user_id: 'U060NLFUM', last_check_at: null }} />);
    expect(screen.getByText('KitlaDos', { exact: false })).toBeTruthy();
    expect(screen.getByText('U060NLFUM', { exact: false })).toBeTruthy();
    expect(screen.getByText(/Disable Notifications/)).toBeTruthy();
  });

  it('wires Disable button to onDisable with sub id', () => {
    const onDisable = vi.fn();
    render(<NotificationsPanel {...base} hasSlackSession enabledForThis={{ id: 's1', vehicle_name: 'X', slack_user_id: 'U1' }} onDisable={onDisable} />);
    fireEvent.click(screen.getByText(/Disable Notifications/));
    expect(onDisable).toHaveBeenCalledWith('s1');
  });

  it('when subscribed but the Slack session expired, still offers Disable with no re-sign-in nag', () => {
    // Disable works via the Tesla session cookie server-side, so an
    // expired Slack session must not gate it (owner request 2026-06-12).
    const onDisable = vi.fn();
    render(<NotificationsPanel {...base} hasSlackSession={false} enabledForThis={{ id: 's1', vehicle_name: 'X', slack_user_id: 'U1' }} onDisable={onDisable} />);
    expect(screen.queryByText(/Slack session has expired/i)).toBeNull();
    fireEvent.click(screen.getByText(/Disable Notifications/));
    expect(onDisable).toHaveBeenCalledWith('s1');
  });

  it('not-enabled, not-signed-in: shows the Sign in with Slack flow, Enable disabled, no manual input', () => {
    const { container } = render(<NotificationsPanel {...base} slackUserId="" hasSlackSession={false} />);
    expect(screen.getByText('Sign in with Slack')).toBeTruthy();
    expect(container.querySelector('input')).toBeNull(); // manual-entry field removed
    const enable = Array.from(container.querySelectorAll('button')).find(b => b.textContent.includes('Enable Daily'));
    expect(enable.disabled).toBe(true);
  });

  it('not-enabled, signed in (slack id + live session): "Switch slack account" + Enable usable', () => {
    const onEnable = vi.fn();
    const { container } = render(<NotificationsPanel {...base} slackUserId="U061GUNS2" hasSlackSession onEnable={onEnable} />);
    expect(container.textContent).toContain('U061GUNS2');
    expect(screen.getByText('Switch slack account')).toBeTruthy();
    const enable = Array.from(container.querySelectorAll('button')).find(b => b.textContent.includes('Enable Daily'));
    expect(enable.disabled).toBe(false);
    fireEvent.click(enable);
    expect(onEnable).toHaveBeenCalled();
  });

  it('not-enabled, have a saved slack id but no live session: Enable disabled, prompts to re-sign-in', () => {
    const { container } = render(<NotificationsPanel {...base} slackUserId="U061GUNS2" hasSlackSession={false} />);
    expect(screen.getByText(/session has expired/i)).toBeTruthy();
    const enable = Array.from(container.querySelectorAll('button')).find(b => b.textContent.includes('Enable Daily'));
    expect(enable.disabled).toBe(true);
  });

  it('renders error message when notifError is set', () => {
    render(<NotificationsPanel {...base} notifError="Slack session expired" />);
    expect(screen.getByText(/Slack session expired/)).toBeTruthy();
  });
});
