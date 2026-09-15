import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  GripVertical,
  LayoutDashboard,
  Plus,
  Trash2,
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
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';

import SortableItem from '../dnd/SortableItem';
import Button from '../ui/Button';
import EmptyState from '../ui/EmptyState';
import OptionMenu from '../ui/OptionMenu';
import { SegmentedControl } from '../ui/FormControls';
import { Panel, PanelHead } from '../board/addons/seo/LabsBits';
import SectionConfigForm from './SectionConfigForm';
import SECTION_REGISTRY from './sectionRegistry';
import { isMonthKey, formatMonthKey } from '../../utils/monthKeys';
import {
  addSection,
  boardTitle,
  normaliseHome,
  pickableBoards,
  removeSection,
  reorderSections,
  sectionKey,
  setConfig,
  setWidth,
} from '../../utils/executiveSections';

/**
 * SectionEditor — the one editor for an executive home, used by both screens.
 *
 * ---- WHY THERE IS ONE OF THESE AND NOT TWO --------------------------------
 *
 * An executive home is composed twice by two different people. An admin sets it
 * up in the configurator (`ExecutiveViewConfigPage.jsx`, the Home step), saving
 * through `PUT /api/orgs/:orgId/executive-views/:userId`. The executive
 * rearranges their own from the home page itself, saving through
 * `PUT /api/me/executive-view` (the store's `saveMine({ home })`). Same
 * document, same `home[]`, same validator on the far side — and, if there were
 * two components, two chances to disagree about what a width means, what a
 * removal does to `order`, or which board a picker may offer. The interesting
 * failures would only show on one of the two screens, which is the kind of bug
 * that gets reported as "it works for me".
 *
 * So this component NEVER CALLS AN API. It takes a list of sections, a list of
 * pickable boards, and a callback; it hands back a new list of sections. That
 * is the entire reason one component can serve both callers — the only thing
 * the two screens actually disagree about is which endpoint the result goes to
 * and which person's boards are pickable, and both of those are the caller's to
 * know. Nothing in here reads a store, and nothing in here knows whose home it
 * is editing.
 *
 * The arithmetic is not here either: every change to the list goes through
 * `utils/executiveSections.js`, which is pure and tested. What is left in this
 * file is dnd wiring, a menu, and the rows.
 *
 * ---- WHY SAVE AND CANCEL ARE EXPLICIT --------------------------------------
 *
 * The obvious build is to save on every change: drop a section, PUT; drag a row,
 * PUT. It feels modern and it makes "I was only trying it out" impossible. This
 * is somebody's home page — the screen they land on every morning — and the
 * cost of a change is asymmetric: adding a tile to see what it looks like is
 * cheap and should be free, while discovering that looking has already
 * rearranged the page and deleted the note you had on it is not a thing you can
 * undo by pressing anything.
 *
 * So there is a DRAFT, held here, and it becomes the document when somebody
 * says so. Cancel is "go back to the list the caller gave us", which is only a
 * restore because every helper in `executiveSections.js` is pure and the
 * original array is therefore still the original array. That property is
 * asserted in `executiveSections.test.mjs`; without it, Cancel would quietly be
 * a no-op and nobody would find out until a reload.
 *
 * ---- WHY THE DRAFT SURVIVES A RE-RENDER BUT NOT A SAVE --------------------
 *
 * The `home` prop is re-read whenever the caller hands over a different array,
 * but ONLY while the draft is clean. A caller that recomputes `home` inline (the
 * usual `profile?.home || []`) hands us a new array on every one of its own
 * renders; re-seeding on that would wipe a half-built section every time
 * anything else on the page changed state. A clean draft has nothing to lose
 * and takes the new value, which is what makes a save (or a profile reload)
 * land correctly; a dirty draft keeps the person's work and lets Save or Cancel
 * decide.
 */

/** Fired when nothing in the registry can be drawn — see the render below. */
const NO_TYPES = 'No section types are registered in this build.';

/**
 * What the footer says when a save was refused and the server did not say why.
 *
 * A LAST RESORT, not the usual message. Every refusal this editor can provoke
 * comes back as `{ error }` — the shape every handler in
 * `controllers/executiveViewController.js` answers with, and the one the app
 * reads everywhere else as `err?.response?.data?.error`. Those sentences are
 * written for the person reading them ("You do not have an executive view"),
 * and they are the only thing that distinguishes a save this person can retry
 * from one they cannot. Swallowing them here would be especially expensive on
 * the executive's OWN home page, where nothing else displays them: that page
 * toasts a success and a partial save, and re-throws the failure precisely so
 * this editor keeps the draft — so this line is the whole report.
 */
const SAVE_FAILED = 'That did not save.';

