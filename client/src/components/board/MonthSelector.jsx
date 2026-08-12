import { useMemo } from 'react';
import { CalendarDays } from 'lucide-react';
import Dropdown from '../ui/Dropdown';

/**
 * The board-level month picker for a tracker board.
 *
 * One control scopes all three views — Board, Delivery and Goals — so it sits
 * under the board title with the board's identity, rather than in the header's
 * action row. It is a scope control, not an action, and putting it beside the
 * tabs would make it look like it belonged to whichever tab was open.
 *
 * Built on the existing `ui/Dropdown`, which already portals its panel, flips
 * up near the viewport edge, closes on outside-click and Escape, and carries
 * listbox/option roles. Crucially it renders `option.label` as a node, so the
 * "Unclosed" badge below needs no changes to it at all.
 *
 * Months, labels and the current-month flag all come from the server — see
 * `utils/monthKeys.js` for why the client never works out what month it is.
 */
const MonthSelector = ({
  months = [], value, onChange, loading = false, timezone, onEditTimezone,
}) => {
  const options = useMemo(
    () =>
      months.map((m) => ({
        value: m.key,
        label: (
          <span className="flex items-center gap-2 min-w-0">
            <span className="truncate">{m.label}</span>
            {m.isCurrent && (
              <span
                className="shrink-0 font-body text-[10px] uppercase tracking-wide px-1.5 py-0.5"
                style={{
                  background: 'var(--color-accent-light)',
                  color: 'var(--color-accent-text)',
                  borderRadius: 'var(--radius-full)',
                }}
              >
                Now
              </span>
            )}
            {m.unclosed && (
              <span
                className="shrink-0 font-body text-[10px] uppercase tracking-wide px-1.5 py-0.5"
                style={{
                  background: 'var(--color-status-working-bg)',
                  color: 'var(--color-status-working)',
                  borderRadius: 'var(--radius-full)',
                }}
                title={
                  m.unclosedCount
                    ? `${m.unclosedCount} goal${m.unclosedCount === 1 ? '' : 's'} still need final numbers`
                    : 'Goals still need final numbers'
                }
              >
                Unclosed
              </span>
            )}
          </span>
        ),
      })),
    [months]
  );

  if (!loading && months.length === 0) return null;

  return (
    <div className="flex items-center gap-2 mt-2">
      <CalendarDays
        size={15}
        color="var(--color-text-secondary)"
        aria-hidden="true"
        className="shrink-0"
      />
      <div className="w-[210px]">
        <Dropdown
          size="sm"
          value={value || ''}
          options={options}
          onChange={onChange}
          disabled={loading || months.length === 0}
          placeholder={loading ? 'Loading months…' : 'Pick a month'}
        />
      </div>

      {/* The timezone belongs here rather than in the header's action row: it is
          the thing that decides where these months begin and end, so it reads as
          a footnote to the picker instead of a sixth button. */}
      {timezone && (
        onEditTimezone ? (
          <button
            type="button"
            onClick={onEditTimezone}
            title="Change which calendar defines this board's months"
            className="font-body shrink-0 underline decoration-dotted underline-offset-2 hover:text-[color:var(--color-accent)] transition-colors duration-100"
            style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
          >
            {timezone}
          </button>
        ) : (
          <span
            className="font-body shrink-0"
            style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
            title="The calendar this board's months are measured in"
          >
            {timezone}
          </span>
        )
      )}
    </div>
  );
};

export default MonthSelector;
