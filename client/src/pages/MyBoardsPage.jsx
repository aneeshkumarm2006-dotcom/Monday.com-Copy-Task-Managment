import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  Search,
  LayoutGrid,
  List as ListIcon,
  Folder,
  FolderOpen,
  Lock,
  Globe,
  MoreHorizontal,
  Calendar as CalendarIcon,
  GripVertical,
} from 'lucide-react';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import PageWrapper from '../components/layout/PageWrapper';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import {
  SkeletonBoardCard,
  SkeletonBoardListRow,
} from '../components/ui/Skeleton';
import BoardCard from '../components/board/BoardCard';
import BoardFormModal from '../components/board/BoardFormModal';
import DeleteBoardModal from '../components/board/DeleteBoardModal';
import BoardFilterPanel from '../components/board/BoardFilterPanel';
import SortableItem from '../components/dnd/SortableItem';
import useOrgStore from '../store/orgStore';
import useBoardStore from '../store/boardStore';
import useToastStore from '../store/toastStore';
import useExecutiveViewStore, {
  selectIsExecutive,
} from '../store/executiveViewStore';
import usePermissions from '../hooks/usePermissions';
import { convertBoard } from '../services/monthService';
import { timeAgo } from '../utils/dateUtils';
import {
  EMPTY_BOARD_FILTERS,
  boardMatchesFilters,
  countActiveBoardFilters,
} from '../utils/boardFilters';
import {
  orderBoardsForProfile,
  displayName,
  boardIdOf,
  labelsByBoardId,
} from '../utils/executiveBoards';

/**
 * Rotating palette for the top accent bar on each card.
 * Matches the stat-card palette from Design doc Section 2.
 */
const ACCENT_CYCLE = [
  'var(--color-card-blue)',
  'var(--color-card-green)',
  'var(--color-card-orange)',
  'var(--color-card-purple)',
];

/**
 * localStorage key for the "Detailed view" preference — whether each board card
 * shows its completion percentage bar. Defaults ON (absent key ⇒ true); only an
 * explicit '0' turns it off, so the bar shows until the user hides it.
 */
const DETAILED_VIEW_KEY = 'myBoards:detailedView';

/**
 * The label map for somebody who has no executive view: empty, and the SAME
 * empty map every time. A `new Map()` built per render would be a new identity
 * per render, which re-runs the search memo that depends on it on every keystroke
 * anywhere on the page — for the people who have no labels at all.
 */
const NO_LABELS = new Map();

const readDetailedView = () => {
  try {
    return localStorage.getItem(DETAILED_VIEW_KEY) !== '0';
  } catch {
    return true;
  }
};

