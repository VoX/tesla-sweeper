// Cross-side aware notification planner.
// See docs/notification-scenarios.md for the scenario catalog and reasoning.

const WINDOW_DAYS = 7;
const TIGHT_FLIP_DAYS = 3;
const APP_URL = 'https://claw.bitvox.me/sweeper/';

export function classifyWeek({ events = [], carSide = null, sideDetection = null, todayET }) {
  if (!todayET) throw new Error('classifyWeek: todayET required');
  const oppositeSide = carSide === 'even' ? 'odd' : carSide === 'odd' ? 'even' : null;
  const window = events.filter(e => {
    const d = daysBetween(todayET, e.date);
    return d >= 0 && d <= WINDOW_DAYS;
  });

  const base = {
    primaryEvent: null,
    conflictEvent: null,
    oppositeNextDate: null,
    daysUntilPrimary: null,
    windowEvents: window,
    carSide,
    oppositeSide,
  };

  const stagger = findSameDayPair(window);
  if (stagger) {
    const { date, evenE, oddE } = stagger;
    return { ...base, class: 'same-day-stagger',
      primaryEvent: carSide === 'odd' ? oddE : evenE,
      conflictEvent: carSide === 'odd' ? evenE : oddE,
      daysUntilPrimary: daysBetween(todayET, date) };
  }

  const both = window.find(e => e.side === 'both');
  if (both) {
    return { ...base, class: 'both-sides-flag',
      primaryEvent: both,
      daysUntilPrimary: daysBetween(todayET, both.date) };
  }

  if (!carSide) {
    const next = window[0];
    if (!next) return { ...base, class: 'safe' };
    return { ...base, class: 'unknown-side',
      primaryEvent: next,
      daysUntilPrimary: daysBetween(todayET, next.date) };
  }

  if (oneSidedStreet(sideDetection)) {
    const mine = window.find(e => e.side === carSide);
    if (mine) {
      return { ...base, class: 'one-sided-street',
        primaryEvent: mine,
        daysUntilPrimary: daysBetween(todayET, mine.date) };
    }
  }

  const sideEvents = window.filter(e => e.side === 'odd' || e.side === 'even');
  const hasOdd = sideEvents.some(e => e.side === 'odd');
  const hasEven = sideEvents.some(e => e.side === 'even');
  if (sideEvents.length >= 3 && hasOdd && hasEven) {
    // Anchor on the first user-side event so daysUntilPrimary reflects
    // the user's actual action date, not e.g. an opposite-side sweep
    // that already happened today.
    const anchor = sideEvents.find(e => e.side === carSide) || sideEvents[0];
    return { ...base, class: 'triple-flip',
      primaryEvent: anchor,
      daysUntilPrimary: daysBetween(todayET, anchor.date) };
  }

  const mine = window.find(e => e.side === carSide);
  if (!mine) return { ...base, class: 'safe' };
  const minePopulated = { ...base, primaryEvent: mine, daysUntilPrimary: daysBetween(todayET, mine.date) };

  const conflict = window.find(e =>
    e.side === oppositeSide &&
    daysBetween(mine.date, e.date) >= 1 &&
    daysBetween(mine.date, e.date) <= TIGHT_FLIP_DAYS
  );
  if (conflict) return { ...minePopulated, class: 'tight-flip', conflictEvent: conflict };

  // Imminent opposite-side sweep BEFORE the user-side event: moving
  // pre-emptively puts the user on a side that's about to be swept.
  // The right action is "wait for opposite to sweep, then flip onto it."
  const imminent = window.find(e =>
    e.side === oppositeSide &&
    e.date > todayET &&
    e.date < mine.date
  );
  if (imminent) {
    const nextOppositeAfterMine = events.find(e => e.side === oppositeSide && e.date > mine.date);
    return { ...minePopulated, class: 'imminent-opposite',
      conflictEvent: imminent,
      oppositeNextDate: nextOppositeAfterMine?.date || null };
  }

  const oppositeToday = events.find(e => e.side === oppositeSide && e.date === todayET);
  if (oppositeToday) return { ...minePopulated, class: 'opposite-already-swept', conflictEvent: oppositeToday };

  const nextOpposite = events.find(e => e.side === oppositeSide && e.date > mine.date);
  return { ...minePopulated, class: 'lone-flip', oppositeNextDate: nextOpposite?.date || null };
}

export function shouldDispatchPlan(plan) {
  if (!plan || plan.class === 'safe') return false;
  return plan.daysUntilPrimary != null
    && plan.daysUntilPrimary >= 1
    && plan.daysUntilPrimary <= 3;
}

