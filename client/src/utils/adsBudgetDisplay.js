/**
 * How ads budgets are RENDERED. Nothing here decides anything.
 *
 * The state on every row — `on_track`, `behind`, `over` and the rest — is
 * computed once on the server by `utils/adsBudgetPacing.js` and travels with
 * the row. This file only turns that string into a colour, and turns activity
 * rows into ledger lines. If you find yourself comparing a percentage to a
 * threshold in here, it belongs on the server instead: two implementations of
 * "is this client overspending" is two answers to the question the tab is for.
 *
 * Kept free of React so the ledger rules can be asserted by a plain Node test
 * (`adsBudgetDisplay.test.mjs`) rather than described in a comment — the same
 * arrangement `rankRows.js` and `goalDisplay.js` already use.
 */

/**
 * State → the colours it wears.
 *
 * The `tone` the server sends is the authority on severity; this map exists
 * because a tone is not a colour and the palette lives here. Mirrors
 * `OUTCOME_META` in goalDisplay.js in shape, so a status chip on the Ads Budget
 * tab and one on the Goals tab are visibly the same kind of thing.
 *
 * RED IS RESERVED FOR `over`. A page that is amber everywhere teaches people to
 * ignore amber; a page that is red everywhere teaches them to ignore red. Ahead
 * of pace, behind pace and at risk are all worth a second look and none of them
 * is a failure — the money has not been lost, it is being spent at the wrong
 * speed.
 */
export const STATE_META = {
  on_track: {
    label: 'On Track',
    color: 'var(--color-status-done)',
    bg: 'var(--color-status-done-bg)',
  },
  behind: {
    label: 'Low Spend',
    color: 'var(--color-status-working)',
    bg: 'var(--color-status-working-bg)',
  },
  ahead: {
    label: 'Needs Attention',
    color: 'var(--color-status-working)',
    bg: 'var(--color-status-working-bg)',
  },
  at_risk: {
    label: 'Needs Attention',
    color: 'var(--color-status-working)',
    bg: 'var(--color-status-working-bg)',
  },
  over: {
    label: 'Over Budget',
    color: 'var(--color-status-stuck)',
    bg: 'var(--color-status-stuck-bg)',
  },
  draft: {
    label: 'Draft',
    color: 'var(--color-text-muted)',
    bg: 'var(--color-bg-subtle)',
  },
  paused: {
    label: 'Paused',
    color: 'var(--color-text-muted)',
    bg: 'var(--color-bg-subtle)',
  },
  unset: {
    label: 'Not set up',
    color: 'var(--color-text-muted)',
    bg: 'var(--color-bg-subtle)',
  },
};

/**
 * The colours for a state, falling back rather than rendering a blank chip.
 *
 * A state this client has no entry for is NAMED — the raw key, in muted grey —
 * for the same reason `ConnectorDataTab` names a section kind it cannot render:
 * a server that grew a state should show something honest, not nothing.
 */
export const stateMeta = (state, serverLabel) => {
  const known = STATE_META[state];
  if (known) return known;
  return {
    label: serverLabel || state || 'Unknown',
    color: 'var(--color-text-muted)',
    bg: 'var(--color-bg-subtle)',
  };
};

