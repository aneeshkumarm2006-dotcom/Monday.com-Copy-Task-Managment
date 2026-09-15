import { useState } from 'react';

import Dropdown from '../ui/Dropdown';
import Input from '../ui/Input';
import { NumberField, SegmentedControl } from '../ui/FormControls';
import { isMonthKey, formatMonthKey } from '../../utils/monthKeys';
import { boardTitle, configDefaultsFor } from '../../utils/executiveSections';
import SECTION_REGISTRY, {
  // The option lists and clamps live in the registry, beside the
  // `defaultConfig` values they belong to, and are that file's mirror of
  // `VALID_RANGES` / `MY_WORK_DUE` / `MAX_MY_WORK` / `MAX_NOTE_*` on the
  // server. Imported rather than restated: a third copy of "which ranges are
  // legal" is how a form comes to offer a value the server silently rewrites.
  ANALYTICS_RANGE_OPTIONS,
  MY_WORK_DUE_OPTIONS,
  MY_WORK_LIMIT_MAX,
  NOTE_TEXT_MAX,
  NOTE_TITLE_MAX,
} from './sectionRegistry';

/**
 * SectionConfigForm — the fields behind one home section's `config`.
 *
 * Rendered inside `SectionEditor.jsx`, once per section, when somebody opens a
 * row. Like the editor around it, it is PRESENTATION ONLY: it makes no request,
 * reads no store, and knows nothing about which of the two screens is hosting
 * it. It reports a PATCH — the keys it changed, and only those — and the editor
 * merges it with `setConfig`.
 *
 * ---- WHY IT REPORTS A PATCH RATHER THAN A CONFIG ---------------------------
 *
 * Not every key of a config is editable here, and the one that is not matters:
 * `goalScores` carries `groups`, the list of clients the section is narrowed to
 * (`{ board, month, groups }` — see the contract's config table). Narrowing it
 * needs the BOARD's group list, which needs a request, which this component
 * does not make. So `groups` is not drawn, and if this form reported a whole
 * config every time somebody changed the month, that narrowing would be deleted
 * silently: the section would widen from three clients to forty, on a page
 * whose entire point is the three, and nothing on screen would have said so.
 *
 * A patch cannot do that. `setConfig` merges, the untouched keys survive, and
 * the one place that could have dropped them does not know they exist.
 *
 * ---- WHY THE FIELDS COME FROM THE CONFIG'S KEYS, NOT FROM THE TYPE ---------
 *
 * There is no `switch (type)` below. The fields are looked up by CONFIG KEY —
 * `board`, `month`, `range`, `due`, `limit`, `title`, `text` — against the key
 * set the registry's `defaultConfig` declares for that type, merged under
 * whatever is stored. Three consequences, all wanted:
 *
 *   - A key means the same thing everywhere. `board` on `goalScores`,
 *     `deliveryScores` and `adsBudgetPacing` is one field written once, so
 *     three board pickers cannot drift into three different controls.
 *   - A NEW section type that reuses `board` + `month` needs no edit here at
 *     all. Registering it is a registry row, a server handler and a renderer —
 *     which is the promise `executiveHome.js` makes in its own header, and this
 *     is what keeps it true on the client.
 *   - A type this build does not know still opens: an unknown type has no
 *     declared keys, so the form says so plainly instead of throwing, and the
 *     row can still be reordered or removed.
 *
 * `PER_TYPE_COPY` below is the exception, and it is deliberately only COPY. It
 * never decides which types exist or which fields they have — a type missing
 * from it renders with the generic wording.
 *
 * ---- THE BOARD PICKER LISTS THE VIEW'S BOARDS AND NOTHING ELSE -------------
 *
 * `boards` is the profile's board list (`pickableBoards` in
 * `utils/executiveSections.js` shapes it), never every board the person can
 * read. The server enforces the same rule from the other end — every section's
 * board is re-checked with `resolveAccess(...).canRead` before its handler runs
 * (`services/executiveHome.js`, invariant 1), and the self PUT strips a board
 * id out of a section config the caller cannot read. Both saying it is the
 * point: the server's check is what makes it SAFE, this one is what makes it
 * make SENSE, because an option that saves and then renders "You no longer have
 * access to this board" is a worse answer than an option that was never
 * offered.
 */

