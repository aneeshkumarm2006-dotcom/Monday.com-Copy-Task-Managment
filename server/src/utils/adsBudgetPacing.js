const { firstDayKeyOf, lastDayKeyOf, isMonthKey } = require('./monthKey');
const { dayKeyOf, daysBetween, compareDayKeys } = require('./tzDay');

/**
 * The ONLY place a budget's status is decided.
 *
 * ---- Why this is server-side, and singular ---------------------------------
 *
 * Every status the Ads Budget tab renders — the chip on a platform row, the
 * chip on a campaign row, the verdict under the Budget Overview bar, and the
 * per-client column on the roster — is this one function. The client is handed
 * a `state` string and looks up a colour; it never compares a percentage to a
 * threshold of its own.
 *
 * That is the rule `utils/goalTypes.js` states for scoring, and it exists
 * because two implementations of a threshold is two answers to "is this client
 * overspending", which is the question the page is for. It also keeps the CSV
 * and PDF exports honest: they carry the state that was on screen, not a second
 * opinion computed while writing the file.
 *
 * ---- Pacing is a fact about the CALENDAR, so it needs the board's timezone --
 *
 * "57% spent" means nothing on its own. It is healthy on the 18th of a 31-day
 * month and alarming on the 4th, so every judgement below compares spend
 * against the fraction of the month that has ELAPSED — and which day it is
 * depends on where the board thinks it lives.
 *
 * NEVER reach for `new Date().toISOString().slice(0, 10)` to get "today". That
 * is the UTC day, it is a very tempting one-liner, and `utils/tzDay.js` already
 * names two places in this codebase that got it wrong. A board in Auckland
 * would spend the first thirteen hours of every month being told it was still
 * last month, and the pacing verdict would flip with it.
 *
 * ---- Pure ------------------------------------------------------------------
 *
 * No mongoose, no `Date.now()` except through the injectable `now`. That is
 * what lets `adsBudgetPacing.test.js` assert the boundaries — the 15-point
 * drift, a leap February, a past and a future month — rather than describe them.
 */

/**
 * How far through the month we are, in the board's own timezone.
 *
 * `elapsedDays` counts TODAY as elapsed (the 1st is 1 of 31, not 0), because
 * money can be spent on the day being counted. A past month is fully elapsed; a
 * future month has not started. Both are clamped rather than allowed to go
 * negative or overshoot, so a bookmarked link to next March cannot produce a
 * pacing verdict built on -180 days.
 *
 * @param {string} monthKey  'YYYY-MM'
 * @param {string} timezone  IANA zone; the board's `monthTimezone`
 * @param {Date|number} [now]
 * @returns {{totalDays:number, elapsedDays:number, remainingDays:number, elapsedPct:number}|null}
 */
const monthWindow = (monthKey, timezone, now = Date.now()) => {
  if (!isMonthKey(monthKey)) return null;

  const first = firstDayKeyOf(monthKey);
  const last = lastDayKeyOf(monthKey);
  const totalDays = daysBetween(first, last) + 1;

  const today = dayKeyOf(now, timezone || 'UTC');
  if (!today) return null;

  let elapsedDays;
  if (compareDayKeys(today, first) < 0) {
    // The month has not started. Nothing is elapsed, and nothing is expected.
    elapsedDays = 0;
  } else if (compareDayKeys(today, last) > 0) {
    // The month is over. It is fully elapsed — a closed month is judged on the
    // whole of itself, not on the fraction that had passed when it closed.
    elapsedDays = totalDays;
  } else {
    elapsedDays = daysBetween(first, today) + 1;
  }

  return {
    totalDays,
    elapsedDays,
    remainingDays: totalDays - elapsedDays,
    elapsedPct: totalDays > 0 ? elapsedDays / totalDays : 0,
  };
};

/**
 * How far spend may drift from the calendar before it is worth saying so.
 *
 * 15 points, both directions; `at_risk` is twice that. Tighter and every board
 * is amber for the first week, when one day's spend is a large fraction of the
 * month so far and the noise is larger than the signal. Looser and a client can
 * be half a month's budget out before anybody is told.
 *
 * ---- Where this number came from, since the brief did not supply one --------
 *
 * The brief lists the vocabulary (On Track / Low Spend / Needs Attention / Over
 * Budget) and gives example rows, but those examples are ILLUSTRATIVE and not
 * reproducible from any single rule — in its own table, two rows at an
 * identical 68.9% of budget carry different statuses, and a row 2.2 points
 * AHEAD of pace is labelled "Low Spend" while one 1.7 points ahead is "On
 * Track". Implementing them literally would mean implementing a contradiction.
 *
 * The one figure the brief does state as a computed verdict is the Budget
 * Overview: $14,280 of $25,000 with 17 of 31 days left — 57.1% spent against
 * 45.2% elapsed, a drift of 12.0 points — described as "Healthy pacing". So the
 * band has to be wider than 12 points, and 15 is the round number above it.
 */
const DRIFT = 0.15;

/**
 * The states, in the order they are TESTED. First match wins, and the order is
 * the point: a row that has already gone over budget is over budget, not
 * "at risk of going over".
 *
 * `label` is the chip on a table row. `verdict` is the sentence under the
 * Budget Overview bar, which reads as a description of the month rather than a
 * classification of a row — "Spending ahead" rather than "Needs Attention".
 * `tone` is what the client maps to a colour; red is reserved for `over` alone.
 */