/** A 0–1 fraction as a whole percentage, or an em dash. Never 0 for null. */
export const formatPct = (fraction) => {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(1)}%`;
};

/** The 0–100 number a progress bar fills to. Clamped; a bar cannot overflow. */
export const barPct = (fraction) => {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return 0;
  return Math.max(0, Math.min(100, fraction * 100));
};

/**
 * ---- The ledger ------------------------------------------------------------
 *
 * "Budget Activity" is not a second thing people type in. It is the row edits,
 * read back as money movements. That is the whole reason the tab can offer
 * editable Budget and Spend fields without also asking for a matching ledger
 * line — and it is why an amount here is always DERIVED from what changed,
 * never stored. Correcting a typo moves the ledger rather than adding a second
 * entry contradicting the first.
 *
 * The sign convention, which is the part worth getting right:
 *
 *   allocated ↑   money INTO the plan     +   "Budget added" / "Budget adjustment"
 *   allocated ↓   money OUT of the plan   −   "Budget adjustment"
 *   spent     ↑   money OUT of the plan   −   "Campaign spend"
 *   spent     ↓   a correction back in    +   "Spend correction"
 *
 * So `direction` is not simply the sign of the delta: raising the SPEND by 640
 * is money leaving, and shows as −640. Reading it the other way round paints
 * every ad campaign as income.
 */

/** Fields that carry money and therefore produce a ledger line. */
const MONEY_FIELDS = new Set(['allocated', 'spent']);

const numeric = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * What one activity row means in the ledger, or null if it is not a movement.
 *
 * Renames, owner changes and pauses are real history and appear in a row's own
 * timeline — they are simply not money, and a ledger that listed them would
 * bury the four lines somebody opened it to read.
 */
const ledgerRow = (entry) => {
  const meta = entry?.metadata || {};
  const platform = meta.platform || '';
  const name = meta.isCampaign ? meta.campaignName || 'a campaign' : platform || 'a budget';

  if (entry?.type === 'ads_budget.created') {
    const opened = numeric(entry.newValue?.allocated);
    if (opened === 0) return null;
    return {
      _id: entry._id,
      createdAt: entry.createdAt,
      platform,
      name,
      isCampaign: !!meta.isCampaign,
      activity: 'Budget added',
      amount: opened,
      direction: 'in',
      actor: entry.actor || null,
    };
  }

  if (entry?.type === 'ads_budget.deleted') {
    // What left the plan with it. Shown as money out, because after this row
    // the client's allocated total is lower by exactly this much — a ledger
    // that omitted it would not reconcile against the tables above it.
    const removed = numeric(entry.oldValue?.allocated);
    if (removed === 0) return null;
    return {
      _id: entry._id,
      createdAt: entry.createdAt,
      platform,
      name,
      isCampaign: !!meta.isCampaign,
      activity: 'Budget removed',
      amount: removed,
      direction: 'out',
      actor: entry.actor || null,
    };
  }

  if (entry?.type !== 'ads_budget.field_changed') return null;
  if (!MONEY_FIELDS.has(entry.field)) return null;

  // `delta` is written by the server alongside the change. Recomputed here only
  // when it is absent — rows from an older build, or a path that forgot it.
  const delta =
    typeof entry.metadata?.delta === 'number'
      ? entry.metadata.delta
      : numeric(entry.newValue) - numeric(entry.oldValue);
  if (delta === 0) return null;

  const isSpend = entry.field === 'spent';
  let activity;
  if (isSpend) {
    activity = delta > 0 ? 'Campaign spend' : 'Spend correction';
  } else {
    // "Added" for a first allocation, "adjustment" for a later change. Both are
    // in the brief's own example ledger and they are genuinely different
    // events: one starts a budget, the other revises one.
    const from = numeric(entry.oldValue);
    activity = from === 0 && delta > 0 ? 'Budget added' : 'Budget adjustment';
  }

  // Spend rising is money OUT even though its delta is positive. This inversion
  // is the one thing in this file that is easy to get backwards.
  const outward = isSpend ? delta > 0 : delta < 0;

  return {
    _id: entry._id,
    createdAt: entry.createdAt,
    platform,
    name,
    isCampaign: !!meta.isCampaign,
    activity,
    amount: Math.abs(delta),
    direction: outward ? 'out' : 'in',
    actor: entry.actor || null,
  };
};

/**
 * Activity rows → ledger lines, newest first, non-money rows dropped.
 *
 * @param {Array} items - from `getClientActivity`
 */
export const ledgerRows = (items) => (items || []).map(ledgerRow).filter(Boolean);

/** "+$2,000" / "−$640", given a formatter that already knows the currency. */
export const signedAmount = (row, format) => {
  const body = format(row.amount);
  // A true minus sign, not a hyphen: it aligns with digits and reads as
  // arithmetic rather than as a dash between words.
  return row.direction === 'out' ? `−${body}` : `+${body}`;
};

export const amountColor = (row) =>
  row.direction === 'out' ? 'var(--color-text-primary)' : 'var(--color-status-done)';