/**
 * The fields, in the order they are drawn. A config key absent from this list
 * is simply not editable here (see `groups` above); a key in this list that the
 * type does not declare is not drawn.
 */
const FIELD_ORDER = ['board', 'boards', 'month', 'range', 'due', 'limit', 'title', 'text'];

/**
 * Per-type wording only — never a list of types, never a list of fields.
 *
 * The one place the same key genuinely says different things: `board: null` on
 * `workspaceNumbers` means "every board you can read" (the analytics report's
 * own default), while on a goal or delivery section it means the section has
 * not been pointed at anything yet. Same control, same stored value, two
 * different sentences, and printing the wrong one would tell somebody their
 * section is configured when it is not.
 */
const PER_TYPE_COPY = {
  workspaceNumbers: {
    boardLabel: 'Narrow to one board',
    boardEmpty: 'Every board you can read',
    boardHint: 'Leave this as it is for workspace-wide numbers.',
  },
};

/** The `value` a Dropdown carries for "no board" — `''`, stored as `null`. */
const NO_BOARD = '';

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A labelled row. Every control gets the same label treatment and the same
 * hint slot, including the ones (`SegmentedControl`, the chip list,
 * `NumberField`) that have no label prop of their own.
 */
const Field = ({ label, hint, children }) => (
  <div className="w-full">
    <span
      className="block mb-2 font-body font-medium uppercase tracking-wide"
      style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}
    >
      {label}
    </span>
    {children}
    {hint ? (
      <p className="mt-1.5 font-body" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
        {hint}
      </p>
    ) : null}
  </div>
);

/**
 * One board, or none.
 *
 * A stored id that is NOT in `boards` still gets an option of its own. That
 * happens whenever a board leaves the view after a section was pointed at it,
 * and without the extra option the picker would show its placeholder — which
 * reads as "not configured" for a section that is configured, and points at
 * something. Saying so is the honest control; the person can then choose
 * another board or leave it, and the composer will draw the tile's own
 * "unavailable" either way.
 */
const BoardField = ({ type, value, boards, onChange, disabled }) => {
  const copy = PER_TYPE_COPY[type] || {};
  const stored = value ? String(value) : '';
  const known = boards.some((b) => b.id === stored);

  const options = [
    { value: NO_BOARD, label: copy.boardEmpty || 'Not chosen yet' },
    ...boards.map((b) => ({ value: b.id, label: boardTitle(b) })),
  ];
  if (stored && !known) {
    options.push({ value: stored, label: 'A board that is no longer on this view' });
  }

  return (
    <Field
      label={copy.boardLabel || 'Board'}
      hint={
        boards.length === 0
          ? 'There are no boards on this view yet, so there is nothing to point this at.'
          : copy.boardHint
      }
    >
      <Dropdown
        options={options}
        value={stored}
        // `''` is how the Dropdown spells "none"; the document spells it `null`.
        onChange={(next) => onChange({ board: next || null })}
        disabled={disabled}
        ariaLabel={copy.boardLabel || 'Board for this section'}
        placeholder={copy.boardEmpty || 'Not chosen yet'}
      />
    </Field>
  );
};

/**
 * Several boards, or none — which means ALL of them.
 *
 * Empty is not "no boards", it is "every board on this view" (the contract's
 * config table says so, and the composer reads it that way). That is a genuine
 * trap for anybody reading the control, so the hint says it out loud, and the
 * empty state is phrased as a choice rather than as an omission.
 *
 * Chips rather than a multi-select menu: a view carries a handful of boards, the
 * whole point of this section is WHICH ones, and a closed menu answers that with
 * a number.
 */