// Daily DM — action verb leads, metadata follows. Bold only the action.
// URL is dropped on routine flips (the Slack DM is already from the
// sweeper bot); kept on `unknown-side` where the URL IS the action.
export function formatPlanDM({ vehicleName, address, plan }) {
  const e = plan.primaryEvent;
  const opp = plan.conflictEvent;
  const carUC = (plan.carSide || '').toUpperCase();
  const oppUC = (plan.oppositeSide || '').toUpperCase();

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
      const last = plan.windowEvents[plan.windowEvents.length - 1];
      head = `:warning: *Park off-street through ${formatDay(last.date)}* — ${plan.windowEvents.length} sweeps this week, too many flips to chase.`;
      break;
    }
    case 'tight-flip':
      head = `:broom: *Move to ${oppUC} by ${nightBefore(e.date)}, then back by ${nightBefore(opp.date, 'evening')}.* ${oppUC} sweeps ${formatDay(opp.date)} — or park off-street through ${formatDay(opp.date)} (easier).`;
      break;
    case 'imminent-opposite': {
      const oppDay = formatDay(opp.date).split(',')[0];
      const tail = plan.oppositeNextDate
        ? ` Clear through ${formatDay(plan.oppositeNextDate)}.`
        : ' Opposite has no upcoming sweep after.';
      head = `:broom: *${oppUC} sweeps ${oppDay} morning — wait, then move to ${oppUC} ${oppDay} evening.*${tail}`;
      break;
    }
    case 'opposite-already-swept':
      head = `:broom: *Move to ${oppUC} anytime* — just swept, clear for ~2 weeks.`;
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
      head = `Sweep ${formatDay(e?.date)}.`;
  }
  const foot = `_${vehicleName}${address ? ` · ${address}` : ''}_`;
  return `${head}\n${foot}`;
}

export function formatWeeklyDigest({ vehicleName, address, plan }) {
  const events = plan.windowEvents;
  const head = `:broom: *${vehicleName}* — sweep schedule for the week`;
  const foot = `:round_pushpin: ${address || 'address unresolved'}\n<${APP_URL}>`;
  if (!events.length) {
    return `${head}\n  • clear all week — nothing to do.\n${foot}`;
  }
  const lines = events.map(ev => {
    const tag = ev.side === 'both' ? '*BOTH*' : `*${ev.side.toUpperCase()}*`;
    return `  • ${formatDay(ev.date)}: ${tag} ${shortTime(ev.time)}`;
  }).join('\n');
  return `${head}:\n${lines}\n\n*Plan:* ${digestRecommendation(plan)}\n${foot}`;
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
      return `park off-street through ${formatDay(plan.windowEvents[plan.windowEvents.length - 1].date)} — too many flips this week.`;
    case 'tight-flip':
      return `flip to ${oppUC} for ${formatDay(e.date)}, then back to ${carUC} by ${dayBefore(opp.date)} (${oppUC} sweeps ${formatDay(opp.date)}).`;
    case 'imminent-opposite':
      return `wait for ${oppUC} sweep ${formatDay(opp.date)}, then move to ${oppUC} that evening.`;
    case 'opposite-already-swept':
      return `move to ${oppUC} anytime — opposite was just swept.`;
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

// "Tue, May 12" → "Mon night" for an event on Tue. Caller can pass
// 'evening' to swap the suffix when the action is dusk rather than late.
function nightBefore(date, suffix = 'night') {
  const weekday = dayBefore(date).split(',')[0];
  return `${weekday} ${suffix}`;
}

function shortTime(t) {
  if (!t) return '';
  return t.replace(/:00 /g, '').replace(/\s-\s/g, '-');
}

function findSameDayPair(events) {
  const byDate = {};
  for (const e of events) {
    if (e.side !== 'odd' && e.side !== 'even') continue;
    (byDate[e.date] ||= []).push(e);
  }
  for (const list of Object.values(byDate)) {
    const sides = new Set(list.map(e => e.side));
    if (sides.size >= 2) {
      return { date: list[0].date, evenE: list.find(e => e.side === 'even'), oddE: list.find(e => e.side === 'odd') };
    }
  }
  return null;
}

function oneSidedStreet(sideDetection) {
  const p = sideDetection?.side_parity;
  if (!p) return false;
  const left = (p.left_even || 0) + (p.left_odd || 0);
  const right = (p.right_even || 0) + (p.right_odd || 0);
  // Need ≥3 buildings sampled before we trust a one-sided declaration —
  // a single building per side is OSM noise, not a parking signal.
  if (left + right < 3) return false;
  return left === 0 || right === 0;
}
