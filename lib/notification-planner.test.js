import { describe, it, expect } from 'vitest';
import {
  classifyWeek,
  shouldDispatchPlan,
  formatPlanDM,
  formatWeeklyDigest,
  daysBetween,
} from './notification-planner.js';

const TIME = '8:00 AM - 12:00 PM';
const TODAY = '2026-05-11'; // Monday

const ev = (date, side, time = TIME) => ({ date, side, time });

describe('daysBetween', () => {
  it('handles same day', () => expect(daysBetween('2026-05-11', '2026-05-11')).toBe(0));
  it('handles forward', () => expect(daysBetween('2026-05-11', '2026-05-14')).toBe(3));
  it('handles backward', () => expect(daysBetween('2026-05-14', '2026-05-11')).toBe(-3));
  it('handles month boundary', () => expect(daysBetween('2026-05-30', '2026-06-02')).toBe(3));
  it('handles DST spring-forward without rounding error', () => {
    // 2026 spring DST: Sun 3/8. Crossing it should still produce integer day deltas.
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
  });
  it('returns NaN for malformed input', () => expect(Number.isNaN(daysBetween('', '2026-05-11'))).toBe(true));
});

describe('classifyWeek — safe', () => {
  it('returns safe when no events at all', () => {
    const p = classifyWeek({ events: [], carSide: 'even', todayET: TODAY });
    expect(p.class).toBe('safe');
    expect(shouldDispatchPlan(p)).toBe(false);
  });

  it('returns safe when only opposite-side events in window', () => {
    const p = classifyWeek({
      events: [ev('2026-05-12', 'odd'), ev('2026-05-19', 'odd')],
      carSide: 'even', todayET: TODAY,
    });
    expect(p.class).toBe('safe');
  });

  it('returns safe when user-side event is beyond 7-day window', () => {
    const p = classifyWeek({ events: [ev('2026-05-25', 'even')], carSide: 'even', todayET: TODAY });
    expect(p.class).toBe('safe');
  });
});

describe('classifyWeek — lone-flip', () => {
  it('detects single user-side event with no opposite conflict', () => {
    const p = classifyWeek({
      events: [ev('2026-05-12', 'even'), ev('2026-05-26', 'even')],
      carSide: 'even', todayET: TODAY,
    });
    expect(p.class).toBe('lone-flip');
    expect(p.primaryEvent.date).toBe('2026-05-12');
    expect(p.daysUntilPrimary).toBe(1);
    expect(p.oppositeNextDate).toBeNull();
    expect(shouldDispatchPlan(p)).toBe(true);
  });

  it('surfaces "clear through" date when opposite sweeps far in the future', () => {
    const p = classifyWeek({
      events: [ev('2026-05-12', 'even'), ev('2026-05-26', 'odd')],
      carSide: 'even', todayET: TODAY,
    });
    expect(p.class).toBe('lone-flip');
    expect(p.oppositeNextDate).toBe('2026-05-26');
  });
});

describe('classifyWeek — tight-flip', () => {
  it('detects opposite-side conflict 1 day after primary', () => {
    const p = classifyWeek({
      events: [ev('2026-05-12', 'even'), ev('2026-05-13', 'odd')],
      carSide: 'even', todayET: TODAY,
    });
    expect(p.class).toBe('tight-flip');
    expect(p.primaryEvent.date).toBe('2026-05-12');
    expect(p.conflictEvent.date).toBe('2026-05-13');
  });

  it('detects opposite-side conflict 3 days after primary', () => {
    const p = classifyWeek({
      events: [ev('2026-05-12', 'even'), ev('2026-05-15', 'odd')],
      carSide: 'even', todayET: TODAY,
    });
    expect(p.class).toBe('tight-flip');
  });

  it('does NOT trigger tight-flip when opposite is 4+ days out', () => {
    const p = classifyWeek({
      events: [ev('2026-05-12', 'even'), ev('2026-05-16', 'odd')],
      carSide: 'even', todayET: TODAY,
    });
    expect(p.class).toBe('lone-flip');
  });

  it('opposite-already-swept takes precedence when opposite was today', () => {
    const p = classifyWeek({
      events: [ev('2026-05-11', 'odd'), ev('2026-05-13', 'even')],
      carSide: 'even', todayET: TODAY,
    });
    expect(p.class).toBe('opposite-already-swept');
  });

  it('detects tight-flip for an ODD-parked user too', () => {
    const p = classifyWeek({
      events: [ev('2026-05-12', 'odd'), ev('2026-05-14', 'even')],
      carSide: 'odd', todayET: TODAY,
    });
    expect(p.class).toBe('tight-flip');
    expect(p.primaryEvent.side).toBe('odd');
    expect(p.conflictEvent.side).toBe('even');
  });
});

