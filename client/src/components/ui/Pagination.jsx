import { ChevronLeft, ChevronRight } from 'lucide-react';
import { pageSlots } from '../../utils/tableControls';

/**
 * A numbered pager, with a caption that says where you are in the whole set.
 *
 * ---- Why this exists when the app already has "Load more" -------------------
 *
 * Because the app's other long lists are FEEDS. An activity log, a comment
 * thread and a notification list are read newest-first, and nobody navigates to
 * page four of one — "Load more" is exactly right there and this would be worse.
 *
 * A rank table is not a feed. It is sorted, it is compared against last week,
 * and the question being asked of it is "where is this keyword and how many are
 * there" — which needs a TOTAL and an addressable position. "Load more" answers
 * neither: it cannot tell you there are 200 keywords without loading all 200,
 * and it turns "go back to where I was" into scrolling.
 *
 * ---- The window, and why it never resizes ----------------------------------
 *
 * The page list is always the same WIDTH — first, last, a window around the
 * current page, and ellipses for the gaps. A pager whose buttons move under the
 * cursor as you page through it is a pager you misclick, so the slot count is
 * fixed and only the numbers inside it change.
 *
 * All of it is presentation: the caller does the slicing (`utils/rankRows.js`
 * `paginate`), which is what keeps the arithmetic testable without a DOM.
 */

const btn = (activeState) => ({
  minWidth: 30,
  height: 30,
  padding: '0 8px',
  fontSize: 12.5,
  fontWeight: activeState ? 600 : 500,
  borderRadius: 'var(--radius-sm)',
  border: `1px solid ${activeState ? 'var(--color-accent)' : 'var(--color-border)'}`,
  background: activeState ? 'var(--color-accent)' : 'var(--color-bg-surface)',
  color: activeState ? '#FFFFFF' : 'var(--color-text-secondary)',
  cursor: 'pointer',
});

/**
 * @param {Object} props
 * @param {number} props.page       - 1-based, already clamped by the caller
 * @param {number} props.pageCount
 * @param {number} props.from       - 1-based inclusive, 0 when empty
 * @param {number} props.to
 * @param {number} props.total
 * @param {Function} props.onPage   - called with the next 1-based page
 * @param {string} [props.noun]     - what is being counted, for the caption
 * @param {number[]} [props.pageSizes]
 * @param {number} [props.pageSize]
 * @param {Function} [props.onPageSize]
 */
const Pagination = ({
  page,
  pageCount,
  from,
  to,
  total,
  onPage,
  noun = 'rows',
  pageSizes,
  pageSize,
  onPageSize,
}) => {
  // One page and nothing to choose. The caption still earns its place — "24
  // keywords" is information — but the buttons would be furniture.
  const showButtons = pageCount > 1;

  return (
    <div
      className="flex flex-wrap items-center gap-3 px-4 py-3"
      style={{ borderTop: '1px solid var(--color-border)' }}
    >
      <p className="font-body" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
        {total === 0
          ? `No ${noun}`
          : `${from}–${to} of ${total} ${noun}`}
      </p>

      {pageSizes?.length > 1 && onPageSize && (
        <label
          className="font-body inline-flex items-center gap-1.5"
          style={{ fontSize: 12, color: 'var(--color-text-muted)' }}
        >
          Per page
          <select
            value={pageSize}
            onChange={(e) => onPageSize(Number(e.target.value))}
            className="font-body"
            style={{
              height: 26,
              fontSize: 12,
              padding: '0 6px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--color-border)',
              background: 'var(--color-bg-surface)',
              color: 'var(--color-text-primary)',
            }}
          >
            {pageSizes.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="flex-1" />

      {showButtons && (
        <nav className="flex items-center gap-1" aria-label="Pagination">
          <button
            type="button"
            onClick={() => onPage(page - 1)}
            disabled={page <= 1}
            aria-label="Previous page"
            style={{ ...btn(false), opacity: page <= 1 ? 0.4 : 1, cursor: page <= 1 ? 'default' : 'pointer' }}
            className="inline-flex items-center justify-center"
          >
            <ChevronLeft size={14} aria-hidden="true" />
          </button>

          {pageSlots(page, pageCount).map((slot, i) =>
            slot === null ? (
              <span
                key={`gap-${i}`}
                className="font-body"
                style={{ padding: '0 2px', fontSize: 12.5, color: 'var(--color-text-muted)' }}
                aria-hidden="true"
              >
                …
              </span>
            ) : (
              <button
                key={slot}
                type="button"
                onClick={() => onPage(slot)}
                aria-current={slot === page ? 'page' : undefined}
                className="font-body inline-flex items-center justify-center"
                style={btn(slot === page)}
              >
                {slot}
              </button>
            )
          )}

          <button
            type="button"
            onClick={() => onPage(page + 1)}
            disabled={page >= pageCount}
            aria-label="Next page"
            style={{
              ...btn(false),
              opacity: page >= pageCount ? 0.4 : 1,
              cursor: page >= pageCount ? 'default' : 'pointer',
            }}
            className="inline-flex items-center justify-center"
          >
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </nav>
      )}
    </div>
  );
};

export default Pagination;
