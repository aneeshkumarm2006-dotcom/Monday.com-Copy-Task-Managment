import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { ChevronDown, ChevronRight, GripVertical, LayoutDashboard, LayoutGrid } from 'lucide-react';

import Button from '../ui/Button';
import EmptyState from '../ui/EmptyState';
import Switch from '../ui/Switch';
import SortableItem from '../dnd/SortableItem';
import BoardPresetFields from '../executive/BoardPresetFields';
import useBoardStore from '../../store/boardStore';
import useOrgStore from '../../store/orgStore';
import useToastStore from '../../store/toastStore';
import useExecutiveViewStore from '../../store/executiveViewStore';
import { NAV_KEYS } from '../../utils/executiveNav';
import {
  boardIdOf,
  normalisePreset,
  presetSummary,
  samePreset,
} from '../../utils/executiveBoards';

/**
 * MY VIEW — the Settings tab where an Executive edits their own screen.
 *
 * Settings → "My view", rendered only when `isExecutive` (the tab itself is
 * gated by `executiveTab` in `SettingsSidebar.jsx`, fed from `SettingsPage`).
 * It is the SELF half of the admin's configurator: the same document, the same
 * validator, the same service — `PUT /api/me/executive-view` through the store's
 * `saveMine` — and, apart from the home layout, the same things that page edits.
 *
 * ---- WHAT THIS TAB MAY CHANGE, AND WHY IT IS SAFE TO OFFER AT ALL ----------
 *
 * SHAPE ONLY. The profile never grants access (spec invariant 1), and the self
 * plane never writes one (invariant 2): the server runs this PUT with
 * `allowReachChange: false`, so a board entry for a board this person cannot
 * already open is dropped rather than honoured. Which means nothing on this
 * screen — not a reorder, not a nickname, not a rail switch — can widen what
 * they reach. That is the whole reason an "edit your own view" surface exists
 * instead of every change having to go through an admin.
 *
 * The four things it edits:
 *
 *   NAV SWITCHES   the eight Booleans of `profile.nav`. A switch HIDES a rail
 *                  destination; it can never reveal one (invariant 6), and the
 *                  note under them says so on screen because a switch that
 *                  looks like it might grant something will eventually be
 *                  clicked in the hope that it does.
 *   BOARD ORDER    `profile.boards[].order`, by drag. NEVER `Board.order` —
 *                  that field is workspace-wide and `reorderBoards` rewrites it
 *                  for every member of the org, so one person tidying their own
 *                  four rows would rearrange the whole company's board list.
 *                  The trap is written up in full in `utils/executiveBoards.js`.
 *   LABELS         `profile.boards[].label`, a NICKNAME for finding a board in
 *                  a list. It never reaches `board.name`; the board page's own
 *                  heading keeps the name everybody else uses.
 *   TAB PRESETS    `profile.boards[].defaultTab` and `.tabs` — which tab a
 *                  board opens on, and which tabs it keeps. Both only ever
 *                  SUBTRACT (`resolveViewTabs` can hide a tab the gate allowed
 *                  and can never show one it hid), which is what makes them
 *                  safe on a self-service screen. The control is
 *                  `components/executive/BoardPresetFields.jsx`, shared with the
 *                  configurator so the "an allowlist always keeps the main tab"
 *                  rule has one home rather than two.
 *
 * The HOME LAYOUT is deliberately not here. It is edited in place on the home
 * page itself ("Edit home"), where the person can see what they are arranging;
 * a second editor for it in Settings would be two surfaces writing one array.
 * There is a link to it at the bottom instead.
 *
 * ---- WHY ONE SAVE BUTTON AND NOT EIGHT IMMEDIATE TOGGLES -------------------
 *
 * `ExtraFeaturesTab` next door saves each switch the moment it moves, and that
 * is right there: each one is an independent field on the user. Here every
 * write is a PUT of the WHOLE document — the endpoint replaces it, nothing
 * merges on either side — so eight quick toggles would be eight full-document
 * writes racing each other, and the one that lands last wins regardless of the
 * order they were made in. A single explicit save sends one body, once, and the
 * store then holds the server's answer rather than an optimistic guess.
 *
 * ---- A BOARD THAT IS NOT ON THIS LIST IS NOT BEING HIDDEN FROM YOU ---------
 *
 * `GET /api/me/executive-view` resolves the profile against this person's own
 * access and removes entries whose board they can no longer open, reporting
 * them separately in `skipped[]`. This tab renders what survived and saves
 * exactly that — and the entries it was never shown SURVIVE the save anyway.
 * The self PUT goes through `reachFilteredBoards` in
 * `server/src/services/executiveView.js`, which re-attaches every stored entry
 * the subject cannot currently read, exactly as stored, whether or not the body
 * mentioned it: an entry somebody was never shown cannot be an entry they chose
 * to remove. So a board whose grant lapsed this morning keeps its nickname, its
 * place and its tab presets, and has them back the moment the grant is.
 *
 * The same rule read the other way: a hidden entry is not EDITABLE from here
 * either — the stored copy wins over anything a body sends for it. The screen
 * where such an entry is visible, and can be taken off the list deliberately,
 * is the admin's configurator, which is handed the same `skipped[]`.
 */

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The rail switches, IN THE FIRST PERSON — this is somebody editing their own
 * screen, not an admin editing somebody else's, so "My Work" reads as the thing
 * that disappears rather than as a field name.
 *
 * Keyed by the profile's `nav` keys, and the LIST IS BUILT FROM `NAV_KEYS`
 * (`utils/executiveNav.js`, itself derived from the route map that the rail
 * filters with). A key added there but not described here still renders, with
 * its raw key as the label — visibly unfinished, rather than a switch that
 * silently cannot be reached. The server's `validateNav` REJECTS an unknown
 * key rather than dropping it, so the reverse mistake (a name invented here)
 * would fail the whole save, which is why nothing below is typed by hand.
 */