const MyBoardsPage = () => {
  const navigate = useNavigate();
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const boards = useBoardStore((s) => s.boards);
  const loading = useBoardStore((s) => s.loading);
  const fetchBoards = useBoardStore((s) => s.fetchBoards);
  const toastSuccess = useToastStore((s) => s.success);
  const toastError = useToastStore((s) => s.error);
  const createBoardAction = useBoardStore((s) => s.createBoard);
  const updateBoardAction = useBoardStore((s) => s.updateBoard);
  const deleteBoardAction = useBoardStore((s) => s.deleteBoard);
  const reorderBoardsAction = useBoardStore((s) => s.reorderBoards);

  /**
   * The executive view, if this person has one.
   *
   * `isExecutive` comes from the store's own `selectIsExecutive` rather than
   * from a `!!execProfile` written here: "a profile exists" is the definition of
   * being an Executive, it is answered in one expression in the store, and a
   * second copy of it in a page is how two screens end up disagreeing about who
   * one person is. With no profile every executive line below is inert and this
   * page renders exactly as it always has — same DOM, same handlers, same order.
   */
  const execProfile = useExecutiveViewStore((s) => s.profile);
  const saveMine = useExecutiveViewStore((s) => s.saveMine);
  const isExecutive = useExecutiveViewStore(selectIsExecutive);
  // The two fields that say whether `isExecutive` is an ANSWER or just the
  // absence of one yet. Read here for the same reason `DashboardRoute` reads
  // them in App.jsx — see `execUndecided` below, where the cost of guessing is
  // a write to every member of the workspace's board list.
  const execLoading = useExecutiveViewStore((s) => s.loading);
  const execLoadedForOrg = useExecutiveViewStore((s) => s.loadedForOrg);

  const { can } = usePermissions();
  const canCreateBoard = can('board.create');

  /**
   * Whether the ⋯ menu (Edit / Delete) shows for a board.
   *
   * `GET /api/boards` ships each board's RESOLVED permissions — the two-layer AND
   * already applied — so this just reads the answer. It used to reconstruct the
   * board half locally ("did I make it, or is it public and do I manage public
   * boards"), which quietly missed a member holding an explicit edit grant on
   * someone else's private board: they could rename it, but the menu never
   * appeared. That is exactly the drift a second implementation invites.
   */
  const canManageBoard = useCallback(
    (board) => (board?.permissions?.capabilities || []).includes('board.rename'),
    []
  );

  const [view, setView] = useState('grid'); // "grid" | "list"
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState(EMPTY_BOARD_FILTERS);
  const [detailedView, setDetailedView] = useState(readDetailedView);
  const [createOpen, setCreateOpen] = useState(false);

  // Flip the "Detailed view" preference and persist it.
  const toggleDetailedView = () =>
    setDetailedView((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(DETAILED_VIEW_KEY, next ? '1' : '0');
      } catch {
        /* ignore storage failures (private mode, quota) */
      }
      return next;
    });
  const [editTarget, setEditTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  // The profile board entries a drag has just written, held here until the save
  // settles. This is the optimistic half of the optimistic-then-revert that the
  // workspace-wide reorder does inside `boardStore` — the executive save writes
  // a different document, so the buffer lives here instead.
  const [execOrder, setExecOrder] = useState(null);

  /**
   * Which drag owns that buffer, and the queue its saves go through.
   *
   * `execOrder` is a SINGLE optimistic slot, so two drags in quick succession
   * need both of these or the second one appears to undo itself:
   *
   *  - THE TICKET says whose order is on screen. Without it the first save's
   *    `.finally` puts the buffer down while the second drag is still unsaved,
   *    and the list snaps back to the first order in front of the person who
   *    just made the second one.
   *  - THE QUEUE says the saves reach the server in the order they were made.
   *    `PUT /api/me/executive-view` REPLACES the document, and `saveMine`
   *    writes whatever comes back into the store, so two in flight at once can
   *    cross: the slower FIRST response lands last, and the store — and the
   *    screen, once the buffer clears — ends up showing an order the server
   *    does not have, with nothing to re-fetch it until the org or the user
   *    changes. A chain is enough because each body is the WHOLE list rather
   *    than a delta: the last one queued is the whole truth, even if an earlier
   *    one failed.
   *
   * Refs, not state: neither is rendered, and both are read inside a callback
   * that must see the newest value rather than the one its closure captured.
   * `executiveViewStore`'s own `fetchTicket` is the same device for the same
   * class of bug on the read side.
   */
  const dragTicket = useRef(0);
  const saveQueue = useRef(Promise.resolve());

  const orgId = currentOrg?._id || null;

  // Fetch boards whenever the current org changes
  useEffect(() => {
    if (!orgId) return;
    fetchBoards(orgId).catch((err) => {
      console.error('Failed to fetch boards:', err);
    });
  }, [orgId, fetchBoards]);

  const activeFilterCount = countActiveBoardFilters(filters);

  /**
   * The profile's labels by board id — an empty map for everybody else.
   *
   * The search below matches this AS WELL AS the board's real name. A label is
   * a nickname for finding a board in a list, so the case that matters is the
   * one where it shares nothing with the real name: a board called "Acme
   * Digital — 2026" that this person's profile calls "Q4 Retainer". They read
   * the card, type "Q4", and a name-only filter answers "Nothing found" about a
   * card that was on screen one keystroke earlier. The real name still matches
   * too — it is what everybody else calls the board, and it is what they will
   * be told to look for.
   *
   * `execProfile`, not `execProfileNow`: a drag reorders entries and never
   * renames one, so labels do not move while a save is in flight, and the
   * search must not re-run every time the order does.
   */
  const execLabels = useMemo(
    () => (isExecutive ? labelsByBoardId(execProfile) : NO_LABELS),
    [isExecutive, execProfile]
  );

  // Client-side search (Task 7.8) + Filter popup categories. A board must pass
  // the name search AND every active filter category.
  const filteredBoards = useMemo(() => {
    const q = search.trim().toLowerCase();
    return boards.filter((b) => {
      if (q) {
        // The board's own name, or the name THIS person sees on the card. The
        // label map is empty unless they are an Executive, so for everybody
        // else this stays the single `name` test it has always been.
        const name = (b.name || '').toLowerCase();
        const label = (execLabels.get(String(b._id)) || '').toLowerCase();
        if (!name.includes(q) && !label.includes(q)) return false;
      }
      return boardMatchesFilters(b, filters);
    });
  }, [boards, search, filters, execLabels]);

  const handleCreateSubmit = async (values) => {
    await createBoardAction({
      name: values.name,
      visibility: values.visibility,
      description: values.description,
      // Client Portal boards: boardType 'client'.
      // Tracker boards: boardType 'tracker' + the browser's resolved timezone,
      // which the server requires and validates.
      boardType: values.boardType || 'standard',
      monthTimezone: values.monthTimezone,
      // Client boards only, and a LABEL only — what the client sees at the top
      // of their portal. No contact is invited here and no link is minted: the
      // first SERVICE added to the board does both, because a portal with no
      // services opens on an empty page. See server/src/utils/portalActivation.js.
      clientName: values.clientName,
      // Which template seeds the columns, statuses and groups. THIS PAYLOAD IS
      // BUILT FIELD BY FIELD rather than spread, so anything the form adds and
      // this list does not name is silently dropped — which is exactly what
      // happened to `template` the first time: the picker worked, the value was
      // stored, and every board came out blank because it stopped here.
      template: values.template,
      organisation: orgId,
    });
    setCreateOpen(false);
  };

  const handleEditSubmit = async (values) => {
    if (!editTarget) return;

    // The plain fields first. `PUT /api/boards/:id` deliberately ignores
    // `boardType` — changing the type re-files every task, so it is a different
    // operation with its own endpoint and its own capability.
    //
    // `visibility` goes ONLY when it actually changed. The endpoint gates per
    // FIELD, and `board.change_visibility` is conferred by no rung of the access
    // ladder — so someone holding an `edit` grant on a board they did not create
    // has `board.rename` and not the other. Sending the unchanged current value
    // still counts as "this request carries visibility", which 403'd every
    // rename they attempted with an error about a field they had not touched.
    const patch = {
      name: values.name,
      description: values.description,
    };
    if (values.visibility !== editTarget.visibility) {
      patch.visibility = values.visibility;
    }
    await updateBoardAction(editTarget._id, patch);

    if (values.typeChanged) {
      const result = await convertBoard(editTarget._id, {
        to: values.boardType,
        timezone: values.monthTimezone,
      });
      // Board type drives the tabs, the month picker and the card's pill, so the
      // cache has to see the new shape.
      await fetchBoards(orgId);
      if (values.boardType === 'tracker') {
        toastSuccess(
          `“${values.name}” is now a tracker board — ${result?.filed?.tasks ?? 0} tasks filed by month.`
        );
      } else {
        toastSuccess(`“${values.name}” is back to a standard board. Nothing was deleted.`);
      }
    }

    setEditTarget(null);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    await deleteBoardAction(deleteTarget._id);
    setDeleteTarget(null);
  };

  const openBoard = (board) => navigate(`/boards/${board._id}`);

  const hasBoards = boards.length > 0;
  const hasResults = filteredBoards.length > 0;
  const searching = search.trim().length > 0;
  // The view is "narrowed" when either the name search or the Filter popup is
  // active — both hide boards, so both must gate reordering and drive the
  // "nothing found" state.
  const narrowed = searching || activeFilterCount > 0;

  /**
   * "We do not know yet whether this person is an Executive."
   *
   * `isExecutive` is `profile !== null`, so it reads FALSE for two different
   * people: somebody who is not an Executive, and an Executive whose profile
   * has not arrived yet. On this page those two answers pick different DRAG
   * HANDLERS, and one of them writes to every member of the workspace.
   *
   * The standard drag calls `reorderBoards`, which rewrites `Board.order` —
   * the workspace-wide number — for the whole org. Its server-side check is
   * only that the ids form a permutation of the boards THE CALLER can see, and
   * an Executive's visible set is exactly their curated handful (they hold no
   * `board.view_public`), so a four-card drag is accepted and those four boards
   * take orders 0-3 on everybody's screen. That is invariant 7 — nobody else's
   * screen changes — broken by a page that guessed while it was still loading.
   * The trap is written up in full in `utils/executiveBoards.js`.
   *
   * So the drag waits. This is the same undecided test `DashboardRoute` makes
   * in `App.jsx` before it picks a home page, for the same reason, and the two
   * want to stay in step: a fetch in flight, or a store still holding another
   * workspace's answer, is not an answer.
   *
   * It costs a non-executive nothing worth seeing. The grip handle is
   * `opacity-0` until the card is hovered, the profile is fetched once per
   * (person, workspace) from an App-level effect that runs while this page is
   * still drawing skeletons, and the alternative — let the drag run and
   * silently discard it — is the "handle that does nothing when pulled" this
   * file refuses everywhere else.
   *
   * WHAT THIS DOES NOT COVER, and why the fix is not in this file: the store
   * FAILS CLOSED, so a profile fetch that 500s resolves to `profile: null`
   * with `loadedForOrg` set, which reads here as decided-and-not-an-Executive
   * for the rest of the session. Closing that needs either an error flag on
   * `executiveViewStore` or — better, because it covers every caller rather
   * than this one screen — `reorderBoards` refusing a caller without
   * `board.view_public`, for whom "every visible board" is a curated subset
   * and not the workspace's list at all.
   */
  const execUndecided = !orgId || execLoading || execLoadedForOrg !== orgId;

  // Reordering is disabled while the list is narrowed so the user doesn't
  // accidentally rewrite the full order using a partial slice — and while the
  // executive profile is undecided, for the reason above. Both groups read
  // this: it is also what stops an executive drag being saved into the profile
  // of the workspace they just switched away from.
  const dndDisabled = narrowed || execUndecided;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleBoardDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id || dndDisabled || !orgId) return;
    const oldIndex = boards.findIndex((b) => b._id === active.id);
    const newIndex = boards.findIndex((b) => b._id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(boards, oldIndex, newIndex);
    const orderedIds = next.map((b) => b._id);
    reorderBoardsAction(orgId, orderedIds).catch((err) => {
      console.error('Failed to reorder boards:', err);
    });
  };

  const boardIds = useMemo(() => filteredBoards.map((b) => b._id), [filteredBoards]);

  // ---- Executive view: two groups, and a drag that writes the PROFILE ------

  /**
   * The profile as it should read right now: the store's copy, unless a drag is
   * in flight, in which case the order the person just made with their hands.
   */
  const execProfileNow = useMemo(
    () => (execOrder ? { ...execProfile, boards: execOrder } : execProfile),
    [execProfile, execOrder]
  );

  /**
   * The split into "their list" and "everything else they can read".
   *
   * It runs on `filteredBoards`, AFTER the search box and the filter popup: a
   * listed board the search hid stays hidden rather than being promoted into
   * "Other boards", and reordering is already disabled while the list is
   * narrowed, so a partial list can never be saved as the whole order.
   *
   * For everybody else this is `{ listed: [], other: filteredBoards }` with
   * `other` being the very same array — nothing is copied, and nothing on the
   * non-executive path reads either half.
   */
  const { listed: execListed, other: execOther } = useMemo(
    () => orderBoardsForProfile(filteredBoards, isExecutive ? execProfileNow : null),
    [filteredBoards, isExecutive, execProfileNow]
  );

  /**
   * The real board behind a card. The executive grid renders COPIES carrying
   * the profile's label in `name`, so anything that acts ON a board has to come
   * back through here first: `setEditTarget` on a copy would open the Edit form
   * with the nickname in the name field, and saving that form would rename the
   * board for the entire workspace.
   */
  const boardsById = useMemo(
    () => new Map(boards.map((b) => [b._id, b])),
    [boards]
  );
  const realBoard = useCallback((b) => boardsById.get(b?._id) || b, [boardsById]);

  /**
   * Drag-reorder for an Executive — the one place in this file where the order
   * being written is NOT `Board.order`.
   *
   * `reorderBoardsAction` (the handler above) rewrites the workspace-wide order
   * for every member of the org. On this list that would mean one person tidying
   * their own four cards silently rearranging the whole company's board list, so
   * this path calls `saveMine({ boards })` instead, which writes
   * `ExecutiveView.boards[].order` and touches nobody else's screen. The full
   * trap is written up in `utils/executiveBoards.js`.
   *
   * THREE things here are load-bearing:
   *
   *  1. The move is applied to `execProfileNow.boards` — the PROFILE's entries —
   *     and not to the rendered cards. An entry is more than an id: it carries
   *     the label, the default tab and the tab allowlist, and what is on screen
   *     are RELABELLED COPIES of boards with no entry behind them. Rebuilding
   *     the array out of the cards would save a list of board ids and drop every
   *     preset hanging off them.
   *
   *     What it does NOT do — an earlier version of this comment claimed it did,
   *     and the claim was worth correcting rather than deleting — is preserve an
   *     entry for a board this person cannot currently read. `resolveForViewer`
   *     has already removed those from the profile the client was handed (they
   *     arrive separately, in `skipped[]`), so they are not in
   *     `execProfileNow.boards` to be preserved, and the self PUT drops them
   *     again on the way in. A drag made while a grant is revoked therefore
   *     SAVES THE LIST WITHOUT THAT ENTRY — label, default tab, allowlist and
   *     all — and restoring the grant brings the board back bare. That is the
   *     self plane behaving as specified (invariant 2: it may not write what it
   *     cannot see), not something this handler can fix. The place that loss is
   *     visible, and the place to put it back, is the admin's configurator.
   *  2. `order` is renumbered from the new positions before sending. The server
   *     re-sorts by `order` on save (`withDenseOrder`), so entries carrying
   *     their OLD numbers in a NEW array order come back out in the old order —
   *     a drag that saves successfully and changes nothing.
   *  3. The optimistic copy is dropped once the LATEST save settles, whichever
   *     way it went: on success the store holds the saved order, on failure it
   *     still holds the old one, and the store is the truth in both cases.
   *     "Latest" is the whole of it — a save settling while a later drag is
   *     still unsaved must not hand the screen back, or the person watches the
   *     drag they just made undo itself. That, and the queue that stops two of
   *     these crossing on the wire, are `dragTicket` and `saveQueue` above.
   *
   * AND WHY `home` AND `nav` RIDE ALONG: `PUT /api/me/executive-view` REPLACES
   * the document from the validated body — nothing merges, on the client or the
   * server — and the validator reads an absent `home` as "no sections" and an
   * absent `nav` as "every switch on". A body of `{ boards }` alone would
   * therefore save this new order and wipe the person's home layout and rail
   * switches on the way past. In phase 1 that damage is invisible (the home is
   * empty and the switches are all on anyway), which is exactly why it has to
   * be written down now rather than discovered the week phase 2 ships. Both
   * fields round-trip safely by design: a home section keeps its `_id` through
   * the validator, and `nav` is stored `_id: false`, so sending them straight
   * back is a no-op.
   */
  const handleExecutiveDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id || dndDisabled) return;

    const entries = Array.isArray(execProfileNow?.boards)
      ? execProfileNow.boards
      : [];
    const oldIndex = entries.findIndex(
      (e) => boardIdOf(e?.board) === String(active.id)
    );
    const newIndex = entries.findIndex(
      (e) => boardIdOf(e?.board) === String(over.id)
    );
    if (oldIndex < 0 || newIndex < 0) return;

    const next = arrayMove(entries, oldIndex, newIndex).map((entry, i) => ({
      ...entry,
      order: i,
    }));

    // Whose optimistic order is on screen, from here on.
    const ticket = (dragTicket.current += 1);
    setExecOrder(next);

    // QUEUED, not fired. See `saveQueue` for why two of these must never be in
    // flight together. The body was computed above, synchronously, from the
    // order the person is looking at — waiting for a turn changes when it is
    // sent, never what is sent.
    saveQueue.current = saveQueue.current
      // An earlier save that failed was reported when it failed; it must not
      // also poison the queue for the drag after it.
      .catch(() => {})
      .then(() =>
        saveMine({
          boards: next,
          // Carried back unchanged — see the header. This page edits the order
          // and only the order; these two ride along so the save does not
          // delete them.
          home: execProfileNow?.home || [],
          nav: execProfileNow?.nav,
        })
      )
      .catch((err) => {
        console.error('Failed to save your board order:', err);
        toastError('Could not save your board order.');
      })
      .finally(() => {
        // ONLY the latest drag may put the buffer down. A save settling while a
        // later drag is still unsaved would otherwise hand the screen back to
        // the store, which holds the EARLIER order — the person watches their
        // second drag undo itself, then redo itself when that save lands.
        if (dragTicket.current === ticket) setExecOrder(null);
      });
  };

  return (
    <PageWrapper>
      {/* Page header */}
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1
            className="font-display font-bold text-[22px] md:text-[28px]"
            style={{
              color: 'var(--color-text-primary)',
              letterSpacing: '-0.02em',
            }}
          >
            My Boards
          </h1>
          <p
            className="mt-1 font-body"
            style={{ fontSize: 14, color: 'var(--color-text-secondary)' }}
          >
            Manage your projects and workflows
          </p>
        </div>
        {canCreateBoard && (
          <Button
            variant="primary"
            icon={Plus}
            onClick={() => setCreateOpen(true)}
          >
            Create Board
          </Button>
        )}
      </header>

      {/* Toolbar */}
      <div className="mt-6 flex items-center gap-3 flex-wrap">
        {/* Search input */}
        <div
          className="relative flex items-center w-full sm:w-[320px]"
        >
          <Search
            size={16}
            color="var(--color-text-muted)"
            className="absolute left-3"
            aria-hidden="true"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search boards..."
            aria-label="Search boards"
            className="w-full font-body text-[14px] transition-[border-color,box-shadow,background-color] duration-150 ease-in-out placeholder:text-[color:var(--color-text-muted)] focus:outline-none focus:bg-white focus:border-[color:var(--color-accent)] focus:shadow-[0_0_0_3px_rgba(37,99,235,0.12)]"
            style={{
              height: 38,
              paddingLeft: 36,
              paddingRight: 12,
              background: 'var(--color-bg-input)',
              border: '1.5px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--color-text-primary)',
            }}
          />
        </div>

        {/* View toggle */}
        <div
          className="flex items-center"
          style={{
            padding: 3,
            border: '1.5px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-bg-input)',
          }}
        >
          <button
            type="button"
            onClick={() => setView('grid')}
            aria-label="Grid view"
            aria-pressed={view === 'grid'}
            className="flex items-center justify-center transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
            style={{
              width: 30,
              height: 30,
              borderRadius: 'var(--radius-sm)',
              background:
                view === 'grid' ? 'var(--color-accent)' : 'transparent',
              color:
                view === 'grid'
                  ? '#FFFFFF'
                  : 'var(--color-text-secondary)',
            }}
          >
            <LayoutGrid size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setView('list')}
            aria-label="List view"
            aria-pressed={view === 'list'}
            className="flex items-center justify-center transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
            style={{
              width: 30,
              height: 30,
              borderRadius: 'var(--radius-sm)',
              background:
                view === 'list' ? 'var(--color-accent)' : 'transparent',
              color:
                view === 'list'
                  ? '#FFFFFF'
                  : 'var(--color-text-secondary)',
            }}
          >
            <ListIcon size={14} aria-hidden="true" />
          </button>
        </div>

        {/* Filter popup — visibility / progress / ownership / last updated,
            plus the Detailed view toggle */}
        <BoardFilterPanel
          filters={filters}
          onChange={setFilters}
          matchedCount={filteredBoards.length}
          totalCount={boards.length}
          detailedView={detailedView}
          onToggleDetailedView={toggleDetailedView}
        />
      </div>

      {/* Content area */}
      <div className="mt-6">
        {!hasBoards && loading ? (
          <div
            role="status"
            aria-live="polite"
            aria-label="Loading boards"
          >
            {view === 'grid' ? (
              <div className="grid gap-5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <SkeletonBoardCard key={i} index={i} />
                ))}
              </div>
            ) : (
              <div
                className="bg-surface overflow-hidden"
                style={{
                  borderRadius: 'var(--radius-lg)',
                  boxShadow: 'var(--shadow-card)',
                }}
              >
                {[0, 1, 2, 3].map((i) => (
                  <SkeletonBoardListRow key={i} isLast={i === 3} />
                ))}
              </div>
            )}
          </div>
        ) : !hasBoards ? (
          <div
            className="bg-surface"
            style={{
              borderRadius: 'var(--radius-lg)',
              boxShadow: 'var(--shadow-card)',
              padding: '48px 16px',
            }}
          >
            <EmptyState
              icon={FolderOpen}
              title="No boards yet"
              description="Create your first board to get started"
              actionLabel={canCreateBoard ? 'Create your first board' : undefined}
              onAction={canCreateBoard ? () => setCreateOpen(true) : undefined}
            />
          </div>
        ) : !hasResults && narrowed ? (
          <div
            className="bg-surface"
            style={{
              borderRadius: 'var(--radius-lg)',
              boxShadow: 'var(--shadow-card)',
              padding: '48px 16px',
            }}
          >
            <EmptyState
              icon={Search}
              title="Nothing found"
              description={
                searching
                  ? 'Try a different search term or adjust your filters'
                  : 'No boards match the selected filters'
              }
            />
          </div>
        ) : isExecutive ? (
          <ExecutiveBoardGroups
            listed={execListed}
            other={execOther}
            view={view}
            accents={ACCENT_CYCLE}
            sensors={sensors}
            onDragEnd={handleExecutiveDragEnd}
            dndDisabled={dndDisabled}
            canManageBoard={canManageBoard}
            onOpen={openBoard}
            // Re-pointed at the real board: see `realBoard` above.
            onEdit={(b) => setEditTarget(realBoard(b))}
            onDelete={(b) => setDeleteTarget(realBoard(b))}
            showProgress={detailedView}
          />
        ) : view === 'grid' ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleBoardDragEnd}
          >
            <SortableContext items={boardIds} strategy={rectSortingStrategy}>
              <div className="grid gap-5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                {filteredBoards.map((board, i) => (
                  <SortableBoardCard
                    key={board._id}
                    board={board}
                    accentColor={ACCENT_CYCLE[i % ACCENT_CYCLE.length]}
                    onOpen={openBoard}
                    canManage={canManageBoard(board)}
                    onEdit={(b) => setEditTarget(b)}
                    onDelete={(b) => setDeleteTarget(b)}
                    dndDisabled={dndDisabled}
                    showProgress={detailedView}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleBoardDragEnd}
          >
            <SortableContext items={boardIds} strategy={verticalListSortingStrategy}>
              <BoardListView
                boards={filteredBoards}
                accents={ACCENT_CYCLE}
                onOpen={openBoard}
                canManageBoard={canManageBoard}
                onEdit={(b) => setEditTarget(b)}
                onDelete={(b) => setDeleteTarget(b)}
                dndDisabled={dndDisabled}
                showProgress={detailedView}
              />
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* Create modal */}
      <BoardFormModal
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        onSubmit={handleCreateSubmit}
        mode="create"
        // For "copy an existing board" — the list this page already holds, so
        // the picker costs no extra request.
        existingBoards={boards}
      />

      {/* Edit modal */}
      <BoardFormModal
        isOpen={!!editTarget}
        onClose={() => setEditTarget(null)}
        onSubmit={handleEditSubmit}
        initialValues={editTarget || undefined}
        mode="edit"
        // Read the server's own answer rather than guessing at it here. The ⋯
        // menu opens on `board.rename`, which is a LOWER bar than flipping the
        // board public — so the two have to be asked separately or the form
        // offers a control the save will refuse.
        canChangeVisibility={(editTarget?.permissions?.capabilities || []).includes(
          'board.change_visibility'
        )}
      />

      {/* Delete confirmation */}
      <DeleteBoardModal
        isOpen={!!deleteTarget}
        board={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDeleteConfirm}
      />
    </PageWrapper>
  );
};