describe('classifyWeek — same-day-stagger', () => {
  it('catches the catastrophe (different sides, same date)', () => {
    const p = classifyWeek({
      events: [
        ev('2026-05-12', 'even', '8:00 AM - 10:00 AM'),
        ev('2026-05-12', 'odd', '10:00 AM - 12:00 PM'),
      ],
      carSide: 'even', todayET: TODAY,
    });
    expect(p.class).toBe('same-day-stagger');
    expect(p.daysUntilPrimary).toBe(1);
    expect(p.primaryEvent.side).toBe('even');
    expect(p.conflictEvent.side).toBe('odd');
  });

  it('takes precedence over both-sides-flag', () => {
    const p = classifyWeek({
      events: [
        ev('2026-05-12', 'even'),
        ev('2026-05-12', 'odd'),
        ev('2026-05-15', 'both'),
      ],
      carSide: 'even', todayET: TODAY,
    });
    expect(p.class).toBe('same-day-stagger');
  });

  it('takes precedence over triple-flip count', () => {
    const p = classifyWeek({
      events: [
        ev('2026-05-12', 'even'),
        ev('2026-05-12', 'odd'),
        ev('2026-05-14', 'odd'),
        ev('2026-05-16', 'even'),
      ],
      carSide: 'even', todayET: TODAY,
    });
    expect(p.class).toBe('same-day-stagger');
  });

  it('flips primary/conflict for ODD-parked user', () => {
    const p = classifyWeek({
      events: [
        ev('2026-05-12', 'even', '8:00 AM - 10:00 AM'),
        ev('2026-05-12', 'odd', '10:00 AM - 12:00 PM'),
      ],
      carSide: 'odd', todayET: TODAY,
    });
    expect(p.class).toBe('same-day-stagger');
    expect(p.primaryEvent.side).toBe('odd');
    expect(p.conflictEvent.side).toBe('even');
  });
});

describe('classifyWeek — both-sides-flag', () => {
  it('detects Recollect "both" event', () => {
    const p = classifyWeek({
      events: [ev('2026-05-12', 'both')],
      carSide: 'even', todayET: TODAY,
    });
    expect(p.class).toBe('both-sides-flag');
  });
});

describe('classifyWeek — triple-flip', () => {
  it('detects 3+ events with mixed sides', () => {
    const p = classifyWeek({
      events: [
        ev('2026-05-12', 'even'),
        ev('2026-05-14', 'odd'),
        ev('2026-05-16', 'even'),
      ],
      carSide: 'even', todayET: TODAY,
    });
    expect(p.class).toBe('triple-flip');
  });

  it('does NOT trigger triple-flip when all 3 events are on one side', () => {
    const p = classifyWeek({
      events: [
        ev('2026-05-12', 'even'),
        ev('2026-05-14', 'even'),
        ev('2026-05-16', 'even'),
      ],
      carSide: 'odd', todayET: TODAY,
    });
    expect(p.class).toBe('safe');
  });

  it('anchors primaryEvent on the user-side event so dispatch fires correctly', () => {
    // Today is Mon 5/11. ODD swept 5/11, EVEN sweeps 5/13, ODD sweeps 5/15.
    // User on EVEN: action date is Wed 5/13 (T-2), not today's already-done ODD.
    const p = classifyWeek({
      events: [
        ev('2026-05-11', 'odd'),
        ev('2026-05-13', 'even'),
        ev('2026-05-15', 'odd'),
      ],
      carSide: 'even', todayET: TODAY,
    });
    expect(p.class).toBe('triple-flip');
    expect(p.primaryEvent.side).toBe('even');
    expect(p.daysUntilPrimary).toBe(2);
    expect(shouldDispatchPlan(p)).toBe(true); // would fail if anchor was 5/11 (days=0)
  });
});

