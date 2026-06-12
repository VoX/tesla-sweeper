// Cross-side aware notification planner.
// See docs/notification-scenarios.md for the scenario catalog and reasoning.

import { escapeSlack } from '../integrations/slack.js';

const WINDOW_DAYS = 7;
const TIGHT_FLIP_DAYS = 3;
const APP_URL = 'https://sweeper.bitvox.me/';

// Somerville sweeping season is Apr 1 – Dec 31. Off-season the cron
// must not wake the car (real battery cost, zero information). Pure
// date-string helpers so the gate is testable without a clock.
// Mar 29-31 count as IN-season: the T-3/T-1 dispatch for season-opening
// sweeps (Apr 1-3) lands on those days, and next_event_date must be
// persisted before the Apr 1 7am gate can work. Three extra wakes/year.
export function isOffSeason(dateET) {
  const month = parseInt(String(dateET).slice(5, 7), 10);
  const day = parseInt(String(dateET).slice(8, 10), 10);
  if (month === 3 && day >= 29) return false;
  return month >= 1 && month <= 3;
}

// Last week of March: the one off-season Sunday digest we DO send — a
// "season starts Apr 1" heads-up instead of a 13th "clear all week".
export function isSeasonPreviewWindow(dateET) {
  const month = parseInt(String(dateET).slice(5, 7), 10);
  const day = parseInt(String(dateET).slice(8, 10), 10);
  return month === 3 && day >= 25;
}

export function formatSeasonPreviewDM({ vehicleName }) {
  return `:broom: *Street-sweeping season starts Apr 1.* Daily checks for *${escapeSlack(vehicleName)}* resume then — DMs land 3 days and 1 day before each sweep on your side, plus a 7am last call.`;
}

export function classifyWeek({ events = [], carSide = null, sideDetection = null, todayET }) {
  if (!todayET) throw new Error('classifyWeek: todayET required');
  // Recollect typically returns events sorted by date, but the API doesn't
  // guarantee it — sort defensively so same-day-pair detection and "first
  // user-side event" semantics aren't insertion-order-dependent.
  const sorted = [...events].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const oppositeSide = carSide === 'even' ? 'odd' : carSide === 'odd' ? 'even' : null;
  const window = sorted.filter(e => {
    const d = daysBetween(todayET, e.date);
    return d >= 0 && d <= WINDOW_DAYS;
  });

  const base = { primaryEvent: null, conflictEvent: null, oppositeNextDate: null,
    daysUntilPrimary: null, windowEvents: window, carSide, oppositeSide };
  const withPrimary = (e, extra = {}) => ({
    ...base, primaryEvent: e, daysUntilPrimary: daysBetween(todayET, e.date), ...extra,
  });

  const stagger = findSameDayPair(window);
  if (stagger) {
    const { evenE, oddE } = stagger;
    const isOdd = carSide === 'odd';
    return withPrimary(isOdd ? oddE : evenE, { class: 'same-day-stagger', conflictEvent: isOdd ? evenE : oddE });
  }

  const both = window.find(e => e.side === 'both');
  if (both) return withPrimary(both, { class: 'both-sides-flag' });

  if (!carSide) {
    const next = window[0];
    if (!next) return { ...base, class: 'safe' };
    return withPrimary(next, { class: 'unknown-side' });
  }

  if (oneSidedStreet(sideDetection)) {
    const mine = window.find(e => e.side === carSide);
    if (mine) return withPrimary(mine, { class: 'one-sided-street' });
  }

  const sideEvents = window.filter(e => e.side === 'odd' || e.side === 'even');
  const hasMixed = sideEvents.some(e => e.side === 'odd') && sideEvents.some(e => e.side === 'even');
  if (sideEvents.length >= 3 && hasMixed) {
    return withPrimary(sideEvents.find(e => e.side === carSide) || sideEvents[0], { class: 'triple-flip' });
  }

  const mine = window.find(e => e.side === carSide);
  if (!mine) return { ...base, class: 'safe' };

  const conflict = window.find(e => {
    if (e.side !== oppositeSide) return false;
    const gap = daysBetween(mine.date, e.date);
    return gap >= 1 && gap <= TIGHT_FLIP_DAYS;
  });
  if (conflict) return withPrimary(mine, { class: 'tight-flip', conflictEvent: conflict });

  const imminent = window.find(e => e.side === oppositeSide && e.date > todayET && e.date < mine.date);
  if (imminent) {
    return withPrimary(mine, {
      class: 'imminent-opposite', conflictEvent: imminent,
      oppositeNextDate: nextOppositeAfter(sorted, oppositeSide, mine.date),
    });
  }

  const oppositeToday = sorted.find(e => e.side === oppositeSide && e.date === todayET);
  if (oppositeToday) return withPrimary(mine, { class: 'opposite-already-swept', conflictEvent: oppositeToday });

  return withPrimary(mine, { class: 'lone-flip', oppositeNextDate: nextOppositeAfter(sorted, oppositeSide, mine.date) });
}