/**
 * ExecutiveBoardGroups — My Boards for somebody who has an executive view.
 *
 * Two groups, in this order:
 *
 *   YOUR BOARDS   the profile's list, in the profile's order and under the
 *                 profile's labels. Draggable, and the drag writes the PROFILE
 *                 (see `handleExecutiveDragEnd`, and `utils/executiveBoards.js`
 *                 for why it must never reach `reorderBoards`).
 *   OTHER BOARDS  everything else this person can still read — a board they
 *                 made themselves, or one somebody shared with them directly.
 *                 Spec section 4.2: these are reachable and must not vanish.
 *                 Not draggable, because there is nowhere to put the order: the
 *                 profile orders the boards it names, and these are the boards
 *                 it does not name.
 *
 * "Not draggable" is RENDERED rather than explained. The group is wrapped in a
 * sortable context with dragging disabled — the same switch the search box
 * already flips — and both the card and the row answer that by not drawing a
 * grip handle at all. A handle that does nothing when pulled is worse than no
 * handle, and a tooltip explaining why is worse than both.
 *
 * The headings appear only when there is something to tell apart. With no other
 * boards this page is just the curated list, and a lone "Your boards" heading
 * over the only group on screen is noise; with no listed boards the "Other
 * boards" heading stays, because then it is the line that explains why none of
 * these cards can be dragged.
 */
