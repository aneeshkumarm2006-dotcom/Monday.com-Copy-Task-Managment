import { ArrowDown, ArrowUp } from 'lucide-react';
import { nextSort } from '../../utils/tableControls';

/**
 * A clickable table header that cycles asc → desc → off.
 *
 * ---- Why this is a component and not a fourth copy --------------------------
 *
 * There are three hand-written versions of this already — `TaskTable.jsx`'s
 * header row, the Goals table, and the People table — and they agree on the
 * behaviour and disagree on the details: which arrow means which direction, how
 * an inactive column hints that it can be sorted, whether the whole cell or just
 * the label is the hit target. Phase 5 needs a fourth and phases 6-8 need four
 * more, and eight copies of a three-state toggle is how the SEO tables end up
 * sorting the opposite way round from the board.
 *
 * The visual language is `TaskTable`'s verbatim, because that is the one people
 * use every day: the active column takes the accent colour, its arrow points up
 * for ascending, and an inactive sortable column shows a ghosted up arrow so it
 * is discoverable without being noisy.
 *
 * ---- The cycle has three states, not two ------------------------------------
 *
 * asc → desc → OFF. The third one matters: a table's unsorted order is
 * meaningful here — it is the order the keywords were authored in, which is the
 * order a person typed them — and a two-state toggle makes that order
 * unreachable once anything has been clicked. `nextSort` below is
 * `goalSort.nextGoalSort`'s contract, spelled once so the two cannot drift.
 *
 * Styling is inline for the same reason every other table cell in this app is:
 * these tables live inside `ScrollTable`, whose sticky headers need explicit
 * `position`/`background`, and a Tailwind class cannot carry a CSS variable
 * through the theme the way `var(--color-accent)` does.
 */

/**
 * One header cell.
 *
 * @param {Object} props
 * @param {string} props.column      - the sort key this header owns
 * @param {Object} props.sort        - `{key, dir}`, the whole table's state
 * @param {Function} props.onSort    - called with the NEXT `{key, dir}`
 * @param {boolean} [props.sortable] - false renders a plain header
 * @param {'left'|'right'|'center'} [props.align]
 * @param {number|string} [props.width]
 * @param {string} [props.title]     - the tooltip; defaults to "Sort by <label>"
 */
const SortableTh = ({
  column,
  sort = { key: null, dir: 'asc' },
  onSort,
  sortable = true,
  align = 'left',
  width,
  title,
  children,
}) => {
  const active = sortable && sort.key === column;

  const base = {
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    textAlign: align,
    padding: '8px 12px',
    // Sticky, because these tables scroll inside their own box and a header that
    // scrolls away turns a hundred-row rank table into a column-counting
    // exercise.
    position: 'sticky',
    top: 0,
    background: 'var(--color-bg-subtle)',
    borderBottom: '1px solid var(--color-border)',
    whiteSpace: 'nowrap',
    width,
    color: active ? 'var(--color-accent)' : 'var(--color-text-muted)',
  };

  if (!sortable) {
    return (
      <th className="font-body font-medium" style={base}>
        {children}
      </th>
    );
  }

  return (
    <th
      scope="col"
      className="font-body font-medium"
      style={{ ...base, padding: 0 }}
      // Announced so a screen reader hears the state rather than the arrow.
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(nextSort(sort, column))}
        title={title || (typeof children === 'string' ? `Sort by ${children}` : 'Sort')}
        className="w-full inline-flex items-center gap-1 font-body font-medium transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--color-accent)]"
        style={{
          justifyContent:
            align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start',
          padding: '8px 12px',
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: 'inherit',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        {children}
        {active ? (
          sort.dir === 'asc' ? (
            <ArrowUp size={11} aria-hidden="true" />
          ) : (
            <ArrowDown size={11} aria-hidden="true" />
          )
        ) : (
          // Ghosted rather than absent: a column that turns out to be sortable
          // only once you click it is a column nobody clicks.
          <ArrowUp size={11} aria-hidden="true" style={{ opacity: 0.25 }} />
        )}
      </button>
    </th>
  );
};

export default SortableTh;