// Dispatch at 3 days out (heads-up) and 1 day out (last call). Day 2 was
// dropped 2026-06-12: three near-identical DMs per event trained the
// reader to skim the one that mattered — distinct day-3/day-1 framing
// (see formatPlanDM) replaces volume with contrast.
export function shouldDispatchPlan(plan) {
  if (!plan || plan.class === 'safe') return false;
  return plan.daysUntilPrimary === 3 || plan.daysUntilPrimary === 1;
}

// Daily DM — action verb leads, metadata follows. URL only kept where
// it IS the action (unknown-side). `safe` returns empty so a stray call
// can't render `Sweep .` if dispatch logic ever changes.
export function formatPlanDM({ vehicleName, address, plan, nearestNote }) {
  if (!plan || plan.class === 'safe') return '';
  const e = plan.primaryEvent;
  const opp = plan.conflictEvent;
  const carUC = (plan.carSide || '').toUpperCase();
  const oppUC = (plan.oppositeSide || '').toUpperCase();
  const dayOf = (d) => formatDay(d).split(',')[0]; // "Tue"

  let head;
  switch (plan.class) {
    case 'same-day-stagger': {
      const evenE = e.side === 'even' ? e : opp;
      const oddE = e.side === 'odd' ? e : opp;
      head = `:warning: *Park off-street ${formatDay(e.date)}.* BOTH sides sweep (EVEN ${shortTime(evenE.time)}, ODD ${shortTime(oddE.time)}). Flipping won't save you.`;
      break;
    }
    case 'both-sides-flag':
      head = `:warning: *Park off-street ${formatDay(e.date)}* — whole-street sweep, no safe side.`;
      break;
    case 'one-sided-street':
      head = `:warning: *Park off-street ${formatDay(e.date)}* — one-sided street, nowhere to flip.`;
      break;
    case 'triple-flip': {
      const last = plan.windowEvents.at(-1);
      const list = plan.windowEvents.map(ev => `${dayOf(ev.date)} ${ev.side.toUpperCase()}`).join(', ');
      head = `:warning: *Park off-street through ${formatDay(last.date)}* — ${plan.windowEvents.length} sweeps this week (${list}).`;
      break;
    }
    case 'tight-flip':
      head = `:broom: *Move to ${oppUC} by ${nightBefore(e.date)}, then back by ${nightBefore(opp.date, 'evening')}.* ${oppUC} sweeps ${formatDay(opp.date)} — or park off-street through ${formatDay(opp.date)}.`;
      break;
    case 'imminent-opposite': {
      const oppDay = dayOf(opp.date);
      const tail = plan.oppositeNextDate
        ? ` Clear through ${formatDay(plan.oppositeNextDate)}.`
        : '';
      head = `:broom: *Stay on ${carUC} tonight. After ${oppUC} is swept ${oppDay} morning, move to ${oppUC} ${oppDay} evening.*${tail}`;
      break;
    }
    case 'opposite-already-swept':
      head = `:broom: *Move to ${oppUC} anytime before ${nightBefore(e.date)}.* Opposite just swept, clear for ~2 weeks.`;
      break;
    case 'lone-flip':
      head = plan.oppositeNextDate
        ? `:broom: *Move to ${oppUC} by ${nightBefore(e.date)}.* Clear through ${formatDay(plan.oppositeNextDate)}.`
        : `:broom: *Move to ${oppUC} by ${nightBefore(e.date)}.* Opposite has no upcoming sweep.`;
      break;
    case 'unknown-side':
      head = `:warning: Sweep on ${e.side.toUpperCase()} side ${formatDay(e.date)}. *Couldn't auto-detect your side* — open <${APP_URL}> to confirm.`;
      break;
    default:
      // Surface a missing case loudly instead of DMing "Sweep ." — every
      // class above is exhaustive and `safe` returns early up top.
      throw new Error(`formatPlanDM: unhandled plan class '${plan.class}'`);
  }
  // Day-1 DM is the one that prevents the ticket — frame it unmistakably
  // differently from the day-3 heads-up.
  if (plan.daysUntilPrimary === 1) {
    head = `:rotating_light: *LAST CALL — sweep tomorrow morning.*\n${head}`;
  }
  return `${head}\n${footer(vehicleName, address, nearestNote)}`;
}

// Day-of (7am ET) urgent DM: the car is STILL on the swept side with the
// sweeper due at 8AM. Composed from the live check's message string.
export function formatDayOfDM({ vehicleName, address, message, nearestNote }) {
  return `:rotating_light: *MOVE NOW — sweeping starts 8AM TODAY.* ${escapeSlack(message || '')}\n${footer(vehicleName, address, nearestNote)}`;
}

