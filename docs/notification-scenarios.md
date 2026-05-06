# Cross-Side Notification Scenarios — Brainstorm

## The problem

Today's DM model is single-event: pick the next sweep within `days_until_next ∈ {1,2,3}`, compare its side to the user's parked side, fire one message ("sweep on your side, move tonight"). The implicit assumption is **moving to the other side is always the right move**. That assumption breaks the moment the other side has its own sweep within the same planning window.

Concretely: Somerville street-cleaning runs in pairs (one side, then the other). For most residential streets the two events are spaced 2 days apart in the same week. Telling the user "move to the other side tonight" can teleport them straight into the second sweep two mornings later.

This doc enumerates the cases, calls out the one that's actually catastrophic, and proposes how the DM should change.

## What runSweepCheck already knows

The cron already pulls **30 days** of forward Recollect events for each subscriber's address. We just throw most of it away — `next_event = sweep_events[0]` and the rest is unused. Fixing the messaging is mostly a presentation problem: the data is in hand.

Side detection (`whichSide`) returns the user's parked side (`even`/`odd`/`unknown`) plus the building parity that mapped the geometric side. Same data is reused.

Cron fires daily at 12:00 ET. Sweeping windows are 8AM-12PM. The cron always runs *after* a same-day sweep would have happened, so any T-0 ("today") DM would already be too late by definition — that's why the dispatcher filters to `days_until_next ∈ {1,2,3}` only.

## Scenario catalog

For every scenario: **car starts on EVEN side at #9.** "Move" = user reads the T-1 DM the night before and physically relocates.

### A. Lone sweep, opposite side clear

```
Tue 5/12  EVEN sweep 8-12        ← within window
Wed 5/13  —
Thu 5/14  —
…(no ODD sweep for 14+ days)
```

**Outcome with current logic:** T-3/T-2/T-1 DMs fire on Sat/Sun/Mon. User flips to ODD Mon night. ODD has no upcoming sweep. Fine.

**Outcome with smart logic:** identical, but the message tells them how long ODD is clear so they don't flip-flop unnecessarily.

### B. Same-week opposite-side sweep (the canonical "VoX" case)

```
Tue 5/12  EVEN sweep 8-12
Thu 5/14  ODD sweep 8-12
```

**Outcome with current logic:**
1. Mon noon T-1: DM "EVEN sweep tomorrow, move tonight."
2. User flips to ODD Mon night.
3. Tue 8AM EVEN sweep — safe.
4. Tue noon cron re-snapshots the user on ODD. `next_event = Thu ODD`, `days_until_next = 2`. T-2 DM fires: "sweep in 2 days on your side."
5. Wed noon T-1: DM fires for Thu ODD.
6. User flips back to EVEN Wed night. Thu 8AM ODD sweep — safe.

So we *do* eventually warn them. But:
- It's **two flips for one week of parking**. Many users will read the first DM, move, and assume the job is done — they're not expecting a second DM 24 hours later.
- The first DM doesn't tell them about the second event, so they have no chance to plan a single off-street park instead of two flips.

**Smart message:** the Mon DM should mention Thu so the user can choose: flip-twice OR park-off-street-once.

### C. Adjacent-day opposite-side sweep

```
Tue 5/12  EVEN sweep 8-12
Wed 5/13  ODD sweep 8-12
```

**Outcome with current logic:**
1. Mon T-1: DM for Tue EVEN.
2. User flips to ODD Mon night.
3. Tue 8AM EVEN sweep — safe.
4. Tue noon cron: user is on ODD. `next_event = Wed ODD, days_until = 1`. T-1 DM fires.
5. User must read it the **same afternoon** and flip back **before Wed 8AM** — about 16-20 waking hours.

Mostly works. But: tight window, two notifications in 24 hours, and users who don't read DMs same-day get hit. **The Mon DM should tell them up front this week is a flip-flip pattern**, so they can park off-street Mon night and forget about it.

### D. Same-day staggered (the real catastrophe)

```
Tue 5/12  EVEN sweep 8-10
Tue 5/12  ODD  sweep 10-12
```

**Outcome with current logic:**
1. Mon T-1: DM for Tue EVEN. ODD is **not mentioned** — `next_event = sweep_events[0]` is just the EVEN entry, and the dispatcher's side filter would suppress the ODD entry anyway because at this moment the car is on EVEN.
2. User flips to ODD Mon night.
3. Tue 8-10 EVEN sweep — safe.
4. Tue 10-12 ODD sweep — **TICKET**. The Tue noon cron has not even fired yet by the time the ODD sweep is finishing.
5. Even if the cron *did* run pre-sweep, `days_until_next = 0` is filtered out of the DM dispatcher (which only fires for 1/2/3).

