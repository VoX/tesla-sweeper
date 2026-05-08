import { describe, it, expect } from 'vitest';
import {
  classifyWeek, shouldDispatchPlan, formatPlanDM, formatWeeklyDigest, daysBetween,
} from '../notifications/planner.js';

const TIME = '8:00 AM - 12:00 PM';
const TODAY = '2026-05-11'; // Monday

const ev = (date, side, time = TIME) => ({ date, side, time });
const cls = (events, opts = {}) => classifyWeek({ events, carSide: 'even', todayET: TODAY, ...opts });
const fmt = (plan) => formatPlanDM({ vehicleName: 'T', address: 'A', plan });
const digest = (plan) => formatWeeklyDigest({ vehicleName: 'T', address: 'A', plan });

describe('daysBetween', () => {
  it.each([
    ['same day', '2026-05-11', '2026-05-11', 0],
    ['forward', '2026-05-11', '2026-05-14', 3],
    ['backward', '2026-05-14', '2026-05-11', -3],
    ['month boundary', '2026-05-30', '2026-06-02', 3],
    ['DST spring-forward', '2026-03-07', '2026-03-09', 2],
  ])('%s', (_, a, b, expected) => expect(daysBetween(a, b)).toBe(expected));

  it('returns NaN for malformed input', () => expect(Number.isNaN(daysBetween('', '2026-05-11'))).toBe(true));
});

describe('classifyWeek — safe', () => {
  it('returns safe when no events at all', () => {
    const p = cls([]);
    expect(p.class).toBe('safe');
    expect(shouldDispatchPlan(p)).toBe(false);
  });

  it('returns safe when only opposite-side events in window', () => {
    expect(cls([ev('2026-05-12', 'odd'), ev('2026-05-19', 'odd')]).class).toBe('safe');
  });

  it('returns safe when user-side event is beyond 7-day window', () => {
    expect(cls([ev('2026-05-25', 'even')]).class).toBe('safe');
  });
});

describe('classifyWeek — lone-flip', () => {
  it('detects single user-side event with no opposite conflict', () => {
    const p = cls([ev('2026-05-12', 'even'), ev('2026-05-26', 'even')]);
    expect(p.class).toBe('lone-flip');
    expect(p.primaryEvent.date).toBe('2026-05-12');
    expect(p.daysUntilPrimary).toBe(1);
    expect(p.oppositeNextDate).toBeNull();
    expect(shouldDispatchPlan(p)).toBe(true);
  });

  it('surfaces "clear through" date when opposite sweeps far in the future', () => {
    expect(cls([ev('2026-05-12', 'even'), ev('2026-05-26', 'odd')]).oppositeNextDate).toBe('2026-05-26');
  });
});

describe('classifyWeek — tight-flip', () => {
  it('detects opposite-side conflict 1 day after primary', () => {
    const p = cls([ev('2026-05-12', 'even'), ev('2026-05-13', 'odd')]);
    expect(p.class).toBe('tight-flip');
    expect(p.primaryEvent.date).toBe('2026-05-12');
    expect(p.conflictEvent.date).toBe('2026-05-13');
  });

  it('detects opposite-side conflict 3 days after primary', () => {
    expect(cls([ev('2026-05-12', 'even'), ev('2026-05-15', 'odd')]).class).toBe('tight-flip');
  });

  it('does NOT trigger tight-flip when opposite is 4+ days out', () => {
    expect(cls([ev('2026-05-12', 'even'), ev('2026-05-16', 'odd')]).class).toBe('lone-flip');
  });

  it('detects tight-flip for an ODD-parked user too', () => {
    const p = cls([ev('2026-05-12', 'odd'), ev('2026-05-14', 'even')], { carSide: 'odd' });
    expect(p.class).toBe('tight-flip');
    expect(p.primaryEvent.side).toBe('odd');
    expect(p.conflictEvent.side).toBe('even');
  });
});