const NAV_COPY = {
  boards: {
    label: 'My Boards',
    hint: 'The board list itself. Your boards stay reachable from the home page.',
  },
  myWork: { label: 'My Work', hint: 'Everything assigned to you, across boards.' },
  chat: { label: 'Chat', hint: 'Direct messages and board conversations.' },
  calendar: { label: 'Calendar', hint: 'The scheduling view.' },
  notifications: { label: 'Notifications', hint: 'The full notifications page.' },
  members: { label: 'Members', hint: 'Needs the members permission as well.' },
  analytics: { label: 'Analytics', hint: 'Needs the analytics permission as well.' },
  productivity: {
    label: 'Productivity',
    hint: 'Needs the productivity permission as well.',
  },
};

const navRows = () =>
  NAV_KEYS.map((key) => ({
    key,
    label: NAV_COPY[key]?.label || key,
    hint: NAV_COPY[key]?.hint || '',
  }));

/** Every switch defaults to ON: an absent key is the model's "true". */
const navFromProfile = (profile) =>
  NAV_KEYS.reduce((acc, key) => {
    acc[key] = profile?.nav?.[key] !== false;
    return acc;
  }, {});

/**
 * The profile's board entries as this tab edits them.
 *
 * WHOLE ENTRIES, not ids. An entry carries the label AND the tab presets
 * (`defaultTab`, `tabs`); rebuilding the array out of the rows on screen would
 * save a list of board ids and silently delete every preset hanging off them.
 * `order` is re-derived from the array position on save, because the server
 * re-sorts by `order` — entries carrying their old numbers in a new array order
 * come back out in the old order, which is a drag that saves and changes
 * nothing.
 */
const entriesFromProfile = (profile) =>
  (Array.isArray(profile?.boards) ? profile.boards : [])
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        (Number.isFinite(a.entry?.order) ? a.entry.order : a.index) -
          (Number.isFinite(b.entry?.order) ? b.entry.order : b.index) ||
        a.index - b.index
    )
    .map(({ entry }) => ({
      board: boardIdOf(entry?.board),
      label: entry?.label || '',
      /**
       * The presets, through `normalisePreset` on the way in.
       *
       * It folds the two shapes the server REFUSES (`tabs: []`, and an
       * allowlist with no 'board' in it) back into ones it accepts, and either
       * could arrive from storage — a Mongoose array default can land as `[]`,
       * and this tab PUTs back whatever it read. Without the pass, one old
       * document would make every save from this screen fail with a 400 about
       * a field nobody on the page had touched.
       *
       * No board is passed: the board list is fetched separately and may not
       * have landed, so nothing is narrowed by board type here. Narrowing
       * happens where the board IS in hand — the row's summary, the form, and
       * (the one that decides what the document ends up holding) `handleSave`.
       * A preset repaired here and never narrowed again would be a value the
       * whole screen draws as absent and the document quietly keeps.
       */
      ...normalisePreset(entry),
    }));