describe('classifyWeek — opposite-already-swept', () => {
  it('detects opposite swept earlier today', () => {
    const p = classifyWeek({
      events: [ev('2026-05-11', 'odd'), ev('2026-05-14', 'even')],
      carSide: 'even', todayET: TODAY,
    });
    expect(p.class).toBe('opposite-already-swept');
    expect(p.conflictEvent.date).toBe('2026-05-11');
  });

  it("does not fire if opposite-today is the user's own side", () => {
    const p = classifyWeek({
      events: [ev('2026-05-11', 'even'), ev('2026-05-14', 'even')],
      carSide: 'even', todayET: TODAY,
    });
    expect(p.class).toBe('lone-flip');
  });
});

describe('classifyWeek — one-sided-street', () => {
  it('triggers when sideDetection has zero buildings on opposite side', () => {
    const p = classifyWeek({
      events: [ev('2026-05-12', 'even')],
      carSide: 'even', todayET: TODAY,
      sideDetection: { side: 'even', side_parity: { left_even: 5, left_odd: 4, right_even: 0, right_odd: 0 } },
    });
    expect(p.class).toBe('one-sided-street');
  });

  it('does NOT trigger when both sides have buildings', () => {
    const p = classifyWeek({
      events: [ev('2026-05-12', 'even')],
      carSide: 'even', todayET: TODAY,
      sideDetection: { side: 'even', side_parity: { left_even: 5, left_odd: 4, right_even: 3, right_odd: 6 } },
    });
    expect(p.class).toBe('lone-flip');
  });

  it('does NOT declare one-sided when only 1-2 buildings sampled (low confidence)', () => {
    const p = classifyWeek({
      events: [ev('2026-05-12', 'even')],
      carSide: 'even', todayET: TODAY,
      sideDetection: { side: 'even', side_parity: { left_even: 1, left_odd: 1, right_even: 0, right_odd: 0 } },
    });
    expect(p.class).toBe('lone-flip');
  });
});

describe('classifyWeek — unknown-side', () => {
  it('falls back to schedule-only when carSide is null', () => {
    const p = classifyWeek({
      events: [ev('2026-05-12', 'even')],
      carSide: null, todayET: TODAY,
    });
    expect(p.class).toBe('unknown-side');
    expect(p.primaryEvent.date).toBe('2026-05-12');
  });

  it('still safe if no events when carSide is null', () => {
    const p = classifyWeek({ events: [], carSide: null, todayET: TODAY });
    expect(p.class).toBe('safe');
  });
});

describe('shouldDispatchPlan', () => {
  it('fires for daysUntilPrimary 1, 2, 3', () => {
    for (const d of [1, 2, 3]) {
      expect(shouldDispatchPlan({ class: 'lone-flip', daysUntilPrimary: d })).toBe(true);
    }
  });

  it('does NOT fire for days 0, 4, 5', () => {
    for (const d of [0, 4, 5]) {
      expect(shouldDispatchPlan({ class: 'lone-flip', daysUntilPrimary: d })).toBe(false);
    }
  });

  it('never fires for safe class', () => {
    expect(shouldDispatchPlan({ class: 'safe', daysUntilPrimary: 1 })).toBe(false);
  });

  it('handles null plan gracefully', () => {
    expect(shouldDispatchPlan(null)).toBe(false);
  });
});

