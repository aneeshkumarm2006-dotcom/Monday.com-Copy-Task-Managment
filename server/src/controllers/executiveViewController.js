const mongoose = require('mongoose');

const Board = require('../models/Board');
const ExecutiveView = require('../models/ExecutiveView');
const User = require('../models/User');
const { loadOrgContext } = require('../utils/boardContext');
// `levelAtLeast` compares two rungs of the board ladder. `copyFrom` is the only
// caller: it has to ask whether the level it read off the SOURCE is one the
// ACTOR is standing high enough to hand on, and comparing two strings by index
// into `BOARD_LEVELS` here would be a second, private opinion about an ordering
// the capabilities module already owns.
const { EXECUTIVE_ROLE_KEY, levelAtLeast } = require('../utils/capabilities');
const {
  isOrgOwner,
  resolveAccess,
  resolveOrgAccess,
} = require('../utils/permissions');
const { applyRoleAssignment } = require('./roleController');
const {
  getForUser,
  resolveForViewer,
  validateShape,
  upsert,
  addBoard: addProfileBoard,
  removeBoard: removeProfileBoard,
  remove: removeProfile,
  BOARD_TABS,
} = require('../services/executiveView');
/**
 * `HANDLERS` comes along beside `compose` because the reach filter below has to
 * know one thing about a section type that is not visible in its config: whether
 * a board is that section's SUBJECT or merely a NARROWING of it. The registry
 * already states it (`optionalBoard`), and re-stating it here would be a second
 * list of section types on the server — the one thing `executiveHome.js` says it
 * exists to prevent.
 */
const { compose, HANDLERS } = require('../services/executiveHome');
const {
  logExecutiveDeclared,
  logExecutiveUpdated,
  logExecutiveRemoved,
  logExecutiveBoardAdded,
  logExecutiveBoardRemoved,
} = require('../services/executiveActivity');

/**
 * The HTTP plane for executive views — two planes, one document, one service.
 *
 * An executive view is a per-(organisation, user) profile describing what ONE
 * person's screen looks like: which boards are on their list and in what order,
 * what their home page is composed of, which rail entries they kept. Every
 * handler here is a thin shell: parse, authorise, call
 * `services/executiveView.js`, log, respond. The document's rules — what a
 * valid shape is, which boards survive a resolve, how a board joins the list —
 * all live in that service, because both planes below have to obey exactly the
 * same ones.
 *
 * ---- THE TWO PLANES, AND WHY THEY ARE IN ONE FILE --------------------------
 *
 * ADMIN (`/orgs/:orgId/executive-views/...`) — gated on
 * `org.manage_executive_views`. May change everything, including which boards
 * are on the list, which writes real grants through `services/boardGrants.js`.
 *
 * SELF (`/me/executive-view`) — any authenticated caller, no extra capability.
 * May change the SHAPE of their own profile and nothing else: `allowReachChange:
 * false`, so a board entry the caller cannot already read is dropped rather than
 * honoured, and no grant is ever written. It also cannot CREATE a profile —
 * having one is what makes somebody an Executive, and that is an admin's
 * decision (see `putMine`).
 *
 * They share a file because they share a document and a validator, and because
 * the difference between them is exactly two arguments (`allowReachChange`, and
 * whose id the profile is keyed on). Split across two controllers, that
 * difference becomes something a reader has to go and find.
 *
 * ---- WHAT THIS FILE IS NOT ALLOWED TO DO -----------------------------------
 *
 * Invariant 1: the profile never grants access. Nothing here decides what
 * anybody can reach. Reach is the two-layer AND — org role AND board grant —
 * resolved only by `resolveAccess`, and the only handler below that touches
 * reach at all is `addBoard`, which does it by asking the grant service to write
 * an ordinary `Board.memberAccess` entry that the ordinary resolver then reads.
 * A board on a list the person cannot read is SKIPPED and reported, never
 * errored and never quietly made readable.
 *
 * Invariant 8: the owner cannot be made an Executive. Enforced in `declare` AND
 * in `put`, because `put` is create-or-replace and would otherwise be the way
 * around it — the client decides `isExecutive` from "does a profile exist", so
 * writing one for the owner IS making them one. And enforced a third time on
 * every READ (`ownerIsNeverAnExecutive`), because ownership MOVES: a transfer
 * can produce an owner holding a profile without any write to this feature
 * being involved at all. Read that helper before touching either half.
 *
 * ---- ACTIVITY ROWS ---------------------------------------------------------
 *
 * Every mutating handler calls a writer in `services/executiveActivity.js`, and
 * never `logActivity` directly — that helper admits four subjects and silently
 * drops a fifth. The writers are fire-and-forget by design, so none of them is
 * awaited in a way that can fail the change it describes.
 */

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

/**
 * The same laxness `getMyTasks` applies to `?org=`: a malformed id is a 400
 * rather than a CastError surfacing as a 500 from the catch block. It does not
 * prove the document exists — the load that follows does that.
 */
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));

/**
 * A ref as its id string, whether it arrived as an id, an ObjectId or a
 * POPULATED document.
 *
 * `String(doc)` on a populated Mongoose document is its inspect string and never
 * the hex id — the trap `utils/permissions.js` documents and the reason the
 * contract forbids `ref.toString()` outright. Everything in this file is handed
 * documents somebody else loaded (`loadOrgContext` populates, the members list
 * populates), so the comparison has to go through here or it silently answers
 * "no" for every caller who happened to populate the path.
 */
const idOf = (ref) => String(ref?._id || ref || '');

/**
 * Load the org, check membership, and require the capability that gates this
 * whole plane. Returns the SAME `{ status, error }` shape `loadOrgContext` does,
 * so every caller checks it exactly once and the same way.
 *
 * `org.manage_executive_views` deliberately buys the EDITOR and never the
 * reach: see the capability's own comment in `utils/capabilities.js`. Holding
 * it is not enough to change a role (`declare` re-checks `org.assign_roles`) and
 * not enough to put a board on somebody's list (the service re-checks the
 * actor's own `canManageAccess` on that board).
 */
const loadAdminContext = async (req) => {
  const ctx = await loadOrgContext(req.params.orgId, req.user.userId);
  if (ctx.error) return ctx;
  if (!ctx.can('org.manage_executive_views')) {
    return {
      status: 403,
      error: 'You do not have permission to manage executive views',
    };
  }
  return ctx;
};

/**
 * The target's name, denormalised into every activity row.
 *
 * `executiveActivity` captures the name at write time precisely because the
 * thing these rows point at is expected to disappear — deleting a profile is a
 * feature, not an accident — so the row has to keep reading afterwards. One
 * projected read per mutating request is the price of history that still makes
 * sense a year later.
 *
 * Never null: a missing user still produces a row, it just has no name in it,
 * which is a better outcome than a silent hole in the log.
 */
const loadTargetUser = async (userId) => {
  const user = await User.findById(userId).select('name').lean();
  return user ? { _id: user._id, name: user.name } : { _id: userId, name: '' };
};

/**
 * The service refuses with `{ error, status }` rather than throwing, for the
 * same reason `loadOrgContext` does: a refusal is an answer, not an exception.
 * Returns the sent response when it refused, or null when it did not.
 */
const passThroughDenial = (res, result) =>
  result && result.error
    ? res.status(result.status || 400).json({ error: result.error })
    : null;

/**
 * Which PARTS of the profile this request touched, in the vocabulary
 * `logExecutiveUpdated` expects (`executiveActivity.CHANGE_KEYS`).
 *
 * Derived from the RAW body rather than the validated shape: the validator
 * normalises and fills in, so `value` always carries all three keys and would
 * make every save look like it changed everything. What the request actually
 * carried is what the person actually edited — and it is the one thing only
 * this layer knows, which is why the writer takes the list instead of diffing
 * a layout blob for it.
 */
const changedParts = (body) =>
  ['boards', 'home', 'nav'].filter((key) => body && body[key] !== undefined);

/**
 * Is this person somebody who may hold an executive view at all?
 *
 * Shared by `put`, `declare` and `addBoard` so the three cannot disagree about
 * it. Returns a refusal or null. Both refusals are 400s: the request is
 * well-formed and the caller is authorised — it is the target that is wrong.
 */
const refuseIneligibleTarget = (org, targetUserId) => {
  const target = String(targetUserId);

  // Invariant 8, the WRITE half. Checked before membership because it is the
  // more specific answer: the owner IS a member, so the generic message would
  // be misleading. `isOrgOwner` rather than a local comparison, so "who owns
  // this workspace" has exactly one answer in this file, and it is the same one
  // `resolveAccess` uses when it short-circuits them to every capability.
  if (isOrgOwner(org, target)) {
    return {
      status: 400,
      error: 'The workspace owner cannot be given an executive view',
    };
  }
  if (!org.members.some((m) => idOf(m) === target)) {
    return { status: 400, error: 'User is not a member of this workspace' };
  }
  return null;
};

/**
 * INVARIANT 8, THE READ HALF: the workspace owner has no executive view, even
 * when a document says they do.
 *
 * `refuseIneligibleTarget` stops the owner being GIVEN one, and that was the
 * whole of the enforcement — until it met the one event that produces the
 * forbidden state with no write to this feature anywhere in it. Ownership
 * MOVES (`POST /api/orgs/:id/transfer-ownership`). An Executive who is handed
 * the workspace keeps their profile, and from the next page load the one person
 * who implicitly reaches every board in the workspace is looking at a curated
 * list of four of them, with the dashboard and the full board list gone.
 * Invariant 8 exists to prevent exactly that, and a rule enforced only on the
 * way in is a rule that every other code path walks around.
 *
 * So the reads ask it too. `transferOrgOwnership` now deletes the incoming
 * owner's profile as it moves the title (see its comment there), which means
 * this should never fire — but "should never" is a property of today's call
 * graph, and invariant 8 is a property of the product. The delete is the
 * tidy-up; this is the guarantee, and it is the half that cannot be forgotten
 * by whoever writes the next path that makes somebody an owner.
 *
 * It answers "no profile" rather than an error, because that IS the honest
 * answer: to the store's `isExecutive`, to the configurator and to the home
 * page, the owner is somebody who is not an Executive — precisely what
 * invariant 8 says they are.
 *
 * `list` is deliberately NOT filtered this way. It is the only surface in the
 * app that can show an orphaned profile, and an owner's profile that survived a
 * failed delete is exactly that: hiding it there would make it unfixable rather
 * than untidy, which is the reasoning that handler's own header already sets
 * out for profiles whose user has been deleted.
 */
