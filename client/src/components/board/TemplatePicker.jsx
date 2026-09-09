import { useEffect, useState } from 'react';
import {
  Calendar,
  CreditCard,
  LayoutGrid,
  Receipt,
  TrendingUp,
  UserPlus,
  Users,
  Check,
  Bookmark,
} from 'lucide-react';
import { getBoardTemplates } from '../../services/boardService';

/**
 * The template step of the board dialog.
 *
 * A template seeds columns, statuses and groups and then has no further
 * existence — nothing stores which one a board came from. So this screen is
 * doing one job: showing what you will get, clearly enough that you can tell
 * the six apart without creating six boards to find out.
 *
 * Blank is first and selected by default. Most boards are still task boards,
 * and the picker must not make the ordinary case feel like the wrong one.
 */

/** Icon per template. Keyed by the registry's `icon` string, not by index. */
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

const TemplateCard = ({ template, selected, onSelect }) => {
  const Icon = ICONS[template.icon] || LayoutGrid;
  return (
    <button
      type="button"
      onClick={() => onSelect(template.key)}
      aria-pressed={selected}
      className="text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]"
      style={{
        // The border thickens on selection rather than a ring appearing, and
        // the padding drops by the same pixel — so the card does not grow and
        // shove its neighbours when you click it.
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

      <span className="flex items-center gap-1.5">
        <span
          className="font-display block"
          style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--color-text-primary)' }}
        >
          {template.name}
        </span>
        {selected && <Check size={13} color="var(--color-accent)" strokeWidth={3} aria-hidden="true" />}
      </span>

      <span
        className="font-body block mt-1 mb-2"
        style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--color-text-secondary)' }}
      >
        {template.blurb}
      </span>

      <span className="flex gap-1 flex-wrap">
        {/* Four column names, then a count. The full list is what the preview
            strip below the grid is for — a card that spells out nine columns
            is a card nobody reads. */}
        {template.columns.slice(0, 4).map((c) => (
          <span
            key={c.name}
            className="font-body"
            style={{
              fontSize: 9.5,
              padding: '2px 6px',
              borderRadius: 3,
              background: 'var(--color-bg-subtle)',
              color: 'var(--color-text-secondary)',
            }}
          >
            {c.name}
          </span>
        ))}
        {template.columns.length > 4 && (
          <span className="font-body" style={{ fontSize: 9.5, padding: '2px 4px', color: 'var(--color-text-muted)' }}>
            +{template.columns.length - 4}
          </span>
        )}
      </span>
    </button>
  );
};

/**
 * "From one of your boards" — the option that stops these being six guesses.
 *
 * The value it produces is `board:<id>`, which `createBoard` resolves by
 * reading that board under the caller's own access. Nothing about the shape is
 * assembled here and posted; the client only names which board.
 */
const FromBoardCard = ({ boards, value, onChange }) => {
  const selected = value.startsWith('board:') ? value.slice('board:'.length) : '';
  return (
    <div
      style={{
        border: selected ? '2px solid var(--color-accent)' : '1px dashed var(--color-border-strong)',
        padding: selected ? 12 : 13,
        borderRadius: 'var(--radius-md)',
        background: selected ? 'var(--color-accent-light)' : 'var(--color-bg-input)',
      }}
    >
      <span
        className="flex items-center justify-center mb-2.5"
        style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--color-bg-subtle)' }}
        aria-hidden="true"
      >
        <Bookmark size={16} color="var(--color-text-secondary)" />
      </span>
      <p className="font-display" style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--color-text-primary)' }}>
        From one of your boards
      </p>
      <p
        className="font-body mt-1 mb-2"
        style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--color-text-secondary)' }}
      >
        Copy its columns, statuses and groups — without its rows.
      </p>
      <select
        value={selected}
        onChange={(e) => onChange(e.target.value ? `board:${e.target.value}` : 'blank')}
        aria-label="Copy the shape of which board"
        className="w-full font-body"
        style={{
          height: 30,
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
  );
};

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
      <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(196px, 1fr))' }}>
        {templates.map((t) => (
          <TemplateCard
            key={t.key}
            template={t}
            selected={t.key === value}
            onSelect={onChange}
          />
        ))}
        {boards.length > 0 && (
          <FromBoardCard boards={boards} value={value} onChange={onChange} />
        )}
      </div>

      {/* What the selection actually means, spelled out. The cards can only
          show four column names; this says how many of everything, and names
          the two consequences a card cannot show — the forced privacy and the
          view it opens on. */}
      {selected && selected.key !== 'blank' && (
        <div
          className="mt-3 px-3.5 py-3"
          style={{
            background: 'var(--color-bg-input)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <p
            className="font-body mb-1.5"
            style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}
          >
            You&rsquo;ll get
          </p>
          <p className="font-body" style={{ fontSize: 12.5, color: 'var(--color-text-primary)' }}>
            {selected.columns.length} column{selected.columns.length === 1 ? '' : 's'}
            {' · '}
            {selected.statuses.map((s) => s.name).join(' / ')}
            {selected.groups.length > 0 && ` · ${selected.groups.length} groups`}
          </p>
          {selected.groups.length > 0 && (
            <p className="font-body mt-1" style={{ fontSize: 11.5, color: 'var(--color-text-secondary)' }}>
              {selected.groups.slice(0, 6).join(' · ')}
              {selected.groups.length > 6 && ` +${selected.groups.length - 6} more`}
            </p>
          )}
          {selected.forceVisibility === 'private' && (
            <p className="font-body mt-1.5" style={{ fontSize: 11.5, color: 'var(--color-status-working)' }}>
              This board is always private — hiring boards carry things that should not be workspace-wide.
            </p>
          )}
          {selected.defaultView === 'calendar' && (
            <p className="font-body mt-1.5" style={{ fontSize: 11.5, color: 'var(--color-text-secondary)' }}>
              Opens on the calendar rather than the table.
            </p>
          )}
          <p className="font-body mt-1.5" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            Everything can be changed after the board exists.
          </p>
        </div>
      )}
    </div>
  );
};

export default TemplatePicker;
