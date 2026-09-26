import { useEffect, useState } from 'react';
import {
  Bookmark,
  Calendar,
  CreditCard,
  LayoutGrid,
  Receipt,
  TrendingUp,
  UserPlus,
  Users,
} from 'lucide-react';
import { getBoardTemplates } from '../../services/boardService';

/**
 * The template step of the board dialog.
 *
 * A template seeds columns, statuses and groups and then has no further
 * existence — nothing stores which one a board came from. So this screen does
 * one job: show what you will get, clearly enough to tell the seven apart
 * without creating seven boards to find out.
 *
 * ---- THE LAYOUT IS THE POINT, AND IT WAS GOT WRONG ONCE ------------------
 *
 * THREE ACROSS, everything visible at once. It shipped briefly as a
 * horizontally-scrolling rail, which put two and a half cards on screen and hid
 * the rest behind a gesture — so the one decision this screen exists for got
 * made against a third of the options. A picker you have to scroll sideways to
 * read is a picker whose first card always wins.
 *
 * Blank is first and selected by default. Most boards are still task boards,
 * and this must not make the ordinary case feel like the wrong one.
 */

/** Icon per template, keyed by the registry's `icon` string. */
const ICONS = {
  layout: LayoutGrid,
  receipt: Receipt,
  chart: TrendingUp,
  users: Users,
  hiring: UserPlus,
  card: CreditCard,
  calendar: Calendar,
};

/** A translucent wash of the template's accent, for the icon tile. */
const tint = (hex) => `${hex}14`;

/**
 * What a column TYPE adds to its chip, beyond the column's name.
 *
 * A formula column carries its marker, because "this is worked out for you" is
 * a fact about a money board that a bare column name cannot tell you — and it
 * is exactly what somebody is looking for when choosing between Budget and
 * Blank. A payments column says what it holds, because "Payments" alone reads
 * like one number when it is a dated log of every payment against the row.
 *
 * `numeric` is which types right-align in the preview head, the way the board
 * itself aligns them.
 */
const COLUMN_TYPE_HINTS = {
  formula: { mark: 'ƒ', title: 'Worked out for you from other columns', numeric: true },
  payments: { mark: null, title: 'Every payment against the row, with its date', numeric: true },
  number: { mark: null, title: null, numeric: true },
};

const chipLabel = (c) => {
  const mark = COLUMN_TYPE_HINTS[c.type]?.mark;
  return mark ? `${c.name} ${mark}` : c.name;
};

/**
 * Does this template carry money — and so should the dialog ask what currency?
 *
 * The server's own flag (`templateSummaries` derives `hasMoney` from the
 * columns), so no template key is named here: a new money template is asked
 * about without anyone remembering to list it. A payments column is money by
 * definition, which covers a server too old to send the flag; the summary
 * ships column TYPES only, and a `number` column is as likely to be hours as
 * money, so the type alone cannot say more.
 */
const isMoneyTemplate = (t) => {
  if (!t || t.key === 'blank') return false;
  if (typeof t.hasMoney === 'boolean') return t.hasMoney;
  return Array.isArray(t.columns) && t.columns.some((c) => c.type === 'payments');
};