/* -------------------------------------------------------------------------- */
/* Tab                                                                         */
/* -------------------------------------------------------------------------- */

const MyViewTab = () => {
  const navigate = useNavigate();
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const profile = useExecutiveViewStore((s) => s.profile);
  const saveMine = useExecutiveViewStore((s) => s.saveMine);
  const boards = useBoardStore((s) => s.boards);
  const fetchBoards = useBoardStore((s) => s.fetchBoards);
  const toastSuccess = useToastStore((s) => s.success);
  const toastError = useToastStore((s) => s.error);

  const orgId = currentOrg?._id || null;

  // Local until Save. Seeded from the profile and RE-SEEDED whenever the
  // profile changes identity — a save replaces the document in the store, and
  // an admin editing this person's view while the tab is open changes it out
  // from under them. Keyed on `updatedAt` rather than on the object so that a
  // re-render carrying the same document does not throw away what they typed.
  const [nav, setNav] = useState(() => navFromProfile(profile));
  const [entries, setEntries] = useState(() => entriesFromProfile(profile));
  const [saving, setSaving] = useState(false);

  const stamp = profile ? `${profile._id || ''}:${profile.updatedAt || ''}` : '';
  useEffect(() => {
    setNav(navFromProfile(profile));
    setEntries(entriesFromProfile(profile));
    // `stamp` is the dependency; `profile` is read inside. Listing the object
    // would re-seed on every store write, including ones that changed nothing
    // about this document, and wipe an in-progress edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp]);

  // The rows show each board's REAL name, which only `GET /api/boards` knows —
  // the profile stores ids. Fetched here because Settings has no reason to have
  // loaded boards before now, and keyed on the workspace rather than on "is the
  // list empty" so that arriving here after an org switch does not label this
  // workspace's boards with the last one's names.
  useEffect(() => {
    if (!orgId) return;
    fetchBoards(orgId).catch((err) => {
      console.error('Failed to fetch boards:', err);
    });
  }, [orgId, fetchBoards]);

  const boardsById = useMemo(() => {
    const map = new Map();
    for (const board of boards || []) map.set(boardIdOf(board._id), board);
    return map;
  }, [boards]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  /**
   * Is there anything for Save to do?
   *
   * Measured against the stored document rather than a snapshot taken on mount,
   * for the same reason the configurator does it that way: a snapshot has to be
   * re-taken after every server read, and one that drifts makes the page claim
   * unsaved changes that do not exist.
   */
  const dirty = useMemo(() => {
    if (!profile) return false;
    const stored = entriesFromProfile(profile);
    const orderMoved =
      stored.length !== entries.length ||
      stored.some((e, i) => e.board !== entries[i]?.board);
    const labelsMoved = entries.some((e) => {
      const was = stored.find((s) => s.board === e.board);
      return (e.label || '') !== (was?.label || '');
    });
    // `samePreset` rather than a deep-equal: `tabs: null` ("every tab") and
    // `tabs: [every tab there is]` are different settings that a naive compare
    // of two arrays cannot tell apart, and reading them as equal would leave
    // Save greyed out over a real change.
    const presetsMoved = entries.some((e) => {
      const was = stored.find((s) => s.board === e.board);
      return !samePreset(e, was || {});
    });
    const navMoved = NAV_KEYS.some(
      (key) => (nav[key] !== false) !== (profile.nav?.[key] !== false)
    );
    return orderMoved || labelsMoved || presetsMoved || navMoved;
  }, [profile, entries, nav]);

  const setLabel = useCallback((boardId, value) => {
    setEntries((rows) =>
      rows.map((row) => (row.board === boardId ? { ...row, label: value } : row))
    );
  }, []);

  /**
   * Store the two tab presets for one board.
   *
   * `BoardPresetFields` has already run its answer through `normalisePreset`,
   * so what arrives is a shape the server will accept. It is normalised AGAIN
   * here against the board this row actually resolved — the component is given
   * the same board, so this is belt and braces rather than a second opinion,
   * and it costs one pass over a ten-element list on a keystroke nobody makes
   * in a loop.
   */
  const setPreset = useCallback((boardId, board, preset) => {
    setEntries((rows) =>
      rows.map((row) =>
        row.board === boardId ? { ...row, ...normalisePreset(preset, board) } : row
      )
    );
  }, []);

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setEntries((rows) => {
      const from = rows.findIndex((r) => r.board === String(active.id));
      const to = rows.findIndex((r) => r.board === String(over.id));
      if (from < 0 || to < 0) return rows;
      return arrayMove(rows, from, to);
    });
  };

  const handleSave = async () => {
    if (!profile || saving) return;
    setSaving(true);
    try {
      // `home` is NOT sent. The store's `saveMine` fills it from the loaded
      // profile precisely so a caller editing one part of the document cannot
      // delete another — the endpoint replaces the whole thing and reads an
      // absent `home` as "no sections". Sending it from here would be a second
      // copy of that rule, and the one that drifts.
      const result = await saveMine({
        boards: entries.map((row, index) => ({
          board: row.board,
          label: row.label || '',
          // Position IS order. See `entriesFromProfile`.
          order: index,
          /**
           * The tab presets, narrowed against the board ONE LAST TIME.
           *
           * `entriesFromProfile` repairs the SHAPE on the way in and
           * deliberately narrows nothing — the board list is fetched separately
           * and may not have landed. But the row summary and the form both
           * describe a preset as this board would apply it, so a `defaultTab`
           * the board can no longer show (someone converted a tracker board to a
           * standard one; an add-on was switched off) has been drawn as cleared
           * ever since `GET /api/boards` answered. Sending the un-narrowed value
           * back would store a setting this screen says is not there, and hand
           * it back the day that board changes type again.
           *
           * Narrowing here rather than at load is what makes that safe: with no
           * board in hand `tabsForBoard` offers everything, so a list that has
           * not arrived yet cannot delete anything. The server validates the
           * result regardless — `defaultTab` must name a real tab, and `tabs`
           * must be null or a non-empty list containing 'board'.
           */
          ...normalisePreset(row, boardsById.get(row.board) || null),
        })),
        nav: NAV_KEYS.reduce((acc, key) => {
          acc[key] = nav[key] !== false;
          return acc;
        }, {}),
      });

      // ONE sentence for `dropped`, whatever it described. The server merges
      // board entries it would not keep and board ids it stripped out of home
      // section configs into a single list, so counting them as two things here
      // would be this screen inventing a distinction the payload does not make.
      const dropped = result?.dropped || [];
      if (dropped.length > 0) {
        toastError(
          `Saved, but ${dropped.length} ${
            dropped.length === 1 ? 'board you cannot open was' : 'boards you cannot open were'
          } removed.`
        );
      } else {
        toastSuccess('Your view was saved.');
      }
    } catch (err) {
      console.error('Failed to save your view:', err);
      toastError(
        err?.response?.data?.error || 'Could not save your view. Please try again.'
      );
    } finally {
      setSaving(false);
    }
  };

  // Defensive: `SettingsPage` only renders this tab when `isExecutive`, which is
  // exactly `profile !== null`. The branch exists so that a profile deleted by
  // an admin while this tab is open degrades to a sentence rather than to a
  // crash on the render below.
  if (!profile) {
    return (
      <div>
        <TabHeader />
        <div className="mt-6">
          <EmptyState
            icon={LayoutDashboard}
            title="You do not have an executive view"
            description="This tab appears for people whose workspace screen has been curated for them."
          />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <TabHeader />
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
        </Button>
      </div>

      {/* ---------------------------- Navigation --------------------------- */}
      <section className="mt-6" aria-labelledby="myview-nav-heading">
        <h2
          id="myview-nav-heading"
          className="font-display font-semibold text-[color:var(--color-text-primary)]"
          style={{ fontSize: 15 }}
        >
          Navigation
        </h2>
        <p className="font-body text-[12.5px] text-[color:var(--color-text-secondary)] mt-1">
          Which destinations you keep in the left rail. All on by default.
        </p>

        <ul
          className="flex flex-col mt-3"
          style={{
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          {navRows().map((row, index) => (
            <li
              key={row.key}
              className="flex items-center justify-between gap-4"
              style={{
                padding: '10px 14px',
                borderBottom:
                  index === NAV_KEYS.length - 1
                    ? 'none'
                    : '1px solid var(--color-border)',
              }}
            >
              <div className="min-w-0">
                <p
                  className="font-body font-semibold text-[13.5px]"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  {row.label}
                </p>
                {row.hint && (
                  <p
                    className="font-body text-[12px]"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {row.hint}
                  </p>
                )}
              </div>
              <Switch
                checked={nav[row.key] !== false}
                disabled={saving}
                onChange={(next) => setNav((n) => ({ ...n, [row.key]: next }))}
                label={`${row.label} in my rail`}
              />
            </li>
          ))}
        </ul>

        {/* Invariant 6, said out loud. A switch that looks like it might grant
            something will eventually be clicked in the hope that it does, and
            the honest answer costs two lines. */}
        <p
          className="mt-3 font-body text-[12.5px]"
          style={{ color: 'var(--color-text-muted)' }}
        >
          A switch can only hide a destination your role already allows — it can
          never reveal one. Members, Analytics and Productivity each need a
          permission as well, so leaving those on does nothing if your role does
          not hold it. Home and Settings have no switch: they are how you get
          back to everything else.
        </p>
      </section>

      {/* ------------------------------ Boards ----------------------------- */}
      <section className="mt-8" aria-labelledby="myview-boards-heading">
        <h2
          id="myview-boards-heading"
          className="font-display font-semibold text-[color:var(--color-text-primary)]"
          style={{ fontSize: 15 }}
        >
          My boards
        </h2>
        <p className="font-body text-[12.5px] text-[color:var(--color-text-secondary)] mt-1">
          Drag to set the order they appear in, and give any of them a shorter
          name to find it by. Changing the order here changes only your screen.
        </p>

        {entries.length === 0 ? (
          <div
            className="mt-3"
            style={{
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <EmptyState
              icon={LayoutGrid}
              title="No boards on your list yet"
              description="When your admin adds boards to your view, they show up here."
            />
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={entries.map((e) => e.board)}
              strategy={verticalListSortingStrategy}
            >
              <ul
                className="flex flex-col mt-3"
                style={{
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                }}
              >
                {entries.map((entry, index) => (
                  <BoardRow
                    key={entry.board}
                    entry={entry}
                    board={boardsById.get(entry.board) || null}
                    isLast={index === entries.length - 1}
                    disabled={saving}
                    onLabelChange={setLabel}
                    onPresetChange={setPreset}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}

        <p
          className="mt-3 font-body text-[12.5px]"
          style={{ color: 'var(--color-text-muted)' }}
        >
          A short name is a nickname for you alone. The board keeps its real name
          everywhere else, and everybody else keeps seeing that one. “Tabs” on a
          row sets which tab that board opens on for you and which of its tabs
          you keep — neither can show you anything your permissions do not
          already allow.
        </p>
      </section>

      {/* ------------------------------- Home ------------------------------ */}
      <section className="mt-8" aria-labelledby="myview-home-heading">
        <h2
          id="myview-home-heading"
          className="font-display font-semibold text-[color:var(--color-text-primary)]"
          style={{ fontSize: 15 }}
        >
          Home page
        </h2>
        <p className="font-body text-[12.5px] text-[color:var(--color-text-secondary)] mt-1">
          The sections on your home page — goal scores, delivery, board tiles and
          the rest — are arranged on the page itself, where you can see them.
        </p>
        <div className="mt-3">
          {/* `navigate`, not a `Link` wrapped around a Button: a <button>
              inside an <a> is invalid markup and gives a screen reader two
              overlapping controls for one action. */}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => navigate('/dashboard')}
          >
            Go to my home page
          </Button>
        </div>
      </section>
    </div>
  );
};

const TabHeader = () => (
  <header>
    <h1
      className="font-display font-bold text-[color:var(--color-text-primary)]"
      style={{ fontSize: 22 }}
    >
      My view
    </h1>
    <p className="font-body text-[13px] text-[color:var(--color-text-secondary)] mt-1">
      Your rail, your board order, your names for them, and which tab each board
      opens on. Nothing here changes what you can open, and nothing here changes
      anybody else's screen.
    </p>
  </header>
);

/**
 * One board row: grip, name, nickname, and the tab presets behind a disclosure.
 *
 * `board` is null when `GET /api/boards` has not landed yet (or, rarely, when a
 * board left the list between the two reads). The row still renders — dropping
 * it would quietly shorten the list somebody is about to SAVE — and falls back
 * to the nickname, then to a neutral word, rather than claiming a name it does
 * not have. The preset form copes with the same null: with no board document to
 * read a type off it offers every tab and says it is unsure (`tabsForBoard`),
 * which is the honest answer and cannot destroy a preset already stored.
 *
 * ---- WHY THE PRESETS ARE FOLDED AWAY ---------------------------------------
 *
 * They are the rarest thing on this screen and the tallest: a dropdown, a mode
 * switch and up to ten checkboxes, per board. Inline they would turn a list
 * somebody scans to drag into four screens of form. Collapsed, the row keeps
 * saying what it is set to (`presetSummary`) so nothing is hidden — only
 * folded — and the default reads as the do-nothing it is.
 */
const BoardRow = ({
  entry,
  board,
  isLast,
  disabled,
  onLabelChange,
  onPresetChange,
}) => {
  const realName = board?.name || '';
  const shown = realName || entry.label || 'Board';
  // Open state is per row and deliberately local: it is not a preference worth
  // remembering, and lifting it would make the parent re-render the whole list
  // on a disclosure click.
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <SortableItem id={entry.board} disabled={disabled}>
      {({ ref, style, attributes, listeners, setActivatorNodeRef }) => (
        <li
          ref={ref}
          className="flex flex-col group/exec-row"
          style={{
            ...style,
            borderBottom: isLast ? 'none' : '1px solid var(--color-border)',
            background: 'var(--color-bg-surface)',
          }}
        >
          <div
            className="flex items-center gap-3"
            style={{ padding: '10px 14px' }}
          >
            <button
              ref={setActivatorNodeRef}
              type="button"
              aria-label={`Drag to reorder ${shown}`}
              disabled={disabled}
              {...attributes}
              {...listeners}
              className="flex items-center justify-center shrink-0 opacity-40 group-hover/exec-row:opacity-100 focus-visible:opacity-100 transition-opacity duration-150"
              style={{
                width: 20,
                height: 24,
                cursor: disabled ? 'not-allowed' : 'grab',
                // Without this a touch drag scrolls the settings panel instead.
                touchAction: 'none',
                background: 'transparent',
                border: 'none',
                padding: 0,
              }}
            >
              <GripVertical
                size={14}
                color="var(--color-text-muted)"
                aria-hidden="true"
              />
            </button>

            <div className="min-w-0 flex-1">
              <p
                className="font-body font-semibold text-[13.5px] truncate"
                style={{ color: 'var(--color-text-primary)' }}
              >
                {shown}
              </p>
              {/* Only worth a second line when the nickname is hiding the real
                  name. Repeating the name under itself is noise. */}
              {entry.label && realName ? (
                <p
                  className="font-body text-[12px] truncate"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  Shown to you as “{entry.label}”
                </p>
              ) : null}
            </div>

            {/* '' means "use the board's own name", which is why the placeholder
                is that name rather than a word like "Optional". Clamped to 60 to
                match the server's own clamp instead of letting it silently trim. */}
            <input
              type="text"
              value={entry.label}
              maxLength={60}
              disabled={disabled}
              onChange={(e) => onLabelChange(entry.board, e.target.value)}
              placeholder={realName || 'Short name'}
              aria-label={`Short name for ${shown}`}
              className="font-body shrink-0"
              style={{
                width: 160,
                maxWidth: '40%',
                fontSize: 13,
                padding: '6px 10px',
                borderRadius: 'var(--radius-md)',
                border: '1.5px solid var(--color-border)',
                background: 'var(--color-bg-input)',
                color: 'var(--color-text-primary)',
              }}
            />

            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              // The summary rides the accessible name so a screen reader hears
              // what is inside without having to open it.
              aria-label={`Tabs for ${shown} — ${presetSummary(entry, board)}`}
              title={presetSummary(entry, board)}
              className="shrink-0 inline-flex items-center gap-1 font-body rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                padding: '6px 8px',
                border: 'none',
                background: 'transparent',
                color: 'var(--color-text-secondary)',
                cursor: 'pointer',
              }}
            >
              <Chevron size={14} aria-hidden="true" />
              Tabs
            </button>
          </div>

          {open && (
            <div
              style={{
                padding: '2px 14px 14px 37px',
                background: 'var(--color-bg-surface)',
              }}
            >
              <BoardPresetFields
                board={board}
                entry={entry}
                boardName={shown}
                disabled={disabled}
                onChange={(preset) => onPresetChange(entry.board, board, preset)}
              />
            </div>
          )}
        </li>
      )}
    </SortableItem>
  );
};

export default MyViewTab;