const ExecutiveBoardGroups = ({
  listed,
  other,
  view,
  accents,
  sensors,
  onDragEnd,
  dndDisabled = false,
  canManageBoard,
  onOpen,
  onEdit,
  onDelete,
  showProgress = true,
}) => {
  /**
   * The nickname, looked up by board id — NOT written over `board.name`.
   *
   * The obvious shape is a shallow copy carrying the label in `name`, and it is
   * wrong twice. The card's `title` attribute exists to answer "which board am
   * I actually opening" by naming BOTH, and a copy whose `name` is already the
   * nickname has nothing left to answer with. And every handler below —
   * `onOpen`, `onEdit`, `onDelete`, `canManageBoard` — would then be holding a
   * board whose name is a private nickname, which is how a rename dialog opens
   * pre-filled with a name only one person uses.
   *
   * So the real board goes everywhere, and the label rides beside it as a prop.
   */
  const labelById = useMemo(() => {
    const map = new Map();
    for (const { board, label } of listed) {
      if (label) map.set(board._id, displayName(board, { label }));
    }
    return map;
  }, [listed]);

  const listedBoards = useMemo(() => listed.map(({ board }) => board), [listed]);

  const listedIds = useMemo(() => listedBoards.map((b) => b._id), [listedBoards]);
  const otherIds = useMemo(() => other.map((b) => b._id), [other]);

  const strategy =
    view === 'grid' ? rectSortingStrategy : verticalListSortingStrategy;

  // Both groups render identically apart from whether they can be dragged, so
  // the grid/list fork lives in one place rather than in four.
  const renderBoards = (rows, disabled) =>
    view === 'grid' ? (
      <div className="grid gap-5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((board, i) => (
          <SortableBoardCard
            key={board._id}
            board={board}
            label={labelById.get(board._id) || ''}
            accentColor={accents[i % accents.length]}
            onOpen={onOpen}
            canManage={canManageBoard(board)}
            onEdit={onEdit}
            onDelete={onDelete}
            dndDisabled={disabled}
            showProgress={showProgress}
          />
        ))}
      </div>
    ) : (
      <BoardListView
        boards={rows}
        labelById={labelById}
        accents={accents}
        onOpen={onOpen}
        canManageBoard={canManageBoard}
        onEdit={onEdit}
        onDelete={onDelete}
        dndDisabled={disabled}
        showProgress={showProgress}
      />
    );

  return (
    <div className="flex flex-col gap-8">
      {listedBoards.length > 0 && (
        <section aria-label="Your boards">
          {other.length > 0 && <BoardGroupHeading title="Your boards" />}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
          >
            <SortableContext items={listedIds} strategy={strategy}>
              {renderBoards(listedBoards, dndDisabled)}
            </SortableContext>
          </DndContext>
        </section>
      )}

      {other.length > 0 && (
        <section aria-label="Other boards">
          <BoardGroupHeading
            title="Other boards"
            description="Boards you can open that are not on your list — ones you created, or that someone shared with you directly. They have no order of their own, so they cannot be dragged."
          />
          {/* Dragging off, deliberately. The context is still here because both
              the card and the row are sortable-aware components; disabled, they
              render with no grip and nothing can move. */}
          <DndContext sensors={sensors} collisionDetection={closestCenter}>
            <SortableContext items={otherIds} strategy={strategy}>
              {renderBoards(other, true)}
            </SortableContext>
          </DndContext>
        </section>
      )}
    </div>
  );
};