describe('classifyWeek — imminent-opposite', () => {
  it('detects opposite-side sweep BEFORE user-side event (the VoX case)', () => {
    const p = classifyWeek({
      events: [ev('2026-05-07', 'odd'), ev('2026-05-08', 'even'), ev('2026-05-21', 'odd')],
      carSide: 'even', todayET: '2026-05-06',
    });
    expect(p.class).toBe('imminent-opposite');
    expect(p.primaryEvent.date).toBe('2026-05-08');
    expect(p.conflictEvent.date).toBe('2026-05-07');
    expect(p.oppositeNextDate).toBe('2026-05-21');
  });

  it('opposite-already-swept wins when opposite is today', () => {
    const p = classifyWeek({
      events: [ev('2026-05-06', 'odd'), ev('2026-05-08', 'even')],
      carSide: 'even', todayET: '2026-05-06',
    });
    expect(p.class).toBe('opposite-already-swept');
  });

  it('tight-flip wins when opposite is AFTER user-side event', () => {
    const p = classifyWeek({
      events: [ev('2026-05-08', 'even'), ev('2026-05-10', 'odd')],
      carSide: 'even', todayET: '2026-05-06',
    });
    expect(p.class).toBe('tight-flip');
  });

  it('falls through to lone-flip when imminent opposite is far future', () => {
    const p = classifyWeek({
      events: [ev('2026-05-08', 'even'), ev('2026-05-21', 'odd')],
      carSide: 'even', todayET: '2026-05-06',
    });
    expect(p.class).toBe('lone-flip');
  });

  it('shouldDispatchPlan fires for imminent-opposite at T-1/T-2/T-3', () => {
    const p = classifyWeek({
      events: [ev('2026-05-07', 'odd'), ev('2026-05-08', 'even')],
      carSide: 'even', todayET: '2026-05-06',
    });
    expect(p.daysUntilPrimary).toBe(2);
    expect(shouldDispatchPlan(p)).toBe(true);
  });
});

describe('classifyWeek — same-day-stagger', () => {
  const stagger = [
    ev('2026-05-12', 'even', '8:00 AM - 10:00 AM'),
    ev('2026-05-12', 'odd', '10:00 AM - 12:00 PM'),
  ];

  it('catches the catastrophe', () => {
    const p = cls(stagger);
    expect(p.class).toBe('same-day-stagger');
    expect(p.daysUntilPrimary).toBe(1);
    expect(p.primaryEvent.side).toBe('even');
    expect(p.conflictEvent.side).toBe('odd');
  });

  it('takes precedence over both-sides-flag', () => {
    expect(cls([...stagger, ev('2026-05-15', 'both')]).class).toBe('same-day-stagger');
  });

  it('takes precedence over triple-flip count', () => {
    expect(cls([...stagger, ev('2026-05-14', 'odd'), ev('2026-05-16', 'even')]).class).toBe('same-day-stagger');
  });

  it('flips primary/conflict for ODD-parked user', () => {
    const p = cls(stagger, { carSide: 'odd' });
    expect(p.primaryEvent.side).toBe('odd');
    expect(p.conflictEvent.side).toBe('even');
  });

  it('detects pair regardless of event-array insertion order', () => {
    expect(cls([stagger[1], stagger[0]]).class).toBe('same-day-stagger');
  });
});

describe('classifyWeek — both-sides-flag', () => {
  it('detects Recollect "both" event', () => {
    expect(cls([ev('2026-05-12', 'both')]).class).toBe('both-sides-flag');
  });
});