const BoardsField = ({ value, boards, onChange, disabled }) => {
  const chosen = Array.isArray(value) ? value.map(String) : [];

  const toggle = (id) => {
    const next = chosen.includes(id)
      ? chosen.filter((b) => b !== id)
      : [...chosen, id];

    // Sorted back into the VIEW's own order rather than click order, so the
    // tiles come out in the order the boards were dragged into on My Boards.
    // Anything chosen that is no longer on the view keeps its place at the end
    // rather than being dropped: this is a click on a different chip, and it
    // must not quietly edit a choice nobody touched.
    const onView = boards.map((b) => b.id);
    onChange({
      boards: [
        ...onView.filter((id2) => next.includes(id2)),
        ...next.filter((id2) => !onView.includes(id2)),
      ],
    });
  };

  return (
    <Field
      label="Boards"
      hint={
        boards.length === 0
          ? 'There are no boards on this view yet.'
          : 'Choose none to show every board on this view, in the order they are listed.'
      }
    >
      <div className="flex flex-wrap gap-2">
        {boards.map((board) => {
          const selected = chosen.includes(board.id);
          return (
            <button
              key={board.id}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              onClick={() => toggle(board.id)}
              className="font-body max-w-full truncate"
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: '5px 12px',
                borderRadius: 'var(--radius-full)',
                border: selected
                  ? '1.5px solid var(--color-accent)'
                  : '1.5px solid var(--color-border)',
                background: selected ? 'var(--color-accent-light)' : 'transparent',
                color: selected
                  ? 'var(--color-accent-text)'
                  : 'var(--color-text-secondary)',
                cursor: disabled ? 'not-allowed' : 'pointer',
              }}
            >
              {boardTitle(board)}
            </button>
          );
        })}
      </div>
    </Field>
  );
};

/**
 * "Current month" or a fixed one.
 *
 * ---- WHY "CURRENT MONTH" IS A REAL OPTION AND NOT A BLANK -----------------
 *
 * `month: null` means "whichever month it is now, resolved in the BOARD's
 * timezone" (`monthFor` in `services/executiveHome.js`). That is the setting
 * almost everybody wants and the one a blank field hides: somebody who sets up
 * a home page in September and is offered only a month box will type September,
 * and their home page will still be showing September in January. So it is a
 * named, selectable, default choice, and the hint says what each one does in so
 * many words.
 *
 * ---- WHY THE CLIENT DOES NOT OFFER A LIST OF MONTHS ------------------------
 *
 * Because it does not know what month it is. `utils/monthKeys.js` says so in
 * its own header and means it: the answer depends on the board's timezone, and
 * there is no timezone-aware day math on this side of the wire — `new
 * Date().getMonth()` is the browser's month and is wrong for anybody whose
 * board lives somewhere else, for a day at a time, twelve times a year.
 *
 * So the choice is between a value the SERVER resolves (`null`) and a value a
 * PERSON states. `<input type="month">` is exactly the second one: the browser
 * owns the calendar, and its value is already the `YYYY-MM` the document
 * stores. Nothing here computes a month, which is the property that keeps this
 * file out of the argument.
 *
 * Choosing "A specific month" and leaving the box empty keeps `month: null` —
 * the section stays on the current month until a month is actually named, which
 * is the truthful reading of a control nobody has filled in.
 */