const TemplateCard = ({ template, selected, onSelect }) => {
  const Icon = ICONS[template.icon] || LayoutGrid;
  return (
    <button
      type="button"
      onClick={() => onSelect(template.key)}
      aria-pressed={selected}
      className="text-left h-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
      style={{
        // The border thickens on selection and the padding drops by the same
        // pixel, so the card does not grow and shift the grid when clicked.
        border: selected ? '2px solid var(--color-accent)' : '1px solid var(--color-border)',
        padding: selected ? 12 : 13,
        borderRadius: 'var(--radius-md)',
        background: selected ? 'var(--color-accent-light)' : 'var(--color-bg-surface)',
      }}
    >
      <span
        className="flex items-center justify-center mb-2.5"
        style={{ width: 32, height: 32, borderRadius: 8, background: tint(template.accent) }}
        aria-hidden="true"
      >
        <Icon size={16} color={template.accent} />
      </span>

      <span
        className="font-display block"
        style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--color-text-primary)' }}
      >
        {template.name}
      </span>

      <span
        className="font-body block mt-1 mb-2"
        style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--color-text-secondary)' }}
      >
        {template.blurb}
      </span>

      <span className="flex gap-1 flex-wrap">
        {template.columns.slice(0, 4).map((c) => (
          <span
            key={c.name}
            className="font-body"
            title={COLUMN_TYPE_HINTS[c.type]?.title || undefined}
            style={{
              fontSize: 9.5,
              padding: '2px 6px',
              borderRadius: 3,
              background: 'var(--color-bg-subtle)',
              color: 'var(--color-text-secondary)',
              whiteSpace: 'nowrap',
            }}
          >
            {chipLabel(c)}
          </span>
        ))}
        {template.columns.length > 4 && (
          <span
            className="font-body"
            style={{ fontSize: 9.5, padding: '2px 4px', color: 'var(--color-text-muted)' }}
          >
            +{template.columns.length - 4}
          </span>
        )}
      </span>
    </button>
  );
};

/**
 * "From one of your boards" — the option that stops these being seven guesses.
 *
 * Wider than the others and last, because it is a different KIND of choice: the
 * seven above are things Macan knows how to make; this is a thing you already
 * made. It produces `board:<id>`, which `createBoard` resolves by re-reading
 * that board under your own access — the client never assembles a shape and
 * posts it.
 */