describe('classifyWeek — triple-flip', () => {
  it('detects 3+ events with mixed sides', () => {
    expect(cls([ev('2026-05-12', 'even'), ev('2026-05-14', 'odd'), ev('2026-05-16', 'even')]).class).toBe('triple-flip');
  });

  it('does NOT trigger when all 3 events are on one side', () => {
    expect(cls([ev('2026-05-12', 'even'), ev('2026-05-14', 'even'), ev('2026-05-16', 'even')], { carSide: 'odd' }).class).toBe('safe');
  });

  it('anchors primaryEvent on user-side event so dispatch fires correctly', () => {
    // ODD swept today + EVEN Wed + ODD Fri. User on EVEN: action is Wed (T-2),
    // not the already-done ODD today. Pre-fix: anchor was sideEvents[0]
    // (today's ODD), days_until=0, dispatch suppressed.
    const p = cls([ev('2026-05-11', 'odd'), ev('2026-05-13', 'even'), ev('2026-05-15', 'odd')]);
    expect(p.class).toBe('triple-flip');
    expect(p.primaryEvent.side).toBe('even');
    expect(p.daysUntilPrimary).toBe(2);
    expect(shouldDispatchPlan(p)).toBe(true);
  });
});

describe('classifyWeek — opposite-already-swept', () => {
  it('detects opposite swept earlier today', () => {
    const p = cls([ev('2026-05-11', 'odd'), ev('2026-05-14', 'even')]);
    expect(p.class).toBe('opposite-already-swept');
    expect(p.conflictEvent.date).toBe('2026-05-11');
  });

  it("does not fire if opposite-today is the user's own side", () => {
    expect(cls([ev('2026-05-11', 'even'), ev('2026-05-14', 'even')]).class).toBe('lone-flip');
  });
});

describe('classifyWeek — one-sided-street', () => {
  const sideDet = (right_even, right_odd) => ({
    side: 'even', side_parity: { left_even: 5, left_odd: 4, right_even, right_odd },
  });

  it('triggers when sideDetection has zero buildings on opposite side', () => {
    expect(cls([ev('2026-05-12', 'even')], { sideDetection: sideDet(0, 0) }).class).toBe('one-sided-street');
  });

  it('does NOT trigger when both sides have buildings', () => {
    expect(cls([ev('2026-05-12', 'even')], { sideDetection: sideDet(3, 6) }).class).toBe('lone-flip');
  });

  it('does NOT declare one-sided when only 1-2 buildings sampled (low confidence)', () => {
    const lowConf = { side: 'even', side_parity: { left_even: 1, left_odd: 1, right_even: 0, right_odd: 0 } };
    expect(cls([ev('2026-05-12', 'even')], { sideDetection: lowConf }).class).toBe('lone-flip');
  });
});

describe('classifyWeek — unknown-side', () => {
  it('falls back to schedule-only when carSide is null', () => {
    const p = cls([ev('2026-05-12', 'even')], { carSide: null });
    expect(p.class).toBe('unknown-side');
    expect(p.primaryEvent.date).toBe('2026-05-12');
  });

  it('still safe if no events when carSide is null', () => {
    expect(cls([], { carSide: null }).class).toBe('safe');
  });
});

describe('shouldDispatchPlan', () => {
  it.each([[1, true], [2, true], [3, true], [0, false], [4, false], [5, false]])(
    'days=%i → %s', (d, expected) => expect(shouldDispatchPlan({ class: 'lone-flip', daysUntilPrimary: d })).toBe(expected),
  );

  it('never fires for safe class', () => {
    expect(shouldDispatchPlan({ class: 'safe', daysUntilPrimary: 1 })).toBe(false);
  });

  it('handles null plan gracefully', () => expect(shouldDispatchPlan(null)).toBe(false));
});