const ownerIsNeverAnExecutive = (org, userId) => isOrgOwner(org, userId);

/**
 * Every board id a home layout NAMES, wherever its section configs put one.
 *
 * Walked STRUCTURALLY rather than per section type. Every config in the
 * registry spells a board one of two ways — `board` (one, nullable) or `boards`
 * (a list) — so a type added later that follows the same two spellings is
 * covered the day it is written rather than the day somebody remembers this
 * function exists. A type that invents a THIRD spelling is not covered here,
 * which is survivable only because the composer re-checks `canRead` per board
 * before any scorer runs (invariant 1): that is the check protecting the data,
 * and this one exists so an id the person cannot read is never STORED.
 */
const homeBoardIds = (sections) => {
  const ids = new Set();
  for (const section of Array.isArray(sections) ? sections : []) {
    const config = section && section.config;
    if (!config || typeof config !== 'object') continue;
    if (config.board) ids.add(String(config.board));
    if (Array.isArray(config.boards)) {
      for (const id of config.boards) if (id) ids.add(String(id));
    }
  }
  return [...ids];
};

/**
 * The self plane's reach filter for `home[]` — the same rule the service
 * applies to `boards[]`, applied to the board ids a LAYOUT names.
 *
 * ---- WHY IT EXISTS ---------------------------------------------------------
 *
 * `validateShape` normalises a section's config but cannot judge reach: it is a
 * pure function over a request body, with no org, no user and no database. So
 * `config.board` was stored verbatim, and on the self plane that let an
 * Executive name ANY board id in the workspace inside a section — one they have
 * never been able to open. Nothing leaks today: the composer resolves `canRead`
 * per board before it runs a scorer, so such a section renders `unavailable`
 * and not one row of that board is ever read. But "the next layer catches it"
 * is how leaks get built, and a document recording somebody naming a board they
 * have no business naming is wrong on its own terms — it is also the thing an
 * admin reading the configurator would take as evidence that the board was once
 * theirs.
 *
 * ---- WHY AN ALREADY-STORED ID IS KEPT --------------------------------------
 *
 * Exactly the reasoning in the service's `reachFilteredBoards`, and against the
 * same failure. A section an ADMIN composed for a board this person cannot
 * currently read is the admin's configuration, not this person's claim. Unlike
 * a hidden board ENTRY — which `resolveForViewer` elides, so the client cannot
 * echo it back — a section round-trips through the client intact. Nulling its
 * board would mean an Executive who merely dragged a section to the top
 * silently destroyed a section that would have come back to life the moment
 * their access was restored. So an id already stored in THAT SAME section —
 * matched on the section's `_id`, the only stable identity a section has — is
 * left alone, and only a NEW one is refused.
 *
 * ---- WHY A NARROWING IS REFUSED RATHER THAN NULLED -------------------------
 *
 * Nulling a board is only safe where `null` means "not configured". On
 * `goalScores`, `deliveryScores` and `adsBudgetPacing` it does: the composer
 * answers such a section with "This section has not been given a board yet",
 * the tile says so, and the person can fix it.
 *
 * On `workspaceNumbers` it means the opposite. That type reports on the WHOLE
 * WORKSPACE unless it has been pointed at one board — the registry marks it
 * `optionalBoard` for exactly that reason — so nulling its board does not
 * disarm the section, it WIDENS it. A tile configured to report one board's
 * figures would quietly start reporting forty boards' figures, under the same
 * heading, on a page whose numbers get read out in meetings. A silent widening
 * is the one outcome a filter like this must never produce: the whole point of
 * refusing the board was that the person had no business naming it.
 *
 * So a narrowing that cannot be honoured costs the SECTION, not the narrowing.
 * The board is reported in `dropped` like any other, and the saved profile
 * comes back without that section, so the page it was on re-renders without it
 * rather than with something nobody asked for. Losing a tile is visible and
 * costs one click to rebuild; reporting the wrong total is invisible.
 *
 * ---- WHY AN EMPTIED LIST IS LEFT EMPTY -------------------------------------
 *
 * Empty `boards` means "every board on the profile" (the spec's config table),
 * not "none", so filtering the last id out of a list changes its meaning. That
 * is the safe direction: the profile's own board list is itself reach-filtered
 * on read, so "all of them" is a set this person can already open. The
 * alternative would be inventing a "no boards" spelling the validator does not
 * have, on two planes, to tidy a case only a hand-written body can produce.
 *
 * Returns `{ home, dropped }`. `dropped` is board ids — the same vocabulary the
 * service's own `dropped` speaks, so the caller merges them into one list
 * rather than making the page choose between two sentences.
 */
const reachFilterHome = async (org, userId, sections, stored) => {
  const named = homeBoardIds(sections);
  if (named.length === 0) return { home: sections, dropped: [] };

  // ONE query for the whole layout, and scoped to this workspace: a board id
  // from another org must never be resolved against THIS org's roles and
  // grants — the wrong question, and one that can answer "yes". Same trap
  // `loadBoardsById` documents in the service.
  const valid = named.filter((id) => isId(id));
  const docs = valid.length
    ? await Board.find({ _id: { $in: valid }, organisation: org._id })
    : [];
  const byId = new Map(docs.map((b) => [String(b._id), b]));

  // What each section ALREADY says, keyed by the section's own id.
  const storedIds = new Map();
  for (const section of (stored && stored.home) || []) {
    const key = String(section?._id || '');
    if (key) storedIds.set(key, new Set(homeBoardIds([section])));
  }

  const dropped = [];
  const home = [];
  for (const section of sections || []) {
    const config = section && section.config;
    if (!config || typeof config !== 'object') {
      home.push(section);
      continue;
    }

    const already = storedIds.get(String(section._id || '')) || new Set();
    // A board that does not resolve at all (deleted, or another workspace's) is
    // "cannot read" here, exactly as it is in the reader and in the service.
    const keep = (id) => {
      const key = String(id);
      if (already.has(key)) return true;
      const doc = byId.get(key);
      return !!doc && resolveAccess(doc, org, userId).canRead;
    };

    let touched = false;
    let refused = false;
    const next = { ...config };
    if (next.board && !keep(next.board)) {
      dropped.push(String(next.board));
      // A board this type treats as a NARROWING cannot be nulled — that would
      // widen the section instead of disarming it. See the header. An unknown
      // type reaches neither branch in practice (`validateShape` rejects one
      // before this runs), and defaults to the safe reading: nulled, not kept.
      if (HANDLERS[section.type] && HANDLERS[section.type].optionalBoard) {
        refused = true;
      } else {
        next.board = null;
        touched = true;
      }
    }
    if (!refused && Array.isArray(next.boards)) {
      const kept = next.boards.filter((id) => keep(id));
      if (kept.length !== next.boards.length) {
        for (const id of next.boards) if (!keep(id)) dropped.push(String(id));
        next.boards = kept;
        touched = true;
      }
    }

    if (refused) continue;
    // The section object is only rebuilt when something actually moved, so an
    // untouched layout is handed to the service byte-for-byte as validated.
    home.push(touched ? { ...section, config: next } : section);
  }

  return { home, dropped: [...new Set(dropped)] };
};

/**
 * `?revoke=` on the remove-a-board route, defaulting to TRUE.
 *
 * Taking a board off somebody's curated list normally means they should not be
 * able to open it any more, and the configurator's confirm dialog says so. The
 * opt-out exists for the other case — a board the person also reaches some other
 * way, which was only ever being tidied off the list — and has to be asked for
 * explicitly, because the failure modes are not symmetric: a grant left behind
 * by accident is silent, a grant revoked by accident is a support ticket the
 * admin can undo in one click from the board's own share dialog.
 */
const parseRevoke = (raw) => {
  if (raw === undefined || raw === null || raw === '') return true;
  const v = String(raw).trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'no');
};

// ---------------------------------------------------------------------------
// Admin plane
// ---------------------------------------------------------------------------

/**
 * One row of the Executives strip: the stored profile, plus whatever the user
 * lookup found for the person it names (or null when it found nobody).
 *
 * Pure, and exported, because the ORPHAN case is a decision rather than a
 * rendering, and it is the decision this row shape got wrong. A profile whose
 * user has been deleted keeps its row — that part was always right — and it now
 * also keeps the two ids that make the row actionable: its own `_id`, and the
 * raw `userId` it is keyed on. `user: null` says "there is nobody to draw
 * here"; those two say "and here is where to point". Emitting only the first is
 * what turned a tidy-up into a permanent counter on the Members page.
 *
 * `userId` is emitted for a LIVE row too rather than only for an orphan. A key
 * that appears only in the broken case is a key every caller forgets to read,
 * and when the person does resolve it is the same id as `user._id` anyway.
 *
 * Note what is deliberately NOT here: no board list, no home layout, no nav.
 * The strip is a summary (see `list`), and the configurator fetches the full
 * profile the moment somebody clicks through.
 */
