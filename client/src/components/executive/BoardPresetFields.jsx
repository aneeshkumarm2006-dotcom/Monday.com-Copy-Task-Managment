import { useMemo } from 'react';

import Dropdown from '../ui/Dropdown';
import { SegmentedControl } from '../ui/FormControls';
import {
  BASE_TAB,
  normalisePreset,
  tabsForBoard,
} from '../../utils/executiveBoards';

/**
 * BoardPresetFields — the two per-board presets, on both screens that set them.
 *
 * One board entry carries `defaultTab` (which `?view=` that board opens on for
 * this person) and `tabs` (an allowlist of tab values, or null for every tab).
 * This component is the only control for either, and it is rendered from BOTH
 * the admin's configurator (`pages/ExecutiveViewConfigPage.jsx`, Boards step)
 * and the person's own Settings tab (`components/settings/MyViewTab.jsx`),
 * exactly as `SectionEditor` is shared between the same two screens.
 *
 * ---- WHY ONE COMPONENT AND NOT ONE PER SCREEN ------------------------------
 *
 * Because of a single rule that is invisible when it is obeyed: an allowlist
 * must always contain `'board'`. A board with no tabs cannot be opened at all,
 * so the server refuses such a shape (`validateBoardEntry`), the board page
 * repairs it again at render time (`resolveViewTabs` keeps `'board'` alive
 * whatever the allowlist says), and the form below cannot compose one. Two
 * copies of this form would be two places for that rule to be forgotten — and
 * the copy that forgot it would fail as a red banner from a 400, on one of the
 * two screens, for whoever happened to untick the wrong box.
 *
 * The same argument covers the smaller rules: which tabs a board can actually
 * show, what an empty list means, and why a stored preset for a tab that no
 * longer exists has to degrade rather than persist. All of them live in
 * `utils/executiveBoards.js` (`tabsForBoard`, `normalisePreset`) and every
 * control here reports through `normalisePreset`, so the value that leaves this
 * component is always one the server will accept.
 *
 * ---- PRESENTATION ONLY, AND IN NOBODY'S VOICE ------------------------------
 *
 * It makes no request, reads no store, and does not know which of the two
 * screens is hosting it. That is also why the copy below is neutral — "Opens
 * on", "Tabs shown" — rather than "they" or "you": each host writes its own
 * blurb above its own list, where it knows whose screen is being described. A
 * `voice` prop would be a switch that has to be passed correctly at both call
 * sites in order to say something neither call site is confused about.
 *
 * ---- "EVERY TAB" IS A CHOICE, NOT AN EMPTY LIST ----------------------------
 *
 * The mode control is the load-bearing part of this UI. `tabs: null` means
 * "whatever tabs this board has"; `tabs: [all ten of them]` means "these ten".
 * They look identical today and diverge the day an eleventh tab ships — the
 * first keeps up, the second freezes, for one person on one board, with nothing
 * on screen to explain it. So they are two visibly different states here rather
 * than "all the boxes happen to be ticked", and the hint under the checkboxes
 * says out loud what an allowlist costs.
 *
 * ---- WHAT THIS FORM CANNOT KNOW, AND SAYS SO -------------------------------
 *
 * Two things, and they are admitted rather than guessed at.
 *
 *   THE CONNECTOR TABS depend on a per-board request neither host makes (see
 *   `tabsForBoard`). They are offered with "if switched on" beside them, which
 *   is the honest word: offering one costs nothing, because an allowlist can
 *   only ever subtract from the tabs the board actually resolved.
 *
 *   CAPABILITIES are not resolvable from either screen — an admin's reach on a
 *   board is not the target's, and a person's own Settings page is not their
 *   board page. So the footnote says it once, for the whole form, instead of
 *   putting a doubt marker on nine rows out of ten.
 */

/** The `value` the "Opens on" dropdown carries for "no preset" — stored as null. */
const NO_DEFAULT = '';

const MODE_OPTIONS = [
  { value: 'all', label: 'Every tab' },
  { value: 'some', label: 'Choose tabs' },
];

/**
 * A labelled row. Same treatment as `SectionConfigForm`'s `Field`, deliberately
 * — these two forms sit on the same screens and a second label style would read
 * as a second kind of setting.
 */
const Field = ({ label, hint, children }) => (
  <div className="w-full min-w-0">
    <span
      className="block mb-2 font-body font-medium uppercase tracking-wide"
      style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}
    >
      {label}
    </span>
    {children}
    {hint ? (
      <p
        className="mt-1.5 font-body"
        style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
      >
        {hint}
      </p>
    ) : null}
  </div>
);

/**
 * @param {Object}   props
 * @param {Object}   props.board     - the board document, or null when the host
 *                                     cannot read it (see `tabsForBoard`)
 * @param {Object}   props.entry     - `{ defaultTab, tabs }` as currently edited
 * @param {string}   props.boardName - what this board is called on screen, for
 *                                     the accessible names of the controls
 * @param {boolean}  props.disabled
 * @param {Function} props.onChange  - `(preset) => void`, already normalised
 */
