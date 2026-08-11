const mongoose = require('mongoose');

/**
 * A human's word about one (tracker, group, period) cell.
 *
 *   confirmed — "this did happen." Satisfies a MANUAL_CONFIRM requirement, and
 *               on a tracker that does not require one it overrides the cell to
 *               `met` outright. This is how a monthly client report gets
 *               recorded: the document is sent by email or Drive, not created in
 *               Macan, so nothing in the task data can ever prove it went out.
 *               `link` holds the doc URL and renders as a Drive chip.
 *   excused   — "this was not owed." Client on hold, project paused, agreed day
 *               off. Leaves the kept/required ratio entirely rather than
 *               counting as a miss.
 *
 * These rows are also the only escape hatch for the two known correctness limits
 * of computing on read: a task moved between groups rewrites its own history
 * (Task.group is the CURRENT group), and deleting a task destroys its updates
 * and activity rows. When the grid gets a cell wrong for either reason, a human
 * says so here and their word wins.
 *
 * periodKey carries a type prefix — 'd:2026-08-11', 'w:2026-08-10',
 * 'm:2026-08-01' — so that if someone changes a tracker's cadence the old
 * entries stay identifiably orphaned instead of silently colliding with new keys
 * that happen to share a date. See INVARIANT 2 in utils/trackerPeriods.js.
 */
const trackerEntrySchema = new mongoose.Schema(
  {
    tracker: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tracker',
      required: true,
      index: true,
    },
    // Denormalised from the tracker so board deletion and org cascade can clean
    // up without loading trackers first, matching how ActivityLog carries board.
    board: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Board',
      required: true,
      index: true,
    },
    organisation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organisation',
      required: true,
      index: true,
    },
    group: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaskGroup',
      required: true,
    },
    periodKey: {
      type: String,
      required: true,
    },
    state: {
      type: String,
      enum: ['confirmed', 'excused'],
      required: true,
    },
    by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    at: {
      type: Date,
      default: Date.now,
    },
    // Optional evidence: the report document, the sent email, the deliverable.
    link: {
      type: String,
      default: '',
      trim: true,
    },
    note: {
      type: String,
      default: '',
      trim: true,
    },
  },
  { timestamps: true }
);

// One verdict per cell. The controller upserts against this, so re-confirming
// updates in place rather than stacking duplicates.
trackerEntrySchema.index({ tracker: 1, group: 1, periodKey: 1 }, { unique: true });

module.exports = mongoose.model('TrackerEntry', trackerEntrySchema);