This is the failure mode where the system *guides the user into the violation*. We must catch it.

### E. Same-day both-sides

```
Tue 5/12  BOTH sides sweep 8-12   (Recollect tags this as side: 'both')
```

**Outcome with current logic:** DM fires (`side === 'both'` matches every car), message says "$50 fine!". User is told to move but has no safe destination on the same street.

**Smart message:** explicitly say "park off-street, flipping won't help." The current copy is alarming but not actionable.

### F. Opposite side just swept this morning

```
Mon 5/11  ODD  sweep 8-12   (ALREADY HAPPENED by the time T-3 DM fires)
Thu 5/14  EVEN sweep 8-12
```

User on EVEN. Mon noon cron fires. `next_event = Thu EVEN, days_until = 3`. T-3 DM fires.

**Outcome with current logic:** message says "Thu EVEN sweep, move." It doesn't mention that ODD was swept this morning and is now safe for ~14 days, which is exactly the info the user needs to make a confident move.

**Smart message:** "Move to ODD anytime — just swept this morning, clear for ~2 weeks."

### G. Triple-event week (rare but real on big arteries)

```
Mon 5/11  ODD  sweep 8-10
Wed 5/13  EVEN sweep 8-10
Fri 5/15  ODD  sweep 8-10
```

User on EVEN. Mon DMs about Wed. Wed they flip. Thu cron sees ODD, next is Fri ODD T-1. They flip back. **Three flips in one week.** Off-street park for half the week is the only sane option, and the Sun/Mon DM is the only chance to surface that.

### H. User not home / different parking address

The car spent the day at the office — Tesla GPS resolves to a different street's schedule. Out of scope for this work. The current sub model is "always notify based on current GPS"; cross-day caching would be a separate feature.

### I. Holiday cancellation

Recollect's events list reflects the cancellation directly — the event isn't returned. The current pipeline already handles this correctly. No work needed.

### J. Side detection low-confidence

`whichSide` falls back to `houseNum % 2` when OSM has no buildings. We already surface confidence in the diagnostic card, but the DM doesn't. Worth a one-liner footnote when `side_source === 'house_parity'` so users know to spot-check.

### K. One-sided street

User lives on a street with buildings on only one side (river edge, park edge). "Move to other side" is meaningless — there is no other side. `whichSide` reports building counts per side; if one side is empty, the DM should advise off-street directly.

## Messaging strategy options

### Option 1: do nothing

The cron's next-day re-snapshot does eventually catch most adjacent-day flips (Scenario C). Real risk is Scenario D (same-day staggered) — uncommon but catastrophic when it hits.

**Verdict:** unacceptable for D.

### Option 2: notify on every event regardless of side

Drop the `side === car_side` filter from `shouldNotifySweep`. User gets a DM for every sweep on their address.

**Pro:** fixes Scenario D — user finds out about the ODD sweep even when parked on EVEN.
**Con:** doubles notification volume, including for events the user can ignore. "Sweep tomorrow on the OTHER side" pings are noise for someone with no plan to move.

**Verdict:** half-step. Ships info but in the wrong shape.

### Option 3: per-DM action plan (recommended)

Replace `formatSweepDM(out)` with a planner that takes the **full week** of events plus the user's current side and produces a single message tailored to the situation. The planner classifies the upcoming 3-7 day window into one of:

| Class | Trigger | Message shape |
|---|---|---|
| `safe` | No sweeps on user's side in window | (no DM) |
| `lone-flip` | One sweep on user's side, opposite side clear ≥ 4 days | "Move to ODD — clear through {date}" |
| `tight-flip` | One sweep on user's side + opposite-side sweep within 1-3 days | "Flip to ODD by tonight, then BACK to EVEN by {date} evening (ODD sweeps {date})" |
| `same-day-stagger` | Both sides sweep same day, different times | "BOTH sides sweep {date} 8AM-12PM. Park off-street." |
| `both-sides-flag` | Recollect event with `side: 'both'` | "Full-block sweep {date} 8AM-12PM. Park off-street." |
| `triple-flip` | 3+ events in next 7 days | "Three sweeps this week ({dates}). Park off-street through {end-date}." |
| `opposite-already-swept` | Opposite swept today AM, user-side sweep upcoming | "Move to ODD — just swept this morning, clear for ~2 weeks" |
| `one-sided-street` | `whichSide` reports empty opposite side | "No safe spot on this block — park off-street." |

