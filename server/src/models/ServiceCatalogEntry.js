const mongoose = require('mongoose');

/**
 * The organisation's SERVICE CATALOG — the vocabulary of things an agency sells,
 * reusable across every client board in the workspace.
 *
 * "Catalog + free text": the invite table offers this list in a dropdown, and
 * typing a name that is not in it MINTS a row here. The catalog therefore grows
 * by use, and nobody has to curate it before the first invite goes out.
 *
 * A row here is a NAME AND A COLOUR, nothing more. It does not own the groups
 * that use it — `TaskGroup.serviceKey` holds this row's `slug`, not its `_id`,
 * so deleting or renaming a catalog entry can never orphan a board. See that
 * field's comment for why the join is a slug.
 *
 * ---- WHY ITS OWN COLLECTION, and not an array on `Organisation` -----------
 *
 * `Organisation` already carries `roles`, `memberRoles` and `holidays`, so an
 * array there is the obvious move. It is the wrong one, for three reasons:
 *
 *   1. IT IS UNBOUNDED. Holidays are a year at a time and roles are a handful.
 *      This grows every time anyone types a service name that has not been typed
 *      before, forever. `Organisation` is loaded by `loadBoardContext` on EVERY
 *      board request; an array with no ceiling does not belong on it.
 *   2. CONCURRENT APPEND. `orgController.saveHolidaysAndReturn` already documents
 *      what `doc.save()` does to a concurrently-edited org array: a VersionError
 *      that surfaces as a 500 and silently drops the edit. A batch invite appends
 *      several entries at once, from a screen two managers may have open together.
 *   3. `Organisation.ensureSystemRoles()` calls `save()` on first touch from
 *      `loadBoardContext`. An array this hot has no business riding that write.
 */
const serviceCatalogEntrySchema = new mongoose.Schema(
  {
    organisation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organisation',
      required: true,
    },
    /**
     * The normalised key, produced ONLY by `utils/serviceCatalog.serviceSlug`.
     * Never user-facing — it exists so that "Meta Ads", "meta ads" and
     * "  META   ADS  " are one entry rather than three.
     */
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 60,
    },
    /**
     * What the first person to use it actually typed. This is what every UI
     * shows. A later row naming the same slug does NOT overwrite it — first
     * casing wins, so one person's hurried "seo" cannot restyle the service for
     * everyone who already reads it as "SEO".
     */
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
    },
    /** Resolved from the slug by `colorForSlug` when nobody picked one. */
    color: {
      type: String,
      default: '#6B7280',
    },
    order: {
      type: Number,
      default: 0,
    },
    /**
     * Hidden from the picker. There is deliberately NO delete: a catalog entry
     * is referenced by slug from groups that will outlive it, and archiving
     * keeps the colour resolving for those groups while taking the name out of
     * the dropdown.
     */
    archived: {
      type: Boolean,
      default: false,
    },
    /**
     * How many times this service has been put on a board. Sorts the dropdown so
     * the four services this agency actually runs are the first four rows,
     * instead of alphabetical order burying "SEO" under "Content" and "Design".
     */
    usageCount: {
      type: Number,
      default: 0,
    },
    lastUsedAt: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

/**
 * One entry per (org, slug). This index IS the entire idempotency of the catalog
 * upsert: four rows naming "Meta Ads" in one batch invite race each other, and
 * this is what makes the losers read back the winner instead of minting
 * duplicates — the same contract `Channel`'s (board, group, mode, audience)
 * index carries for `createSurfaces`.
 *
 * Created EXPLICITLY by scripts/resetClientPortals.js --indexes, not left to
 * autoIndex. An autoIndex build failure is emitted on the model and, with no
 * listener, swallowed — so you would deploy believing the constraint exists
 * while duplicates quietly accumulate. This is the rule migratePortalToBoard.js
 * already writes down for its own index phase.
 */
serviceCatalogEntrySchema.index({ organisation: 1, slug: 1 }, { unique: true });

module.exports = mongoose.model('ServiceCatalogEntry', serviceCatalogEntrySchema);