describe('formatPlanDM — message smoke tests', () => {
  const fixture = (...evs) => classifyWeek({
    events: evs, carSide: 'even', todayET: TODAY,
  });

  it('lone-flip leads with the move action and surfaces clear-through date', () => {
    const p = fixture(ev('2026-05-12', 'even'), ev('2026-05-26', 'odd'));
    const m = formatPlanDM({ vehicleName: 'Test', address: '9 Foo St', plan: p });
    expect(m).toMatch(/Move to ODD/);
    expect(m).toContain('Clear through');
    expect(m).toContain('Test');
    expect(m).toContain('9 Foo St');
  });

  it('tight-flip leads with the flip action and offers off-street alternative', () => {
    const p = fixture(ev('2026-05-12', 'even'), ev('2026-05-14', 'odd'));
    const m = formatPlanDM({ vehicleName: 'T', address: 'A', plan: p });
    expect(m).toMatch(/Move to ODD by .* night/);
    expect(m).toMatch(/back by .* evening/);
    expect(m).toContain('off-street');
    expect(m).toContain('(easier)');
  });

  it('same-day-stagger leads with park-off-street and keeps the wry punchline', () => {
    const p = fixture(
      ev('2026-05-12', 'even', '8:00 AM - 10:00 AM'),
      ev('2026-05-12', 'odd', '10:00 AM - 12:00 PM'),
    );
    const m = formatPlanDM({ vehicleName: 'T', address: 'A', plan: p });
    expect(m).toMatch(/Park off-street/);
    expect(m).toContain('BOTH sides');
    expect(m).toContain("Flipping won't save you");
  });

  it('both-sides-flag uses plain-English "whole-street" not "full-block"', () => {
    const p = fixture(ev('2026-05-12', 'both'));
    const m = formatPlanDM({ vehicleName: 'T', address: 'A', plan: p });
    expect(m).toContain('whole-street');
    expect(m).toContain('off-street');
    expect(m).not.toContain('Full-block');
  });

  it('triple-flip recommends off-street through the last event', () => {
    const p = fixture(ev('2026-05-12', 'even'), ev('2026-05-14', 'odd'), ev('2026-05-16', 'even'));
    const m = formatPlanDM({ vehicleName: 'T', address: 'A', plan: p });
    expect(m).toContain('3 sweeps');
    expect(m).toContain('off-street');
    expect(m).toMatch(/through .*16/);
  });

  it('opposite-already-swept reassures briefly without a preceding sweep prefix', () => {
    const p = fixture(ev('2026-05-11', 'odd'), ev('2026-05-14', 'even'));
    const m = formatPlanDM({ vehicleName: 'T', address: 'A', plan: p });
    expect(m).toMatch(/Move to ODD anytime/);
    expect(m).toContain('just swept');
    expect(m).toContain('clear for ~2 weeks');
  });

  it('one-sided-street recommends off-street', () => {
    const p = classifyWeek({
      events: [ev('2026-05-12', 'even')], carSide: 'even', todayET: TODAY,
      sideDetection: { side: 'even', side_parity: { left_even: 5, left_odd: 4, right_even: 0, right_odd: 0 } },
    });
    const m = formatPlanDM({ vehicleName: 'T', address: 'A', plan: p });
    expect(m).toContain('one-sided');
    expect(m).toContain('off-street');
  });

  it('unknown-side leads with the actionable fact and keeps the URL', () => {
    const p = classifyWeek({ events: [ev('2026-05-12', 'even')], carSide: null, todayET: TODAY });
    const m = formatPlanDM({ vehicleName: 'T', address: 'A', plan: p });
    expect(m).toContain('Sweep on EVEN');
    expect(m).toContain("Couldn't auto-detect");
    expect(m).toContain('claw.bitvox.me/sweeper');
  });

  it('routine flips do NOT include the URL footer', () => {
    const p = fixture(ev('2026-05-12', 'even'), ev('2026-05-26', 'odd'));
    const m = formatPlanDM({ vehicleName: 'T', address: 'A', plan: p });
    expect(m).not.toContain('claw.bitvox.me/sweeper');
  });
});

describe('formatWeeklyDigest', () => {
  it('lists every event in the window with weekday-prefixed dates', () => {
    const p = classifyWeek({
      events: [ev('2026-05-12', 'even'), ev('2026-05-14', 'odd')],
      carSide: 'even', todayET: TODAY,
    });
    const m = formatWeeklyDigest({ vehicleName: 'T', address: 'A', plan: p });
    expect(m).toContain('Tue, May 12');
    expect(m).toContain('Thu, May 14');
    expect(m).toContain('EVEN');
    expect(m).toContain('ODD');
    expect(m).toContain('Plan:');
  });

  it('handles empty week with explicit "clear all week" line', () => {
    const p = classifyWeek({ events: [], carSide: 'even', todayET: TODAY });
    const m = formatWeeklyDigest({ vehicleName: 'T', address: 'A', plan: p });
    expect(m).toContain('clear all week');
    expect(m).not.toContain('Plan:');
  });

  it('digest plan recommends off-street for triple-flip', () => {
    const p = classifyWeek({
      events: [ev('2026-05-12', 'even'), ev('2026-05-14', 'odd'), ev('2026-05-16', 'even')],
      carSide: 'even', todayET: TODAY,
    });
    const m = formatWeeklyDigest({ vehicleName: 'T', address: 'A', plan: p });
    expect(m).toContain('park off-street through');
  });
});