Each class has a single canonical sentence pattern. The planner walks `sweep_events` once, classifies, picks the template, fills in dates. No conditional fan-out in the user-facing copy.

**Pro:** every notification is actionable. The user knows exactly what to do without having to mentally project the rest of the week.
**Con:** more code, more test surface. The planner needs unit tests for each class (none of those exist today; we'd add them).

**Verdict:** the right call. The whole point of the app is "tell me what to do," not "tell me a fact about today."

### Option 4: weekly digest (additive, optional)

Sunday-evening DM with the upcoming week's full schedule and a recommended parking plan. Per-day T-1/T-2/T-3 DMs continue, but the digest is the one the user actually plans against. Nice-to-have polish; lower priority than fixing the per-event copy.

## Recommended approach

Ship **Option 3** as a single change:

1. New module `src/notifications/planner.js` exporting `classifyWeek(events, carSide, todayET)` → `{ class, eventDate, oppositeDate, message }`.
2. `formatSweepDM` calls `classifyWeek` and renders the message text.
3. `shouldNotifySweep` becomes `shouldDispatch(plan)` — fires whenever `plan.class !== 'safe'` and `last_dm_date !== todayET` (existing dedup gate stays).
4. Unit tests for each class with crafted `sweep_events` fixtures. No real Recollect calls in tests — pass synthetic event lists straight to `classifyWeek`.
5. Per-DM action sentence stays under 4 lines so Slack notifications still fit on a phone screen.

Then layer **Option 4** later as a separate cron (Sun 8PM ET) calling a `formatWeeklyDigest(plan)` variant.

## Implementation sketch

```js
// src/notifications/planner.js
export function classifyWeek({ events, carSide, todayET }) {
  const today = new Date(todayET + 'T12:00:00Z');
  const window = events.filter(e => daysBetween(e.date, todayET) <= 7);

  // Same-day staggered: two events on the same date, different sides
  const sameDayPair = findSameDateOppositeSides(window);
  if (sameDayPair) return { class: 'same-day-stagger', ...sameDayPair };

  // Both-sides flag from Recollect
  const both = window.find(e => e.side === 'both');
  if (both) return { class: 'both-sides-flag', event: both };

  // Triple-or-more events in window
  if (window.length >= 3) return { class: 'triple-flip', events: window };

  // User-side event in window
  const mine = window.find(e => e.side === carSide);
  if (!mine) return { class: 'safe' };

  // Look for opposite-side conflict in the window after `mine`
  const oppositeSide = carSide === 'even' ? 'odd' : 'even';
  const conflict = window.find(e =>
    e.side === oppositeSide &&
    daysBetween(mine.date, e.date) >= 0 &&
    daysBetween(mine.date, e.date) <= 3
  );
  if (conflict) return { class: 'tight-flip', mine, conflict };

  // Opposite-side just swept this morning
  if (sweptThisMorning(events, oppositeSide, todayET)) {
    return { class: 'opposite-already-swept', mine, oppositeSide };
  }

  return { class: 'lone-flip', mine, nextOppositeFar: nextOppositeBeyondWindow(events, oppositeSide) };
}
```

Message templates live alongside as a single `MESSAGES[class](plan)` map — easy to grep, easy to A/B copy later.

## Risk / out-of-scope

- **Subscriber base is small (single digits today).** A misclassification ships to one user. Worst case: extra DM, or a single missed "park off-street." Risk is contained; rolling forward is fine.
- **No mock for Recollect schedule patterns** in tests. We'd seed handcrafted event arrays into `classifyWeek` directly; integration with the real Recollect feed stays manually verified.
- **User-driven side flips that happen between cron runs** are still invisible to the planner — we only see GPS at noon. Fixing that needs vehicle-state polling, which is rate-limited Tesla territory and out of scope for this brainstorm.
- **Multi-block streets** where house numbering jumps (Beacon St crossing a bridge) might confuse `whichSide`'s parity vote. Already a known limitation; the planner inherits it.
- **Cancellation mid-week** (snow): Recollect-driven; the planner re-classifies fresh each cron run, so a removed event drops out naturally.

## Net diff estimate

- `src/notifications/planner.js`: ~150 lines (classifier + message templates)
- `src/notifications/planner.test.js`: ~200 lines (one fixture per class, two-three edge cases each)
- `server.js`: ~20 lines net (rip out current `formatSweepDM` + `shouldNotifySweep`, replace with planner call)
- 1-2 commits.
