import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Compass,
  Eye,
  LayoutDashboard,
  LayoutGrid,
  Plus,
  ShieldCheck,
  Trash2,
} from 'lucide-react';

import PageWrapper from '../components/layout/PageWrapper';
import Button from '../components/ui/Button';
import Dropdown from '../components/ui/Dropdown';
import EmptyState from '../components/ui/EmptyState';
import Modal from '../components/ui/Modal';
import Switch from '../components/ui/Switch';
import SectionEditor from '../components/executive/SectionEditor';
import SECTION_REGISTRY from '../components/executive/sectionRegistry';
import BoardPresetFields from '../components/executive/BoardPresetFields';
import PreviewFrame from '../components/executive/PreviewFrame';
import useBoardStore from '../store/boardStore';
import useOrgStore from '../store/orgStore';
import * as orgService from '../services/orgService';
import {
  normalisePreset,
  presetAlreadyStored,
  presetSummary,
  samePreset,
} from '../utils/executiveBoards';
import {
  addExecutiveBoard,
  getExecutiveView,
  previewExecutiveView,
  removeExecutiveBoard,
  saveExecutiveView,
} from '../services/executiveViewService';

/**
 * THE EXECUTIVE VIEW CONFIGURATOR — one person's screen, composed by an admin.
 *
 * Reached from the Members page at `/members/:userId/executive-view`, gated on
 * `org.manage_executive_views` by the route itself (see `App.jsx`). It edits ONE
 * `ExecutiveView` profile: the boards on somebody's list, the nicknames they
 * carry, the rail entries that person keeps, and — from phase 2 — the sections
 * on their home page.
 *
 * ---- THE ONE THING TO UNDERSTAND BEFORE CHANGING ANYTHING HERE -------------
 *
 * THE PROFILE NEVER GRANTS ACCESS (invariant 1). Listing a board in somebody's
 * view does not let them open it; a separate board GRANT does, and the two are
 * written by two different endpoints for that reason. Which is why this page has
 * TWO SAVE MODELS sitting side by side, and says so on screen rather than
 * pretending otherwise:
 *
 *   ADD / REMOVE A BOARD  — takes effect the moment it is pressed, because each
 *                           one writes or revokes a real share of that board.
 *                           They go through `addExecutiveBoard` /
 *                           `removeExecutiveBoard`, each of which re-checks the
 *                           ADMIN'S OWN `canManageAccess` on that board. An
 *                           admin cannot hand out reach they do not have.
 *   EVERYTHING ELSE       — nicknames, the per-board tab presets and the eight
 *                           rail switches — is local until Save, which PUTs the
 *                           whole shape. All three only ever SHAPE A SCREEN:
 *                           `resolveViewTabs` can hide a tab the person's own
 *                           capabilities allowed and can never show one they
 *                           hid, so none of them can widen anybody's reach.
 *
 * Collapsing the two into one "Save" would mean a page that looks unsaved while
 * somebody already has access to four boards, or one that writes shares as a
 * side effect of a button labelled Save. Both are worse than the seam.
 *
 * ---- THE ADMIN PUT REPLACES THE WHOLE DOCUMENT -----------------------------
 *
 * `services/executiveView.js` `upsert` REPLACES `boards`, `home` and `nav` from
 * what it is sent. A body that omits one of the three does not leave it alone —
 * it clears it. So every save from this page sends all three, and `home` is
 * round-tripped VERBATIM (section `_id`s included, which the validator preserves
 * on purpose) even though phase 1 draws no editor for it. Dropping `home`
 * because this screen does not edit it would delete a home layout somebody
 * composed in phase 2 the first time an admin flipped a rail switch here.
 *
 * ---- WHY EVERY MUTATION IS FOLLOWED BY A RE-READ ---------------------------
 *
 * The admin GET resolves the profile AS THE TARGET: boards that person can no
 * longer open are removed from `boards[]` and reported in `skipped[]` (invariant
 * 4 — a lost board is flagged, never silently deleted). The three MUTATING
 * endpoints answer with the STORED document instead, which still contains those
 * entries. Rendering their answer directly would quietly turn every unreachable
 * board into a reachable-looking one, so each mutation is followed by
 * `getExecutiveView` and the screen only ever draws a resolved read.
 *
 * ---- AND WHAT THAT COSTS, WHICH THE SCREEN ADMITS TO -----------------------
 *
 * Because the read is resolved and the write is a replace, a save has to put the
 * skipped entries back by hand or it would destroy them — the exact data loss
 * the skip-never-delete rule exists to prevent. `boardsForSave` does that, and
 * what it CANNOT put back is everything the resolved read did not send with
 * them: the NICKNAME on a board the person cannot currently open (`skipped[]`
 * carries the board's own name, not the entry's label) and its TAB PRESETS
 * (`skipped[]` carries neither field). Such an entry keeps its place on the list
 * and comes back bare.
 *
 * So `boards` is sent ONLY when it has something to say — `boardsNeedWrite`
 * decides, `persist` omits the key otherwise, and `upsert` then leaves the
 * stored array alone. A rail switch, a home layout, a save that changed nothing
 * about any board: none of them can cost somebody a setting on a board this
 * screen cannot see. When a save DOES touch the list the loss is real, and the
 * banner on the Boards step says so rather than leaving somebody to notice.
 *
 * ---- WHAT THE BOARD PICKER LISTS -------------------------------------------
 *
 * The CALLER's own boards, straight from `useBoardStore`. That is what makes an
 * Executive configuring another Executive see only their own reach: they cannot
 * list what they cannot read, and the server would refuse the grant anyway. One
 * rule, enforced twice.
 *
 * Two kinds of board are then withheld, each because ADDING ONE IS A GRANT and
 * this caller may not write that particular grant:
 *
 *   - a board the caller cannot share (`permissions.canManageAccess`), which
 *     `services/executiveView.js` `addBoard` refuses outright; and
 *   - a board the TARGET created, which has no grant to write — `addBoard` has
 *     no board-owner guard of its own, so this page must not hand it one.
 *
 * Both are COUNTED under the picker rather than silently dropped. The same
 * reasoning governs the Full access switch: only a board's creator may give or
 * take it, exactly as `boardController.setBoardAccess` insists. See
 * `canGiveFullAccess` and the `addable` memo for the full argument — the short
 * version is that the executive route authorises on `canManageAccess` alone,
 * which is one rung below what the Share dialog requires for these two writes,
 * and a configurator that offered them would be the way around the difference.
 */

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The steps, in the order the design lays them out (spec §4.7).
 *
 * Every step is reachable from every other. This is an EDITOR of a document that
 * already exists, not a creation wizard — nothing here is unsafe to look at out
 * of order, and gating step 4 behind step 2 would mean an admin fixing one rail
 * switch has to walk past the board list to reach it.
 *
 * Preview is last because it is the only one that READS rather than writes: it
 * asks the server to compose the whole thing as the target and draws the answer.
 * It is not a summary of the four steps before it and does not confirm them —
 * every other step has already saved by the time somebody gets here.
 */
const STEPS = [
  { key: 'role', label: 'Role', icon: ShieldCheck },
  { key: 'boards', label: 'Boards', icon: LayoutGrid },
  { key: 'home', label: 'Home', icon: LayoutDashboard },
  { key: 'nav', label: 'Navigation', icon: Compass },
  { key: 'preview', label: 'Preview', icon: Eye },
];

/**
 * The access ladder, WORD FOR WORD from `components/board/BoardAccessModal.jsx`.
 *
 * Deliberately copied rather than reworded. This is the same grant, written to
 * the same field, by the same `services/boardGrants.js` the Share dialog uses —
 * an admin who reads "Contribute" here and "Contribute" there is reading about
 * one thing, and two teams inventing two vocabularies for one permission is how
 * a support answer stops matching the product.
 *
 * `none` is absent from this list on purpose. On the Share dialog "No access" is
 * how a grant is taken away; here that is what REMOVING THE BOARD does, and it
 * asks a question this control cannot ("also take it off the list?").
 */
const LEVELS = [
  { value: 'view', label: 'View', hint: 'Read the board' },
  { value: 'comment', label: 'Comment', hint: 'Read, and post updates' },
  {
    value: 'contribute',
    label: 'Contribute',
    hint: 'Add tasks, and work on tasks assigned to them',
  },
  { value: 'edit', label: 'Can edit', hint: 'Full control of board content' },
];

const LEVEL_LABEL = {
  owner: 'Owner',
  edit: 'Can edit',
  contribute: 'Contribute',
  comment: 'Comment',
  view: 'View',
  // Grants written before the ladder existed carry the old spelling; the server
  // folds `read` onto `view`, and so does this, or the select renders with
  // nothing selected on a board shared years ago.
  read: 'View',
};

/** Fold a stored grant onto the ladder. Mirrors `normaliseLevel` on the server. */
const normaliseLevel = (level) => {
  if (!level) return null;
  const mapped = level === 'read' ? 'view' : level;
  return LEVELS.some((l) => l.value === mapped) ? mapped : null;
};

/**
 * The eight rail switches, LABELLED AS DESTINATIONS.
 *
 * "Boards" is a switch name; "My Boards" is the thing that disappears from the
 * rail when it is off. An admin is deciding what somebody sees, so the list
 * reads as the rail reads — and `hint` says which entries carry a capability
 * behind them, because a switch left ON does not conjure an Analytics link for
 * somebody whose role cannot see Analytics.
 *
 * The keys are the server's `NAV_KEYS` (`models/ExecutiveView.js`), in rail
 * order. `validateNav` REJECTS an unknown key rather than dropping it, so a typo
 * here is a save that fails loudly — which is the behaviour we want, but it does
 * mean this list is the contract and not a display detail.
 *
 * Home and Settings are deliberately absent: they are never hideable, so there
 * is no switch to store for them.
 */
const NAV_ENTRIES = [
  {
    key: 'boards',
    label: 'My Boards',
    hint: 'Their curated board list',
  },
  {
    key: 'myWork',
    label: 'My Work',
    hint: 'Tasks assigned to them, across every board they can reach',
  },
  { key: 'chat', label: 'Chat', hint: 'Direct messages and board channels' },
  { key: 'calendar', label: 'Calendar', hint: 'Their tasks, by date' },
  {
    key: 'notifications',
    label: 'Notifications',
    hint: 'Mentions, assignments and board activity',
  },
  {
    key: 'members',
    label: 'Members',
    hint: 'The workspace roster — also needs “See who is in the workspace”',
  },
  {
    key: 'analytics',
    label: 'Analytics',
    hint: 'Workspace numbers — also needs “View analytics”',
  },
  {
    key: 'productivity',
    label: 'Productivity',
    hint: 'Per-person throughput — also needs “View others’ productivity”',
  },
];

const NAV_KEYS = NAV_ENTRIES.map((e) => e.key);

/**
 * THE capability this whole feature turns on, and the one way to configure it
 * so that it silently does nothing.
 *
 * A role without it cannot see the workspace's public boards at all, which is
 * what makes a curated list the WHOLE list. A role that still holds it sees the
 * curated list PLUS every public board in the workspace — the configurator
 * appears to work, the person's screen does not change, and nothing anywhere
 * reports an error. Step 1 exists to catch precisely that.
 */
const VIEW_PUBLIC = 'board.view_public';

