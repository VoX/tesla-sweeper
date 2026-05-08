import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';
import { NotificationsPanel } from '../components/NotificationsPanel.jsx';

afterEach(cleanup);

describe('NotificationsPanel', () => {
  it('shows the enabled state with vehicle name + slack id', () => {
    render(<NotificationsPanel
      slackUserId=""
      enabledForThis={{ id: 's1', vehicle_name: 'KitlaDos', slack_user_id: 'U060NLFUM', last_check_at: null }}
      notifLoading={false} notifError=""
      onSlackSignIn={() => {}} onEnable={() => {}} onDisable={() => {}}
      setSlackUserId={() => {}}
    />);
    expect(screen.getByText('KitlaDos', { exact: false })).toBeTruthy();
    expect(screen.getByText('U060NLFUM', { exact: false })).toBeTruthy();
    expect(screen.getByText(/Disable Notifications/)).toBeTruthy();
  });

  it('wires Disable button to onDisable with sub id', () => {
    const onDisable = vi.fn();
    render(<NotificationsPanel
      slackUserId="" enabledForThis={{ id: 's1', vehicle_name: 'X', slack_user_id: 'U1' }}
      notifLoading={false} notifError=""
      onSlackSignIn={() => {}} onEnable={() => {}} onDisable={onDisable}
      setSlackUserId={() => {}}
    />);
    fireEvent.click(screen.getByText(/Disable Notifications/));
    expect(onDisable).toHaveBeenCalledWith('s1');
  });

  it('shows the sign-in flow when not enabled', () => {
    render(<NotificationsPanel
      slackUserId="" enabledForThis={null}
      notifLoading={false} notifError=""
      onSlackSignIn={() => {}} onEnable={() => {}} onDisable={() => {}}
      setSlackUserId={() => {}}
    />);
    expect(screen.getByText('Sign in with Slack')).toBeTruthy();
  });

  it('disables Enable button when slackUserId is empty', () => {
    const { container } = render(<NotificationsPanel
      slackUserId="" enabledForThis={null}
      notifLoading={false} notifError=""
      onSlackSignIn={() => {}} onEnable={() => {}} onDisable={() => {}}
      setSlackUserId={() => {}}
    />);
    const enable = Array.from(container.querySelectorAll('button')).find(b => b.textContent.includes('Enable Daily'));
    expect(enable).toBeDefined();
    expect(enable.disabled).toBe(true);
  });

  it('calls setSlackUserId with parsed input when typing', () => {
    const setSlackUserId = vi.fn();
    render(<NotificationsPanel
      slackUserId="" enabledForThis={null}
      notifLoading={false} notifError=""
      onSlackSignIn={() => {}} onEnable={() => {}} onDisable={() => {}}
      setSlackUserId={setSlackUserId}
    />);
    const input = screen.getByPlaceholderText(/U060NLFUM/);
    fireEvent.input(input, { target: { value: 'https://app.slack.com/team/U999' } });
    expect(setSlackUserId).toHaveBeenCalledWith('U999');
  });

  it('renders error message when notifError is set', () => {
    render(<NotificationsPanel
      slackUserId="" enabledForThis={null}
      notifLoading={false} notifError="Slack session expired"
      onSlackSignIn={() => {}} onEnable={() => {}} onDisable={() => {}}
      setSlackUserId={() => {}}
    />);
    expect(screen.getByText(/Slack session expired/)).toBeTruthy();
  });
});
