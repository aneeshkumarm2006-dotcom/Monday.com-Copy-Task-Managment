const mongoose = require('mongoose');
const { SYSTEM_ROLES, sanitizePermissions } = require('../utils/capabilities');
const { CURRENCY_CODES, FX_CADENCES, FX_PROVIDERS } = require('../utils/money');

// 'YYYY-MM-DD'. Same convention, and the same reasoning, as Tracker.js: a
// holiday is a CALENDAR DATE with no time and no zone, and a Date would
// silently attach both. utils/tzDay.js is what turns a UTC instant into one of
// these; nothing here ever needs to.
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

const dayKeyField = (extra = {}) => ({
  type: String,
  match: DAY_KEY_RE,
  ...extra,
});

/**
 * A role is a NAMED BUNDLE OF CAPABILITY KEYS — see
 * [capabilities.js](../utils/capabilities.js) for the catalog.
 *
 * `key` is a stable slug. The seeded system roles (owner/admin/executive/member/
 * viewer/guest) keep their well-known keys forever; custom roles get a generated
 * slug. The list is `SYSTEM_ROLES` in capabilities.js and it grows — do not
 * hardcode a count or an exhaustive key list anywhere. Members
 * point at a role by its `_id`, not its key, so renaming a custom role never
 * orphans anyone.
 *
 * `isSystem` roles cannot be DELETED (members hold them, and `owner` is
 * load-bearing), but their permissions stay editable in the matrix — except the
 * owner's, which the resolver ignores in favour of "always everything".
 */
const roleSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    color: { type: String, default: '#6B7280' },
    isSystem: { type: Boolean, default: false },
    permissions: { type: [String], default: [] },
  },
  { _id: true, timestamps: false }
);

/**
 * Which role each member holds. This is a SEPARATE array from `members` on
 * purpose.
 *
 * `members` stays a plain `[ObjectId]` because org membership is written on both
 * sides (`Organisation.members` AND `User.organisations`) and dozens of call
 * sites `.populate('members')` or `members.some(...)` over it. Reshaping it into
 * subdocuments would have rippled through every one of those and through the
 * join/onboarding reconciliation. Role assignment rides alongside instead.
 *
 * A member with no entry here holds the default role. Absence is not an error
 * state — it just means nothing special was said about this person.
 */
const memberRoleSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    role: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
  },
  { _id: false, timestamps: false }
);

const organisationSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  /**
   * Optional logo — a Cloudinary URL, '' when none. `logoPublicId` is kept
   * beside it so replacing or removing the logo can delete the old asset.
   * Written ONLY by controllers/logoController.js (the /logo routes).
   */
  logo: { type: String, default: '' },
  logoPublicId: { type: String, default: '' },
  /**
   * The workspace owner. Immutable, singular, and holds every capability
   * unconditionally. Retained as the root of trust: a role system whose owner can
   * be locked out by a bad matrix edit is worse than no role system at all.
   */
  admin: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  /**
   * LEGACY. Superseded by `roles` + `memberRoles`, but kept in sync by the role
   * assignment path so nothing that still reads it goes stale. Resolve permission
   * through [permissions.js](../utils/permissions.js), never through this array.
   */
  admins: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
  members: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
  roles: { type: [roleSchema], default: [] },
  memberRoles: { type: [memberRoleSchema], default: [] },
  /**
   * The workspace holiday calendar — days the office was closed.
   *
   * The FIRST org-level config field, and deliberately a plain array of
   * subdocuments rather than a settings blob: there is one thing here, and a
   * bag named `settings` invites everything else to move in beside it.
   *
   * There is no `tag`. An entry here IS a holiday — that is what separates it
   * from `Tracker.daysOff`, which carries a reason precisely because it can be
   * an event or a day the team was pulled onto other work. When a holiday
   * surfaces in the Delivery grid it reports `tag: 'holiday'`, so the existing
   * icon and copy tables handle it with no new vocabulary.
   *
   * Years are entered independently. Most holidays outside a handful of fixed
   * civil dates move every year, so an auto-repeat would be wrong more often
   * than right; the Settings editor offers a copy-last-year button instead.
   *
   * `affects` is WHAT THIS DAY STOPS, asked when the day is marked. Not every
   * closed day means the same thing: a public holiday stops everything, while a
   * company offsite means no client work was owed but the nightly digest should
   * still go out. Both default to true because that is what "holiday" means
   * unqualified, and each is ANDed with the opt-out on the other side
   * (`Tracker.observesOrgHolidays`, `Automation.schedule.skipHolidays`) so
   * either end can decline.
   *
   * Merged with the per-tracker list in utils/trackerDaysOff.js and NOWHERE
   * else. See utils/orgHolidays.js for why the scope widened.
   */
  holidays: [
    {
      _id: false,
      date: dayKeyField({ required: true }),
      name: { type: String, default: '', trim: true },
      affects: {
        // Tracker columns go grey instead of red, and the day leaves the ratio.
        delivery: { type: Boolean, default: true },
        // Scheduled automations roll forward to the next working day.
        automations: { type: Boolean, default: true },
      },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      at: { type: Date, default: Date.now },
    },
  ],
  /**
   * The workspace's default currency — what money here is assumed to be in.
   *
   * A SECOND named org-level field, beside `holidays` and for the same reason
   * stated there: one thing, named, rather than a `settings` bag that invites
   * everything else to move in beside it.
   *
   * What it decides:
   *
   *   1. the unit of every board that FOLLOWS the workspace — a board whose
   *      own `currency` is null, which is every board unless somebody gave it
   *      a currency of its own. A new board follows by default and its money
   *      columns are born in this unit (`boardTemplates.js` used to hardcode
   *      rupees into every billing, budget, pipeline and expenses board);
   *   2. what those boards are RELABELLED to when this changes. Saving a new
   *      value (orgController `saveCurrencySettings`) relabels every following
   *      board's own money columns to it — services/boardCurrency.js
   *      `relabelFollowingBoards`. Relabel means the stored figures are kept
   *      exactly as typed and only the unit they are said to be in moves;
   *      nothing is converted;
   *   3. the FALLBACK unit when nothing closer says: a board with no money
   *      column naming a code resolves to this (`boardCurrencyOf` in
   *      utils/money.js), and so does a money column stored without a code.
   *
   * It does NOT reach a board with its own currency (`Board.currency` set — an
   * explicit override): that board keeps its unit until somebody relabels it,
   * or puts it back to following (`PATCH /api/boards/:id/currency`). It never
   * WRITES `adsBudget.currency` — but an Ads Budget that never chose a unit
   * (null) reads its board's, so on a following board it moves with this too
   * (adsBudgetController `adsBudgetCurrencyOf`). Goals stay USD — see
   * goalTypes.js.
   *
   * It is NOT the display currency. A reader who has not chosen one
   * (`User.displayCurrency` is null) sees every figure AS ENTERED, in the unit
   * of the column that holds it — converting a CAD invoice into rupees for
   * somebody who never asked is how "this board is CAD but it shows ₹" happens.
   * This comment used to claim otherwise; the client never did it.
   *
   * Defaults to INR because that is what this workspace bills in, which is the
   * same reason the templates did. The difference is that it is now a setting.
   */
  baseCurrency: {
    type: String,
    default: 'INR',
    trim: true,
    uppercase: true,
    enum: CURRENCY_CODES,
  },

  /**
   * How this workspace gets its exchange rates.
   *
   * Named `fx` rather than folded into `baseCurrency` because it is a different
   * KIND of fact — one is "what we bill in", the other is "who we ask about
   * rates and how often". Shaped as a sub-document for the same reason
   * `Board.adsBudget` is: this is what a settings read has to answer in one go.
   *
   * ---- Why a key is optional --------------------------------------------
   *
   * The default provider needs no credential at all, so this is configuration
   * rather than a prerequisite. An org that never opens this screen still gets
   * live rates. A key only buys a different provider.
   */
  fx: {
    /** Which provider to ask. See services/fx/providers/. */
    provider: {
      type: String,
      default: 'frankfurter',
      enum: FX_PROVIDERS,
    },

    /**
     * The provider credential, sealed by `utils/connectorCrypto.js` with
     * { orgId, provider: 'fx' } bound as AAD.
     *
     * `select: false`, and the reasoning is `ConnectorAccount.sealedTokens`'
     * verbatim: it must never ride along on an incidental read that then gets
     * JSON-serialised to a client. `getOrg` returns the whole org document, so
     * without this the key would be on the wire the first time anybody opened
     * Settings. NOTHING may return this field, or anything derived from it.
     *
     * Server-readable by design rather than vaulted — a rate refresh at 04:00
     * has no browser and nobody to type a passphrase, so a credential the
     * server cannot decrypt is one the scheduler cannot use.
     */
    sealedApiKey: { type: String, default: null, select: false },

    /**
     * The last four characters of the key, for the settings screen.
     *
     * Not a security measure and not a secret — it exists so somebody looking
     * at the page can tell WHICH key is installed without being asked to "find
     * the password again". Same affordance the Connectors tab offers.
     */
    keyPreview: { type: String, default: '' },

    /**
     * How often to fetch. `monthly` is not a degraded `daily`.
     *
     * A free provider is a shared, unmetered courtesy, and an agency that bills
     * monthly does not need — or want — a rate that moves under a March invoice
     * every night. Fetching once a month means every March record values at the
     * 1 March rate, which is both cheaper and more stable. Daily is there for a
     * workspace that would rather track the market closely.
     */
    cadence: {
      type: String,
      default: 'monthly',
      enum: FX_CADENCES,
    },

    /** When the runner last succeeded, and what went wrong if it did not. */
    lastFetchAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
  },

  inviteCode: {
    type: String,
    unique: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

/**
 * The sealed FX key never serialises, whatever a caller did to get here.
 *
 * `select: false` on the field covers the path that actually matters — `getOrg`
 * reads the org from the database and never asks for it — but it is a QUERY
 * option, so it says nothing about a document some code assigned the field to
 * in memory. That is exactly the shape of the accident worth guarding: seal a
 * key into a loaded document, then hand the document back to express.
 *
 * So the projection is the first defence, this is the second, and the
 * controller building its settings payload by hand is the third. A credential
 * is worth three.
 */
const stripSealedKey = (doc, ret) => {
  if (ret && ret.fx) delete ret.fx.sealedApiKey;
  return ret;
};

organisationSchema.set('toJSON', { transform: stripSealedKey });
organisationSchema.set('toObject', { transform: stripSealedKey });

/**
 * Seed the system roles onto an org that lacks them. Safe to call repeatedly: it
 * only ADDS roles whose `key` is missing, so a matrix the user has customised is
 * never clobbered, and an org created before this feature picks its roles up the
 * first time it is touched. Returns true if anything changed.
 */
organisationSchema.methods.ensureSystemRoles = function ensureSystemRoles() {
  const existing = new Set((this.roles || []).map((r) => r.key));
  let added = false;
  for (const preset of SYSTEM_ROLES) {
    if (existing.has(preset.key)) continue;
    this.roles.push({
      key: preset.key,
      name: preset.name,
      description: preset.description,
      color: preset.color,
      isSystem: true,
      permissions: sanitizePermissions(preset.permissions),
    });
    added = true;
  }
  return added;
};

/** The role subdocument carrying `key`, or undefined. */
organisationSchema.methods.roleByKey = function roleByKey(key) {
  return (this.roles || []).find((r) => r.key === key);
};

module.exports = mongoose.model('Organisation', organisationSchema);
