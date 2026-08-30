const mongoose = require('mongoose');
const { CONNECTOR_PROVIDERS } = require('../utils/connectorProviders');

/**
 * "This board uses this connector."
 *
 * ---- Why this is a collection and not a field on Board ----------------------
 *
 * Board is already a 400-line schema carrying labels, statuses, columns,
 * goalColumns, groupTags, portal categories and portal FAQs. Adding a seventh
 * embedded array would load all of it on every board read for the benefit of a
 * feature most boards never turn on, and every future connector setting would
 * have to be threaded through that same document.
 *
 * ---- Why it exists at all, rather than being inferred ----------------------
 *
 * The obvious shortcut is "a board uses Ubersuggest if any ConnectorProject is
 * mapped to one of its groups". That inverts the order people actually work in:
 * you enable the connector, THEN browse the projects, THEN decide which maps to
 * which group. Inferring enablement from mapping would leave no way to see the
 * project list before committing to a mapping — and no way to keep the tab while
 * temporarily unmapping a client.
 *
 * The row is also what the Ubersuggest tab's visibility keys off. Enabling is
 * `connector.manage`; seeing the result is `connector.view`.
 */
const boardConnectorSchema = new mongoose.Schema(
  {
    board: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Board',
      required: true,
      index: true,
    },
    // Denormalised from the board so an org cascade can clean up without
    // loading boards first — the same reasoning as TrackerEntry carrying board.
    organisation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organisation',
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: CONNECTOR_PROVIDERS,
      required: true,
    },

    /**
     * Disabling hides the tab and stops the runner without discarding anything.
     * A row is kept rather than deleted so the field mappings, the group-to-
     * project bindings and every snapshot survive being switched off and back
     * on — turning a connector off for a month should not cost you the history
     * that is the entire point of the feature.
     */
    enabled: { type: Boolean, default: true },

    /**
     * WHAT WE PAY TO COLLECT. Empty means "everything the provider offers",
     * which is the sane default for a board that just enabled it. A board that
     * only cares about rankings can narrow this and stop paying for audits it
     * never opens.
     *
     * ---- Why this and `enabledScreens` are two fields ----------------------
     *
     * They read like the same switch and they are not, and collapsing them
     * would be a bug with somebody else's name on it.
     *
     * `scheduleForProvider` UNIONS `kinds` ACROSS EVERY BOARD that maps the same
     * project, because the project is collected ONCE and one collection has to
     * satisfy whichever board asked for the most. So narrowing this list is not
     * a local act: a co-tenant board that narrows to `positions` cannot take
     * `movement` away from a board that wants it — but the reverse is also true,
     * and a board switching a kind ON starts a purchase every board mapping that
     * project shares the bill for.
     *
     * `enabledScreens` below is free and purely local. It changes what THIS
     * board renders out of data already collected and paid for, and it can never
     * reach across to a co-tenant.
     *
     * The rule that falls out: narrow `enabledScreens` to tidy a tab, narrow
     * `kinds` only when the intent really is "stop buying this".
     */
    kinds: { type: [String], default: [] },

    /**
     * WHAT WE RENDER. Empty means "every screen the provider declares".
     *
     * The other half of the pair above, and the cheap half. A screen is a view
     * over snapshots we already hold, so switching one off costs nothing, gives
     * nothing back, and cannot affect another board — which is exactly why it is
     * the right knob for "this client does not care about backlinks" and `kinds`
     * is not.
     *
     * Validated against the descriptor's own `screens` catalog on write, so a
     * key that no provider declares cannot be stored. An unknown key left in the
     * array would be indistinguishable from a screen a later phase adds, and the
     * day phase 7 ships `backlinks` a board carrying a stale `backlinks` string
     * would silently switch it on.
     */
    enabledScreens: { type: [String], default: [] },

    /**
     * How often this board wants its projects collected, in hours. Null — the
     * normal state — means the descriptor's own cadence.
     *
     * ---- The consequence of "min across boards" ----------------------------
     *
     * `snapshotService.scheduleForProvider` resolves this as the MINIMUM across
     * every board mapping the same project, for the same reason `kinds` is
     * unioned: there is one collection and it has to satisfy the board that
     * asked for the most. So THE EAGER BOARD'S CADENCE IS SUBSIDISED BY THE
     * FRUGAL ONE — board A asking for 24h and board B asking for 168h produces
     * one 24h collection, and B pays for none of the extra six-sevenths.
     *
     * That is fine while budgets are per organisation, which is what
     * `ConnectorBudget`'s `org` scope is: one DataForSEO account, one pot, and
     * the internal split is a reporting question. IT STOPS BEING FINE THE DAY
     * ANYONE BILLS PER BOARD, because at that point B is charged nothing for a
     * cadence A chose. The fix on that day is not a smarter min — it is to stop
     * collecting a shared project once, which is a different design.
     *
     * A 0, a negative or a NaN is treated as "no opinion" by
     * `snapshotService.askedInterval` rather than as "every hour"; the write
     * path below refuses to store one at all.
     */
    intervalHours: { type: Number, default: null },

    /**
     * WHICH ALERT HAS ALREADY BEEN SENT ABOUT WHICH READING.
     *
     * A flat map of `rule|project|variant` to the `periodKey` last notified
     * about, written by `services/seoAlertRunner.js` and read by nothing else.
     *
     * ---- Why this is a claim rather than a log ------------------------------
     *
     * The alert pass runs hourly and reads the same two snapshots every time
     * until a new one lands. Without a claim, one rank drop is a notification
     * every hour for a week — which is not a louder version of the feature, it
     * is the feature destroyed, because the second message teaches everybody to
     * ignore the first.
     *
     * The claim is `findOneAndUpdate` with `{[path]: {$ne: periodKey}}` in the
     * FILTER, so it is atomic on one document and holds across a restart, a
     * clock that steps backwards and a second Render instance — the same
     * technique `GoalReminder`'s unique index uses, without a collection of its
     * own for something that is one string per rule per site.
     *
     * ---- And why it is claimed BEFORE the notification goes out -------------
     *
     * `goalReminderRunner` records the reasoning and it holds here: a crash
     * between the claim and the fan-out UNDER-notifies, and a crash the other
     * way round notifies twice. For an alert, under is the right direction to
     * fail.
     *
     * `Mixed` because the keys are composed at runtime and are not a schema.
     * They contain no dots by construction — a variant key is
     * `2840|en|desktop`, an id is hex, and a rule key is `[a-z_]`.
     */
    alertState: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },

    /**
     * What this board is ALLOWED TO CONSUME, not what it is guaranteed.
     *
     * ---- Why an allocation and not a ceiling -------------------------------
     *
     * Money is per provider ACCOUNT and the account is org-scoped — DataForSEO
     * has no sub-accounts, no multiple API keys and no reseller programme, so
     * per-tenant metering is entirely our problem. The number that actually
     * stops work is therefore the org's `ConnectorBudget`, and this one answers
     * a billing question instead: how much of the workspace's money may this
     * client's board account for.
     *
     * Reserved SECOND and released FIRST, so a board that has used up its
     * allocation can never leave the org's money held — see
     * `services/connectors/budget.js` `reserveAll`.
     *
     * NULL BY DEFAULT, and absent is the normal state: a board with no
     * allocation is bounded by the org cap like everything else, exactly as it
     * was before budgets existed. Only an explicit positive number creates a
     * second budget document, so the two-document reservation and its
     * compensation are opt-in rather than a cost every job pays.
     *
     * ---- Why there is no `perRefreshUsd`, which the plan listed -------------
     *
     * Decided while building the panel, and recorded rather than left as a gap.
     * A per-refresh ceiling can only be enforced where a cost ESTIMATE exists,
     * and the estimate is built inside the provider's own reserve
     * (`dataforseo/budget.js`) from the account's live price book — several
     * layers below `refreshConnectorData`, which knows only a board and a
     * provider. A field the write path stores and no gate reads is worse than no
     * field: it reads as a limit, and the first person to trust it finds out it
     * never was one. The two ceilings that are real — the org cap and this
     * board's monthly allocation — already bound a runaway refresh, and the
     * per-hour rate limit on the refresh route bounds the number of attempts.
     */
    budget: {
      /** USD per calendar month, UTC. Null means "bounded only by the org cap". */
      monthlyUsd: { type: Number, default: null },
      /** Warn at this fraction of the allocation. Display only; never a gate. */
      alertAtPct: { type: Number, default: 80 },
    },

    lastRefreshAt: { type: Date, default: null },
    lastRefreshBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    enabledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true }
);

// One row per (board, provider). Upserted against, so a double-click on Enable
// cannot produce two rows and a board cannot half-enable a connector.
boardConnectorSchema.index({ board: 1, provider: 1 }, { unique: true });

module.exports = mongoose.model('BoardConnector', boardConnectorSchema);