const executiveListRow = (profile, user) => ({
  id: profile._id,
  // The id every mutating route in this feature is keyed on, kept whether or
  // not anybody still answers to it. This is the field whose absence made a
  // dead row unreachable.
  userId: profile.user ? String(profile.user) : null,
  user: user
    ? {
        _id: user._id,
        name: user.name,
        email: user.email,
        profilePic: user.profilePic,
      }
    : null,
  boardCount: (profile.boards || []).length,
  createdAt: profile.createdAt,
  updatedAt: profile.updatedAt,
});

/**
 * GET /api/orgs/:orgId/executive-views
 *
 * Every profile in the workspace, with its person and how many boards are on
 * their list. This is what the Executives strip at the top of the Members page
 * reads, so it is deliberately a SUMMARY: no board list, no home layout, no nav
 * — a strip that rendered avatars does not need a megabyte of section configs
 * to do it, and the configurator fetches the full profile anyway the moment
 * somebody clicks through.
 *
 * Read directly off the model rather than through the service: the service owns
 * validation and writing, and its published interface is per-person
 * (`getForUser`, `resolveForViewer`). Asking it once per member would be N
 * queries to answer a question one query answers, and there is nothing to
 * resolve here — a strip lists who HAS a view, not what each of them can reach.
 *
 * A profile whose user has been deleted keeps its row with `user: null`. It is
 * an orphan, and this list is the only surface in the app that could ever
 * surface one; hiding it would make it unfixable rather than untidy.
 *
 * That last sentence was a claim this handler did not keep. It surfaced the
 * orphan and, in the same breath, threw away the only key any route in this
 * feature accepts: `.populate('user', ...)` REPLACES the path, so for a profile
 * whose user has been deleted the raw `user` ObjectId was overwritten with null
 * before the payload was built. Every mutating route is keyed on that id, so
 * the row was visible and unaddressable at once — nothing could edit it and
 * nothing could delete it, and the Members page counted it forever. Surfacing
 * something nobody can point at is not the difference between unfixable and
 * untidy; it is unfixable with a permanent counter attached.
 *
 * So the populate is gone and the people are joined in a second query, which
 * keeps `profile.user` intact and lets the row carry `userId` alongside the
 * person. `DELETE .../executive-views/by-id/:viewId` (`delById`) is the other
 * half: the row also carries its own `id`, and that route takes it.
 */
