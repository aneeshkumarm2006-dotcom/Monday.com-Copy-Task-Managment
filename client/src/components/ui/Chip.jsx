import { forwardRef } from 'react';
import {
  STATUS_COLORS,
  PRIORITY_COLORS,
  getStatusPalette,
  getLabelPalette,
} from '../../utils/priorityColors';
import { chipStyle } from '../../utils/chipStyle';

/**
 * Chip — status (pill) or priority (rounded-sm) label.
 *
 * Props:
 *   type:  'status' | 'priority' | 'label'
 *   value: priority key, status id/legacy-key, or label id
 *   board: optional board doc (required for `status` and `label` types when
 *          the value is an ObjectId). Falls back to the legacy STATUS_COLORS
 *          palette for status when board is omitted (e.g. personal tasks).
 *   label: optional override label
 *   onClick: optional — makes the chip clickable
 *   variant: 'pill' | 'fill' | 'tint' | 'tag' — see utils/chipStyle.js
 *
 * `pill` is the default and is deliberately unchanged: it is what renders on
 * My Work, the dashboard, kanban cards, the ledger, the client portal and in
 * notifications. Only a board TABLE opts into the filled forms, because a
 * colour-first cell needs a cell — a notification rendered as a solid green
 * rectangle is not an improvement.
 */
const Chip = forwardRef(function Chip(
  {
    type = 'status',
    value,
    board,
    label: labelOverride,
    onClick,
    variant = 'pill',
    className = '',
    ...rest
  },
  ref,
) {
  let palette;
  let label;

  if (type === 'priority') {
    palette = PRIORITY_COLORS[value] || PRIORITY_COLORS.low;
    label = labelOverride ?? palette.label;
  } else if (type === 'label') {
    palette = getLabelPalette(board, value);
    label = labelOverride ?? palette.label;
  } else {
    // status
    palette = board
      ? getStatusPalette(board, value)
      : STATUS_COLORS[value] || STATUS_COLORS.not_started;
    label = labelOverride ?? palette.label;
  }

  const isClickable = typeof onClick === 'function';
  const Tag = isClickable ? 'button' : 'span';
  // `fill` and `tint` span their cell, so they cannot be inline-flex — they are
  // the cell. Everything else stays an inline chip that sits in text.
  const spans = variant === 'fill' || variant === 'tint';

  return (
    <Tag
      ref={ref}
      type={isClickable ? 'button' : undefined}
      onClick={onClick}
      className={[
        spans ? 'font-body leading-none' : 'inline-flex items-center gap-1 font-body leading-none',
        'whitespace-nowrap select-none',
        spans ? '' : 'align-middle',
        isClickable
          ? 'cursor-pointer transition-opacity duration-150 hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent)] focus-visible:outline-offset-[-2px]'
          : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={chipStyle(palette, variant)}
      {...rest}
    >
      {label}
    </Tag>
  );
});

export default Chip;