/**
 * The server's sentence, ended so it can sit in front of another one.
 *
 * Some of these messages are written as sentences and some as fragments
 * ("You do not have permission to manage executive views"), and the reassurance
 * that follows must not run into them.
 */
const asSentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** The server's explanation for a refused save, or our own if it gave none. */
const saveFailureMessage = (err) =>
  asSentence(String(err?.response?.data?.error || SAVE_FAILED).trim() || SAVE_FAILED);

const SectionEditor = ({
  /** The stored `home[]`. Sorted and densified on the way in. */
  home,
  /**
   * The boards this view's sections may point at — profile entries
   * (`[{ board, label }]`) or bare boards; `pickableBoards` takes either.
   * NOT every board the person can read: see `SectionConfigForm`'s header for
   * why the picker is narrowed here as well as on the server.
   */
  boards,
  /**
   * `components/executive/sectionRegistry.js`:
   * `{ [type]: { component, label, icon, description, defaultConfig, defaultWidth } }`.
   *
   * A PROP with the real table as its default, so the ordinary caller passes
   * nothing while a preview or a test can hand over a subset. Either way this
   * component has no opinion about which types exist — the registry is the only
   * list of section types on the client and there is deliberately no second one
   * in here.
   */
  registry = SECTION_REGISTRY,
  /**
   * `(nextHome) => void | Promise` — called on SAVE ONLY, never on a drag or a
   * keystroke. May return a promise; the buttons stay busy until it settles and
   * the draft stays dirty if it rejects, so a failed save does not look like a
   * successful one.
   */
  onChange,
  /** Optional: called after Cancel has reverted the draft (close a modal, etc). */
  onCancel,
  /** The caller's own in-flight flag, OR'd with this component's. */
  saving = false,
  title = 'Home sections',
  /** Optional line under the heading — the two callers word it differently. */
  description,
}) => {
  const seeded = useMemo(() => normaliseHome(home), [home]);
  const baselineRef = useRef(seeded);
  const [draft, setDraft] = useState(seeded);
  const [openKey, setOpenKey] = useState(null);
  // The house idiom for an anchored menu (see `SideRail.jsx`): a ref on the
  // trigger plus an open flag, so clicking the trigger again closes it rather
  // than re-anchoring a menu that is already up.
  const addButtonRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * The server's explanation for the last refused save, or null.
   *
   * A STRING rather than a boolean: see `saveFailureMessage`. It is cleared by
   * any edit, by Cancel, and at the start of the next attempt, so it can only
   * ever describe the save the person is actually looking at.
   */
  const [failure, setFailure] = useState(null);

  const dirty = draft !== baselineRef.current;
  const locked = busy || saving;

  // See the header: a CLEAN draft adopts whatever the caller now says, a dirty
  // one is somebody's unfinished work and is left alone.
  useEffect(() => {
    if (draft !== baselineRef.current) return;
    baselineRef.current = seeded;
    setDraft(seeded);
    // `draft` is deliberately not a dependency: this effect is about the caller
    // handing over a new list, and re-running it on every local edit is exactly
    // the wipe it exists to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seeded]);

  const pickable = useMemo(() => pickableBoards(boards), [boards]);

  /**
   * The "add a section" menu, in the order the registry lists its types — which
   * the registry's own header says is the order somebody BUILDS a page in
   * rather than the order the model stores.
   *
   * Derived from the `registry` PROP rather than read off the registry's
   * `ADDABLE_SECTIONS` constant, which is the same list for the default table:
   * a caller that injected a subset must get a menu of that subset, not of
   * everything this build can draw. No filtering for a missing renderer,
   * because the default table has one on every row by construction.
   */
  const typeOptions = useMemo(
    () =>
      Object.entries(registry || {}).map(([type, entry]) => ({
        value: type,
        label: entry?.label || type,
        icon: entry?.icon,
      })),
    [registry]
  );

  const sensors = useSensors(
    // Same activation distance as every other sortable list in the app, so a
    // click on a row's controls is not read as the start of a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const apply = (next) => {
    if (next === draft) return; // a helper refused; nothing to re-render
    setFailure(null);
    setDraft(next);
  };

  const handleAdd = (type) => {
    const next = addSection(draft, type, registry);
    if (next === draft) return;
    apply(next);
    // Opened straight away: a section that appears collapsed and unconfigured
    // at the bottom of a list is a thing somebody has to go and find.
    setOpenKey(sectionKey(next[next.length - 1]));
  };

  const handleDragEnd = ({ active, over }) => {
    if (!over || locked) return;
    apply(reorderSections(draft, active.id, over.id));
  };

  const handleSave = async () => {
    if (!dirty || locked) return;
    const committed = draft;
    setBusy(true);
    setFailure(null);
    try {
      await onChange?.(committed);
      // The baseline moves only on success, so a rejected save leaves the
      // editor dirty and the Save button live rather than pretending.
      baselineRef.current = committed;
      setDraft(committed);
    } catch (err) {
      console.error('Failed to save home sections:', err);
      // The server's own words, not a generic refusal — see `SAVE_FAILED`.
      setFailure(saveFailureMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = () => {
    if (locked) return;
    const reverted = normaliseHome(home);
    baselineRef.current = reverted;
    setDraft(reverted);
    setOpenKey(null);
    setFailure(null);
    onCancel?.();
  };

  return (
    <Panel>
      <PanelHead
        title={title}
        sub={description || `${draft.length} ${draft.length === 1 ? 'section' : 'sections'}`}
        right={
          <Button
            ref={addButtonRef}
            size="sm"
            variant="secondary"
            icon={Plus}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={locked || typeOptions.length === 0}
            onClick={() => setMenuOpen((v) => !v)}
          >
            Add section
          </Button>
        }
      />

      {menuOpen && (
        <OptionMenu
          anchorEl={addButtonRef.current}
          title="Add a section"
          options={typeOptions}
          onSelect={handleAdd}
          onClose={() => setMenuOpen(false)}
          ariaLabel="Section types"
        />
      )}

      <div className="px-4 py-4">
        {typeOptions.length === 0 ? (
          // A build with no registry is a wiring mistake, not a state a person
          // can be in — so it says so plainly rather than rendering an empty
          // page that looks like a feature with nothing in it.
          <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
            {NO_TYPES}
          </p>
        ) : draft.length === 0 ? (
          <EmptyState
            icon={LayoutDashboard}
            title="Nothing on this home page yet"
            description="Add a section and it will show up here in the order you arrange them."
          />
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={draft.map(sectionKey)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="flex flex-col gap-2 list-none p-0 m-0">
                {draft.map((section) => {
                  const key = sectionKey(section);
                  return (
                    <SectionRow
                      key={key}
                      id={key}
                      section={section}
                      entry={registry?.[section.type]}
                      boards={pickable}
                      registry={registry}
                      disabled={locked}
                      open={openKey === key}
                      onToggleOpen={() => setOpenKey(openKey === key ? null : key)}
                      onWidth={(width) => apply(setWidth(draft, key, width))}
                      onConfig={(patch) => apply(setConfig(draft, key, patch))}
                      onRemove={() => {
                        if (openKey === key) setOpenKey(null);
                        apply(removeSection(draft, key));
                      }}
                    />
                  );
                })}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </div>

      <footer
        className="flex flex-wrap items-center gap-3 px-4 py-3"
        style={{ borderTop: '1px solid var(--color-border)' }}
      >
        <span
          className="font-body"
          style={{
            fontSize: 12,
            color: failure ? 'var(--color-status-stuck)' : 'var(--color-text-muted)',
          }}
        >
          {/* The server's sentence first, then the reassurance. The reassurance
              on its own is what this used to say, and it told somebody whose
              role had just lost a capability to "try again" — which they can do
              all afternoon. The explanation is the part that ends the loop, and
              on the home page this line is the only place it appears. */}
          {failure
            ? `${failure} Nothing has been lost — your changes are still here.`
            : dirty
              ? 'Unsaved changes'
              : 'Everything here is saved'}
        </span>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="secondary"
          onClick={handleCancel}
          disabled={locked || (!dirty && !onCancel)}
        >
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={handleSave} disabled={!dirty || locked}>
          {locked ? 'Saving…' : 'Save'}
        </Button>
      </footer>
    </Panel>
  );
};

/**
 * One row: a drag handle, what the section is, how wide it is, and — when
 * opened — its config form.
 *
 * The handle owns the drag listeners rather than the whole row, the same way
 * `SortableBoardCard` in `MyBoardsPage.jsx` does it: a row full of controls
 * that is also draggable everywhere is a row where every click is a possible
 * drag.
 *
 * Removal has no confirmation, deliberately. The editor is Save/Cancel, so a
 * removal is undone by cancelling; a modal in front of an action that is
 * already reversible is furniture that teaches people to click through modals.
 */
const SectionRow = ({
  id,
  section,
  entry,
  boards,
  registry,
  disabled,
  open,
  onToggleOpen,
  onWidth,
  onConfig,
  onRemove,
}) => {
  const Icon = entry?.icon || null;
  // A stored section whose type this build no longer registers still renders,
  // with its raw type for a name. It cannot be configured (the form says so),
  // but it CAN be moved and removed — which is the only way anybody would ever
  // get rid of it.
  const label = entry?.label || section.type;
  const subtitle = describeSection(section, boards, entry);

  return (
    <SortableItem id={id} data={{ type: 'executiveSection' }} disabled={disabled}>
      {({ ref, setActivatorNodeRef, style, attributes, listeners, isDragging }) => (
        <li
          ref={ref}
          style={{
            ...style,
            position: 'relative',
            zIndex: isDragging ? 20 : 'auto',
            background: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <div className="flex flex-wrap items-center gap-2 px-2 py-2 sm:px-3">
            <button
              ref={setActivatorNodeRef}
              type="button"
              aria-label={`Drag to reorder ${label}`}
              disabled={disabled}
              {...attributes}
              {...listeners}
              className="shrink-0 inline-flex items-center justify-center"
              style={{
                width: 28,
                height: 28,
                borderRadius: 'var(--radius-sm)',
                border: 'none',
                background: 'transparent',
                color: 'var(--color-text-muted)',
                cursor: disabled ? 'not-allowed' : 'grab',
                touchAction: 'none',
              }}
            >
              <GripVertical size={15} aria-hidden="true" />
            </button>

            {Icon ? (
              <Icon
                size={16}
                aria-hidden="true"
                className="shrink-0"
                style={{ color: 'var(--color-text-secondary)' }}
              />
            ) : null}

            <span className="min-w-0 flex-1">
              <span
                className="block font-body font-semibold truncate"
                style={{ fontSize: 13.5, color: 'var(--color-text-primary)' }}
              >
                {label}
              </span>
              {subtitle ? (
                <span
                  className="block font-body truncate"
                  style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
                >
                  {subtitle}
                </span>
              ) : null}
            </span>

            <SegmentedControl
              options={[
                { value: 'full', label: 'Full' },
                { value: 'half', label: 'Half' },
              ]}
              value={section.width}
              disabled={disabled}
              onChange={onWidth}
            />

            <button
              type="button"
              onClick={onToggleOpen}
              disabled={disabled}
              aria-expanded={open}
              aria-controls={`section-config-${id}`}
              aria-label={open ? `Hide ${label} settings` : `Edit ${label} settings`}
              className="shrink-0 inline-flex items-center justify-center transition-transform"
              style={{
                width: 30,
                height: 30,
                borderRadius: 'var(--radius-sm)',
                border: '1.5px solid var(--color-border)',
                background: 'transparent',
                color: 'var(--color-text-secondary)',
                cursor: disabled ? 'not-allowed' : 'pointer',
                transform: open ? 'rotate(180deg)' : 'rotate(0)',
              }}
            >
              <ChevronDown size={15} aria-hidden="true" />
            </button>

            <button
              type="button"
              onClick={onRemove}
              disabled={disabled}
              aria-label={`Remove ${label}`}
              className="shrink-0 inline-flex items-center justify-center"
              style={{
                width: 30,
                height: 30,
                borderRadius: 'var(--radius-sm)',
                border: 'none',
                background: 'transparent',
                color: 'var(--color-text-muted)',
                cursor: disabled ? 'not-allowed' : 'pointer',
              }}
            >
              <Trash2 size={15} aria-hidden="true" />
            </button>
          </div>

          {open && (
            <div
              id={`section-config-${id}`}
              className="px-3 pb-3 pt-1 sm:px-4"
              style={{ borderTop: '1px solid var(--color-border)' }}
            >
              <SectionConfigForm
                type={section.type}
                config={section.config}
                registry={registry}
                boards={boards}
                onChange={onConfig}
                disabled={disabled}
              />
            </div>
          )}
        </li>
      )}
    </SortableItem>
  );
};

/**
 * The one line under a row's name.
 *
 * Read off the CONFIG KEYS rather than off the type, for the same reason the
 * form is (see its header): `board` and `month` mean the same thing wherever
 * they appear, so this is written once and a new section type that reuses them
 * is summarised without an edit here.
 *
 * It matters most when a home has three `goalScores` sections. Three rows
 * reading "Goal scores" are three rows nobody can tell apart, so the board and
 * the month — the two things that actually distinguish them — are what this
 * prints, and the registry's description is only the fallback for a section
 * with neither.
 */
const describeSection = (section, boards, entry) => {
  const config = section?.config || {};
  const parts = [];

  if (config.board) {
    const board = boards.find((b) => b.id === String(config.board));
    // Named if we have it, and otherwise said plainly: a section pointing at a
    // board that has left the view is exactly the row somebody needs to notice.
    parts.push(board ? boardTitle(board) : 'A board no longer on this view');
  }
  if (isMonthKey(config.month)) parts.push(formatMonthKey(config.month));

  return parts.length > 0 ? parts.join(' · ') : entry?.description || '';
};

export default SectionEditor;
