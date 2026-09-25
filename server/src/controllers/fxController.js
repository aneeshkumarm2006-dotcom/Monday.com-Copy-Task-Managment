const { snapshotsFor, fetchAndStore } = require('../services/fx/rateService');
const { FX_BASE, DISPLAY_CURRENCIES } = require('../utils/money');
const { FxError } = require('../services/fx/errors');
const Organisation = require('../models/Organisation');

/**
 * EXCHANGE RATES, FOR THE BROWSER.
 *
 * ---- Why this is not under /api/orgs/:id -----------------------------------
 *
 * Because the rates are not the org's. `FxSnapshot` is deliberately global — a
 * rate is a public fact, and what one dollar bought in rupees on 3 March does
 * not depend on who is asking. Hanging it off a workspace id would imply a
 * per-workspace answer that does not exist, and would make the browser re-fetch
 * an identical table every time somebody switched workspaces.
 *
 * It still sits behind `authMiddleware`. Not because the numbers are secret —
 * they are published by central banks — but because an unauthenticated endpoint
 * is an open proxy to somebody else's free API, and the polite thing to do with
 * a courtesy is not to lend it out.
 */

/**
 * GET /api/fx/rates
 *
 * Returns every snapshot the client needs, newest first, plus what it may
 * convert INTO. The whole set rather than one "current" table, because
 * conversion is per record: a ledger holds invoices from different months and
 * each converts at its own month's rate.
 */
const getRates = async (req, res) => {
  try {
    const snapshots = await snapshotsFor({ base: FX_BASE });
    return res.json({
      base: FX_BASE,
      displayCurrencies: DISPLAY_CURRENCIES,
      snapshots,
      // The newest day we hold, for a settings screen that wants to say when
      // rates were last published without walking the list.
      asOf: snapshots.length ? snapshots[0].dayKey : null,
    });
  } catch (err) {
    console.error('getRates error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/fx/refresh — fetch now, for this workspace's configuration.
 *
 * The manual counterpart to the hourly runner, for the Currency settings
 * screen: somebody who has just pasted an API key wants to know it works
 * NOW, not at seventeen past.
 *
 * Deliberately NOT behind `refreshIfDue` — the whole point is to bypass the
 * cadence check, because "nothing happened" is a useless answer to "does my
 * key work". It is gated on `org.manage_settings` by the route, so only the
 * handful of people who can change the provider can spend a request proving it.
 */
const refreshRates = async (req, res) => {
  const orgId = req.params.id;
  try {
    const result = await fetchAndStore({ orgId });
    await Organisation.updateOne(
      { _id: orgId },
      { $set: { 'fx.lastFetchAt': new Date(), 'fx.lastError': '' } }
    );
    return res.json({ ok: true, ...result });
  } catch (err) {
    const display = err instanceof FxError ? err.toDisplay() : 'Could not fetch exchange rates.';
    // Recorded as well as returned: the person testing a key sees it now, and
    // the settings screen still says so after a reload.
    await Organisation.updateOne({ _id: orgId }, { $set: { 'fx.lastError': display } }).catch(
      () => {}
    );
    if (!(err instanceof FxError)) console.error('refreshRates error:', err);
    return res.status(400).json({ error: display });
  }
};

module.exports = { getRates, refreshRates };