describe('formatPlanDM — message smoke tests', () => {
  it('safe plan returns empty string (defensive guard)', () => {
    expect(fmt(cls([]))).toBe('');
  });

  it('lone-flip leads with the move action and surfaces clear-through date', () => {
    const m = fmt(cls([ev('2026-05-12', 'even'), ev('2026-05-26', 'odd')]));
    expect(m).toMatch(/Move to ODD by .* night/);
    expect(m).toContain('Clear through');
    expect(m).toContain('T');
    expect(m).toContain('A');
  });

  it('tight-flip leads with the flip action and offers off-street alternative', () => {
    const m = fmt(cls([ev('2026-05-12', 'even'), ev('2026-05-14', 'odd')]));
    expect(m).toMatch(/Move to ODD by .* night/);
    expect(m).toMatch(/back by .* evening/);
    expect(m).toContain('off-street');
  });

  it('imminent-opposite leads with "stay" then conditional action', () => {
    const p = classifyWeek({
      events: [ev('2026-05-07', 'odd'), ev('2026-05-08', 'even'), ev('2026-05-21', 'odd')],
      carSide: 'even', todayET: '2026-05-06',
    });
    const m = fmt(p);
    expect(m).toContain('Stay on EVEN tonight');
    expect(m).toContain('After ODD is swept Thu morning');
    expect(m).toContain('move to ODD Thu evening');
    expect(m).toContain('Clear through');
  });

  it('same-day-stagger leads with park-off-street and keeps the wry punchline', () => {
    const m = fmt(cls([
      ev('2026-05-12', 'even', '8:00 AM - 10:00 AM'),
      ev('2026-05-12', 'odd', '10:00 AM - 12:00 PM'),
    ]));
    expect(m).toMatch(/Park off-street/);
    expect(m).toContain('BOTH sides');
    expect(m).toContain("Flipping won't save you");
  });

  it('both-sides-flag uses plain-English "whole-street" not "full-block"', () => {
    const m = fmt(cls([ev('2026-05-12', 'both')]));
    expect(m).toContain('whole-street');
    expect(m).toContain('off-street');
    expect(m).not.toContain('Full-block');
  });

  it('triple-flip lists every event without editorial commentary', () => {
    const m = fmt(cls([ev('2026-05-12', 'even'), ev('2026-05-14', 'odd'), ev('2026-05-16', 'even')]));
    expect(m).toContain('3 sweeps');
    expect(m).toContain('off-street');
    expect(m).toMatch(/Tue EVEN, Thu ODD, Sat EVEN/);
    expect(m).not.toContain('too many flips');
  });

  it('opposite-already-swept gives a deadline rather than vague "anytime"', () => {
    const m = fmt(cls([ev('2026-05-11', 'odd'), ev('2026-05-14', 'even')]));
    expect(m).toMatch(/Move to ODD anytime before .* night/);
    expect(m).toContain('Opposite just swept');
    expect(m).toContain('clear for ~2 weeks');
  });

  it('one-sided-street recommends off-street', () => {
    const m = fmt(cls([ev('2026-05-12', 'even')], {
      sideDetection: { side: 'even', side_parity: { left_even: 5, left_odd: 4, right_even: 0, right_odd: 0 } },
    }));
    expect(m).toContain('one-sided');
    expect(m).toContain('off-street');
  });

  it('unknown-side leads with the actionable fact and keeps the URL', () => {
    const m = fmt(cls([ev('2026-05-12', 'even')], { carSide: null }));
    expect(m).toContain('Sweep on EVEN');
    expect(m).toContain("Couldn't auto-detect");
    expect(m).toContain('claw.bitvox.me/sweeper');
  });

  it('routine flips do NOT include the URL footer', () => {
    expect(fmt(cls([ev('2026-05-12', 'even'), ev('2026-05-26', 'odd')]))).not.toContain('claw.bitvox.me/sweeper');
  });
});

describe('formatWeeklyDigest', () => {
  it('lists every event in the window with weekday-prefixed dates', () => {
    const m = digest(cls([ev('2026-05-12', 'even'), ev('2026-05-14', 'odd')]));
    expect(m).toContain('Tue, May 12');
    expect(m).toContain('Thu, May 14');
    expect(m).toContain('EVEN');
    expect(m).toContain('ODD');
    expect(m).toContain('Plan:');
  });

  it('handles empty week with explicit "clear all week" line', () => {
    const m = digest(cls([]));
    expect(m).toContain('clear all week');
    expect(m).not.toContain('Plan:');
  });

  it('digest plan recommends off-street for triple-flip', () => {
    const m = digest(cls([ev('2026-05-12', 'even'), ev('2026-05-14', 'odd'), ev('2026-05-16', 'even')]));
    expect(m).toContain('park off-street through');
  });
});
