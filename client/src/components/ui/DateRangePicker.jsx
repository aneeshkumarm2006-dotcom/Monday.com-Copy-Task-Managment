import { CalendarRange } from 'lucide-react';
import { FilterPopover } from './FilterControls';
import {
  RANGE_PRESETS,
  isRangeInvalid,
  prettyDay,
  resolveRangePreset,
} from '../../utils/dateRange';

/**
 * A from/to range, chosen by preset or typed.
 *
 * ---- Why a new component when there is already a date picker ---------------
 *
 * `DatePickerPopover` picks ONE day, and it is right for a due date. A range is
 * a different question with different failure modes — a reversed range silently
 * returns nothing, and "last 30 days" is the answer nine times in ten and is not
 * expressible as two clicks on a calendar.
 *
 * `ExportActivityModal` solved exactly this problem inline and its `PRESETS`
 * shape is reused verbatim below, including the `custom` sentinel with a null
 * `range`. What that file could not do is offer the same control anywhere else,
 * which is why phase 5's history window needed it lifted out.
 *
 * ---- The dates are UTC DAY KEYS and stay that way --------------------------
 *
 * `YYYY-MM-DD`, the same strings the connector data endpoint's `from`/`to`
 * parse, and the same ones a snapshot's `periodKey` is. A `Date` here would put
 * a timezone between the browser and a period key that has none, and the symptom
 * would be a chart missing its first or last column for everybody west of
 * Greenwich.
 *
 * `to` is deliberately NOT clamped to today — the same decision the server's
 * `resolveRange` records. A board looking at a month that has not finished still
 * wants the whole month.
 */

const input = {
  height: 30,
  width: '100%',
  padding: '0 8px',
  fontSize: 12.5,
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--color-border-strong)',
  background: 'var(--color-bg-input, var(--color-bg-surface))',
  color: 'var(--color-text-primary)',
};

/**
 * @param {Object} props
 * @param {string} props.preset          - a key from RANGE_PRESETS
 * @param {{from: string, to: string}} props.value - the resolved range
 * @param {Function} props.onChange      - `({preset, from, to})`
 * @param {string} [props.label]
 */
const DateRangePicker = ({ preset = '90d', value, onChange, label = 'Range' }) => {
  const current = RANGE_PRESETS.find((p) => p.key === preset) || RANGE_PRESETS[0];
  const invalid = isRangeInvalid(value);

  const choose = (key) => {
    if (key === 'custom') {
      onChange({ preset: 'custom', from: value.from, to: value.to });
      return;
    }
    onChange({ preset: key, ...resolveRangePreset(key, value) });
  };

  return (
    <FilterPopover
      label={
        preset === 'custom'
          ? `${prettyDay(value?.from) || '…'} – ${prettyDay(value?.to) || '…'}`
          : `${label}: ${current.label}`
      }
      icon={CalendarRange}
      // Badged only for a hand-typed range: a preset is the normal state and a
      // permanent "1" beside it would train people to ignore the badge.
      activeCount={preset === 'custom' ? 1 : 0}
    >
      <div style={{ minWidth: 250 }}>
        {RANGE_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            role="option"
            aria-selected={p.key === preset}
            onClick={() => choose(p.key)}
            className="w-full text-left font-body transition-colors duration-150 hover:bg-[color:var(--color-bg-subtle)]"
            style={{
              margin: '2px 0',
              padding: '6px 8px',
              fontSize: 13,
              fontWeight: p.key === preset ? 600 : 500,
              borderRadius: 'var(--radius-sm)',
              background: 'transparent',
              border: 'none',
              color:
                p.key === preset ? 'var(--color-accent)' : 'var(--color-text-primary)',
              cursor: 'pointer',
            }}
          >
            {p.label}
          </button>
        ))}

        {preset === 'custom' && (
          <div className="flex gap-2 mt-2 pt-2" style={{ borderTop: '1px solid var(--color-border)' }}>
            <label className="flex-1 min-w-0">
              <span
                className="font-body block mb-1"
                style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
              >
                From
              </span>
              <input
                type="date"
                value={value?.from || ''}
                max={value?.to || undefined}
                onChange={(e) =>
                  onChange({ preset: 'custom', from: e.target.value, to: value.to })
                }
                style={input}
              />
            </label>
            <label className="flex-1 min-w-0">
              <span
                className="font-body block mb-1"
                style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
              >
                To
              </span>
              <input
                type="date"
                value={value?.to || ''}
                min={value?.from || undefined}
                onChange={(e) =>
                  onChange({ preset: 'custom', from: value.from, to: e.target.value })
                }
                style={input}
              />
            </label>
          </div>
        )}

        {invalid && (
          // A reversed range returns nothing and looks like a connector that
          // stopped working, so it is named rather than silently applied.
          <p
            className="font-body mt-2"
            style={{ fontSize: 11.5, color: 'var(--color-danger, #DC2626)' }}
          >
            The start date has to come before the end date.
          </p>
        )}
      </div>
    </FilterPopover>
  );
};

export default DateRangePicker;