const STATES = {
  unset: { label: 'Not set up', verdict: 'Nothing budgeted yet', tone: 'neutral' },
  draft: { label: 'Draft', verdict: 'Not activated', tone: 'neutral' },
  paused: { label: 'Paused', verdict: 'Paused', tone: 'neutral' },
  over: { label: 'Over Budget', verdict: 'Over budget', tone: 'danger' },
  at_risk: { label: 'Needs Attention', verdict: 'At risk', tone: 'warning' },
  ahead: { label: 'Needs Attention', verdict: 'Spending ahead', tone: 'warning' },
  behind: { label: 'Low Spend', verdict: 'Spending behind', tone: 'warning' },
  on_track: { label: 'On Track', verdict: 'Healthy pacing', tone: 'positive' },
};

const STATE_KEYS = Object.keys(STATES);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * One row's — or one rollup's — money and verdict.
 *
 * Takes a window rather than a monthKey so a screenful of rows shares one
 * calendar computation instead of re-deriving it per row, and so the roster's
 * per-client rollups and the detail screen's per-platform rows cannot disagree
 * about what day it is mid-render.
 *
 * @param {{allocated:number, spent:number, lifecycle?:string}} row
 * @param {object|null} window  from `monthWindow`
 */
const paceOf = (row, window) => {
  const allocated = num(row && row.allocated);
  const spent = num(row && row.spent);
  const remaining = allocated - spent;

  const usedPct = allocated > 0 ? spent / allocated : null;
  const elapsedPct = window ? window.elapsedPct : null;

  /**
   * What this row is on course to spend by month end.
   *
   * Null before any day has elapsed — dividing by zero elapsed days would make
   * a future month's projection Infinity, which then compares as "over budget"
   * and paints every not-yet-started month red.
   */
  const projected =
    window && window.elapsedDays > 0
      ? (spent / window.elapsedDays) * window.totalDays
      : null;

  /** Spend per elapsed day. The tab's "Daily Average Spend" KPI. */
  const dailyAverage =
    window && window.elapsedDays > 0 ? spent / window.elapsedDays : null;

  const money = {
    allocated,
    spent,
    remaining,
    usedPct,
    elapsedPct,
    projected,
    dailyAverage,
  };

  // A row somebody has explicitly parked is not paced. Judging a paused
  // campaign as "Low Spend" is technically true and completely useless — it is
  // not spending because it was switched off.
  const lifecycle = row && row.lifecycle;
  if (lifecycle === 'draft' || lifecycle === 'paused') {
    return { ...money, state: lifecycle, ...STATES[lifecycle] };
  }

  // Nothing committed and nothing spent. Distinguished from on-track-at-zero
  // because the roster uses it to answer "which clients has nobody set up yet",
  // which is most of the roster's value in the first week of a month.
  if (allocated === 0 && spent === 0) {
    return { ...money, state: 'unset', ...STATES.unset };
  }

  /**
   * The ladder. First match wins, and it runs from most to least certain.
   *
   * `projected` deliberately does NOT appear here, though it is returned above
   * and shown on screen as Projected Spend. A linear projection exceeds the
   * budget the moment spend is even fractionally ahead of the calendar, so
   * using it as a trigger makes `at_risk` fire on almost every active row and
   * swallow `ahead` entirely — and it would have flagged the brief's own
   * "Healthy pacing" example, which projects 26% over. It is useful as a number
   * a person reads next to the drift; it is useless as a threshold.
   */
  /**
   * Rounded before it is compared, because these are two divisions subtracted:
   * 65/100 − 50/100 is 0.15000000000000002 in binary floating point, which is
   * greater than DRIFT, so a row sitting EXACTLY on the band would tip over it
   * on some numbers and not others. Six decimal places is a ten-thousandth of a
   * percentage point — far below anything a person could act on, and well above
   * the noise.
   */
  const drift =
    usedPct !== null && elapsedPct !== null
      ? Math.round((usedPct - elapsedPct) * 1e6) / 1e6
      : null;

  let state;
  if (spent > allocated) {
    state = 'over';
  } else if (drift !== null && drift > DRIFT * 2) {
    state = 'at_risk';
  } else if (drift !== null && drift > DRIFT) {
    state = 'ahead';
  } else if (drift !== null && drift < -DRIFT) {
    state = 'behind';
  } else {
    state = 'on_track';
  }

  return { ...money, state, ...STATES[state] };
};

/**
 * Sum a set of rows and pace the total.
 *
 * PLATFORM ROWS ONLY. Passing campaigns in as well double-counts them — see
 * `models/AdsBudget.js` for why a platform's budget is not the sum of its
 * campaigns. This function cannot check that for you; it sums what it is given.
 *
 * Draft rows stay OUT of the totals, the way an unsent invoice is not revenue:
 * that money has not been committed. Paused rows stay IN — that budget was
 * committed and part of it may already be spent, and dropping it would make a
 * client's remaining balance jump the moment somebody parked a campaign.
 *
 * The rollup is paced as `active` rather than inheriting a lifecycle: "this
 * client has one paused platform" is a fact about that row, not about the
 * client's month, and one draft row must not grey out a whole roster line.
 */
const rollUp = (rows, window) => {
  let allocated = 0;
  let spent = 0;
  for (const row of rows || []) {
    if (row && row.lifecycle === 'draft') continue;
    allocated += num(row && row.allocated);
    spent += num(row && row.spent);
  }
  return paceOf({ allocated, spent, lifecycle: 'active' }, window);
};

module.exports = {
  DRIFT,
  STATES,
  STATE_KEYS,
  monthWindow,
  paceOf,
  rollUp,
};
