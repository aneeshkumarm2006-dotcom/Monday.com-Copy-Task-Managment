import { cellStateMeta, LEGEND_ORDER } from '../../../utils/deliveryTrackers';

/**
 * The legend, rendered inline in each section header rather than once at the top
 * of the page — nobody maps a distant legend onto a cell 600px away.
 *
 * The swatch reuses the exact same CELL_STATES entry as the cell itself, at a
 * smaller size, so the two can never drift into a legend that lies.
 */

export const LegendSwatch = ({ state, size = 13 }) => {
  const meta = cellStateMeta(state);
  const Glyph = meta.glyph;

  if (meta.pattern === 'dot') {
    return (
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center"
        style={{ width: size, height: size }}
      >
        <span
          style={{ width: 3, height: 3, borderRadius: '50%', background: meta.ink }}
        />
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className="inline-flex items-center justify-center shrink-0"
      style={{
        width: size,
        height: size,
        borderRadius: 4,
        background:
          meta.pattern === 'half'
            ? 'linear-gradient(135deg, var(--color-status-working) 0 50%,'
              + ' var(--color-status-working-bg) 50% 100%)'
            : meta.fill,
        border:
          meta.border === 'transparent'
            ? '1.5px solid transparent'
            : `1.5px ${meta.pattern === 'dashed' ? 'dashed' : 'solid'} ${meta.border}`,
        color: meta.ink,
      }}
    >
      {Glyph && <Glyph size={size - 5} strokeWidth={3} />}
    </span>
  );
};

const DeliveryLegend = ({ className = '' }) => (
  <div className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 ${className}`}>
    {LEGEND_ORDER.map((state) => (
      <span
        key={state}
        className="inline-flex items-center gap-1.5 font-body"
        style={{ fontSize: 11, color: 'var(--color-text-muted)' }}
      >
        <LegendSwatch state={state} />
        {cellStateMeta(state).label}
      </span>
    ))}
  </div>
);

export default DeliveryLegend;
