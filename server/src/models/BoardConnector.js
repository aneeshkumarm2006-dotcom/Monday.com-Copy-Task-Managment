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
     * Which snapshot kinds this board wants. Empty means "everything the
     * provider offers", which is the sane default for a board that just enabled
     * it. A board that only cares about rankings can narrow this and stop paying
     * for audits it never opens.
     */
    kinds: { type: [String], default: [] },

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