const MonthField = ({ value, onChange, disabled }) => {
  const pinned = isMonthKey(value) ? value : null;
  // Which radio is lit, held locally: somebody who picks "A specific month" has
  // not chosen one yet, and the control must not snap back to "Current" under
  // their hand while they reach for the calendar.
  const [mode, setMode] = useState(pinned ? 'pinned' : 'current');

  return (
    <Field
      label="Month"
      hint={
        mode !== 'pinned'
          ? 'Always the month it is now, in the board’s own timezone.'
          : pinned
            ? `Fixed to ${formatMonthKey(pinned)}. It will not move on.`
            // The toggle is on "specific" but nothing has been named yet, so
            // the stored value is still null. Saying which of the two is
            // actually in force beats leaving the person to assume.
            : 'Name a month. Until you do, this stays on the current one.'
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          options={[
            { value: 'current', label: 'Current month' },
            { value: 'pinned', label: 'A specific month' },
          ]}
          value={mode}
          disabled={disabled}
          onChange={(next) => {
            setMode(next);
            // Switching back to "current" clears the pin immediately — the
            // stored value and the control must never disagree about which
            // month this section is about.
            if (next === 'current') onChange({ month: null });
          }}
        />

        {mode === 'pinned' && (
          <input
            type="month"
            value={pinned || ''}
            disabled={disabled}
            aria-label="Which month"
            onChange={(e) => {
              const next = e.target.value;
              // A cleared box is `null`, not an empty string: the config stores
              // one or the other, and '' would fail `isMonthKey` server-side and
              // be normalised to null anyway — with a round trip to find out.
              onChange({ month: isMonthKey(next) ? next : null });
            }}
            className="font-body"
            style={{
              height: 38,
              padding: '0 10px',
              borderRadius: 'var(--radius-md)',
              border: '1.5px solid var(--color-border)',
              background: 'var(--color-bg-input)',
              color: 'var(--color-text-primary)',
              fontSize: 14,
              opacity: disabled ? 0.6 : 1,
            }}
          />
        )}
      </div>
    </Field>
  );
};

/**
 * The fields, keyed by CONFIG KEY. Each one takes the whole context and reports
 * a patch; none of them knows which section type it is inside except through
 * `type`, which it uses for wording only.
 *
 * The context is `{ type, value, defaultValue, boards, disabled, onChange }`.
 * `defaultValue` is this key's entry in the registry's `defaultConfig` for this
 * type — what the section started life with — and it is there for the one thing
 * a control cannot work out for itself: what to put back when somebody empties
 * it. See `limit`.
 */
const FIELDS = {
  board: (ctx) => <BoardField {...ctx} />,

  boards: (ctx) => <BoardsField {...ctx} />,

  month: (ctx) => <MonthField {...ctx} />,

  range: ({ value, onChange, disabled }) => (
    <Field label="Time range" hint="Matches the range picker on the Analytics page.">
      <Dropdown
        options={ANALYTICS_RANGE_OPTIONS}
        value={value}
        onChange={(next) => onChange({ range: next })}
        disabled={disabled}
        ariaLabel="Time range"
      />
    </Field>
  ),

  due: ({ value, onChange, disabled }) => (
    <Field
      label="Which tasks"
      hint="The same buckets as My Work, so the two agree about what “this week” means."
    >
      <Dropdown
        options={MY_WORK_DUE_OPTIONS}
        value={value}
        onChange={(next) => onChange({ due: next })}
        disabled={disabled}
        ariaLabel="Which tasks to show"
      />
    </Field>
  ),

  /**
   * How many rows the My Work tile draws.
   *
   * ---- WHY AN EMPTY BOX IS ALLOWED TO STAY EMPTY --------------------------
   *
   * A number box is edited by clearing it and typing the new number, so "" is a
   * KEYSTROKE on the way to a value, not an answer. This field used to rewrite
   * it to 1 the instant the box went empty, which meant that changing 20 to 30
   * put a 1 in front of the 0 the person typed next and saved 10 — a wrong
   * number, arrived at without anybody making a mistake.
   *
   * So the empty string is held as it is typed and coerced when the field is
   * LEFT, which is the idiom `NumberField` was built for: it already reports ''
   * for an unparseable box (`ui/FormControls.jsx`), and `TrackersModal` holds
   * that '' in its form state and resolves it on save the same way.
   *
   * `onBlur` sits on the wrapper rather than on the input because
   * `NumberField` takes no blur prop, and React's `onBlur` is focusout — it
   * bubbles — so the span hears the input it contains being left. Coercing to
   * `defaultValue` rather than to `min` is what makes the recovered value the
   * one the section started with (10) rather than the smallest legal one, and
   * it agrees with the server: `CONFIG_NORMALISERS.myWork` clamps a missing or
   * unparseable limit to the same default, so a save that somehow escapes with
   * an empty box lands on the same number this does.
   */
  limit: ({ value, defaultValue, onChange, disabled }) => (
    <Field label="How many" hint={`Up to ${MY_WORK_LIMIT_MAX} rows.`}>
      <span
        onBlur={() => {
          // Only the empty box is rewritten. Every other value NumberField can
          // report is already clamped into range by the control itself.
          if (value === '' || value === null || value === undefined) {
            onChange({ limit: defaultValue ?? 1 });
          }
        }}
      >
        <NumberField
          value={value ?? ''}
          min={1}
          max={MY_WORK_LIMIT_MAX}
          disabled={disabled}
          suffix="tasks"
          ariaLabel="How many tasks to show"
          onChange={(next) => onChange({ limit: next })}
        />
      </span>
    </Field>
  ),

  title: ({ value, onChange, disabled }) => (
    <Field label="Heading">
      <Input
        value={value || ''}
        onChange={(e) => onChange({ title: e.target.value })}
        disabled={disabled}
        maxLength={NOTE_TITLE_MAX}
        placeholder="What this note is about"
        aria-label="Note heading"
      />
    </Field>
  ),

  text: ({ value, onChange, disabled }) => (
    <Field label="Note" hint="Plain text. It is shown to you and to nobody else.">
      <Input
        multiline
        rows={4}
        value={value || ''}
        onChange={(e) => onChange({ text: e.target.value })}
        disabled={disabled}
        maxLength={NOTE_TEXT_MAX}
        placeholder="Anything worth keeping in front of you"
        aria-label="Note text"
      />
    </Field>
  ),
};

/**
 * @param {Object}   props
 * @param {string}   props.type      the section type, for wording and for the
 *                                   registry lookup that declares its keys
 * @param {Object}   props.config    the section's stored config
 * @param {Object}   [props.registry] `components/executive/sectionRegistry.js`,
 *                                   defaulted so the ordinary caller passes
 *                                   nothing and a preview can inject a subset
 * @param {Array}    props.boards    `pickableBoards(...)` output — the boards
 *                                   ON THIS VIEW, never every readable board
 * @param {Function} props.onChange  `(patch) => void`, the keys that changed
 * @param {boolean}  [props.disabled]
 */
const SectionConfigForm = ({
  type,
  config,
  registry = SECTION_REGISTRY,
  boards = [],
  onChange,
  disabled = false,
}) => {
  // Defaults UNDER stored values, so a section saved before a key existed still
  // renders a complete form — the same merge the server does when it composes
  // (`CONFIG_NORMALISERS[type](section.config)`), for the same reason.
  //
  // Kept as its own object as well as merged, because a field that lets its box
  // be emptied has to know what to put back — see `limit`.
  const defaults = configDefaultsFor(type, registry);
  const shape = {
    ...defaults,
    ...(isPlainObject(config) ? config : {}),
  };

  const keys = FIELD_ORDER.filter(
    (key) => Object.prototype.hasOwnProperty.call(shape, key) && FIELDS[key]
  );

  const description = registry?.[type]?.description || '';

  if (keys.length === 0) {
    return (
      <p className="font-body" style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
        {/* Either a section type with nothing to set (a tile that simply draws
            what it draws), or one this build does not know. Both are a row that
            can still be moved, resized and removed — which is the only thing
            this message needs to leave possible. */}
        {description || 'There is nothing to set up on this section.'}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {description ? (
        <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
          {description}
        </p>
      ) : null}

      {keys.map((key) => (
        <div key={key}>
          {FIELDS[key]({
            type,
            value: shape[key],
            // This key's registry default, for a control that needs something
            // to fall back to. Undefined for a key the type does not declare a
            // default for, which every field below treats as "no fallback".
            defaultValue: defaults[key],
            boards,
            disabled,
            // Every field reports a PATCH. See the header: the keys it does not
            // draw have to survive it.
            onChange: (patch) => onChange?.(patch),
          })}
        </div>
      ))}
    </div>
  );
};

export default SectionConfigForm;