/** The heading over one board group, and the line explaining what it holds. */
const BoardGroupHeading = ({ title, description }) => (
  <div className="mb-3">
    <h2
      className="font-display font-bold"
      style={{ fontSize: 15, color: 'var(--color-text-primary)' }}
    >
      {title}
    </h2>
    {description && (
      <p
        className="mt-0.5 font-body"
        style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
      >
        {description}
      </p>
    )}
  </div>
);

/**
 * Lightweight list view — one row per board. Uses the same card shell
 * visually so the grid/list toggle feels consistent.
 */
const BoardListView = ({
  boards,
  labelById,
  accents,
  onOpen,
  canManageBoard,
  onEdit,
  onDelete,
  dndDisabled = false,
  showProgress = true,
}) => {
  return (
    <div
      className="bg-surface overflow-hidden"
      style={{
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      {boards.map((b, i) => {
        const isPublic = b.visibility === 'public';
        const PrivacyIcon = isPublic ? Globe : Lock;
        return (
          <BoardListRow
            key={b._id}
            board={b}
            label={labelById?.get(b._id) || ''}
            accent={accents[i % accents.length]}
            isLast={i === boards.length - 1}
            isPublic={isPublic}
            PrivacyIcon={PrivacyIcon}
            onOpen={onOpen}
            canManage={canManageBoard(b)}
            onEdit={onEdit}
            onDelete={onDelete}
            dndDisabled={dndDisabled}
            showProgress={showProgress}
          />
        );
      })}
    </div>
  );
};

/**
 * SortableBoardCard — wraps BoardCard with @dnd-kit sortable behaviour.
 * The grip handle in the top-left corner owns the drag listeners so the
 * rest of the card stays clickable for navigation.
 */
const SortableBoardCard = ({
  board,
  label = '',
  accentColor,
  onOpen,
  canManage,
  onEdit,
  onDelete,
  dndDisabled,
  showProgress = true,
}) => (
  <SortableItem id={board._id} data={{ type: 'board' }} disabled={dndDisabled}>
    {({ ref, setActivatorNodeRef, style, attributes, listeners, isDragging }) => (
      <div
        ref={ref}
        className="group/board-sortable"
        style={{ ...style, position: 'relative', zIndex: isDragging ? 20 : 'auto' }}
      >
        {!dndDisabled && (
          <button
            ref={setActivatorNodeRef}
            type="button"
            aria-label="Drag to reorder board"
            {...attributes}
            {...listeners}
            onClick={(e) => e.stopPropagation()}
            className="absolute z-10 flex items-center justify-center opacity-0 group-hover/board-sortable:opacity-100 focus-visible:opacity-100 transition-opacity duration-150"
            style={{
              top: 8,
              left: 8,
              width: 24,
              height: 24,
              borderRadius: 'var(--radius-sm)',
              background: 'rgba(255,255,255,0.85)',
              boxShadow: 'var(--shadow-card)',
              cursor: 'grab',
              touchAction: 'none',
            }}
          >
            <GripVertical size={14} color="var(--color-text-secondary)" aria-hidden="true" />
          </button>
        )}
        <BoardCard
          board={board}
          label={label}
          accentColor={accentColor}
          onOpen={onOpen}
          canManage={canManage}
          onEdit={onEdit}
          onDelete={onDelete}
          showProgress={showProgress}
        />
      </div>
    )}
  </SortableItem>
);

const BoardListRow = ({
  board,
  label = '',
  accent,
  isLast,
  isPublic,
  PrivacyIcon,
  onOpen,
  canManage,
  onEdit,
  onDelete,
  dndDisabled = false,
  showProgress = true,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  // The same rule BoardCard applies, for the same reason: an empty label means
  // "use the board's own name", a label equal to the name is not a nickname,
  // and where the two differ the row titles itself with the nickname while the
  // tooltip still answers which board this really is.
  const nickname = label && label !== board.name ? label : '';
  const shownName = nickname || board.name;
  const nameTitle = nickname
    ? `${nickname} — the board's own name is “${board.name}”`
    : board.name;
  return (
    <SortableItem id={board._id} data={{ type: 'board' }} disabled={dndDisabled}>
      {({ ref, setActivatorNodeRef, style, attributes, listeners, isDragging }) => (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      onClick={() => !menuOpen && onOpen?.(board)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen?.(board);
        }
      }}
      className="group/board-row flex items-center gap-4 cursor-pointer transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)] focus-visible:outline-offset-[-2px]"
      style={{
        ...style,
        padding: '14px 16px',
        borderBottom: isLast ? 'none' : '1px solid var(--color-border)',
        background: isDragging ? 'var(--color-bg-subtle)' : undefined,
        position: 'relative',
        zIndex: isDragging ? 20 : 'auto',
      }}
    >
      {!dndDisabled && (
        <button
          ref={setActivatorNodeRef}
          type="button"
          aria-label="Drag to reorder board"
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
          className="flex items-center justify-center shrink-0 opacity-0 group-hover/board-row:opacity-100 focus-visible:opacity-100 transition-opacity duration-150"
          style={{
            width: 20,
            height: 24,
            cursor: 'grab',
            touchAction: 'none',
            background: 'transparent',
            border: 'none',
            padding: 0,
            marginLeft: -4,
          }}
        >
          <GripVertical size={14} color="var(--color-text-muted)" aria-hidden="true" />
        </button>
      )}
      <div
        aria-hidden="true"
        style={{
          width: 4,
          height: 32,
          background: accent,
          borderRadius: 'var(--radius-sm)',
        }}
      />
      <div
        className="flex items-center justify-center shrink-0"
        style={{
          width: 32,
          height: 32,
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-accent-light)',
        }}
        aria-hidden="true"
      >
        <Folder size={16} color="var(--color-accent)" />
      </div>
      <div className="min-w-0 flex-1">
        <p
          className="font-body font-semibold truncate"
          title={nameTitle}
          style={{ fontSize: 14, color: 'var(--color-text-primary)' }}
        >
          {shownName}
        </p>
        <p
          className="font-body truncate"
          style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
        >
          {board.description || 'No description'}
        </p>
      </div>
      {/* Progress — percentage of tasks done on this board */}
      {showProgress && (
      <div
        className="hidden sm:flex items-center gap-2 shrink-0"
        style={{ width: 128 }}
        title={
          (board.taskCount ?? 0) > 0
            ? `${board.doneCount ?? 0} of ${board.taskCount} tasks done`
            : 'No tasks yet'
        }
      >
        <div
          role="progressbar"
          aria-valuenow={board.progress ?? 0}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${board.progress ?? 0}% of tasks done`}
          style={{
            flex: 1,
            height: 6,
            borderRadius: 'var(--radius-full)',
            background: 'var(--color-bg-subtle)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${board.progress ?? 0}%`,
              height: '100%',
              background: 'var(--color-status-done)',
              borderRadius: 'var(--radius-full)',
            }}
          />
        </div>
        <span
          className="font-body"
          style={{
            fontSize: 12,
            fontWeight: 600,
            width: 34,
            textAlign: 'right',
            color: 'var(--color-text-secondary)',
          }}
        >
          {board.progress ?? 0}%
        </span>
      </div>
      )}

      <span
        className="inline-flex items-center gap-1 font-body shrink-0"
        style={{
          fontSize: 11,
          fontWeight: 500,
          padding: '2px 8px',
          borderRadius: 'var(--radius-full)',
          background: isPublic ? 'var(--color-status-done-bg)' : '#FFF0F0',
          color: isPublic ? 'var(--color-status-done)' : '#DC2626',
        }}
      >
        <PrivacyIcon size={10} aria-hidden="true" />
        {isPublic ? 'public' : 'private'}
      </span>
      <div
        className="flex items-center gap-1.5 font-body shrink-0"
        style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
      >
        <CalendarIcon size={12} aria-hidden="true" />
        <span>{timeAgo(board.updatedAt || board.createdAt)}</span>
      </div>

      {canManage && (
        <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            aria-label="Board options"
            onClick={() => setMenuOpen((m) => !m)}
            className="flex items-center justify-center rounded-md transition-colors duration-150 hover:bg-[color:var(--color-border)]"
            style={{ width: 28, height: 28 }}
          >
            <MoreHorizontal
              size={16}
              color="var(--color-text-secondary)"
              aria-hidden="true"
            />
          </button>
          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setMenuOpen(false)}
              />
              <div
                role="menu"
                className="absolute right-0 z-20 mt-1 bg-surface"
                style={{
                  minWidth: 140,
                  borderRadius: 'var(--radius-md)',
                  boxShadow: 'var(--shadow-md)',
                  border: '1px solid var(--color-border)',
                  padding: 4,
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onEdit?.(board);
                  }}
                  className="w-full text-left font-body hover:bg-[color:var(--color-bg-subtle)] transition-colors duration-150"
                  style={{
                    fontSize: 13,
                    padding: '8px 10px',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--color-text-primary)',
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete?.(board);
                  }}
                  className="w-full text-left font-body hover:bg-[color:var(--color-bg-subtle)] transition-colors duration-150"
                  style={{
                    fontSize: 13,
                    padding: '8px 10px',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--color-status-stuck)',
                  }}
                >
                  Delete
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
      )}
    </SortableItem>
  );
};

export default MyBoardsPage;