const BoardPresetFields = ({
  board,
  entry,
  boardName = 'this board',
  disabled = false,
  onChange,
}) => {
  // What this board could show, and the preset as it currently stands. Both go
  // through the same two helpers the save path uses, so what is drawn is what
  // would be stored — a form that renders one thing and saves another is the
  // bug this whole file is arranged to prevent.
  const candidates = useMemo(() => tabsForBoard(board), [board]);
  const preset = useMemo(() => normalisePreset(entry, board), [entry, board]);

  const allowlist = preset.tabs;
  const mode = allowlist ? 'some' : 'all';

  /** Everything leaves through here, so nothing unsendable can leave at all. */
  const emit = (next) => onChange?.(normalisePreset(next, board));

  /**
   * Switching to an allowlist SEEDS IT WITH WHAT THE BOARD SHOWS TODAY.
   *
   * The alternative — seeding with `['board']` — is tidier in principle and
   * worse in practice: somebody who opens this to hide ONE tab would have to
   * tick five boxes to get back to where they started, and a form that begins
   * by hiding everything invites a save that hides everything. The freeze this
   * costs is inherent to choosing an allowlist at all rather than to the seed
   * (any list freezes), it is spelled out in the hint under the boxes, and it
   * took a deliberate click on "Choose tabs" to get here.
   */
  const setMode = (next) =>
    emit({
      defaultTab: preset.defaultTab,
      tabs: next === 'some' ? candidates.map((t) => t.value) : null,
    });

  const toggleTab = (value, checked) => {
    // The main tab has no toggle to honour — its box is checked and disabled —
    // and `normalisePreset` would put it back anyway. Ignored here so that a
    // stray click cannot even briefly render a board with nothing to open.
    if (value === BASE_TAB) return;
    const current = new Set(allowlist || candidates.map((t) => t.value));
    if (checked) current.add(value);
    else current.delete(value);
    emit({ defaultTab: preset.defaultTab, tabs: [...current] });
  };

  /**
   * The "Opens on" options: the board's own tabs, NARROWED BY THE ALLOWLIST.
   *
   * A default that the allowlist does not carry is cleared on save — the board
   * page would fall back to the board view anyway — so offering one here would
   * be offering a choice that silently unmakes itself. Narrowing the list makes
   * the two controls agree instead of racing.
   *
   * `'board'` is not among them: it is the same instruction as the null option
   * above it, and two options that do one thing is a question with a wrong
   * answer in it.
   */
  const defaultOptions = useMemo(() => {
    const rows = candidates.filter(
      (tab) =>
        tab.value !== BASE_TAB && (!allowlist || allowlist.includes(tab.value))
    );
    return [
      { value: NO_DEFAULT, label: 'Board (default)' },
      ...rows.map((tab) => ({
        value: tab.value,
        // The honest word for a tab whose existence this screen cannot check.
        label: tab.certain ? tab.label : `${tab.label} (if switched on)`,
      })),
    ];
  }, [candidates, allowlist]);

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Opens on"
        hint={
          allowlist
            ? 'Only tabs on the list below can be the one it opens on.'
            : 'The tab this board lands on when nothing in the link says otherwise.'
        }
      >
        <Dropdown
          size="sm"
          value={preset.defaultTab || NO_DEFAULT}
          options={defaultOptions}
          disabled={disabled}
          ariaLabel={`Tab ${boardName} opens on`}
          onChange={(value) =>
            emit({ defaultTab: value || null, tabs: allowlist })
          }
        />
      </Field>

      <Field label="Tabs shown">
        <SegmentedControl
          options={MODE_OPTIONS}
          value={mode}
          disabled={disabled}
          onChange={setMode}
        />

        {mode === 'some' && (
          <>
            <ul
              className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3"
              role="group"
              aria-label={`Tabs shown on ${boardName}`}
            >
              {candidates.map((tab) => {
                const locked = tab.value === BASE_TAB;
                return (
                  <li key={tab.value}>
                    <label
                      className="flex items-center gap-2 font-body"
                      style={{
                        fontSize: 13,
                        color: 'var(--color-text-primary)',
                        cursor: disabled || locked ? 'default' : 'pointer',
                      }}
                      // The reason the box cannot be unticked, on the thing
                      // that cannot be unticked. A disabled control with no
                      // explanation is read as a bug.
                      title={
                        locked
                          ? 'Every board keeps its main tab'
                          : tab.certain
                            ? undefined
                            : 'Only appears when this board has that switched on.'
                      }
                    >
                      <input
                        type="checkbox"
                        checked={locked || allowlist.includes(tab.value)}
                        disabled={disabled || locked}
                        onChange={(e) => toggleTab(tab.value, e.target.checked)}
                      />
                      <span>{tab.label}</span>
                      {locked && (
                        <span
                          className="font-body"
                          style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
                        >
                          always
                        </span>
                      )}
                      {!locked && !tab.certain && (
                        <span
                          className="font-body"
                          style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
                        >
                          if switched on
                        </span>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>

            {/* What an allowlist actually costs, said where it is chosen. */}
            <p
              className="mt-2 font-body"
              style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
            >
              This list is fixed from now on. A tab added to the product later
              will not show up on this board until somebody ticks it here —
              <strong> Every tab</strong> is the setting that keeps up on its
              own.
            </p>
          </>
        )}

        {mode === 'all' && (
          <p
            className="mt-2 font-body"
            style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
          >
            Every tab this board has, including any added later. Choosing tabs
            instead pins the list to the ones ticked today.
          </p>
        )}
      </Field>

      {/* Said once for the whole form rather than on nine rows out of ten:
          nothing here can reveal a tab, only hide one. */}
      <p
        className="font-body"
        style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
      >
        Tabs are hidden, never revealed: a tab their permissions or this board's
        add-ons already hide stays hidden whatever is set here.
      </p>
    </div>
  );
};

export default BoardPresetFields;