export function formatWeeklyDigest({ vehicleName, address, plan, nearestNote }) {
  const events = plan.windowEvents;
  const head = `:broom: *${escapeSlack(vehicleName)}* — sweep schedule for the week`;
  if (!events.length) {
    return `${head}\n  • clear all week — nothing to do.\n${footer(vehicleName, address, nearestNote)}`;
  }
  const lines = events.map(ev => {
    const tag = ev.side === 'both' ? '*BOTH*' : `*${ev.side.toUpperCase()}*`;
    return `  • ${formatDay(ev.date)}: ${tag} ${shortTime(ev.time)}`;
  }).join('\n');
  return `${head}:\n${lines}\n\n*Plan:* ${digestRecommendation(plan)}\n${footer(vehicleName, address, nearestNote)}\n<${APP_URL}>`;
}

function digestRecommendation(plan) {
  const carUC = (plan.carSide || '').toUpperCase();
  const oppUC = (plan.oppositeSide || '').toUpperCase();
  const e = plan.primaryEvent;
  const opp = plan.conflictEvent;
  switch (plan.class) {
    case 'safe': return 'no action needed.';
    case 'same-day-stagger':
      return `park off-street ${formatDay(e.date)} — both sides hit on the same morning.`;
    case 'both-sides-flag':
      return `park off-street ${formatDay(e.date)} — whole-street sweep.`;
    case 'one-sided-street':
      return `park off-street ${formatDay(e.date)} — no opposite side on this block.`;
    case 'triple-flip':
      return `park off-street through ${formatDay(plan.windowEvents.at(-1).date)}.`;
    case 'tight-flip':
      return `flip to ${oppUC} for ${formatDay(e.date)}, then back to ${carUC} by ${dayBefore(opp.date)} (${oppUC} sweeps ${formatDay(opp.date)}).`;
    case 'imminent-opposite':
      return `stay on ${carUC} tonight; after ${oppUC} sweeps ${formatDay(opp.date)} morning, move to ${oppUC} that evening.`;
    case 'opposite-already-swept':
      return `move to ${oppUC} anytime before ${dayBefore(e.date)} night — opposite was just swept.`;
    case 'lone-flip':
      return plan.oppositeNextDate
        ? `move to ${oppUC} before ${formatDay(e.date)} — opposite stays clear through ${formatDay(plan.oppositeNextDate)}.`
        : `move to ${oppUC} before ${formatDay(e.date)} — opposite has no upcoming sweep.`;
    case 'unknown-side':
      return `confirm your side at <${APP_URL}>.`;
    default:
      return 'check the app.';
  }
}

function footer(vehicleName, address, nearestNote) {
  // vehicleName/address/nearestNote are the untrusted interpolations
  // (user-named vehicle, OSM + Recollect strings) — escape them here,
  // now that DMs render as mrkdwn again.
  const base = `_${escapeSlack(vehicleName)}${address ? ` · ${escapeSlack(address)}` : ''}_`;
  // When the schedule came from a neighbor (exact address absent from
  // Recollect), disclose it in the DM too — otherwise an auto-DM silently
  // presents a neighbor's sweep days as the user's own.
  return nearestNote ? `${base}\n_(${escapeSlack(nearestNote)})_` : base;
}

export function daysBetween(a, b) {
  if (!a || !b) return NaN;
  const da = new Date(a + 'T12:00:00Z');
  const db = new Date(b + 'T12:00:00Z');
  return Math.round((db - da) / 86400000);
}

export function formatDay(date) {
  if (!date) return '';
  return new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York',
  });
}

function dayBefore(date) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return formatDay(d.toISOString().slice(0, 10));
}

function nightBefore(date, suffix = 'night') {
  return `${dayBefore(date).split(',')[0]} ${suffix}`;
}

function shortTime(t) {
  if (!t) return '';
  // Recollect-sourced string — escape here (the one chokepoint) since it
  // lands inside mrkdwn DM lines.
  return escapeSlack(t.replace(/:00 /g, '').replace(/\s-\s/g, '-'));
}

function findSameDayPair(events) {
  const seen = new Map(); // date -> first odd/even event seen
  for (const e of events) {
    if (e.side !== 'odd' && e.side !== 'even') continue;
    const prev = seen.get(e.date);
    if (!prev) { seen.set(e.date, e); continue; }
    if (prev.side !== e.side) {
      return { evenE: prev.side === 'even' ? prev : e, oddE: prev.side === 'odd' ? prev : e };
    }
  }
  return null;
}

function oneSidedStreet(sideDetection) {
  const p = sideDetection?.side_parity;
  if (!p) return false;
  const left = (p.left_even || 0) + (p.left_odd || 0);
  const right = (p.right_even || 0) + (p.right_odd || 0);
  if (left + right < 3) return false;
  return left === 0 || right === 0;
}

function nextOppositeAfter(events, side, date) {
  return events.find(e => e.side === side && e.date > date)?.date || null;
}