const list = async (req, res) => {
  try {
    const ctx = await loadAdminContext(req);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const profiles = await ExecutiveView.find({ organisation: ctx.org._id })
      .sort({ createdAt: 1 })
      .lean();

    // The people, in one query over the ids the profiles name. This is the same
    // two round trips `.populate` was already making — it is not a second read,
    // it is the same read with the join done here, where the id survives it.
    const userIds = profiles.map((p) => p.user).filter(Boolean);
    const users = userIds.length
      ? await User.find({ _id: { $in: userIds } })
          .select('name email profilePic')
          .lean()
      : [];
    const byId = new Map(users.map((u) => [String(u._id), u]));

    return res.json({
      executives: profiles.map((p) =>
        executiveListRow(p, byId.get(String(p.user)) || null)
      ),
    });
  } catch (err) {
    console.error('executiveViews.list error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/orgs/:orgId/executive-views/:userId
 *
 * The profile as THAT PERSON will experience it — `resolveForViewer` is run
 * against the TARGET's access, never the admin's.
 *
 * This is the whole point of the endpoint and the easy thing to get wrong.
 * Resolving as the caller would show an owner every board on the list, because
 * the owner can read all of them, and `skipped[]` would come back empty on a
 * profile half of whose boards the person lost access to weeks ago. The
 * configurator's job is to flag exactly that (invariant 4), so the honest
 * answer is the only useful one.
 *
 * 200 with `{ profile: null }` rather than a 404 when there is none: "this
 * person is not an Executive" is an answer, and it is the answer the Members
 * page asks for before it decides whether to offer "Make executive" or "Edit
 * executive view".
 */
const get = async (req, res) => {
  try {
    const ctx = await loadAdminContext(req);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const { userId } = req.params;
    if (!isId(userId)) return res.status(400).json({ error: 'Unknown user' });

    // The read half of invariant 8, before the read rather than after it: the
    // owner is not an Executive, so the configurator must be told there is
    // nothing to configure — and must not be handed a document it would then
    // offer to edit. See `ownerIsNeverAnExecutive`.
    if (ownerIsNeverAnExecutive(ctx.org, userId)) {
      return res.json({ profile: null, skipped: [] });
    }

    const resolved = (await resolveForViewer(ctx.org, userId)) || {};
    return res.json({
      profile: resolved.profile || null,
      skipped: resolved.skipped || [],
    });
  } catch (err) {
    console.error('executiveViews.get error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/orgs/:orgId/executive-views/:userId — create or replace the shape.
 *
 * `allowReachChange: true`, which is what separates this from the self path: an
 * admin editing somebody's view may list a board that person cannot currently
 * read, because the admin is about to grant it (or already has, through
 * `addBoard`). The entry is stored and the resolve flags it until the grant
 * exists. That is invariant 4 working as intended, not a hole — the entry still
 * confers nothing.
 *
 * The two guards below are about WHO may have a profile at all, which is not
 * something the shape validator can know:
 *
 *  - the target must be a member of this workspace, or this writes a profile
 *    keyed on somebody who cannot sign into it;
 *  - the target must not be the owner (invariant 8). `declare` refuses the
 *    owner, and this route is create-or-replace, so without the same refusal
 *    here it would simply be the way around that.
 */
const put = async (req, res) => {
  try {
    const ctx = await loadAdminContext(req);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const { userId } = req.params;
    if (!isId(userId)) return res.status(400).json({ error: 'Unknown user' });

    const denied = refuseIneligibleTarget(ctx.org, userId);
    if (denied) return res.status(denied.status).json({ error: denied.error });

    const { value, error } = validateShape(req.body, { knownTabs: BOARD_TABS });
    if (error) return res.status(400).json({ error });

    const result =
      (await upsert(ctx.org, userId, value, {
        actor: req.user.userId,
        allowReachChange: true,
      })) || {};
    const sent = passThroughDenial(res, result);
    if (sent) return sent;

    const targetUser = await loadTargetUser(userId);
    logExecutiveUpdated({
      organisation: ctx.org._id,
      targetUser,
      changed: changedParts(req.body),
      actor: req.user.userId,
    });

    return res.json({
      profile: result.profile || null,
      dropped: result.dropped || [],
    });
  } catch (err) {
    console.error('executiveViews.put error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/orgs/:orgId/executive-views/:userId
 *
 * Deletes the profile and NOTHING ELSE, and says so in the response.
 *
 * That last part is the reason this handler is more than one line. Removing a
 * view leaves the person's ROLE exactly as it was and every board GRANT exactly
 * as it was — they stay an Executive by role and can still open every board
 * they were given, they just get the standard app back (invariant 3: the undo
 * is complete because the document only ever described a view). Those are two
 * genuinely surprising facts, and a confirm dialog that guessed at them would
 * eventually guess wrong. So the flags are in the payload and the client reads
 * its sentence off them rather than hardcoding one.
 *
 * `boardCount` comes off the deleted document the service returns, for the same
 * reason the activity writer asks for it at all: afterwards there is nothing
 * left to count, and a view listing twelve boards and a view listing none are
 * different losses.
 */
const del = async (req, res) => {
  try {
    const ctx = await loadAdminContext(req);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const { userId } = req.params;
    if (!isId(userId)) return res.status(400).json({ error: 'Unknown user' });

    const result =
      (await removeProfile(ctx.org, userId, { actor: req.user.userId })) || {};
    const sent = passThroughDenial(res, result);
    if (sent) return sent;

    if (!result.removed) {
      return res
        .status(404)
        .json({ error: 'This person does not have an executive view' });
    }

    // Counted off the DELETED document the service hands back rather than a
    // read before the delete: it is the same number, one query cheaper, and it
    // cannot disagree with what actually went.
    const boardCount = (result.profile?.boards || []).length;

    const targetUser = await loadTargetUser(userId);
    logExecutiveRemoved({
      organisation: ctx.org._id,
      targetUser,
      actor: req.user.userId,
      boardCount,
    });

    return res.json({
      removed: true,
      // What was deliberately NOT done. See the header.
      roleUnchanged: true,
      grantsUnchanged: true,
      boardCount,
    });
  } catch (err) {
    console.error('executiveViews.del error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/orgs/:orgId/executive-views/by-id/:viewId
 *
 * The same delete as `del`, addressed by the PROFILE's own id instead of the
 * person's.
 *
 * ---- WHY A SECOND ROUTE RATHER THAN A CHANGE TO THE FIRST ------------------
 *
 * `DELETE /:userId` is what the configurator calls today and it is the right
 * shape for the ordinary request: an admin is looking at a person and decides
 * that person should stop having a curated screen. It keeps working unchanged,
 * and nothing here replaces it.
 *
 * This route exists for the one row that one cannot express. A profile OUTLIVES
 * the User it names: deleting an account does not delete the view, and neither
 * does removing somebody from the workspace. The strip then shows a row with
 * nobody in it — and because every other route in this feature is keyed on a
 * user id, that row had no address at all. It could not be read, it could not
 * be edited, and it could not be removed. `list` says surfacing an orphan is
 * what makes it fixable rather than untidy; that was only true once there was
 * something to point at it with. This is that something.
 *
 * ---- WHY IT DELEGATES TO THE SAME SERVICE CALL -----------------------------
 *
 * It resolves the view to the user id the profile is keyed on and then runs the
 * ordinary `remove(org, userId)`. It does NOT delete by `_id` itself, although
 * that would be one query instead of two. The service is the only thing in this
 * feature that deletes a profile, and a second deleter — scoping its own
 * filter, deciding its own return shape — would be a second set of rules to
 * keep in agreement with the first forever, for a route whose entire job is
 * reaching a row the caller already knows exists. So the only thing this
 * handler really does is RECOVER THE ID `list` used to throw away, which is
 * precisely what was missing; everything after that is the existing path.
 *
 * ---- WHAT IT DOES NOT WIDEN ------------------------------------------------
 *
 * Nothing. It goes through `loadAdminContext` exactly like every other route on
 * this plane, so it needs membership of this workspace AND
 * `org.manage_executive_views`, and the lookup is scoped to `ctx.org._id` — a
 * view id belonging to another workspace resolves to nothing here and 404s,
 * which is the same answer a foreign user id gets from the route above. An
 * orphan is still org-scoped data, and it is still deleted by exactly the
 * people who could already delete every other view in the workspace.
 *
 * Like `del`, it deliberately carries NO owner refusal. `del` is one of the
 * paths that clears up a stale document belonging to somebody who has since
 * become the owner (see `ownerIsNeverAnExecutive` and `putMine`), and a
 * by-id delete that refused the owner's row would be a second way to make a
 * document unreachable — the bug this route was written to end.
 */
const delById = async (req, res) => {
  try {
    const ctx = await loadAdminContext(req);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const { viewId } = req.params;
    if (!isId(viewId)) {
      return res.status(400).json({ error: 'Unknown executive view' });
    }

    // Scoped to this workspace, and projected to the one field this handler
    // needs. `user` is `required` on the model, so a stored profile always
    // carries an id here — what it may no longer have is a User document at the
    // other end of it, which is the whole case this route is for and which
    // changes nothing about the delete that follows.
    const view = await ExecutiveView.findOne({
      _id: viewId,
      organisation: ctx.org._id,
    })
      .select('user')
      .lean();
    if (!view) {
      return res
        .status(404)
        .json({ error: 'That executive view no longer exists' });
    }

    const result =
      (await removeProfile(ctx.org, view.user, { actor: req.user.userId })) ||
      {};
    const sent = passThroughDenial(res, result);
    if (sent) return sent;

    if (!result.removed) {
      // The read above found it and the delete did not, so something removed it
      // in between. The same 404, because the caller's request has been
      // satisfied by somebody else and there is nothing left to report.
      return res
        .status(404)
        .json({ error: 'That executive view no longer exists' });
    }

    // Counted off the DELETED document, for the reason `del` gives: afterwards
    // there is nothing left to count.
    const boardCount = (result.profile?.boards || []).length;

    // `loadTargetUser` answers `{ _id, name: '' }` when there is no User at that
    // id, and its header says it never returns null on purpose. That case is
    // the ORDINARY one on this route: removing an orphan is still something
    // that happened and still belongs in the history, it just has no name to
    // put in the row — which is a better record than no row at all.
    const targetUser = await loadTargetUser(view.user);
    logExecutiveRemoved({
      organisation: ctx.org._id,
      targetUser,
      actor: req.user.userId,
      boardCount,
    });

    return res.json({
      removed: true,
      // The same two facts `del` reports, for the same reason: deleting a view
      // leaves the role and every board grant exactly as they were. The client
      // reads its sentence off these rather than hardcoding one.
      roleUnchanged: true,
      grantsUnchanged: true,
      boardCount,
      // Echoed because the caller could not have known it — that is the entire
      // premise of this route — and anything else on the page keyed on the
      // person rather than on the profile needs it to reconcile.
      userId: String(view.user),
    });
  } catch (err) {
    console.error('executiveViews.delById error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/orgs/:orgId/executive-views/:userId/declare
 *
 * "Make executive": assign the Executive role AND create an empty profile, as
 * one sequence over one loaded org document.
 *
 * ---- WHY IT NEEDS TWO CAPABILITIES ----------------------------------------
 *
 * `org.manage_executive_views` buys the editor, never the reach — that split is
 * the entire reason the capability exists separately from `org.assign_roles`
 * (read its comment in `utils/capabilities.js`). This endpoint CAN change a
 * ROLE, so when it is going to, it re-checks `org.assign_roles` on top.
 *
 * ...and only then. The capability is owed to the CHANGE, not to the endpoint,
 * and there are two ways this request changes no role — both of which must go
 * through without it:
 *
 *  - `{ assignRole: false }`: "they already hold a role I want to keep, just
 *    make the profile";
 *  - the target ALREADY holds the Executive role. Nothing would move, so there
 *    is nothing to authorise. The check used to fire here anyway, which made
 *    the commonest repair this feature has — "they have the role, their view
 *    was deleted, give them one back" — the single flow the ops lead could not
 *    perform, on a target who was already an Executive by reach either way.
 *
 * The ops lead the capability comment describes — right person to compose
 * somebody's home page, wrong person to decide who is an admin — is exactly who
 * makes both of those calls, and demanding `org.assign_roles` for a request
 * that moves no role would lock them out of the flow the split was written for.
 * It stays strict in the direction that matters: the moment a role WOULD move,
 * the capability is required and no body flag can opt out of it.
 *
 * ---- WHY IT IS IDEMPOTENT -------------------------------------------------
 *
 * "Make executive" is a button on a list, reachable twice by a double click or
 * a stale page. Declaring somebody who already holds the role and already has a
 * profile succeeds and changes nothing:
 *
 *  - the role is assigned only when they do not already hold it. Re-running
 *    `applyRoleAssignment` would rewrite `memberRoles` (drop-then-push) for no
 *    change at all, and there is nothing to guard when nothing moves;
 *  - the profile is created only when there is none. This is the load-bearing
 *    half: `upsert` REPLACES, so re-declaring somebody with an empty shape would
 *    wipe the board list and home layout an admin spent ten minutes composing.
 *    A second declare must never be destructive.
 *
 * And with nothing changed, nothing is logged — a history row saying a view was
 * created is a lie on the second press.
 */
const declare = async (req, res) => {
  try {
    const ctx = await loadAdminContext(req);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const { userId } = req.params;
    if (!isId(userId)) return res.status(400).json({ error: 'Unknown user' });

    const ineligible = refuseIneligibleTarget(ctx.org, userId);
    if (ineligible) {
      return res.status(ineligible.status).json({ error: ineligible.error });
    }

    // Who they are now, read BEFORE anything moves — it decides three things:
    // whether the role half has any work to do, WHICH CAPABILITY this request
    // needs, and what the activity row records. It has to come before the gate
    // for the second of those, which is the whole of the fix.
    const before = resolveOrgAccess(ctx.org, userId).role;
    const alreadyExecutive = before?.key === EXECUTIVE_ROLE_KEY;

    // Opt OUT, not in: the default is the whole point of the button.
    const wantsRole = req.body?.assignRole !== false;

    // The one question the `org.assign_roles` gate is actually about. See the
    // header: a declare that moves no role is purely "create the profile",
    // which is what `org.manage_executive_views` already bought.
    const roleWouldMove = wantsRole && !alreadyExecutive;
    if (roleWouldMove && !ctx.can('org.assign_roles')) {
      return res.status(403).json({
        error:
          'Making someone an executive changes their role, which needs permission to change roles',
      });
    }

    let role = null;
    let roleAssigned = false;
    if (roleWouldMove) {
      // `loadOrgContext` already seeds on first touch, so this is normally a
      // no-op. It is spelled out because this is the one handler that then reads
      // a role BY KEY, and `roleByKey` returning undefined would fall through to
      // `applyRoleAssignment`'s 'Unknown role' — a message that tells nobody the
      // workspace simply has not been migrated.
      if (ctx.org.ensureSystemRoles()) await ctx.org.save();

      role = ctx.org.roleByKey(EXECUTIVE_ROLE_KEY);
      if (!role) {
        return res.status(500).json({
          error:
            'This workspace has no Executive role yet — run `npm run migrate:executive` on the server',
        });
      }

      const denied = applyRoleAssignment(ctx.org, userId, role, {
        actorUserId: req.user.userId,
        isOwner: ctx.isOwner,
      });
      if (denied) {
        const { status, ...body } = denied;
        return res.status(status).json(body);
      }

      // Saved on its own, before the profile is written. The two writes are
      // separate documents in separate collections and there is no transaction
      // to wrap them in, so the order is chosen for which half is safe to have
      // alone: a role without a profile is an ordinary member of a role (the
      // standard app, no executive shell), while a profile without the role
      // would be an executive shell over admin-wide reach — the one combination
      // this feature exists to prevent.
      await ctx.org.save();
      roleAssigned = true;
    }

    const existing = await getForUser(ctx.org._id, userId);
    let profile = existing || null;
    let created = false;
    if (!existing) {
      // The empty shape, taken from the validator (which documents `null` as
      // exactly this case) so the stored document is normalised the same way
      // every other write is — all eight nav switches on, both arrays present —
      // rather than relying on schema defaults a `.lean()` read never re-applies.
      const { value } = validateShape(null, { knownTabs: BOARD_TABS });
      const result =
        (await upsert(ctx.org, userId, value || {}, {
          actor: req.user.userId,
          allowReachChange: true,
        })) || {};
      const sent = passThroughDenial(res, result);
      if (sent) return sent;
      profile = result.profile || null;
      created = true;
    }

    if (created || roleAssigned) {
      const targetUser = await loadTargetUser(userId);
      // The role they hold NOW, whichever half of this put it there — resolved
      // rather than assumed, so `{ assignRole: false }` records the role that
      // was kept instead of the one that was not assigned.
      const finalRole = resolveOrgAccess(ctx.org, userId).role;
      logExecutiveDeclared({
        organisation: ctx.org._id,
        targetUser,
        actor: req.user.userId,
        roleKey: finalRole?.key || null,
        roleName: finalRole?.name || '',
      });
    }

    return res.status(created ? 201 : 200).json({
      profile,
      created,
      roleAssigned,
      role: resolveOrgAccess(ctx.org, userId).role,
    });
  } catch (err) {
    console.error('executiveViews.declare error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /api/orgs/:orgId/executive-views/:userId/boards
 * Body: { boardId, level?, canManage? }
 *
 * Adds a board to the list AND writes the grant that makes it openable, in one
 * step — the two facts are separate by design (invariant 1) but a configurator
 * that made an admin do them separately would produce a list of boards its owner
 * cannot open, every time somebody forgot the second step.
 *
 * DEFAULTS: `edit` + `canManage`, i.e. full access. "All access like admin" is
 * the decision behind the whole role (spec §11 decision 1) — an Executive is an
 * admin on the boards they are actually given — so the default is the answer
 * that matches the role, and the configurator lowers it per board when somebody
 * wants a read-only line of sight.
 *
 * The authorisation that matters is NOT here. Putting a board on somebody's list
 * has to pass the ACTOR's own `resolveAccess(board).canManageAccess`, checked by
 * the service, which is what stops an Executive holding
 * `org.manage_executive_views` from using this route to hand themselves a board
 * nobody gave them.
 */
const addBoard = async (req, res) => {
  try {
    const ctx = await loadAdminContext(req);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const { userId } = req.params;
    if (!isId(userId)) return res.status(400).json({ error: 'Unknown user' });

    const ineligible = refuseIneligibleTarget(ctx.org, userId);
    if (ineligible) {
      return res.status(ineligible.status).json({ error: ineligible.error });
    }

    const body = req.body || {};
    const { boardId } = body;
    if (!isId(boardId)) {
      return res.status(400).json({ error: 'A board is required' });
    }

    // THE PROFILE MUST ALREADY EXIST — this route adds a board to a view, it
    // never creates one.
    //
    // The service's `addBoard` calls `loadOrCreate`, so without this line "add
    // a board" is a SECOND way to make somebody an Executive, and one that
    // skips every gate `declare` puts on that decision: the `org.assign_roles`
    // check when a role would move, the owner refusal, the role assignment
    // itself, and the `executive.declared` row that records who decided it.
    // The person would land in the executive shell holding the plain member
    // role — a shell over the standard app's reach, which is the one
    // combination `declare` orders its two writes to avoid. Two endpoints that
    // both create a profile and disagree about who may is not a policy, it is
    // a gap.
    //
    // Checked after the body so a malformed request does not spend a query to
    // be told it was malformed. Nothing downstream wants the implicit create:
    // phase 4's `copyFrom` makes the same check for the same reason and 404s
    // rather than creating a profile of its own — see its header.
    if (!(await getForUser(ctx.org._id, userId))) {
      return res.status(404).json({
        error:
          'This person does not have an executive view yet — make them an executive first',
      });
    }

    // See the header: full access unless the caller says otherwise. `canManage`
    // is only honoured at `edit` — the grant service clamps it, and so does the
    // share controller, because a viewer who could hand out access is a hole.
    // An unrecognised `level` is REFUSED by the service rather than defaulted
    // here: it comes from a fixed dropdown, so a value off that list is a bug,
    // and silently granting `edit` instead is the wrong way to find out.
    const level =
      typeof body.level === 'string' && body.level ? body.level : 'edit';
    const canManage = body.canManage === undefined ? true : body.canManage === true;

    const result =
      (await addProfileBoard(ctx.org, userId, boardId, {
        level,
        canManage,
        actor: req.user.userId,
      })) || {};
    const sent = passThroughDenial(res, result);
    if (sent) return sent;

    // The board's NAME, for the row — taken off the service's own result, which
    // has just loaded the document. The projected read is a fallback only,
    // because a row reading "added a board" with no board named in it is the
    // exact failure this denormalisation exists to prevent.
    const board =
      result.board || (await Board.findById(boardId).select('name').lean());
    // The level the service NORMALISED, not the string the body sent. They are
    // the same thing today; logging the raw one would be recording the request
    // rather than the decision, which is what the writer's header warns about.
    const grantedLevel = result.level || level;

    const targetUser = await loadTargetUser(userId);
    logExecutiveBoardAdded({
      organisation: ctx.org._id,
      targetUser,
      board,
      level: grantedLevel,
      canManage,
      actor: req.user.userId,
    });

    return res.json({
      profile: result.profile || null,
      board: board ? { _id: board._id, name: board.name } : null,
      level: grantedLevel,
      canManage,
      // `added` is false when the board was already on the list and this call
      // only changed the grant — which is how the configurator edits a level.
      added: result.added !== false,
    });
  } catch (err) {
    console.error('executiveViews.addBoard error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * DELETE /api/orgs/:orgId/executive-views/:userId/boards/:boardId?revoke=
 *
 * Takes a board off the list and, by default, revokes the grant with it — see
 * `parseRevoke` for why that is the default rather than the option.
 *
 * The row records what ACTUALLY happened, not what was asked for: `revoked` is
 * read off the service's result, never off the query string. A board taken off a
 * list is tidying; a board taken off a list AND revoked is somebody losing
 * reach, and the history has to be able to tell a reader which one this was.
 */
const removeBoard = async (req, res) => {
  try {
    const ctx = await loadAdminContext(req);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const { userId, boardId } = req.params;
    if (!isId(userId)) return res.status(400).json({ error: 'Unknown user' });
    if (!isId(boardId)) return res.status(400).json({ error: 'Unknown board' });

    const revoke = parseRevoke(req.query.revoke);

    // Read before the write: the board survives either way, but the profile
    // entry that names it does not, and one projected read keeps this handler
    // from depending on what the service chooses to hand back.
    const board = await Board.findById(boardId).select('name').lean();

    const result =
      (await removeProfileBoard(ctx.org, userId, boardId, {
        revoke,
        actor: req.user.userId,
      })) || {};
    const sent = passThroughDenial(res, result);
    if (sent) return sent;

    const revoked = result.revoked === true;
    const targetUser = await loadTargetUser(userId);
    logExecutiveBoardRemoved({
      organisation: ctx.org._id,
      targetUser,
      board: result.board || board,
      revoked,
      actor: req.user.userId,
    });

    return res.json({
      profile: result.profile || null,
      removed: result.removed !== false,
      revoked,
      // The revoke can be refused on its own — an admin may tidy a list without
      // being able to share the board it names — and the entry still goes. The
      // client has to be able to say "removed from the list, but they can still
      // open it", so the service's reason travels instead of being flattened
      // into a bare `revoked: false` that reads as "you asked us not to".
      grantLeft: result.grantLeft === true,
      reason: result.reason || null,
    });
  } catch (err) {
    console.error('executiveViews.removeBoard error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// Admin plane — phase 4: copy-from and preview-as
// ---------------------------------------------------------------------------

/**
 * Why a board on the source's list did not make it onto the target's.
 *
 * Its own vocabulary rather than the service's `SKIP_REASONS`, because the two
 * answer different questions. `SKIP_REASONS` is about a VIEWER — "why can this
 * person not see this board any more". These are about a COPY — "why could this
 * ACTOR not hand this board on". Only the first word overlaps, and it overlaps
 * deliberately: a deleted board is a deleted board on either screen, and a
 * client that already has a sentence for it should not need a second one.
 *
 * Every one of them is REPORTED. A copy that silently drops three boards leaves
 * an admin looking at a list that is *almost* right, which is worse than a
 * refusal: they cannot tell which three went, and the person on the other end
 * gets a view nobody composed. Hence a per-board row carrying the board's NAME —
 * an id in an error message is not something anybody can act on.
 */
const COPY_SKIP_REASONS = {
  /** The board is gone from this workspace. There is nothing left to copy. */
  DELETED: 'deleted',
  /**
   * The SOURCE cannot read it either — it is one of the entries flagged on
   * their own list. There is no level to read off it (see `copyFrom`), and
   * granting the default instead would hand the target MORE reach than the
   * person being copied from has, which is the opposite of copying.
   */
  SOURCE_NO_ACCESS: 'source-no-access',
  /**
   * The ACTOR cannot share that board. The service's own refusal, reported
   * rather than raised: an admin curating a view is allowed to run into boards
   * that are not theirs to give, and the other nine boards should still land.
   */
  CANNOT_SHARE: 'cannot-share',
  /** Any other refusal the service returned, with its message. Never swallowed. */
  FAILED: 'failed',
};

/**
 * The presentation half of a stored board entry — everything about it EXCEPT
 * which board it is and where it sits.
 *
 * This is the whole of what copy-from copies per board: a nickname, a landing
 * tab and a tab allowlist. It carries no reach and never has; the grant is a
 * separate write with a separate authorisation, which is invariant 1 and the
 * reason "copy a view" is a safe button to offer at all.
 *
 * Rebuilt key by key rather than spread, because a stored entry is a Mongoose
 * subdocument and spreading one copies `$__` and `_doc` instead of the fields —
 * the trap `plainBoardEntry` documents in the service.
 */
const presentationOf = (entry) => ({
  label: entry.label || '',
  defaultTab: entry.defaultTab || null,
  // An empty array reads back as `null` for the same reason it does in the
  // service: "no tabs at all" is refused on the way in, so an empty one in
  // storage can only be mongoose casting a null default.
  tabs:
    Array.isArray(entry.tabs) && entry.tabs.length > 0
      ? entry.tabs.map(String)
      : null,
});

/**
 * The eight switches as a plain object, with a missing one reading as ON.
 *
 * Two callers, one rule. `copyFrom` needs it because a stored `nav` is a
 * Mongoose subdocument and `validateNav` whitelists by `Object.keys` — handing
 * it the subdocument would offer it `$__` and `_doc` as switch names and be
 * refused. `preview` needs it because the pane draws a rail off this object and
 * the profile it is drawing may predate a switch being added.
 *
 * Missing means ON, which is the client's rule too (`applyNavSwitches` treats an
 * absent key as "on" and says why): the default state of being made an
 * Executive is that everything is still there.
 */
const navOf = (profile) => {
  const stored = (profile && profile.nav) || {};
  const nav = {};
  for (const key of ExecutiveView.NAV_KEYS) {
    nav[key] = stored[key] === undefined ? true : !!stored[key];
  }
  return nav;
};

/**
 * The source's home layout, as a shape the validator will accept.
 *
 * The section `_id`s are DROPPED on purpose. That id is the only stable identity
 * a section has — it is the `id` of the composed envelope, and two `note`
 * sections are otherwise indistinguishable — so it has to mean "this section",
 * not "a section shaped like this one". Copying it would put the same identity
 * on two people's pages, and the first thing that goes wrong is the smallest:
 * somebody debugging a section from a screenshot finds two.
 *
 * `validateSection` mints a fresh id for a section that arrives without one,
 * which is exactly what a copy wants.
 */
const copiedHome = (profile) =>
  ((profile && profile.home) || []).map((section) => ({
    type: section.type,
    order: section.order,
    width: section.width,
    // `config` is a Mixed path, so it is already a plain object; the validator's
    // per-type normaliser rebuilds it key by key regardless, which is what drops
    // any key a section type has since retired.
    config: section.config || {},
  }));

/**
 * POST /api/orgs/:orgId/executive-views/:userId/copy-from/:sourceUserId
 *
 * "Start from somebody else's view" — the button that makes the second
 * Executive cost one click instead of twenty.
 *
 * ---- WHAT IS COPIED, AND WHAT IS EMPHATICALLY NOT -------------------------
 *
 * SHAPE ONLY: the home layout, the eight nav switches, and each board entry's
 * presentation (label, order, default tab, tab allowlist). This route copies NO
 * GRANT by itself — invariant 1 again. Every board goes through the ordinary
 * `addBoard` service call, which re-checks the ACTOR's own
 * `resolveAccess(board, org, actor).canManageAccess` on that board, exactly as
 * the configurator's "Add board" button does. Copying somebody's view is
 * therefore never a way to reach a board you could not already hand out: the
 * worst a copy can do is skip.
 *
 * ---- WHY A BOARD THE ACTOR CANNOT SHARE IS SKIPPED, NOT FAILED ------------
 *
 * The person being copied from was set up by somebody, possibly somebody else,
 * possibly last year. Their list can easily contain a board this actor has no
 * authority over, and refusing the whole request for it would mean the copy
 * button simply does not work for that pair — with no indication of which board
 * is the problem. So the copy proceeds and every board it could not take is
 * reported by NAME and reason. The response is the audit; see
 * `COPY_SKIP_REASONS`.
 *
 * ---- WHY THE TARGET MUST ALREADY BE AN EXECUTIVE (404, NOT AN IMPLICIT CREATE)
 *
 * `addBoard` no longer creates a profile (phase 2 closed that), and this route
 * deliberately does not reopen it from a second direction. The choice was
 * between creating the profile here "through the same path `declare` uses" and
 * refusing:
 *
 *  - CREATING IT would mean this endpoint also has to decide the three things
 *    `declare` decides — whether a role moves, whether the actor holds
 *    `org.assign_roles` for that move, and what the `executive.declared` row
 *    says — or call into a shared helper and then keep two endpoints' refusals
 *    identical forever. That is the exact shape of the gap `addBoard`'s own
 *    guard was added to close: "two endpoints that both create a profile and
 *    disagree about who may is not a policy, it is a gap."
 *  - REFUSING keeps ONE creator of profiles. It makes the `org.assign_roles`
 *    rule un-bypassable through this route BY CONSTRUCTION rather than by a
 *    second copy of it — this handler cannot assign a role, cannot create a
 *    profile, and therefore cannot make anybody an Executive at all.
 *
 * Refusing wins, and it costs the flow nothing: the spec puts "Copy from" ON
 * THE CREATE FLOW, next to the button that has just made the profile. The 404 is
 * a guard against a stale page, not a step in the workflow.
 *
 * ---- WHERE THE LEVEL COMES FROM (the subtle part) --------------------------
 *
 * A board ENTRY stores no level, and never has: a level lives on the BOARD, in
 * `memberAccess`, because that is the only place it can mean anything. So
 * "copy the level" has to name where the level is read FROM, or it means
 * nothing. It is read off the SOURCE's own RESOLVED access to that board —
 * `resolveAccess(board, org, sourceUserId).level`, the same two-layer AND every
 * other surface in the app asks — so what the target is granted is what the
 * person being copied from can actually do there today, not what somebody once
 * typed into a form.
 *
 * Two consequences, both deliberate:
 *
 *  - A board the SOURCE can no longer read has no level to read, so it is
 *    skipped (`SOURCE_NO_ACCESS`) rather than granted the `edit` default. The
 *    default is what "Add board" means; it is not what "copy" means, and using
 *    it here would make the copy hand out MORE than the original holds.
 *  - `canManage` is read off the source's GRANT (`board.fullAccess`), not off
 *    their resolved `canManageAccess`. The resolved flag is also true for the
 *    board's creator and for a matrix override — neither of which is a thing
 *    that can be copied to somebody else. A flag on a grant is; that is the one
 *    that travels.
 *
 * And it is CLAMPED to the actor's own standing on that board, so a copy can
 * never be a way to mint a rung the actor could not grant by hand. Today the
 * clamp is belt and braces — every route to `canManageAccess` also resolves the
 * actor to `edit`, so the clamp cannot bite — and it is written down anyway,
 * because "cannot bite" is a property of the current ladder rather than of this
 * feature, and a clamp is cheaper than the audit that finds out it was needed.
 */
const copyFrom = async (req, res) => {
  try {
    const ctx = await loadAdminContext(req);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const { userId, sourceUserId } = req.params;
    const actorId = req.user.userId;
    if (!isId(userId)) return res.status(400).json({ error: 'Unknown user' });
    if (!isId(sourceUserId)) {
      return res.status(400).json({ error: 'Unknown person to copy from' });
    }

    // Copying somebody onto themselves is always a mistake — the picker offers
    // other people — and it is not the harmless no-op it looks like: it would
    // spend a grant write per board to arrive back exactly where it started,
    // and write a history row saying the view was rebuilt.
    if (String(userId) === String(sourceUserId)) {
      return res
        .status(400)
        .json({ error: 'Pick somebody else to copy from' });
    }

    const ineligible = refuseIneligibleTarget(ctx.org, userId);
    if (ineligible) {
      return res.status(ineligible.status).json({ error: ineligible.error });
    }

    // Invariant 8 on the SOURCE side too. To every reader the owner is not an
    // Executive, whatever document may still exist, so there is nothing of
    // theirs to copy — the same answer `get` gives about the same person, for
    // the same reason. See `ownerIsNeverAnExecutive`.
    if (ownerIsNeverAnExecutive(ctx.org, sourceUserId)) {
      return res
        .status(404)
        .json({ error: 'That person does not have an executive view to copy' });
    }

    const source = await getForUser(ctx.org._id, sourceUserId);
    if (!source) {
      return res
        .status(404)
        .json({ error: 'That person does not have an executive view to copy' });
    }

    // THE TARGET MUST ALREADY BE AN EXECUTIVE. See the header: this route makes
    // nobody one, which is what keeps `declare`'s role gate un-bypassable here.
    if (!(await getForUser(ctx.org._id, userId))) {
      return res.status(404).json({
        error:
          'This person does not have an executive view yet — make them an executive first',
      });
    }

    // Validated BEFORE a single grant is written. The source's shape passed this
    // same validator when it was stored, so a refusal here means the stored
    // document is no longer legal — a section type retired by a deploy, a tab
    // renamed — and the honest moment to find that out is before the copy has
    // widened anybody's reach, not after.
    const shape = validateShape(
      { home: copiedHome(source), nav: navOf(source) },
      { knownTabs: BOARD_TABS }
    );
    if (shape.error) return res.status(400).json({ error: shape.error });

    // The source's list in the order it is stored in. Every write in the service
    // keeps `order` dense, so this sort is a tiebreaker rather than a repair —
    // it is here because the copy REPRODUCES an order, and reading that order
    // off array position would quietly depend on the density staying true.
    const rankOf = (entry, index) =>
      Number.isFinite(Number(entry.order)) ? Number(entry.order) : index;
    const sourceEntries = [...(source.boards || [])]
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => rankOf(a.entry, a.index) - rankOf(b.entry, b.index) || a.index - b.index)
      .map(({ entry }) => entry);

    // ONE query for the whole list, scoped to this workspace — a board id from
    // another org must never be resolved against THIS org's roles and grants.
    // Same trap `loadBoardsById` documents in the service, and the reason a
    // cross-org id lands in `skipped` as DELETED: to this workspace, it is.
    const wanted = sourceEntries.map((e) => idOf(e.board)).filter((id) => isId(id));
    const docs = wanted.length
      ? await Board.find({ _id: { $in: wanted }, organisation: ctx.org._id })
      : [];
    const byId = new Map(docs.map((b) => [idOf(b._id), b]));

    // One projected read for every row this request will write. See
    // `loadTargetUser`: the rows have to keep reading after the profile they
    // describe is gone.
    const targetUser = await loadTargetUser(userId);

    const copied = [];
    const skipped = [];
    for (const entry of sourceEntries) {
      const boardId = idOf(entry.board);
      const doc = byId.get(boardId);
      if (!doc) {
        skipped.push({
          board: boardId,
          // The label is all that is left of a board nobody can look up — the
          // same fallback `resolveForViewer` uses for a deleted one.
          name: entry.label || '',
          reason: COPY_SKIP_REASONS.DELETED,
          error: null,
        });
        continue;
      }

      // The level, read off the SOURCE. See the header — this is the half that
      // makes "copy the level" mean something.
      const sourceAccess = resolveAccess(doc, ctx.org, sourceUserId);
      if (!sourceAccess.canRead) {
        skipped.push({
          board: boardId,
          name: doc.name || '',
          reason: COPY_SKIP_REASONS.SOURCE_NO_ACCESS,
          error: null,
        });
        continue;
      }

      // The clamp. `levelAtLeast(actor, source)` asks whether the actor stands
      // high enough to hand the source's rung on; when they do not, they hand on
      // their own. A null actor level (they cannot read the board at all) falls
      // through to the source's rung deliberately — the service is about to
      // refuse the whole grant for that actor anyway, and it is the ONE
      // authority on whether they may share, so the refusal should come from
      // there and be reported, not be pre-empted by a second opinion here.
      const actorLevel = resolveAccess(doc, ctx.org, actorId).level;
      const level = levelAtLeast(actorLevel, sourceAccess.level)
        ? sourceAccess.level
        : actorLevel || sourceAccess.level;
      // The source's GRANT flag, never their resolved `canManageAccess`. See the
      // header: creator-ness and a matrix override are not copyable facts.
      const canManage = sourceAccess.board.fullAccess === true;

      // The ordinary path, with the ordinary check. `notify` is left at its
      // default: the target genuinely has just been given these boards, and the
      // grant service only notifies on a FIRST grant, so a copy that overlaps
      // what they already had stays quiet on its own.
      const result =
        (await addProfileBoard(ctx.org, userId, boardId, {
          level,
          canManage,
          actor: actorId,
        })) || {};
      if (result.error) {
        skipped.push({
          board: boardId,
          name: doc.name || '',
          // 403 is the one refusal this route expects and the one the admin can
          // do something about ("ask whoever runs that board to share it").
          // Anything else is reported as itself rather than mislabelled.
          reason:
            result.status === 403
              ? COPY_SKIP_REASONS.CANNOT_SHARE
              : COPY_SKIP_REASONS.FAILED,
          error: result.error,
        });
        continue;
      }

      // The level the service NORMALISED, for the same reason `addBoard` logs
      // that one: recording the request rather than the decision is how two
      // records that should agree start disagreeing.
      const granted = result.level || level;
      copied.push({
        board: boardId,
        name: doc.name || '',
        level: granted,
        canManage,
        added: result.added !== false,
        presentation: presentationOf(entry),
      });

      logExecutiveBoardAdded({
        organisation: ctx.org._id,
        targetUser,
        board: result.board || doc,
        level: granted,
        canManage,
        actor: actorId,
      });
    }

    // ---- the presentation, written once over the entries `addBoard` made ----
    //
    // `addBoard` appends a BARE entry (no label, no presets) because that is
    // what adding a board means; the copy's nicknames and tab presets are a
    // shape edit, and shape edits go through `upsert`. Re-read rather than
    // tracked across N service calls: one query, and it cannot disagree with
    // what is actually stored.
    const afterBoards = (await getForUser(ctx.org._id, userId))?.boards || [];

    const rank = new Map(copied.map((c, index) => [c.board, index]));
    const presentation = new Map(copied.map((c) => [c.board, c.presentation]));

    // BOARDS ARE MERGED, NEVER REPLACED — the one asymmetry in this handler.
    // `home` and `nav` are replaced outright, because "copy from" means the
    // target's page becomes the source's page and a merged layout would be a
    // page neither person has. A board list is different: every entry on it was
    // put there by an admin and, unlike a section, an entry that disappears is
    // a board somebody stops being able to find. So the copied boards take the
    // source's order at the top and whatever the target already had keeps its
    // own presentation and follows.
    let tail = rank.size;
    const boards = afterBoards.map((entry) => {
      const boardId = idOf(entry.board);
      const from = presentation.get(boardId);
      return {
        board: boardId,
        ...(from || presentationOf(entry)),
        order: from ? rank.get(boardId) : tail++,
      };
    });

    const boardShape = validateShape({ boards }, { knownTabs: BOARD_TABS });
    if (boardShape.error) {
      return res.status(400).json({ error: boardShape.error });
    }

    // `allowReachChange: true` — the admin plane. It changes nothing about reach
    // here (every entry in `boards` is one the service has just written or one
    // that was already stored), but the self plane's filter would re-judge those
    // entries against the TARGET's access, which is the wrong question on an
    // admin's request and would drop an entry whose grant is still settling.
    const result =
      (await upsert(ctx.org, userId, { ...shape.value, ...boardShape.value }, {
        actor: actorId,
        allowReachChange: true,
      })) || {};
    const sent = passThroughDenial(res, result);
    if (sent) return sent;

    // A copy is an UPDATE plus N board additions, and that is exactly what it
    // writes. `ActivityLog.type` is an enum owned by the model, and a sixth
    // `executive.copied` type would mean editing that enum and giving it a
    // sentence in `activityFormat` — for an event the two existing rows already
    // describe completely, down to which boards landed and at what level.
    //
    // The list says what actually moved rather than what the endpoint touches:
    // a copy from somebody with an empty board list is a home-and-nav copy, and
    // recording "boards" for it would be a row that reads as a change nobody
    // made.
    const changed = ['home', 'nav'];
    if (copied.length) {
      changed.push('boards');
      if (copied.some((c) => c.presentation.label)) changed.push('labels');
      if (copied.some((c) => c.presentation.defaultTab || c.presentation.tabs)) {
        changed.push('presets');
      }
    }
    logExecutiveUpdated({
      organisation: ctx.org._id,
      targetUser,
      changed,
      actor: actorId,
    });

    return res.json({
      profile: result.profile || null,
      // The audit, both halves. Picked key by key rather than spread, so the
      // per-board `presentation` this handler carried internally does not ride
      // along: it is already in the profile above, and the client's sentence is
      // "these boards were copied, at these levels", not a second copy of the
      // labels it has just been handed.
      copied: copied.map((c) => ({
        board: c.board,
        name: c.name,
        level: c.level,
        canManage: c.canManage,
        added: c.added,
      })),
      skipped,
    });
  } catch (err) {
    console.error('executiveViews.copyFrom error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/orgs/:orgId/executive-views/:userId/preview
 *
 * The target's home page and rail, composed SERVER-SIDE AS THE TARGET, so the
 * configurator can show an admin what they have actually built.
 *
 * ---- WHY THIS IS AN ENDPOINT AND NOT A CLIENT-SIDE RENDER ------------------
 *
 * Because the admin's own reach would leak into it, and would leak in the
 * direction that flatters the configuration. An admin composing somebody's page
 * can usually read more boards than the person they are composing it for; a
 * preview drawn from the admin's session would score every one of those boards,
 * fill every tile, and show a page that works — while the person it was built
 * for opens "You no longer have access to this board" four times. The one
 * mistake this screen exists to catch is exactly that one, so the preview has to
 * be resolved and composed as the TARGET or it is worse than no preview at all.
 *
 * Both halves are run about the target and neither is run about the caller:
 * `resolveForViewer(org, targetUserId)` decides which board entries survive and
 * names the rest in `skipped[]`, and `compose(org, targetUserId, ...)` re-checks
 * `canRead` per board before any scorer runs (invariant 1). The caller's
 * identity is used for exactly one thing: the capability gate above, deciding
 * whether they may look at this at all.
 *
 * ---- WHY THE TARGET'S CAPABILITIES SHIP WITH IT ----------------------------
 *
 * The rail is not drawn from `nav` alone. `nav` can only HIDE a row the
 * capability gates already allowed (spec invariant 6 — `applyNavSwitches` is a
 * filter and runs AFTER those gates), so a pane that applied the switches over
 * the ADMIN's capabilities would draw rows the target will never see: Analytics
 * for somebody whose role has no `analytics.view`, Members for somebody with no
 * `org.view_members`. The gates are part of what the target sees, so the
 * target's resolved capability list travels with the preview, in the same
 * `{ role, isOwner, capabilities }` shape `GET /api/orgs/:id` already ships for
 * the caller — the client has a reader for it.
 *
 * ---- WHAT THIS NEVER DOES -------------------------------------------------
 *
 * It never 403s on a board the target cannot read. That case is the whole point
 * of looking: it comes back as an elided entry in `skipped[]` and as a section
 * whose state is `unavailable`, which is precisely what the target's own screen
 * will say. A preview that refused would hide the defect it was opened to find.
 *
 * 404 when there is no profile — the same answer, and the same sentence, as
 * `getMyHome`. `sections: []` would read as "their home page is empty", which a
 * real profile can genuinely be, and the two states must not look alike. The
 * owner gets that 404 too, through `ownerIsNeverAnExecutive`: invariant 8 says
 * they are not an Executive, so there is no executive home to preview.
 */
const preview = async (req, res) => {
  try {
    const ctx = await loadAdminContext(req);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const { userId } = req.params;
    if (!isId(userId)) return res.status(400).json({ error: 'Unknown user' });

    if (ownerIsNeverAnExecutive(ctx.org, userId)) {
      return res
        .status(404)
        .json({ error: 'This person does not have an executive view' });
    }

    const resolved = (await resolveForViewer(ctx.org, userId)) || {};
    if (!resolved.profile) {
      return res
        .status(404)
        .json({ error: 'This person does not have an executive view' });
    }

    // Composed from the RESOLVED profile, exactly as `getMyHome` does it: the
    // boards this person can no longer open are already elided, so a section
    // cannot tile one even if the composer were careless — and the composer is
    // not, it re-checks per board. Defence in depth, and one less query.
    const composed =
      (await compose(ctx.org, userId, { profile: resolved.profile })) || {};

    // The TARGET's org access, never the caller's. See the header.
    const access = resolveOrgAccess(ctx.org, userId);

    return res.json({
      profile: resolved.profile,
      skipped: resolved.skipped || [],
      sections: composed.sections || [],
      // A normalised echo of `profile.nav`, hoisted so the pane drawing the rail
      // does not have to know where the switches live — and so a profile written
      // before a switch existed answers with all eight rather than leaving the
      // pane to infer a default. `navOf` has the "missing means on" rule.
      nav: navOf(resolved.profile),
      permissions: {
        role: access.role,
        isOwner: access.isOwner,
        capabilities: [...access.capabilities],
      },
    });
  } catch (err) {
    console.error('executiveViews.preview error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// Self plane
// ---------------------------------------------------------------------------

/**
 * The org a `/me/...` request is about.
 *
 * It comes from `?org=` because the client always knows which workspace it is
 * looking at and the server cannot guess — a person can be a member of several,
 * and an Executive in one of them. Every other "mine" endpoint in this codebase
 * does exactly this (`GET /api/tasks/my?org=`, the calendar), and doing it
 * differently here would mean the client had to remember which of its "mine"
 * calls carried the org.
 *
 * `loadOrgContext` is what enforces membership — it 403s a non-member — so this
 * only has to reject a missing or malformed id before the lookup.
 */
const loadSelfContext = async (req) => {
  const orgId = req.query.org;
  if (!isId(orgId)) {
    return { status: 400, error: 'An organisation is required' };
  }
  return loadOrgContext(orgId, req.user.userId);
};

/**
 * GET /api/me/executive-view?org=:orgId
 *
 * The caller's own profile, resolved against their own access: boards they can
 * no longer read are dropped from `profile.boards` and named in `skipped[]`, so
 * the shell renders a list that matches what clicking a tile will actually do.
 *
 * `{ profile: null }` with a 200 when there is none. This endpoint is what the
 * client's `isExecutive` is derived from and it is called on every sign-in by
 * everybody, executive or not — a 404 for the ordinary case would be an error in
 * the console of every session in the workspace, and would tempt the store into
 * treating a real failure (offline, 500) as "not an executive", which silently
 * puts an Executive back on the standard dashboard.
 */
const getMine = async (req, res) => {
  try {
    const ctx = await loadSelfContext(req);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    // The read half of invariant 8. The owner asking for their own view is the
    // ordinary case here — every signed-in person calls this endpoint on every
    // sign-in — so this is the same `{ profile: null }` everybody else gets,
    // not a refusal. It is what puts an owner who used to be an Executive back
    // on the standard app on their very next page load. See
    // `ownerIsNeverAnExecutive`.
    if (ownerIsNeverAnExecutive(ctx.org, req.user.userId)) {
      return res.json({ profile: null, skipped: [] });
    }

    const resolved = (await resolveForViewer(ctx.org, req.user.userId)) || {};
    return res.json({
      profile: resolved.profile || null,
      skipped: resolved.skipped || [],
    });
  } catch (err) {
    console.error('executiveViews.getMine error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * PUT /api/me/executive-view?org=:orgId — the Executive edits their own shape.
 *
 * `allowReachChange: false`. The service drops any board entry the caller cannot
 * already read and reports it in `dropped`, and no grant is written on this path
 * at any point (invariant 2). That is what makes self-editing safe to offer at
 * all: rearranging your own home, trimming your own rail and reordering your own
 * board list cannot widen what you reach, because the document does not grant
 * anything in the first place.
 *
 * 404 WHEN THERE IS NO PROFILE, deliberately — the self path EDITS a shape an
 * admin created, it never creates one. Having a profile is what makes somebody
 * an Executive; if this route created one, any member could PUT themselves into
 * the executive shell. They would gain no reach (the role is a separate record
 * and untouched), but they would land on a home page instead of the dashboard
 * and a board list nobody curated, which is a support ticket built out of a
 * missing four-line check.
 *
 * `dropped` is returned rather than swallowed so the page can say "two boards
 * you can no longer open were removed from your list" instead of quietly saving
 * something different from what was on screen.
 */
const putMine = async (req, res) => {
  try {
    const ctx = await loadSelfContext(req);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const userId = req.user.userId;

    // The read half of invariant 8 again, and the same 404 with the same
    // sentence: `getMine` has already told this caller they have no view, so
    // the write that follows must agree with it. Without this line an owner
    // carrying a stale document could edit a view nothing will ever render —
    // and `del` on the admin plane, which deliberately has no owner refusal, is
    // the path that clears one up.
    if (ownerIsNeverAnExecutive(ctx.org, userId)) {
      return res
        .status(404)
        .json({ error: 'You do not have an executive view' });
    }

    const existing = await getForUser(ctx.org._id, userId);
    if (!existing) {
      return res.status(404).json({ error: 'You do not have an executive view' });
    }

    const { value, error } = validateShape(req.body, { knownTabs: BOARD_TABS });
    if (error) return res.status(400).json({ error });

    // The reach filter the service applies to `boards[]`, applied to the board
    // ids a home LAYOUT names — `validateShape` cannot do it (no org, no user,
    // no database) and `upsert` stores `home` verbatim. See `reachFilterHome`
    // for why a stored id survives and a new one does not.
    let homeDropped = [];
    if (value.home !== undefined) {
      const decided = await reachFilterHome(
        ctx.org,
        userId,
        value.home,
        existing
      );
      value.home = decided.home;
      homeDropped = decided.dropped;
    }

    const result =
      (await upsert(ctx.org, userId, value, {
        actor: userId,
        allowReachChange: false,
      })) || {};
    const sent = passThroughDenial(res, result);
    if (sent) return sent;

    // No User read on this path: the token already carries the caller's name,
    // and on the self plane the actor and the target are the same person.
    logExecutiveUpdated({
      organisation: ctx.org._id,
      targetUser: { _id: userId, name: req.user.name },
      changed: changedParts(req.body),
      actor: userId,
    });

    return res.json({
      profile: result.profile || null,
      // ONE list, not two. Both halves say the same thing to whoever reads it —
      // "you named a board you cannot open, and it was not stored" — and a
      // second key would only make the page choose which sentence to show.
      // De-duplicated because the same board can be both a list entry and a
      // section's subject in the same save.
      dropped: [
        ...new Set([...(result.dropped || []).map(String), ...homeDropped]),
      ],
    });
  } catch (err) {
    console.error('executiveViews.putMine error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * GET /api/me/executive-home?org=:orgId → { sections: [...] }
 *
 * The composed home page: the profile's `home[]` walked by
 * `services/executiveHome.js`, one envelope per section. This handler composes
 * NOTHING itself (invariant 5) — it loads, authorises, and hands the profile to
 * the one composer.
 *
 * ---- THE RESOLVED PROFILE IS WHAT THE COMPOSER GETS ------------------------
 *
 * `resolveForViewer` has already dropped the board entries this person can no
 * longer open, so a `boardTiles` section cannot tile a board that is not theirs
 * even if the composer were careless. It is not — it re-checks `canRead` per
 * board before any scorer runs, which is invariant 1 and the check that
 * actually protects the data. Resolving first is defence in depth and one less
 * query: the composer would otherwise need the same board documents to decide
 * the same thing.
 *
 * ---- WHY 404 HERE AND `{ profile: null }` NEXT DOOR ------------------------
 *
 * `GET /me/executive-view` answers 200 with a null profile because EVERYBODY
 * calls it on every sign-in to decide `isExecutive`; a 404 there would be an
 * error in every non-executive's console. This endpoint is only ever called
 * once the client already knows the answer is yes, so reaching it without a
 * profile means the client asked for a page that does not exist for this
 * person. `sections: []` would be the worse lie of the two available: it reads
 * as "your home page is empty", which is a thing a real profile can genuinely
 * be, and it would hide a client bug behind a blank page forever.
 *
 * The owner gets that same 404 through `ownerIsNeverAnExecutive` — invariant 8
 * says they are not an Executive, so there is no executive home to compose for
 * them, whatever document may still exist.
 *
 * `skipped[]` is not repeated here. The page already has it from the profile
 * call it made to get this far, and a section whose board went away says so
 * itself, in its own envelope, with the sentence that belongs to that section.
 */
const getMyHome = async (req, res) => {
  try {
    const ctx = await loadSelfContext(req);
    if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

    const userId = req.user.userId;

    // Same 404 as "no profile", and deliberately the same MESSAGE: to every
    // reader the owner simply is not an Executive, and a special sentence here
    // would be the only place in the app that says otherwise.
    if (ownerIsNeverAnExecutive(ctx.org, userId)) {
      return res
        .status(404)
        .json({ error: 'You do not have an executive view' });
    }

    const resolved = (await resolveForViewer(ctx.org, userId)) || {};
    if (!resolved.profile) {
      return res
        .status(404)
        .json({ error: 'You do not have an executive view' });
    }

    const composed =
      (await compose(ctx.org, userId, { profile: resolved.profile })) || {};

    return res.json({ sections: composed.sections || [] });
  } catch (err) {
    console.error('executiveViews.getMyHome error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  list,
  get,
  put,
  del,
  delById,
  declare,
  addBoard,
  removeBoard,
  copyFrom,
  preview,
  getMine,
  putMine,
  getMyHome,
  // The copy's skip vocabulary, exported so a test and the configurator read the
  // same words this handler writes. Nothing else in the file exports a constant
  // because nothing else invents one — these reasons are this route's own.
  COPY_SKIP_REASONS,
  // The strip's row shape. Exported for `executiveListRow.test.js`, which pins
  // the one thing about it that is a rule and not a rendering: an orphan keeps
  // its row AND both of the ids that make it reachable. A handler cannot be
  // unit-tested without a database; this decision can, so it was lifted out to
  // where it could be.
  executiveListRow,
};