/** Why a listed board did not survive the resolve. The server's `SKIP_REASONS`. */
const SKIP_COPY = {
  deleted:
    'This board has been deleted. Nothing can restore it — take it off the list.',
  'no-access':
    'They can no longer open this board; the share was revoked somewhere else. Add it again below to give the access back, or take it off the list.',
};

/** Why a revoke was refused on its own. The server's `KEEP_REASONS`. */
const KEEP_COPY = {
  'cannot-manage-access':
    'but they can still open it — you cannot manage sharing on that board, so the share was left alone.',
  'board-missing':
    'the board itself no longer exists, so there was no access to take away.',
};

/** Normalise a ref that may be an id string, an ObjectId or a populated doc. */
const idOf = (ref) => String(ref?._id || ref || '');

/**
 * Fixed widths for the three controls at the end of a board row, so the heading
 * strip above the list lines up with every row under it. The first two are the
 * Share dialog's own numbers, for the same reason the words are its own.
 */
const LEVEL_COL = 130;
const FULL_COL = 76;
/** The tab-preset disclosure, which labels itself rather than taking a heading. */
const TABS_COL = 76;
const REMOVE_COL = 82;

/* -------------------------------------------------------------------------- */
/* Small presentational pieces                                                 */
/* -------------------------------------------------------------------------- */

const Panel = ({ children, className = '' }) => (
  <div
    className={className}
    style={{
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-lg)',
      background: 'var(--color-bg-surface)',
      boxShadow: 'var(--shadow-card)',
      padding: '20px 24px',
    }}
  >
    {children}
  </div>
);

const StepHead = ({ title, blurb }) => (
  <header className="mb-5">
    <h2
      className="font-display font-bold text-[16px]"
      style={{ color: 'var(--color-text-primary)' }}
    >
      {title}
    </h2>
    {blurb && (
      <p
        className="mt-1 font-body text-[13px]"
        style={{ color: 'var(--color-text-secondary)' }}
      >
        {blurb}
      </p>
    )}
  </header>
);

/**
 * A coloured message block. `tone` picks the palette from the same status tokens
 * the rest of the app paints with, so a warning here looks like a warning
 * everywhere else rather than like a new kind of thing.
 */
const Notice = ({ tone = 'info', icon: Icon, title, children }) => {
  const palette =
    tone === 'warning'
      ? {
          background: 'var(--color-status-working-bg)',
          color: 'var(--color-status-working)',
        }
      : tone === 'danger'
        ? {
            background: 'var(--color-status-stuck-bg)',
            color: 'var(--color-status-stuck)',
          }
        : tone === 'success'
          ? {
              background: 'var(--color-status-done-bg)',
              color: 'var(--color-status-done)',
            }
          : {
              background: 'var(--color-bg-subtle)',
              color: 'var(--color-text-secondary)',
            };
  return (
    <div
      className="font-body"
      style={{
        padding: '12px 14px',
        borderRadius: 'var(--radius-md)',
        fontSize: 13,
        ...palette,
      }}
    >
      <div className="flex items-start gap-2">
        {Icon && (
          <Icon size={16} aria-hidden="true" style={{ marginTop: 1, flexShrink: 0 }} />
        )}
        <div className="min-w-0">
          {title && <p style={{ fontWeight: 600 }}>{title}</p>}
          {children && <div className={title ? 'mt-1' : ''}>{children}</div>}
        </div>
      </div>
    </div>
  );
};

/** A column caption over the board list's right-hand controls. */
const ColumnHeading = ({ width, align = 'left', children }) => (
  <span
    className="font-body shrink-0"
    style={{
      width,
      textAlign: align,
      fontSize: 10,
      fontWeight: 600,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      color: 'var(--color-text-muted)',
    }}
  >
    {children}
  </span>
);

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