const FromBoardCard = ({ boards, value, onChange }) => {
  const selected = value.startsWith('board:') ? value.slice('board:'.length) : '';
  return (
    <div
      className="h-full"
      style={{
        border: selected ? '2px solid var(--color-accent)' : '1px dashed var(--color-border-strong)',
        padding: selected ? 12 : 13,
        borderRadius: 'var(--radius-md)',
        background: selected ? 'var(--color-accent-light)' : 'var(--color-bg-input)',
      }}
    >
      <div className="flex items-start gap-3">
        <span
          className="flex items-center justify-center shrink-0"
          style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--color-bg-subtle)' }}
          aria-hidden="true"
        >
          <Bookmark size={16} color="var(--color-text-secondary)" />
        </span>
        <div className="min-w-0 flex-1">
          <p
            className="font-display"
            style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--color-text-primary)' }}
          >
            From one of your boards
          </p>
          <p
            className="font-body mt-1 mb-2"
            style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--color-text-secondary)' }}
          >
            Copy the columns, statuses and groups of a board you already run — without its
            rows. The one that learns from what you actually do.
          </p>
          <select
            value={selected}
            onChange={(e) => onChange(e.target.value ? `board:${e.target.value}` : 'blank')}
            aria-label="Copy the shape of which board"
            className="font-body"
            style={{
              height: 30,
              maxWidth: 280,
              width: '100%',
              fontSize: 12,
              padding: '0 7px',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-bg-surface)',
              color: 'var(--color-text-primary)',
            }}
          >
            <option value="">Choose a board…</option>
            {boards.map((b) => (
              <option key={b._id} value={b._id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
};

/**
 * The preview strip — the selected template's columns as an actual table head.
 *
 * A card can only carry four chips. This answers "what you'll get" in full, and
 * drawing it as a table header rather than a list is the point: it is what the
 * board will look like, at the size it will look like it.
 */
const Preview = ({ template }) => {
  if (!template || template.key === 'blank') return null;
  const groupWord = template.groups.length === 12 ? 'monthly groups' : 'groups';
  const numeric = (t) => !!COLUMN_TYPE_HINTS[t]?.numeric;
  return (
    <div
      className="mt-3"
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
      }}
    >
      <div
        className="px-3 flex items-center font-body"
        style={{
          height: 30,
          background: 'var(--color-bg-input)',
          borderBottom: '1px solid var(--color-border)',
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: '0.07em',
          textTransform: 'uppercase',
          color: 'var(--color-text-muted)',
        }}
      >
        {template.name} — what you&rsquo;ll get
      </div>

      <div className="px-3 py-2.5" style={{ background: 'var(--color-bg-surface)' }}>
        {template.groups.length > 0 && (
          <div className="flex items-center gap-2 mb-2">
            <span
              style={{ width: 8, height: 8, borderRadius: '50%', background: template.accent }}
              aria-hidden="true"
            />
            <span
              className="font-body"
              style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-primary)' }}
            >
              {template.groups[0]}
            </span>
            <span className="font-body" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
              · first of {template.groups.length}
            </span>
          </div>
        )}

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid var(--color-border)' }}>
            <thead>
              <tr>
                {template.columns.map((c) => (
                  <th
                    key={c.name}
                    scope="col"
                    className="font-body"
                    title={COLUMN_TYPE_HINTS[c.type]?.title || undefined}
                    style={{
                      height: 30,
                      padding: '0 10px',
                      textAlign: numeric(c.type) ? 'right' : 'left',
                      fontSize: 10,
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.07em',
                      color: 'var(--color-text-secondary)',
                      background: 'var(--color-bg-input)',
                      borderBottom: '1px solid var(--color-border)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td
                  colSpan={template.columns.length}
                  className="font-body"
                  style={{ height: 34, padding: '0 10px', fontSize: 11.5, color: 'var(--color-text-muted)' }}
                >
                  Empty and ready — {template.columns.length} columns,{' '}
                  {template.statuses.length} statuses
                  {template.groups.length > 0 && `, ${template.groups.length} ${groupWord}`}.
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {template.forceVisibility === 'private' && (
          <p className="font-body mt-2" style={{ fontSize: 11.5, color: 'var(--color-status-working)' }}>
            Always private — hiring boards carry things that should not be workspace-wide.
          </p>
        )}
      </div>
    </div>
  );
};

/**
 * `onChange(key, { money })` — the key the server seeds from, and whether that
 * template carries money columns, so the dialog knows whether to ask what
 * currency they are in (default: follow the workspace). A copy of an existing
 * board reports `money: false`: it keeps its source board's currencies — and
 * follows the workspace only when its source did and was in step with it — so
 * asking would be a question whose answer is ignored.
 */
const TemplatePicker = ({ value, onChange, boards = [] }) => {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getBoardTemplates()
      .then((list) => {
        if (!cancelled) setTemplates(list);
      })
      .catch((err) => {
        console.error('Failed to load board templates:', err);
        // A failed list must not block board creation: fall back to Blank only,
        // which is what the dialog did before templates existed.
        if (!cancelled) setTemplates([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = templates.find((t) => t.key === value) || null;

  if (loading) {
    return (
      <p className="font-body py-6 text-center" style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
        Loading templates…
      </p>
    );
  }

  if (templates.length === 0) {
    return (
      <p className="font-body py-6 text-center" style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
        Templates are unavailable right now — your board will start blank.
      </p>
    );
  }

  return (
    <div>
      {/* Three across on a wide dialog, two on a narrow one, one on a phone.
          Never a horizontal scroller — see the header. */}
      <div className="grid gap-2.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {templates.map((t) => (
          <TemplateCard
            key={t.key}
            template={t}
            selected={t.key === value}
            onSelect={(key) => onChange(key, { money: isMoneyTemplate(t) })}
          />
        ))}

        {/* Spans the rest of its row: a different kind of choice from the seven
            above it, and it needs the width for the board picker. */}
        {boards.length > 0 && (
          <div className="lg:col-span-2">
            <FromBoardCard
              boards={boards}
              value={value}
              onChange={(key) => onChange(key, { money: false })}
            />
          </div>
        )}
      </div>

      <Preview template={selected} />
    </div>
  );
};

export default TemplatePicker;
