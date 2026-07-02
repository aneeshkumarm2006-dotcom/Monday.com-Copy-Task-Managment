const mongoose = require('mongoose');

/**
 * Note — a rich-text doc attached to a board group. A group can hold many
 * notes (meeting notes, checklists, vendor contacts, ideas). Modelled on the
 * task `Update` feature: `body` stores the TipTap JSON document as-is, and
 * `bodyText` is a plain-text mirror used for list previews and the empty-note
 * check (contexts that don't have the editor on hand).
 *
 * `board` is denormalised from the group so board-scoped queries — the header
 * count badges and the cascade delete when a group is removed — stay single
 * collection lookups.
 */
const noteSchema = new mongoose.Schema(
  {
    group: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaskGroup',
      required: true,
      index: true,
    },
    board: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Board',
      required: true,
      index: true,
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    lastEditedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    title: {
      type: String,
      default: '',
    },
    // TipTap JSON document (rich content). Stored as Mixed so structure can
    // evolve without schema migrations.
    body: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    // Plain-text mirror for list previews and empty checks.
    bodyText: {
      type: String,
      default: '',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Note', noteSchema);