const ExecutiveViewConfigPage = () => {
  const { userId } = useParams();
  const navigate = useNavigate();

  const currentOrg = useOrgStore((s) => s.currentOrg);
  const members = useOrgStore((s) => s.members);
  const memberRoles = useOrgStore((s) => s.memberRoles);
  const adminId = useOrgStore((s) => s.adminId);
  const fetchMembers = useOrgStore((s) => s.fetchMembers);
  const boards = useBoardStore((s) => s.boards);
  const fetchBoards = useBoardStore((s) => s.fetchBoards);

  const orgId = currentOrg?._id || null;

  // `?step=preview` is a way IN (the Members page links straight to the
  // preview), read once and never written back — the URL is not the step's
  // state, and an unknown key simply lands on the first step.
  const [searchParams] = useSearchParams();
  const [step, setStep] = useState(() => {
    const asked = searchParams.get('step');
    return STEPS.some((s) => s.key === asked) ? asked : 'role';
  });

  // Server truth, re-read after every mutation. `skipped` is the honest answer
  // resolved AS THE TARGET, never as the admin looking at this page.
  const [profile, setProfile] = useState(null);
  const [skipped, setSkipped] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // The role matrix, for step 1. `useOrgStore.roles` carries a role's NAME but
  // not its permissions (see `listMembers` on the server), and this page has to
  // read an actual capability off the role rather than assume one from its key.
  const [roleRows, setRoleRows] = useState(null);

  // Local until Save: the per-entry nicknames and the eight switches.
  const [entries, setEntries] = useState([]);
  const [nav, setNav] = useState(() =>
    NAV_KEYS.reduce((acc, key) => ({ ...acc, [key]: true }), {})
  );

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  /**
   * "The write landed, the re-read did not."
   *
   * A THIRD outcome, and it has to be its own state because it is neither of
   * the other two. `persist` writes and then re-reads (see its header for why
   * the echo cannot be rendered), and the re-read is a second request that can
   * fail on its own. Folding that failure into `saveError` would put "Not
   * saved" in front of an admin whose change IS on the document — and somebody
   * who believes nothing was written and walks away has just silently changed
   * another person's view. So the write's success stands, and the refresh
   * reports itself.
   */
  const [saveNotice, setSaveNotice] = useState('');
  // What the SERVER said it stored, not what this page hoped it would.
  const [receipt, setReceipt] = useState(null);

  /**
   * How many times the Home step's editor has been RE-SEEDED from the server.
   *
   * This is the `SectionEditor`'s React key, and it is a counter rather than
   * `profile.updatedAt` for one reason: remounting that editor throws away its
   * draft, and `updatedAt` moves on saves that have nothing to do with the
   * draft. See the key itself at the Home step for the full argument.
   */
  const [homeSeed, setHomeSeed] = useState(0);

  /**
   * Did the CALLER's own board list fail to load?
   *
   * It has to be a separate flag, because an empty `boards` array is the same
   * shape as a failed read and the Boards step states it as fact: every row
   * reads "Access unknown", the picker says "No more boards to add", and the
   * count of boards-you-cannot-share is zero. All three are assertions about
   * this admin's reach, and a dropped request must not be allowed to make them.
   * A Notice plus a retry is the difference between "you can share nothing" and
   * "we could not ask".
   */
  const [boardsFailed, setBoardsFailed] = useState(false);

  // Board mutations: one at a time, and the board id is the busy token so the
  // row that is working is the row that looks like it.
  const [busyBoard, setBusyBoard] = useState(null);
  const [boardError, setBoardError] = useState('');
  const [boardNotice, setBoardNotice] = useState('');
  const [addPick, setAddPick] = useState('');

  const [removeTarget, setRemoveTarget] = useState(null);
  const [removeRevoke, setRemoveRevoke] = useState(true);
  const [removing, setRemoving] = useState(false);

  /**
   * THE PREVIEW — `{ profile, skipped, sections, nav, capabilities }`, composed
   * server-side AS THE TARGET.
   *
   * It is fetched by the step rather than with the page, because it is the one
   * read here that costs real work: the composer runs a scorer per section —
   * goals, delivery, ads pacing, the analytics aggregation — on boards that may
   * not be small. Loading it on mount would make every visit to this page pay
   * for a step most visits never open, to look at numbers that are stale by the
   * time anybody does.
   *
   * `null` means "not asked yet", which is why the effect below can key on it
   * without a second flag.
   */
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');

  /**
   * Which rows have their tab presets open — board ids, and nothing else.
   *
   * Not a single "which row is open", because the useful comparison on this
   * step is between two boards: an admin deciding that both tracker boards open
   * on Goals wants to see both forms at once. Not persisted either: it is a
   * disclosure, not a preference, and it deliberately survives the re-read that
   * follows a board mutation (the ids stay valid; a row that left the list
   * simply stops being drawn, and its stale id in here is inert).
   */
  const [openPresets, setOpenPresets] = useState(() => new Set());

  const togglePreset = (boardId) =>
    setOpenPresets((open) => {
      const next = new Set(open);
      if (next.has(boardId)) next.delete(boardId);
      else next.add(boardId);
      return next;
    });

  /* ---------------------------------------------------------------------- */
  /* Loading                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Fold a resolved read into local state.
   *
   * `keepEdits` preserves the UNSAVED half of a row — the nickname typed since
   * the last save, and the tab presets set beside it. Adding or removing a
   * BOARD is an immediate server call and forces a re-read, and it would be
   * indefensible for that to silently throw away a label somebody typed two
   * fields up, or a tab allowlist they had just finished ticking. A board that
   * left the list takes its edits with it, which is the only case where losing
   * them is the right answer.
   */
  const applyResolved = useCallback((data, { keepEdits = false } = {}) => {
    const nextProfile = data?.profile || null;
    const serverEntries = nextProfile?.boards || [];

    setProfile(nextProfile);
    setSkipped(data?.skipped || []);
    // A resolved read has just landed, so "this page could not be refreshed" is
    // no longer true whoever triggered the read — a board add refreshes the page
    // just as well as a retry does, and a warning left standing after the thing
    // it warns about has fixed itself is a warning people learn to ignore.
    setSaveNotice('');

    setEntries((previous) => {
      // The whole row, not just its label: the presets are edited on the same
      // screen and lost by the same re-read.
      const typed = keepEdits
        ? new Map(previous.map((e) => [e.board, e]))
        : new Map();
      return serverEntries.map((entry, index) => {
        const board = idOf(entry.board);
        const edited = typed.get(board) || null;
        return {
          board,
          label: edited ? edited.label : entry.label || '',
          // Re-indexed from the array rather than trusting the stored number:
          // the server densifies `order` on every write, so position IS order.
          order: index,
          /**
           * The tab presets, from the same place the label came from: the
           * unsaved edit when there is one, the stored document otherwise —
           * and through `normalisePreset` either way.
           *
           * That pass is not cosmetic. It folds the two shapes the server
           * REFUSES (`tabs: []`, and an allowlist with no 'board' in it) back
           * into ones it accepts, and either could arrive from storage: a
           * Mongoose array default can land as `[]`, and this page PUTs back
           * whatever it read. Without it, one old document would make every
           * save from this screen fail with a 400 about a field nobody on the
           * page had touched.
           *
           * NO BOARD IS PASSED. The board list loads in parallel with this
           * read and this admin may not be able to read the board at all, so
           * narrowing a preset by board type here could quietly delete one
           * that is perfectly good. That narrowing belongs where the board IS
           * in hand: the row summary, the form, and — the pass that decides
           * what the document ends up holding — `boardsForSave`. A preset
           * repaired here and never narrowed again would be a value every
           * screen draws as absent and the document quietly keeps.
           */
          ...normalisePreset(edited || entry),
        };
      });
    });

    if (!keepEdits) {
      setNav(
        NAV_KEYS.reduce((acc, key) => {
          // Absent means ON: the model defaults every switch to true, and a
          // `.lean()` read of a document written before a switch existed simply
          // has no key for it.
          acc[key] = nextProfile?.nav?.[key] !== false;
          return acc;
        }, {})
      );
    }
    return nextProfile;
  }, []);

  const load = useCallback(
    async ({ keepEdits = false } = {}) => {
      if (!orgId || !userId) return null;
      const data = await getExecutiveView(orgId, userId);
      return applyResolved(data, { keepEdits });
    },
    [orgId, userId, applyResolved]
  );

  /**
   * Re-read the caller's own boards, and REMEMBER whether that worked.
   *
   * Every board mutation invalidates this list — the grant lives on the board,
   * and the level selector reads it back off `memberAccess` — so it is refetched
   * after each one. The failure has to be recorded rather than swallowed for the
   * reason `boardsFailed` exists: a board list that silently stayed stale (or
   * empty) turns this screen into a confident liar. It deliberately does not
   * throw: a refresh that failed after a grant that succeeded must not be
   * reported as a failed grant.
   */
  const refreshBoards = useCallback(async () => {
    if (!orgId) return;
    try {
      await fetchBoards(orgId);
      setBoardsFailed(false);
    } catch {
      setBoardsFailed(true);
    }
  }, [orgId, fetchBoards]);

  useEffect(() => {
    if (!orgId || !userId) return undefined;
    let live = true;
    setLoading(true);
    setLoadError('');

    // The three reads this page cannot render without, in parallel because none
    // of them depends on another: the profile, the role matrix (for step 1's
    // capability check) and the caller's own boards (the picker, and the grant
    // levels, which are read off each board's `memberAccess`).
    Promise.all([
      getExecutiveView(orgId, userId),
      orgService.listRoles(orgId).catch(() => null),
      // Resolved to a FLAG rather than swallowed. `fetchBoards` throws on a
      // failure and leaves `boards` as it was, which on a fresh mount is `[]` —
      // indistinguishable from an admin who genuinely has no boards, and the
      // Boards step says so out loud. See `boardsFailed`.
      fetchBoards(orgId).then(
        () => false,
        () => true
      ),
      members.length === 0 ? fetchMembers(orgId).catch(() => null) : null,
    ])
      .then(([view, matrix, boardsBroke]) => {
        if (!live) return;
        applyResolved(view);
        // null, not [], when the matrix could not be read. Step 1 must be able
        // to say "I could not check" — an empty list would read as "this role
        // holds nothing", which is an all-clear it has not earned.
        setRoleRows(matrix?.roles || null);
        setBoardsFailed(boardsBroke === true);
      })
      .catch((err) => {
        if (!live) return;
        setLoadError(
          err?.response?.data?.error || 'Could not load this executive view'
        );
      })
      .finally(() => {
        if (live) setLoading(false);
      });

    return () => {
      live = false;
    };
    // `members` is deliberately not a dependency: it is read once to decide
    // whether the roster needs fetching, and listing it here would re-run the
    // whole load the moment `fetchMembers` resolved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, userId, applyResolved, fetchBoards, fetchMembers]);

  /**
   * Ask the server what this person's screen looks like.
   *
   * ONE ENDPOINT, AND IT DOES ALL OF IT. There is no client-side assembly here
   * and there must never be: `GET .../preview` runs `resolveForViewer` and
   * `compose` against the TARGET, so the reach that decides which boards appear,
   * which sections score and which rail rows survive is theirs. The admin's own
   * session is not consulted at any point — which is the property the whole step
   * is for, and the one that a helpful "we already have the boards loaded, let
   * us just filter them here" would quietly destroy. An owner filtering their
   * own board list would produce a preview showing every board in the workspace.
   *
   * A stale answer must never win a race: two loads in flight (the step opened,
   * then a save landed) resolve in whatever order the network gives them, and
   * the older one would overwrite the newer. The token settles it.
   */
  const previewRun = useRef(0);
  const loadPreview = useCallback(async () => {
    if (!orgId || !userId) return;
    const token = previewRun.current + 1;
    previewRun.current = token;
    setPreviewLoading(true);
    setPreviewError('');
    try {
      const data = await previewExecutiveView(orgId, userId);
      if (previewRun.current !== token) return;
      setPreview(data || null);
    } catch (err) {
      if (previewRun.current !== token) return;
      setPreviewError(
        err?.response?.data?.error || 'Could not build the preview'
      );
    } finally {
      if (previewRun.current === token) setPreviewLoading(false);
    }
  }, [orgId, userId]);

  /**
   * Fetch on arrival, and again after anything is STORED.
   *
   * Keyed on `updatedAt` rather than on the profile object, whose identity
   * changes on every re-read including the ones that changed nothing. A save
   * made on another step and then previewed must show the saved thing, and an
   * admin who saves while standing on this step should watch the picture catch
   * up rather than have to ask it to.
   *
   * It deliberately does NOT re-run on local edits. The preview is of the
   * DOCUMENT; a nickname typed two steps away and not yet saved is not part of
   * anybody's screen yet, and a preview that quietly included it would be
   * showing a view that does not exist. The step says so where `dirty` is true
   * rather than papering over the difference.
   */
  const previewKey = profile?.updatedAt || null;
  const hasProfile = !!profile;
  useEffect(() => {
    if (step !== 'preview' || !hasProfile) return;
    loadPreview();
  }, [step, hasProfile, previewKey, loadPreview]);

  /* ---------------------------------------------------------------------- */
  /* Derived                                                                 */
  /* ---------------------------------------------------------------------- */

  const target = useMemo(
    () => members.find((m) => idOf(m) === String(userId)) || null,
    [members, userId]
  );
  const targetName = target?.name || target?.email || 'This person';

  // Invariant 8. The server refuses on three separate routes; the page refuses
  // to draw the controls at all, because every one of them would 400.
  const targetIsOwner = !!adminId && String(adminId) === String(userId);

  const role = memberRoles?.[String(userId)] || null;
  /**
   * The role AS THE MATRIX STORES IT — permissions included.
   *
   * Matched on id rather than key: a workspace may have several roles derived
   * from the same preset, and the id is what `memberRoles` resolved. The key is
   * only ever used for display elsewhere.
   */
  const roleDetail = useMemo(() => {
    if (!roleRows || !role) return null;
    return roleRows.find((r) => String(r.id) === String(role.id)) || null;
  }, [roleRows, role]);

  /**
   * Three answers, not two. `null` is "could not check", and it must not render
   * as an all-clear — a page that says "public boards are not theirs" because a
   * request failed is worse than one that says it does not know.
   */
  const holdsViewPublic = roleDetail
    ? (roleDetail.permissions || []).includes(VIEW_PUBLIC)
    : null;

  const boardsById = useMemo(() => {
    const map = new Map();
    for (const b of boards || []) map.set(idOf(b._id), b);
    return map;
  }, [boards]);

  /**
   * What the target's access to a board actually is, read off the board's own
   * `memberAccess` — the same field the Share dialog renders from.
   *
   * The profile does NOT record a level (it records a screen), so this is the
   * only honest source. `null` when there is no grant, which on a board an
   * Executive can see means their role is carrying them some other way, and
   * `undefined` when the CALLER cannot read the board at all and therefore
   * cannot be told.
   */
  const grantFor = useCallback(
    (boardId) => {
      const board = boardsById.get(boardId);
      if (!board) return undefined;
      if (idOf(board.createdBy) === String(userId)) {
        // They CREATED it. Board ownership is not a grant and cannot be written
        // or revoked as one — it is the rung above the ladder.
        return { level: 'owner', canManage: true, isBoardOwner: true };
      }
      const row = (board.memberAccess || []).find(
        (g) => idOf(g.user) === String(userId)
      );
      if (!row) return null;
      return {
        level: normaliseLevel(row.level),
        canManage: row.canManage === true,
        isBoardOwner: false,
      };
    },
    [boardsById, userId]
  );

  /**
   * May the CALLER give or take FULL access on this board?
   *
   * Only its creator may. That is not this page's rule — it is
   * `boardController.setBoardAccess`'s, which refuses the identical write with
   * "Only the board owner can give or remove full access" whenever the caller
   * is not `access.board.creator`, and it refuses it to the workspace owner too
   * (`board.creator` is strictly `isBoardCreator`; org ownership does not make
   * you a board's creator). The Share dialog renders the same rule as
   * `fullLocked = row.isOwnerRow || row.isSelf || !isOwner`.
   *
   * The executive route does NOT re-apply it: `services/executiveView.js`
   * `addBoard` checks only the actor's `canManageAccess` before calling
   * `boardGrants.grant`, which stores whatever `canManage` it is handed. So an
   * admin holding `org.manage_executive_views` could mint a sharing peer on a
   * board somebody else created — the precise escalation the controller's guard
   * exists to stop — by routing through this page instead of that dialog. The
   * guard belongs on the server and is reported as such; this stops the page
   * being the way to reach it, and stops it OFFERING a control whose write the
   * rest of the product forbids.
   *
   * `permissions.isBoardOwner` is `withPermissions`' name for
   * `resolveAccess(...).board.creator` — the caller's own creatorship of that
   * board, not the target's.
   */
  const canGiveFullAccess = useCallback(
    (boardId) => boardsById.get(boardId)?.permissions?.isBoardOwner === true,
    [boardsById]
  );

  const listedIds = useMemo(
    () => new Set(entries.map((e) => e.board)),
    [entries]
  );

  /**
   * The boards the Home step's section pickers may offer — THE TARGET'S LIST,
   * never this admin's.
   *
   * A home section names a board, and the person who will read that section is
   * the target. Offering a board only the ADMIN can open would compose to "You
   * no longer have access to this board" on a tile that person never chose, and
   * offering a board they CAN open but which is not on their curated list would
   * put a board's client names and numbers on the front page of an app built to
   * show them a handful of boards and nothing else. So the source is `entries`
   * — the view's own board list, in the view's own order.
   *
   * The board OBJECT rides along when this admin can see it too, so the picker
   * can show the real name; a bare id is passed when they cannot, and
   * `pickableBoards` takes either. An admin configuring a board they cannot
   * themselves read is unusual but entirely legal (the target's grants are not
   * the admin's), and a picker that dropped those rows would silently shorten
   * somebody else's options.
   */
  const homeBoards = useMemo(
    () =>
      entries.map((entry) => ({
        board: boardsById.get(entry.board) || entry.board,
        label: entry.label || '',
      })),
    [entries, boardsById]
  );
  const skippedIds = useMemo(
    () => new Set((skipped || []).map((s) => idOf(s.board))),
    [skipped]
  );

  /**
   * Boards the caller could actually add.
   *
   * Three filters, and the last two are the interesting ones.
   *
   * A board the CALLER cannot share is refused by the server (`addBoard`
   * re-checks the actor's own `canManageAccess`), so offering it would be an
   * invitation to a 403. Those are counted rather than silently dropped —
   * "four boards are not listed because you cannot share them" is a fact an
   * admin can act on; a short list is not.
   *
   * A board the TARGET CREATED is withheld for a different and sharper reason.
   * `addBoard` ALWAYS writes a grant, and `services/executiveView.js` has no
   * board-owner guard of its own — unlike `boardController.setBoardAccess`,
   * which refuses outright with "The board owner always has full access". So
   * adding somebody's own board here would push a `memberAccess` row for that
   * board's creator (meaningless: `resolveAccess` already gives the creator
   * everything) and fire a "you were given access" notification for a board
   * they made. Worse is the undo: removing it later runs `boardGrants.revoke`,
   * which now sees a real entry and deletes every ItemFollow they hold on that
   * board plus every Notification from it — a person's follows on their OWN
   * board, wiped by an admin tidying a list, with the screen reporting "they
   * can no longer open it" when in fact nothing about their access changed.
   *
   * Withholding it costs them nothing they can see: `utils/executiveBoards.js`
   * puts every board an Executive can read but has no profile entry for into
   * the "Other boards" group, so their own board is still on their screen — it
   * just cannot carry a nickname or a place in the curated run. That is the
   * right trade until the service grows the guard `setBoardAccess` already has.
   */
  const { addable, unshareable, ownedByTarget } = useMemo(() => {
    const available = (boards || []).filter(
      (b) => !listedIds.has(idOf(b._id)) && !skippedIds.has(idOf(b._id))
    );
    // Split first: a board the target created must not be counted as merely
    // unshareable, because the reason it is missing is a different sentence.
    const theirs = [];
    const rest = [];
    for (const b of available) {
      (idOf(b.createdBy) === String(userId) ? theirs : rest).push(b);
    }
    return {
      addable: rest.filter((b) => b.permissions?.canManageAccess !== false),
      unshareable: rest.filter((b) => b.permissions?.canManageAccess === false)
        .length,
      ownedByTarget: theirs.length,
    };
  }, [boards, listedIds, skippedIds, userId]);

  /* ---------------------------------------------------------------------- */
  /* Saving the shape                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * The `boards` array a save must send — the visible entries PLUS the skipped
   * ones, rebuilt.
   *
   * This function is the whole reason the header talks about a resolved read and
   * a replacing write. `entries` came out of a read that had already removed the
   * unreachable boards; sending it back as-is would delete them from the stored
   * document and turn "somebody revoked a grant this morning" into "the board
   * fell off the list forever".
   *
   * ---- WHAT A REBUILT SKIPPED ENTRY CANNOT CARRY BACK -----------------------
   *
   * Its place on the list, yes. Its SETTINGS, no — and there are two of them,
   * not one.
   *
   * A deleted board keeps its nickname (the server's `skipped[].name` falls back
   * to the stored label when there is no board left to name it). An unreachable
   * one cannot: `name` there is the BOARD's name, so its entry reverts to an
   * empty label — which means "use the board's own name" and is exactly what the
   * person will see once access comes back.
   *
   * NEITHER CAN CARRY BACK ITS TAB PRESETS. `skipped[]` is `{ board, name,
   * reason }`; the resolved read never sends the stored `defaultTab` / `tabs`
   * for an entry it elided, so the nulls below are not a choice this page makes
   * — they are the only shape it has. Writing them costs somebody a preset they
   * set weeks ago, silently, on a board nobody on this screen was thinking
   * about. Two things keep that from being routine damage:
   *
   *   - a save that has nothing to say about boards does not send `boards` at
   *     all (see `boardsNeedWrite` and `persist`), so a rail switch or a home
   *     layout cannot cost anybody a preset;
   *   - the banner on the Boards step says what the next board-touching save
   *     will do to them, so restoring access first is an option somebody can
   *     actually take.
   *
   * What would close it properly is one field on the server: `skipped[]`
   * shipping the stored entry (or `upsert` merging skipped entries on the admin
   * plane the way `reachFilteredBoards` already does on the self plane, where
   * this loss does not exist at all). Reported rather than reached for, because
   * `services/executiveView.js` is not this unit's file.
   */
  const boardsForSave = useCallback(() => {
    const kept = entries.map((e, index) => ({
      board: e.board,
      label: e.label || '',
      order: index,
      /**
       * Narrowed against the board ONE LAST TIME, on the way out.
       *
       * The load-time pass (`applyResolved`) deliberately passes NO board — the
       * board list is still in flight and this admin may not be able to read the
       * board at all — so it repairs the shape and narrows nothing. But the row
       * summary and the form both describe the preset AS THIS BOARD WOULD APPLY
       * IT, which means a `defaultTab` the board can no longer show (a tracker
       * board converted to a standard one, an add-on switched off) has been
       * drawn as cleared ever since the board list landed. Storing the
       * un-narrowed value would leave the document saying something no screen on
       * either side says — and saying it again the day that board changes back.
       *
       * Safe in the one case that worries: a board this admin cannot read is not
       * in `boardsById`, `tabsForBoard(null)` then offers the whole catalog, and
       * nothing is narrowed. The pass can only ever delete a preset that every
       * screen had already stopped showing.
       */
      ...normalisePreset(e, boardsById.get(e.board) || null),
    }));
    const restored = (skipped || []).map((s, index) => ({
      board: idOf(s.board),
      label: s.reason === 'deleted' ? s.name || '' : '',
      order: kept.length + index,
      defaultTab: null,
      tabs: null,
    }));
    return [...kept, ...restored];
  }, [entries, skipped, boardsById]);

  /**
   * Has `boards[]` anything to say, or should this save leave it alone?
   *
   * `validateShape` builds its value KEY BY KEY and `upsert` assigns only the
   * parts the shape carries, so a PUT that omits `boards` leaves the stored
   * array exactly as it is — including the entries this screen cannot see. That
   * is the difference between flipping a rail switch costing somebody the tab
   * presets on a board whose grant lapsed, and it costing nothing. Sending an
   * array we did not need to send is not free here; it is a rewrite of a list we
   * can only partly reconstruct.
   *
   * IT IS NOT `dirty`, AND FOLDING THE TWO TOGETHER BREAKS ONE OF THEM. `dirty`
   * asks "did somebody EDIT this?" and compares repaired-but-un-narrowed shapes
   * on both sides, so that a document which is merely stale cannot light the
   * Save button on a page nobody has touched. This asks "would writing change
   * what is stored?" and compares what `boardsForSave` would actually send
   * against the RAW stored entry, so that a stale `defaultTab` or an illegal
   * `tabs: []` still gets repaired the next time there is a save to ride along
   * with. `presetAlreadyStored` in `utils/executiveBoards.js` carries both
   * halves of that reasoning.
   *
   * `order` is deliberately not compared. The stored numbers are dense across
   * the WHOLE list including the skipped entries, so the resolved list this page
   * holds legitimately has gaps in it — treating a gap as a change would make
   * every save rewrite `boards[]`, which is precisely the rewrite this exists to
   * avoid. Nothing on this step reorders entries anyway.
   */
  const boardsNeedWrite = useMemo(() => {
    if (!profile) return false;
    const stored = new Map((profile.boards || []).map((e) => [idOf(e.board), e]));
    // A count that disagrees means an add or a remove has not been folded in
    // yet; write rather than guess which side is behind.
    if (stored.size !== entries.length) return true;
    return entries.some((e) => {
      const was = stored.get(e.board);
      if (!was) return true;
      if ((e.label || '') !== (was.label || '')) return true;
      return !presetAlreadyStored(
        normalisePreset(e, boardsById.get(e.board) || null),
        was
      );
    });
  }, [profile, entries, boardsById]);

  /**
   * Is there anything for Save to do?
   *
   * Measured against `profile` — the document as the server last reported it —
   * rather than against a snapshot taken when the page loaded. A snapshot has to
   * be re-taken after every server read, and the read that follows a board being
   * ADDED deliberately keeps local edits, so a snapshot would come back
   * disagreeing with itself and the page would claim unsaved changes that do not
   * exist. Comparing against the document cannot drift, because the document is
   * the thing Save is trying to match.
   *
   * Board membership is absent on purpose: adding and removing are already saved
   * by the time they are on screen.
   *
   * This is NOT `boardsNeedWrite`, which is the other half of the same subject
   * and asks a different question — see the comment there before making the two
   * share code. This one is about what somebody DID; that one is about what a
   * write would change. A stale or illegal stored preset belongs to the second
   * and must stay invisible to this one, or the page greets everybody with an
   * unsaved change they did not make.
   */
  const dirty = useMemo(() => {
    if (!profile) return false;
    const stored = new Map(
      (profile.boards || []).map((e) => [idOf(e.board), e])
    );
    const labelsMoved = entries.some(
      (e) => (e.label || '') !== (stored.get(e.board)?.label || '')
    );
    // `samePreset` rather than a deep-equal: `tabs: null` ("every tab") and
    // `tabs: [every tab there is]` are different settings that comparing two
    // arrays cannot tell apart, and reading them as equal would leave Save
    // greyed out over a real change.
    // The stored side is normalised for the same reason the loaded side is
    // (see `applyResolved`): an old `tabs: []` against a local `null` is the
    // same setting, and reporting it as a change would leave Save lit up on a
    // page nobody had edited.
    const presetsMoved = entries.some(
      (e) => !samePreset(e, normalisePreset(stored.get(e.board) || {}))
    );
    const navMoved = NAV_KEYS.some(
      (key) => (nav[key] !== false) !== (profile.nav?.[key] !== false)
    );
    return labelsMoved || presetsMoved || navMoved;
  }, [profile, entries, nav]);

  /**
   * Write the whole shape, and THROW when it did not land.
   *
   * ---- WHY ONE WRITER TAKES AN OVERRIDE INSTEAD OF TWO WRITERS ------------
   *
   * `PUT /api/orgs/:orgId/executive-views/:userId` REPLACES the document. There
   * is no partial write, so every save from this page — the header button, and
   * the Home step's own Save — has to send `boards`, `home` and `nav` together.
   * Two functions doing that would be two chances to forget one of the three,
   * and forgetting one is silent data loss rather than an error.
   *
   * The Home step passes its freshly arranged list in `home` because the editor
   * holds its draft internally and only hands it over on Save; everything else
   * is read from the state this page already keeps. So pressing Save inside the
   * section editor saves the whole configuration, which is the truth and is
   * what the receipt then reports.
   *
   * IT RETHROWS — but ONLY when the WRITE failed.
   *
   * `SectionEditor` awaits this and keeps its draft (and says so) when the
   * promise rejects; swallowing a failed PUT here would tell somebody their
   * sections were stored when they were not. The header button catches instead
   * — the banner is its report.
   *
   * The RE-READ that follows the write is deliberately outside that contract.
   * It is a second request, it can fail on its own, and its failure does not
   * un-write the document: reporting it as a rejection would make the editor
   * say "That did not save. Nothing has been lost" about a save that landed,
   * which is the one lie a save button must never tell. So it has its own
   * try/catch and its own message (`saveNotice`), and the promise still
   * resolves.
   */
  const persist = async ({ home: homeOverride } = {}) => {
    if (!orgId || !userId || !profile) return null;
    setSaving(true);
    setSaveError('');
    setSaveNotice('');
    setReceipt(null);
    try {
      const data = await saveExecutiveView(orgId, userId, {
        /**
         * `boards` ONLY WHEN IT HAS SOMETHING TO SAY — the one part of this
         * body that is conditional, and the one part this page cannot fully
         * reconstruct.
         *
         * An omitted key is not an empty value: the validator builds its result
         * key by key and `upsert` writes only the parts it finds, so leaving
         * this out preserves the stored array untouched — nicknames and tab
         * presets included, on the entries the resolved read elided and
         * `boardsForSave` can only put back bare. `home` and `nav` are sent
         * unconditionally because this page holds all of both; `boards` is the
         * one it holds only the visible half of.
         */
        ...(boardsNeedWrite ? { boards: boardsForSave() } : {}),
        // The arranged list when the Home step just produced one, otherwise the
        // stored one VERBATIM — a PUT that omitted this would clear the person's
        // whole home page on the way past. `_id` is round-tripped because the
        // validator preserves it and it is the section's identity; a section
        // added in the editor has none yet and the server mints one. `key` (the
        // editor's local id) is deliberately not sent: the server drops it, and
        // sending it would invite somebody to believe it means something.
        home: (homeOverride || profile.home || []).map((section) => ({
          _id: section._id,
          type: section.type,
          order: section.order,
          width: section.width,
          config: section.config || {},
        })),
        // Sent as the eight known keys and nothing else: `validateNav` REJECTS
        // an unknown key rather than dropping it, so a stray `_id` from a lean
        // read would fail the whole save.
        nav: NAV_KEYS.reduce((acc, key) => {
          acc[key] = nav[key] !== false;
          return acc;
        }, {}),
      });

      // The write has landed. The receipt is built from the PUT's OWN echo and
      // set BEFORE the re-read, so what the server says it stored is reported
      // whether or not a second request succeeds. (The echo is good enough to
      // COUNT with — it is only unsafe to RENDER AS THE PAGE, because it still
      // holds the boards this person cannot open.)
      const stored = data?.profile || null;
      setReceipt({
        boards: (stored?.boards || []).length,
        home: (stored?.home || []).length,
        on: NAV_ENTRIES.filter((e) => stored?.nav?.[e.key] !== false).map(
          (e) => e.label
        ),
        off: NAV_ENTRIES.filter((e) => stored?.nav?.[e.key] === false).map(
          (e) => e.label
        ),
        dropped: data?.dropped || [],
      });

      // Read back rather than trusting the echo: the PUT answers with the STORED
      // document, which still holds the boards this person cannot open. Only a
      // resolved read can redraw the skipped banner honestly.
      try {
        await load({ keepEdits: false });
        // The editor may be re-seeded ONLY now — see the key at the Home step.
        // A section list that was just committed and read back is the one case
        // where remounting costs nothing, and bumping this after a re-read that
        // FAILED would reseed the editor from the stale profile and put the
        // pre-save list back on screen.
        if (homeOverride !== undefined) setHomeSeed((n) => n + 1);
      } catch (err) {
        console.error('Saved, but could not re-read the executive view:', err);
        setSaveNotice(
          'Saved, but this page could not be refreshed. What you see below may be out of date — reload to check. Saving again is safe.'
        );
      }
      return data;
    } catch (err) {
      setSaveError(
        err?.response?.data?.error || 'Could not save this executive view'
      );
      // Rethrown on purpose — see the header. The banner above is for the
      // person; this is for the caller that has to decide whether to keep an
      // unsaved draft.
      throw err;
    } finally {
      setSaving(false);
    }
  };

  /**
   * The header button. Swallows the rejection because `saveError` is already on
   * screen by the time it lands, and an unhandled rejection in a click handler
   * is noise in the console rather than information for anybody.
   */
  const handleSave = () => {
    persist().catch(() => {});
  };

  /* ---------------------------------------------------------------------- */
  /* Board reach                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Add a board, or change the grant on one already listed — ONE endpoint for
   * both, because the server's `addBoard` is idempotent on the entry and always
   * rewrites the grant. That is how the level selector below works: it re-adds
   * the same board at a different rung.
   */
  const writeBoard = async (boardId, { level, canManage }) => {
    if (!orgId || !userId) return false;
    setBusyBoard(boardId);
    setBoardError('');
    setBoardNotice('');
    try {
      const result = await addExecutiveBoard(orgId, userId, boardId, {
        level,
        canManage,
      });
      // The grant lives on the BOARD, so the board list is now stale — and it is
      // what the level selector reads from. Refreshed before the profile so the
      // row cannot redraw at its old rung.
      await refreshBoards();
      await load({ keepEdits: true });
      const name = result?.board?.name || 'That board';
      setBoardNotice(
        result?.added
          ? `${name} added — ${targetName} can open it now.`
          : `${name} is now ${
              LEVEL_LABEL[result?.level] || result?.level || 'updated'
            }${canManage && result?.level === 'edit' ? ' with full access' : ''}.`
      );
      return true;
    } catch (err) {
      // One message for both jobs this function does, because the server's own
      // refusal ("You cannot manage access on that board.") is what will
      // actually be shown nine times out of ten; the fallback only has to be
      // true whether the board was being added or re-levelled.
      setBoardError(
        err?.response?.data?.error || 'Could not change access to that board'
      );
      return false;
    } finally {
      setBusyBoard(null);
    }
  };

  const handleAdd = async () => {
    if (!addPick) return;
    // The default the whole role means: full access, an admin on the boards they
    // are actually given (spec §11 decision 1). Lowered per board below.
    //
    // FULL access only where the caller is entitled to hand it out — see
    // `canGiveFullAccess`. On a board somebody else created the add still lands
    // at `Can edit`, which is the whole of the spec's default that this caller
    // may legitimately write; the board's own creator can raise it afterwards
    // from the row, or from the Share dialog, exactly as they could before.
    const ok = await writeBoard(addPick, {
      level: 'edit',
      canManage: canGiveFullAccess(addPick),
    });
    // The choice survives a refusal. Clearing it first would leave an admin who
    // hit "you cannot manage access on that board" with an empty picker and no
    // clue which board they had chosen.
    if (ok) setAddPick('');
  };

  const handleRemove = async () => {
    if (!removeTarget || !orgId || !userId) return;
    setRemoving(true);
    setBoardError('');
    setBoardNotice('');
    try {
      const result = await removeExecutiveBoard(
        orgId,
        userId,
        removeTarget.board,
        { revoke: removeRevoke }
      );
      await refreshBoards();
      await load({ keepEdits: true });
      setRemoveTarget(null);

      // Read `revoked` off the ANSWER, never off the box that was ticked. The
      // entry always goes; the revoke can be refused on its own when the admin
      // cannot manage sharing on that board, and "removed from the list" and
      // "they can no longer open it" are two different sentences.
      const name = removeTarget.name;
      if (result?.revoked) {
        setBoardNotice(`${name} removed — ${targetName} can no longer open it.`);
      } else if (result?.grantLeft || removeRevoke) {
        setBoardNotice(
          `${name} removed from the list — ${
            KEEP_COPY[result?.reason] ||
            'their access to it was left as it was.'
          }`
        );
      } else {
        setBoardNotice(
          `${name} removed from the list. Their access to it is unchanged, as you asked.`
        );
      }
    } catch (err) {
      setBoardError(
        err?.response?.data?.error || 'Could not remove that board'
      );
      setRemoveTarget(null);
    } finally {
      setRemoving(false);
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  const setLabel = (boardId, value) =>
    setEntries((list) =>
      list.map((e) => (e.board === boardId ? { ...e, label: value } : e))
    );

  /**
   * Store the two tab presets for one board.
   *
   * LOCAL UNTIL SAVE, like the nicknames beside them and unlike the grant
   * controls on the same row. That seam is the page's oldest rule: a control
   * that writes a real share of a board takes effect when it is pressed, and
   * everything that only shapes a screen waits for the button. A preset shapes
   * a screen — `resolveViewTabs` can only ever subtract from the tabs that
   * person's own capabilities already allowed — so it belongs on the second
   * side of the seam.
   *
   * `BoardPresetFields` has already normalised what it hands over; doing it
   * again here against the same board is belt and braces, and cheap.
   */
  const setPreset = (boardId, board, preset) =>
    setEntries((list) =>
      list.map((e) =>
        e.board === boardId ? { ...e, ...normalisePreset(preset, board) } : e
      )
    );

  /**
   * Open the remove dialog, and RE-ARM the revoke switch every time.
   *
   * The switch is not a preference that should persist across boards: somebody
   * who deliberately kept one share does not thereby mean to keep the next one,
   * and a dialog that opened already opted out of revoking would be the quiet
   * half of a permission decision.
   */
  const openRemove = (target) => {
    setRemoveRevoke(true);
    setRemoveTarget(target);
  };

  const backToMembers = (
    <Button variant="secondary" icon={ArrowLeft} onClick={() => navigate('/members')}>
      Back to Members
    </Button>
  );

  const body = () => {
    if (!orgId) {
      return (
        <Panel>
          <EmptyState
            icon={LayoutGrid}
            title="No workspace selected"
            description="Pick a workspace from the rail, then open this person's executive view again."
          />
        </Panel>
      );
    }
    if (loading) {
      return (
        <Panel>
          <p
            className="font-body text-[13px]"
            style={{ color: 'var(--color-text-muted)' }}
          >
            Loading this executive view…
          </p>
        </Panel>
      );
    }
    if (loadError) {
      return (
        <Panel>
          <Notice tone="danger" icon={AlertTriangle} title="Could not load">
            {loadError}
          </Notice>
        </Panel>
      );
    }
    if (targetIsOwner) {
      return (
        <Panel>
          <Notice
            tone="warning"
            icon={AlertTriangle}
            title="The workspace owner cannot have an executive view."
          >
            An owner holds every permission unconditionally, on every board, so a
            curated list could not curate anything. Transfer ownership first if
            this is really what you want.
          </Notice>
        </Panel>
      );
    }
    if (!profile) {
      return (
        <Panel>
          <EmptyState
            icon={LayoutDashboard}
            title="No executive view yet"
            description={`${targetName} does not have one. Use “Make executive” on the Members page — it assigns the role and creates the view in one step.`}
            actionLabel="Back to Members"
            onAction={() => navigate('/members')}
          />
        </Panel>
      );
    }

    /* ------------------------------- Step 1 ------------------------------ */
    if (step === 'role') {
      return (
        <Panel>
          <StepHead
            title="Role"
            blurb="What this person's role lets them reach, before any of the boards below. Roles are changed on the Members page, not here."
          />

          <div
            className="flex items-center gap-3 flex-wrap"
            style={{
              padding: '12px 14px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-bg-subtle)',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 10,
                height: 10,
                borderRadius: 9999,
                background: role?.color || 'var(--color-text-muted)',
                flexShrink: 0,
              }}
            />
            <span
              className="font-body font-semibold text-[14px]"
              style={{ color: 'var(--color-text-primary)' }}
            >
              {role?.name || 'No role resolved'}
            </span>
            <span
              className="font-body text-[12.5px]"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {targetName}'s role in {currentOrg?.name}
            </span>
          </div>

          <div className="mt-4">
            {holdsViewPublic === true && (
              <Notice
                tone="warning"
                icon={AlertTriangle}
                title="This role can still see every public board."
              >
                <p>
                  It holds <strong>“See the organisation's public boards at
                  all”</strong>, so the list you build below will not be the
                  whole list — {targetName} will see it <em>plus</em> every
                  public board in {currentOrg?.name}. Everything on this page
                  will appear to work and their screen will barely change.
                </p>
                <p className="mt-2">
                  Two ways out. Move them to a role that does not hold it, from
                  the{' '}
                  <Link
                    to="/members"
                    style={{ textDecoration: 'underline', color: 'inherit' }}
                  >
                    Members page
                  </Link>
                  . Or take the permission off this role in Settings →
                  Permissions — which changes it for everybody else holding the
                  same role, so the first is usually the one you want.
                </p>
              </Notice>
            )}

            {holdsViewPublic === false && (
              <Notice
                tone="success"
                icon={Check}
                title="Public boards are not theirs automatically."
              >
                Their board list is exactly what you give them below, and that is
                a fact about reach rather than a filter on a screen: a board they
                have no share of never leaves the server — not to their board
                list, not to My Work, not to a notification.
              </Notice>
            )}

            {holdsViewPublic === null && (
              <Notice tone="info" icon={AlertTriangle} title="Role not checked.">
                The workspace's permission matrix could not be read, so this page
                cannot tell you whether {role?.name || 'this role'} still sees
                public boards. Everything else on this page still works; reload
                to try the check again.
              </Notice>
            )}
          </div>

          <p
            className="mt-4 font-body text-[12.5px]"
            style={{ color: 'var(--color-text-muted)' }}
          >
            An executive view never grants anything by itself. Reach is this role
            plus the shares written on the Boards step — which is what makes the
            rest of this page safe to hand to the person it describes.
          </p>
        </Panel>
      );
    }

    /* ------------------------------- Step 2 ------------------------------ */
    if (step === 'boards') {
      // What pressing Add will ACTUALLY write on the board that is picked. The
      // button and the paragraph under it both read this rather than stating
      // the spec's default, because on a board this admin did not create the
      // default is not the thing that gets written — see `canGiveFullAccess`.
      const addFullAccess = !!addPick && canGiveFullAccess(addPick);
      return (
        <Panel>
          <StepHead
            title="Boards"
            blurb={`The boards ${targetName} can open, in the order they will see them. Adding one shares that board with them straight away; nicknames and tab presets are saved with the button above.`}
          />

          {skipped.length > 0 && (
            <div className="mb-4">
              <Notice
                tone="warning"
                icon={AlertTriangle}
                title={`${skipped.length} ${
                  skipped.length === 1 ? 'board is' : 'boards are'
                } on this list that ${targetName} cannot open.`}
              >
                <ul className="mt-1 space-y-2">
                  {skipped.map((s) => (
                    <li key={idOf(s.board)}>
                      <span style={{ fontWeight: 600 }}>
                        {s.name || 'An unnamed board'}
                      </span>{' '}
                      — {SKIP_COPY[s.reason] || 'It could not be resolved.'}
                      <button
                        type="button"
                        onClick={() =>
                          openRemove({
                            board: idOf(s.board),
                            name: s.name || 'That board',
                            // The dialog still asks about revoking even here:
                            // "cannot open it" is not "holds no share" — a
                            // downgrade to a rung their role cannot use looks
                            // identical from the outside, and the leftover row
                            // is worth tidying.
                            note:
                              s.reason === 'deleted'
                                ? 'This board has been deleted, so there is almost certainly nothing left to revoke. The entry comes off the list either way.'
                                : `${targetName} cannot open this board today. Revoking still clears whatever share of it is left behind.`,
                          })
                        }
                        className="ml-1 underline"
                        style={{ color: 'inherit', fontWeight: 600 }}
                      >
                        Take it off the list
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="mt-2" style={{ opacity: 0.9 }}>
                  They keep their place on the list when you save. What cannot be
                  read back while a board is unreachable is its nickname and its
                  tab presets — so the next save that changes any board on this
                  list resets those two, and it comes back under the board's own
                  name with its usual tabs. Restoring access first keeps them.
                </p>
              </Notice>
            </div>
          )}

          {/* Everything on this step that is not the profile itself is drawn
              from the CALLER's own board list — the access levels, the picker,
              the count of boards they cannot share. When that read failed the
              step would otherwise assert all three as facts about this admin's
              reach, which is the one thing it must not do silently. */}
          {boardsFailed && (
            <div className="mb-4">
              <Notice
                tone="danger"
                icon={AlertTriangle}
                title="Your own board list could not be loaded."
              >
                <p>
                  Access levels below read “unknown” and there is nothing to
                  add — none of which is a fact about {targetName} or about what
                  you can share. The list on this view is still correct.
                </p>
                <button
                  type="button"
                  onClick={refreshBoards}
                  className="mt-2 underline"
                  style={{ color: 'inherit', fontWeight: 600 }}
                >
                  Try loading it again
                </button>
              </Notice>
            </div>
          )}

          {boardError && (
            <div className="mb-4">
              <Notice tone="danger" icon={AlertTriangle}>
                {boardError}
              </Notice>
            </div>
          )}
          {boardNotice && !boardError && (
            <div className="mb-4">
              <Notice tone="info" icon={Check}>
                {boardNotice}
              </Notice>
            </div>
          )}

          {entries.length === 0 ? (
            <EmptyState
              icon={LayoutGrid}
              title="No boards yet"
              description={`${targetName} sees nothing until you add one. Pick a board below — each one you add is a real share of that board.`}
            />
          ) : (
            <>
              {/* Column headings for the two controls on the right, exactly as
                  the Share dialog labels them. Only from `lg`, where the row is
                  actually a row: below that the row stacks and each control
                  carries its own label instead. */}
              <div
                className="hidden lg:flex items-center justify-end gap-3"
                style={{ padding: '0 14px 6px' }}
                aria-hidden="true"
              >
                <ColumnHeading width={LEVEL_COL}>Access</ColumnHeading>
                <ColumnHeading width={FULL_COL} align="right">
                  Full access
                </ColumnHeading>
                {/* The Tabs disclosure and Remove both label themselves, so
                    these two columns are spacers rather than headings. */}
                <span style={{ width: TABS_COL }} />
                <span style={{ width: REMOVE_COL }} />
              </div>

              <ul
                className="flex flex-col"
                style={{
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                }}
              >
              {entries.map((entry, index) => {
                const board = boardsById.get(entry.board);
                const grant = grantFor(entry.board);
                // Only the board's creator may give or take FULL access — the
                // Share dialog's rule, which the executive route does not
                // re-apply. See `canGiveFullAccess`.
                const mayFull = canGiveFullAccess(entry.board);
                const busy = busyBoard === entry.board;
                const isLast = index === entries.length - 1;
                const name =
                  board?.name ||
                  entry.label ||
                  'A board you cannot open yourself';
                const presetOpen = openPresets.has(entry.board);
                const PresetChevron = presetOpen ? ChevronDown : ChevronRight;

                return (
                  <li
                    key={entry.board}
                    className="flex flex-col"
                    style={{
                      borderBottom: isLast
                        ? 'none'
                        : '1px solid var(--color-border)',
                      opacity: busy ? 0.6 : 1,
                    }}
                  >
                  <div
                    className="flex flex-col gap-3 lg:flex-row lg:items-center"
                    style={{ padding: '12px 14px' }}
                  >
                    <div className="min-w-0 flex-1">
                      <p
                        className="font-body font-semibold text-[13.5px] truncate"
                        style={{ color: 'var(--color-text-primary)' }}
                        title={name}
                      >
                        {name}
                      </p>
                      <p
                        className="font-body text-[12px] truncate"
                        style={{ color: 'var(--color-text-muted)' }}
                      >
                        {board
                          ? `${
                              board.visibility === 'public'
                                ? 'Public board'
                                : 'Private board'
                            }${board.boardType && board.boardType !== 'standard' ? ` · ${board.boardType}` : ''}`
                          : boardsFailed
                            ? // Never "you cannot open this board" when the
                              // truth is "we could not ask". The banner above
                              // carries the retry; this line only has to stop
                              // claiming something it does not know.
                              'Your board list did not load, so its access cannot be shown here.'
                            : 'This board is not on your own list, so its access cannot be shown here.'}
                      </p>
                    </div>

                    {/* Nickname. '' means "use the board's own name", which is
                        why the placeholder is the board's name rather than a
                        word like "Optional". */}
                    <input
                      type="text"
                      value={entry.label}
                      maxLength={60}
                      onChange={(e) => setLabel(entry.board, e.target.value)}
                      placeholder={board?.name || 'Board name'}
                      aria-label={`Nickname for ${name}`}
                      className="font-body"
                      style={{
                        width: 180,
                        maxWidth: '100%',
                        fontSize: 13,
                        padding: '6px 10px',
                        borderRadius: 'var(--radius-md)',
                        border: '1.5px solid var(--color-border)',
                        background: 'var(--color-bg-input)',
                        color: 'var(--color-text-primary)',
                      }}
                    />

                    <div className="flex items-center gap-3 shrink-0 flex-wrap">
                      {grant === undefined ? (
                        <span
                          className="font-body text-[12.5px]"
                          style={{
                            color: 'var(--color-text-muted)',
                            width: LEVEL_COL,
                          }}
                        >
                          Access unknown
                        </span>
                      ) : grant?.isBoardOwner ? (
                        <span
                          className="font-body text-[12.5px]"
                          style={{
                            color: 'var(--color-text-secondary)',
                            width: LEVEL_COL,
                          }}
                          title="They created this board. Board ownership is not a share and cannot be changed from here."
                        >
                          Owner of this board
                        </span>
                      ) : (
                        <select
                          value={grant?.level || ''}
                          disabled={busy}
                          onChange={(e) =>
                            writeBoard(entry.board, {
                              level: e.target.value,
                              // Dropping below `edit` takes full access with it:
                              // the flag means nothing for somebody who cannot
                              // edit, and the server clears it anyway.
                              canManage:
                                e.target.value === 'edit' &&
                                grant?.canManage === true,
                            })
                          }
                          aria-label={`Access level for ${name}`}
                          className="font-body"
                          style={{
                            width: LEVEL_COL,
                            fontSize: 13,
                            padding: '6px 10px',
                            borderRadius: 'var(--radius-md)',
                            border: '1.5px solid var(--color-border-strong)',
                            background: 'var(--color-bg-surface)',
                            color: 'var(--color-text-primary)',
                            cursor: busy ? 'wait' : 'pointer',
                          }}
                        >
                          {!grant?.level && (
                            <option value="" disabled>
                              No share
                            </option>
                          )}
                          {LEVELS.map((l) => (
                            <option key={l.value} value={l.value} title={l.hint}>
                              {l.label}
                            </option>
                          ))}
                        </select>
                      )}

                      <div
                        style={{ width: FULL_COL }}
                        className="flex items-center justify-end gap-2"
                        title={
                          grant?.isBoardOwner
                            ? 'They created this board, so they always have full access to it.'
                            : grant === undefined
                              ? 'This board is not on your own list, so its sharing cannot be changed from here.'
                              : mayFull
                                ? "Full access — they can also manage who this board is shared with. It is full power over the board's CONTENT plus its sharing; it does not include the board's lifecycle (deleting it, or changing whether it is public), which only its creator and the workspace owner hold."
                                : // The Share dialog says the same thing by
                                  // greying the same switch: full access is the
                                  // board CREATOR's to give, so that a delegate
                                  // cannot appoint peers on somebody else's
                                  // board. Owning the workspace does not make
                                  // you a board's creator.
                                  'Only the person who created this board can give or remove full access on it. You can still set the level beside this switch.'
                        }
                      >
                        {/* Below `lg` the row stacks and the heading strip above
                            the list is gone, so the switch says what it is. */}
                        <span
                          className="lg:hidden font-body text-[11px] uppercase tracking-wide"
                          style={{ color: 'var(--color-text-muted)' }}
                          aria-hidden="true"
                        >
                          Full
                        </span>
                        <Switch
                          checked={grant?.canManage === true}
                          disabled={
                            busy ||
                            grant === undefined ||
                            grant?.isBoardOwner === true ||
                            !mayFull
                          }
                          onChange={(next) =>
                            writeBoard(entry.board, {
                              // Full access implies edit, so switching it on
                              // promotes them in one step — the same move the
                              // Share dialog makes.
                              level: next ? 'edit' : grant?.level || 'edit',
                              canManage: next,
                            })
                          }
                          label={`Full access to ${name} for ${targetName}`}
                        />
                      </div>

                      {/* THE TAB PRESETS, FOLDED AWAY.
                          A dropdown, a mode switch and up to ten checkboxes per
                          board would turn this list into four screens of form,
                          and they are the rarest thing on it. Collapsed, the row
                          still SAYS what is set (`presetSummary` rides the title
                          and the accessible name), so nothing is hidden — only
                          folded — and the do-nothing default reads as one. */}
                      <button
                        type="button"
                        onClick={() => togglePreset(entry.board)}
                        aria-expanded={presetOpen}
                        aria-label={`Tabs for ${name} — ${presetSummary(entry, board)}`}
                        title={presetSummary(entry, board)}
                        style={{ width: TABS_COL }}
                        className="inline-flex items-center justify-end gap-1 font-body font-semibold text-[12px] text-[color:var(--color-text-secondary)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)] rounded"
                      >
                        <PresetChevron size={14} aria-hidden="true" />
                        Tabs
                      </button>

                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          openRemove({
                            board: entry.board,
                            name,
                            // A board that is not on the CALLER's own list is a
                            // board they may not be able to share, and the
                            // server refuses the revoke on its own in that case
                            // while still taking the entry off.
                            note: board
                              ? null
                              : 'This board is not on your own list, so you may not be able to revoke the share. The entry comes off the list either way, and the server says afterwards what it was actually able to do.',
                          })
                        }
                        aria-label={`Remove ${name} from this executive view`}
                        style={{ width: REMOVE_COL }}
                        className="inline-flex items-center justify-end gap-1 font-body font-semibold text-[12px] text-[color:var(--color-status-stuck)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-status-stuck)] rounded"
                      >
                        <Trash2 size={14} aria-hidden="true" />
                        Remove
                      </button>
                    </div>
                  </div>

                  {presetOpen && (
                    <div style={{ padding: '0 14px 14px' }}>
                      <BoardPresetFields
                        board={board}
                        entry={entry}
                        boardName={name}
                        // The grant controls on this row are mid-write; the
                        // presets are local until Save and have nothing to do
                        // with that request, but a half-greyed row that still
                        // accepted clicks would read as a bug rather than as a
                        // distinction.
                        disabled={busy || saving}
                        onChange={(preset) =>
                          setPreset(entry.board, board, preset)
                        }
                      />
                    </div>
                  )}
                  </li>
                );
              })}
              </ul>
            </>
          )}

          {/* ---- Add a board ------------------------------------------- */}
          <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1 min-w-0">
              <Dropdown
                label="Add a board"
                placeholder={
                  addable.length > 0
                    ? 'Choose a board…'
                    : boardsFailed
                      ? // "No more boards to add" is a claim about this admin's
                        // reach. With the board list unread it is not one this
                        // page is in a position to make.
                        'Your board list did not load'
                      : 'No more boards to add'
                }
                disabled={addable.length === 0 || !!busyBoard}
                value={addPick}
                onChange={setAddPick}
                options={addable.map((b) => ({
                  value: idOf(b._id),
                  label: b.name,
                }))}
              />
            </div>
            <Button
              icon={Plus}
              onClick={handleAdd}
              disabled={!addPick || !!busyBoard}
            >
              {busyBoard
                ? 'Sharing…'
                : addFullAccess
                  ? 'Add with full access'
                  : // Not a downgrade of the default so much as the truth about
                    // what this caller may write on a board somebody else made.
                    'Add with edit access'}
            </Button>
          </div>

          <p
            className="mt-2 font-body text-[12.5px]"
            style={{ color: 'var(--color-text-muted)' }}
          >
            Added boards start at <strong>Can edit</strong> — an executive is as
            capable as an admin on the boards they are actually given. Lower it
            per board on the row above.{' '}
            <strong>Full access</strong> comes with it only on boards{' '}
            <em>you</em> created: giving somebody the right to re-share a board
            is its creator's decision, and the board's own share dialog refuses
            it to everybody else for the same reason.
            {unshareable > 0 && (
              <>
                {' '}
                {unshareable}{' '}
                {unshareable === 1 ? 'board is' : 'boards are'} missing from
                this list because you cannot manage their sharing; you can only
                give away access you could give from the board's own share
                dialog.
              </>
            )}
            {ownedByTarget > 0 && (
              <>
                {' '}
                {ownedByTarget}{' '}
                {ownedByTarget === 1 ? 'board is' : 'boards are'} missing
                because {targetName} created{' '}
                {ownedByTarget === 1 ? 'it' : 'them'}: adding a board here
                writes a share of it, and there is no share to write for
                somebody who already owns the board outright.{' '}
                {ownedByTarget === 1 ? 'It' : 'They'} will still appear under
                “Other boards” on their own screen.
              </>
            )}
          </p>
        </Panel>
      );
    }

    /* ------------------------------- Step 3 ------------------------------ */
    if (step === 'home') {
      return (
        <>
          {/* Outside a `Panel`, unlike the other steps: `SectionEditor` brings
              its own card, and a card inside a card is a border nobody asked
              for. `StepHead` already carries the gap underneath it. */}
          <StepHead
            title="Home"
            blurb={`What ${targetName} lands on instead of the dashboard. Add the sections they need, drag them into order, and set how wide each one is.`}
          />

          {/* THE SAME EDITOR THE EXECUTIVE USES ON THEIR OWN HOME PAGE, and
              deliberately so: one component, one set of rules about what a
              width means, what a removal does to `order`, and which boards a
              picker may offer. Two copies would disagree eventually, and the
              disagreement would only show on one of the two screens.

              Its Save writes the WHOLE shape through the admin PUT (see
              `persist`), because that endpoint replaces the document and there
              is no such thing as saving only the home half. So a label typed on
              the Boards step is saved by pressing Save here too — which the
              receipt at the top then reports, rather than leaving somebody to
              wonder. */}
          <SectionEditor
            /**
             * KEYED ON A RE-SEED COUNTER, so a save through THIS editor re-seeds
             * it from what the server actually stored — and nothing else does.
             *
             * Why it needs re-seeding at all: the editor holds a DRAFT and only
             * adopts a new `home` prop while that draft is clean — which it is
             * not at the moment `persist` reloads the profile, mid-save. So
             * without a remount the editor would keep rendering the list it
             * just sent, and a section added here would carry no `_id` (the
             * server mints one on the way in) for the rest of the session.
             * Nothing breaks — the PUT replaces the whole array, so there is no
             * duplicate to make — but the section's identity would churn on
             * every subsequent save, and the editor would be showing a list
             * that is equal to the stored one rather than the stored one.
             *
             * ---- WHY THIS IS NOT `profile.updatedAt` ------------------------
             *
             * It used to be, and that was a silent data-loss bug. `updatedAt`
             * moves on EVERY write, including ones that have nothing to do with
             * this draft: an admin who types a nickname on the Boards step,
             * walks to the Home step, builds five sections, and then presses the
             * HEADER "Save changes" (which sends the STORED home, because the
             * draft lives inside the editor and `dirty` cannot see it) would
             * have watched the reload bump `updatedAt`, remount this editor,
             * and wipe five sections — under a green "Saved." receipt, with no
             * "Unsaved changes" line left to notice, and no way back.
             *
             * A counter that advances only when `persist` was given a `home`
             * override cannot do that. A header save now leaves the draft
             * exactly where it was: the editor keeps its work (a dirty draft
             * never adopts a prop), still says "Unsaved changes", and its own
             * Save is still the thing that commits it. A re-read that FAILED
             * does not advance it either — reseeding from a stale profile would
             * put the pre-save list back on screen.
             */
            key={`home-${homeSeed}`}
            home={profile.home || []}
            boards={homeBoards}
            registry={SECTION_REGISTRY}
            onChange={(next) => persist({ home: next })}
            saving={saving}
            title={`${targetName}'s home`}
            description="Sections render read-only for them, with a link into the board behind each one."
          />

          {entries.length === 0 && (
            <p
              className="mt-3 font-body text-[12.5px]"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {/* Said here rather than inside the editor: the editor has no idea
                  whose view it is editing or where boards come from, and this is
                  a fact about THIS view. */}
              Sections that read a board have nothing to point at yet — add
              boards on the Boards step first, and they become the options here.
            </p>
          )}
        </>
      );
    }

    /* ------------------------------- Step 4 ------------------------------ */
    if (step === 'nav') {
      return (
        <Panel>
          <StepHead
            title="Navigation"
            blurb={`Which destinations ${targetName} keeps in the rail. All on by default — turning one off is a tidier screen, never a permission.`}
          />

          <ul
            className="flex flex-col"
            style={{
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            {NAV_ENTRIES.map((entry, index) => (
              <li
                key={entry.key}
                className="flex items-center justify-between gap-4"
                style={{
                  padding: '10px 14px',
                  borderBottom:
                    index === NAV_ENTRIES.length - 1
                      ? 'none'
                      : '1px solid var(--color-border)',
                }}
              >
                <div className="min-w-0">
                  <p
                    className="font-body font-semibold text-[13.5px]"
                    style={{ color: 'var(--color-text-primary)' }}
                  >
                    {entry.label}
                  </p>
                  <p
                    className="font-body text-[12px]"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {entry.hint}
                  </p>
                </div>
                <Switch
                  checked={nav[entry.key] !== false}
                  onChange={(next) =>
                    setNav((n) => ({ ...n, [entry.key]: next }))
                  }
                  label={`${entry.label} in ${targetName}'s rail`}
                />
              </li>
            ))}
          </ul>

          <p
            className="mt-3 font-body text-[12.5px]"
            style={{ color: 'var(--color-text-muted)' }}
          >
            A switch can only hide something their role already allows — it can
            never reveal one. Members, Analytics and Productivity each need a
            capability as well, so leaving those on does nothing for somebody
            whose role does not hold it. Home and Settings have no switch: they
            are how a person gets back to everything else.
          </p>

          {/* The last setup step points at the one that checks it — the
              preview is otherwise easy to miss at the bottom of the rail. */}
          <div
            className="mt-4 pt-3 flex items-center justify-between gap-3 flex-wrap"
            style={{ borderTop: '1px solid var(--color-border)' }}
          >
            <span
              className="font-body text-[12.5px]"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              Done setting up? See the screen {targetName} will get.
            </span>
            <Button
              size="sm"
              variant="secondary"
              icon={Eye}
              onClick={() => setStep('preview')}
            >
              Preview their screen
            </Button>
          </div>
        </Panel>
      );
    }

    /* ------------------------------- Step 5 ------------------------------ */
    /**
     * PREVIEW — the only step that reads instead of writing.
     *
     * Outside a `Panel` like the Home step, because `PreviewFrame` draws its own
     * framed surface and a card around a picture of an app is two borders saying
     * the same thing.
     *
     * Everything below is the SERVER's answer, composed as the target. This
     * page contributes the person's name and nothing else — no filtering, no
     * fallback assembled out of the boards the admin happens to have loaded. See
     * `loadPreview`.
     */
    return (
      <>
        <StepHead
          title="Preview"
          blurb={`The home page and the rail as ${targetName} will see them. Read-only — nothing in the frame navigates or acts.`}
        />

        {/* UNSAVED WORK IS NOT IN THE PICTURE, and saying so is the difference
            between a preview and a trap. The frame shows the stored document;
            a nickname typed on the Boards step and not yet saved is not part of
            anybody's screen, and an admin who read the preview as confirmation
            would walk away having checked the wrong thing. */}
        {dirty && (
          <div className="mb-4">
            <Notice
              tone="warning"
              icon={AlertTriangle}
              title="You have unsaved changes."
            >
              This shows what is <strong>saved</strong>. Press “Save changes” at
              the top and the preview redraws itself.
            </Notice>
          </div>
        )}

        {previewError && (
          <div className="mb-4">
            <Notice tone="danger" icon={AlertTriangle} title="Could not preview">
              <p>{previewError}</p>
              <div className="mt-2">
                <Button size="sm" variant="secondary" onClick={loadPreview}>
                  Try again
                </Button>
              </div>
            </Notice>
          </div>
        )}

        {/* The FIRST load gets a placeholder; a refresh keeps the picture that
            is already there rather than flashing a grey box over it. The
            composer runs a scorer per section, so this is a wait somebody can
            notice — and a preview that blanks on every save is one an admin
            stops trusting to be about the thing they just did. */}
        {previewLoading && !preview ? (
          <div
            role="status"
            aria-live="polite"
            className="bg-surface"
            style={{
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-lg)',
              padding: '48px 24px',
              textAlign: 'center',
            }}
          >
            <p
              className="font-body text-[13px]"
              style={{ color: 'var(--color-text-muted)' }}
            >
              Composing {targetName}'s home page…
            </p>
          </div>
        ) : preview ? (
          <>
            <PreviewFrame
              name={targetName}
              sections={preview.sections || []}
              skipped={preview.skipped || []}
              nav={preview.nav || null}
              // THE TARGET'S capabilities, shipped by the endpoint that resolved
              // them — the same `{ role, isOwner, capabilities }` shape
              // `GET /api/orgs/:id` already answers with for the caller. Never
              // `usePermissions()`, which is the admin standing here: a rail
              // drawn from that would show an owner every row there is, on a
              // screen whose only job is to show what somebody ELSE gets.
              capabilities={preview.permissions?.capabilities || []}
              boardCount={(preview.profile?.boards || []).length}
            />

            <div className="mt-4 flex items-center gap-3 flex-wrap">
              <Button
                size="sm"
                variant="secondary"
                onClick={loadPreview}
                disabled={previewLoading}
              >
                {previewLoading ? 'Refreshing…' : 'Refresh'}
              </Button>
              <span
                className="font-body text-[12px]"
                style={{ color: 'var(--color-text-muted)' }}
              >
                Composed once when you opened this step, and again after every
                save.
              </span>
            </div>
          </>
        ) : null}
      </>
    );
  };

  return (
    <PageWrapper>
      <div className="mx-auto" style={{ maxWidth: 1000 }}>
        {/* Breadcrumb — the way back, and the way this page says whose screen
            it is describing. Matches the board page's treatment. */}
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1.5 font-body"
          style={{ fontSize: 13 }}
        >
          <Link
            to="/members"
            className="transition-colors duration-150 hover:text-[color:var(--color-accent)]"
            style={{ color: 'var(--color-text-muted)' }}
          >
            Members
          </Link>
          <ChevronRight size={14} color="var(--color-text-muted)" aria-hidden="true" />
          <span
            className="truncate"
            style={{ fontWeight: 500, color: 'var(--color-text-primary)' }}
          >
            {targetName}
          </span>
        </nav>

        <header className="mt-4 mb-6 flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h1
              className="font-display font-bold text-[color:var(--color-text-primary)] text-[22px] md:text-[28px]"
              style={{ letterSpacing: '-0.01em' }}
            >
              Executive view
            </h1>
            <p className="mt-1 font-body text-sm text-[color:var(--color-text-secondary)]">
              {targetName}
              {target?.email ? ` · ${target.email}` : ''}
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {backToMembers}
            {step !== 'preview' && profile && !targetIsOwner && (
              <Button
                variant="secondary"
                icon={Eye}
                onClick={() => setStep('preview')}
              >
                Preview as {targetName.split(/[\s@]/)[0]}
              </Button>
            )}
            <Button
              onClick={handleSave}
              disabled={saving || loading || !profile || targetIsOwner || !dirty}
            >
              {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
            </Button>
          </div>
        </header>

        {saveError && (
          <div className="mb-4">
            <Notice tone="danger" icon={AlertTriangle} title="Not saved">
              {saveError}
            </Notice>
          </div>
        )}

        {/* SAVED, BUT NOT RE-READ. A warning rather than a danger, because the
            write landed — what failed is this page's attempt to look at the
            result, and the difference matters: "Not saved" would send an admin
            away believing they had changed nothing. */}
        {saveNotice && !saveError && (
          <div className="mb-4">
            <Notice tone="warning" icon={AlertTriangle} title="Saved, not refreshed">
              {saveNotice}
            </Notice>
          </div>
        )}

        {/* THE SAVE RECEIPT — what the server stored, read off its answer.
            A page that says "Saved!" is reporting that a request returned 200. A
            page that says what is now on the document is reporting the thing the
            admin actually wanted to know, and it is the only way a silently
            dropped board entry would ever be noticed. */}
        {receipt && !saveError && !dirty && (
          <div className="mb-4">
            <Notice tone="success" icon={Check} title="Saved.">
              <p>
                {receipt.boards}{' '}
                {receipt.boards === 1 ? 'board' : 'boards'} on their list ·{' '}
                {receipt.on.length} of {NAV_ENTRIES.length} rail destinations on
                · {receipt.home}{' '}
                {receipt.home === 1 ? 'home section' : 'home sections'}.
              </p>
              {receipt.off.length > 0 && (
                <p className="mt-1">
                  Hidden from their rail: {receipt.off.join(', ')}.
                </p>
              )}
              {receipt.dropped.length > 0 && (
                <p className="mt-1">
                  {receipt.dropped.length}{' '}
                  {receipt.dropped.length === 1 ? 'entry was' : 'entries were'}{' '}
                  not kept — the server would not store{' '}
                  {receipt.dropped.length === 1 ? 'it' : 'them'}.
                </p>
              )}
              {step !== 'preview' && (
                <p className="mt-1.5">
                  <button
                    type="button"
                    onClick={() => setStep('preview')}
                    className="font-body font-semibold underline-offset-2 hover:underline"
                    style={{
                      color: 'var(--color-accent)',
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                    }}
                  >
                    See what {targetName} sees →
                  </button>
                </p>
              )}
            </Notice>
          </div>
        )}

        <div className="flex flex-col gap-5 md:flex-row md:items-start">
          {/* Step rail. A row that scrolls on a phone, a column beside the
              content from `md` up — the same shape the site setup wizard uses,
              at page scale. */}
          <ol
            className="flex md:flex-col gap-1 shrink-0 overflow-x-auto md:overflow-visible md:w-[196px] pb-1 md:pb-0"
            aria-label="Configuration steps"
          >
            {STEPS.map((entry) => {
              const current = entry.key === step;
              const Icon = entry.icon;
              return (
                <li key={entry.key} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => setStep(entry.key)}
                    aria-current={current ? 'step' : undefined}
                    className="flex items-center gap-2 w-full text-left font-body whitespace-nowrap focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
                    style={{
                      padding: '8px 10px',
                      borderRadius: 'var(--radius-md)',
                      border: 'none',
                      background: current
                        ? 'var(--color-bg-subtle)'
                        : 'transparent',
                      color: current
                        ? 'var(--color-text-primary)'
                        : 'var(--color-text-secondary)',
                      fontSize: 12.5,
                      fontWeight: current ? 600 : 400,
                      cursor: 'pointer',
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className="inline-flex items-center justify-center shrink-0"
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: 999,
                        background: current
                          ? 'var(--color-bg-surface)'
                          : 'transparent',
                        border: `1px solid ${
                          current ? 'var(--color-accent)' : 'var(--color-border)'
                        }`,
                        color: current
                          ? 'var(--color-accent)'
                          : 'var(--color-text-muted)',
                      }}
                    >
                      <Icon size={11} />
                    </span>
                    {entry.label}
                    {/* A board on the list that this person cannot open is the
                        exact thing this screen exists to surface (invariant 4),
                        and the banner that explains it lives inside one step.
                        The count rides the rail so the problem is visible from
                        wherever the admin happens to be standing. */}
                    {entry.key === 'boards' && skipped.length > 0 && (
                      <span
                        className="font-body ml-auto inline-flex items-center justify-center"
                        title={`${skipped.length} ${
                          skipped.length === 1 ? 'board' : 'boards'
                        } on this list cannot be opened by ${targetName}`}
                        style={{
                          minWidth: 18,
                          height: 18,
                          padding: '0 5px',
                          borderRadius: 9999,
                          fontSize: 10.5,
                          fontWeight: 700,
                          background: 'var(--color-status-stuck-bg)',
                          color: 'var(--color-status-stuck)',
                        }}
                      >
                        {skipped.length}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>

          <div className="flex-1 min-w-0">{body()}</div>
        </div>

        {/* Remove a board — and the question that has to be asked with it.
            REVOKE IS THE DEFAULT: taking a board off somebody's curated list
            normally means they should not be able to open it any more, and the
            two failure modes are not symmetric. A share left behind by accident
            is silent; a share revoked by accident is one click to undo from the
            board's own dialog. */}
        <Modal
          isOpen={!!removeTarget}
          onClose={() => (removing ? null : setRemoveTarget(null))}
          title="Remove board"
          maxWidth={520}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setRemoveTarget(null)}
                disabled={removing}
              >
                Cancel
              </Button>
              <Button variant="danger" onClick={handleRemove} disabled={removing}>
                {removing ? 'Removing…' : 'Remove'}
              </Button>
            </>
          }
        >
          <p className="font-body text-[14px] text-[color:var(--color-text-primary)]">
            Take <strong>{removeTarget?.name}</strong> off {targetName}'s
            executive view?
          </p>

          {removeTarget?.note ? (
            <p
              className="font-body text-[13px] mt-3"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {removeTarget.note}
            </p>
          ) : null}

          <div
            className="flex items-start justify-between gap-4 mt-4"
            style={{
              padding: '12px 14px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-bg-subtle)',
            }}
          >
            <div className="min-w-0">
              <p
                className="font-body font-semibold text-[13.5px]"
                style={{ color: 'var(--color-text-primary)' }}
              >
                Also revoke access
              </p>
              <p
                className="font-body text-[12.5px] mt-0.5"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                {removeRevoke
                  ? `On — ${targetName} will no longer be able to open this board at all.`
                  : `Off — the board just leaves the list. ${targetName} keeps whatever access they have and can still open it.`}
              </p>
            </div>
            <Switch
              checked={removeRevoke}
              disabled={removing}
              onChange={setRemoveRevoke}
              label="Also revoke access to this board"
            />
          </div>

          <p
            className="font-body text-[12.5px] mt-3"
            style={{ color: 'var(--color-text-muted)' }}
          >
            Revoking also drops the follows and notifications they had on this
            board. It does not unassign their tasks — those stay where they are.
          </p>
        </Modal>
      </div>
    </PageWrapper>
  );
};

export default ExecutiveViewConfigPage;
