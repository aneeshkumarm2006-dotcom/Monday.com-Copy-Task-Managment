import { useState } from 'react';

/**
 * EntityLogo — the square identity tile for a workspace, board or group.
 *
 * ONE component for all three, so a logo looks the same object wherever it
 * lands: the rail's workspace switcher, a board card, the board heading, a
 * group header, the uploader's own preview.
 *
 * TWO SHAPES OF THE SAME TILE
 *
 *   With a logo   The image sits `object-fit: contain` on a white card with a
 *                 hairline edge and a little padding. Logos are the one image a
 *                 person hands us that we must never crop — a wordmark cropped to
 *                 a square is a different word — and most have a transparent
 *                 background that expects to sit on white. The padding stops a
 *                 full-bleed mark from touching the rounded corners.
 *
 *   Without       The caller's fallback: a lettered tile (`initial`) in a solid
 *                 colour, or nothing at all (`fallback={null}` — a group header
 *                 with no logo must look exactly as it did before logos existed).
 *
 * A URL that fails to load drops back to the fallback rather than showing a
 * broken-image glyph, and retries if the URL changes (a fresh upload).
 */
const EntityLogo = ({
  src = '',
  name = '',
  size = 28,
  radius,
  /** Solid colour for the lettered fallback. */
  color = 'var(--color-accent)',
  /** 'letter' (default) | null — what to draw when there is no usable logo. */
  fallback = 'letter',
  className = '',
  style,
  title,
}) => {
  // Remembers WHICH url failed, so a new url (a fresh upload) is tried again
  // without an effect to reset a boolean.
  const [failedSrc, setFailedSrc] = useState('');
  const failed = !!src && failedSrc === src;

  const r = radius ?? Math.max(5, Math.round(size * 0.24));
  const box = {
    width: size,
    height: size,
    borderRadius: r,
    flexShrink: 0,
    ...style,
  };

  if (src && !failed) {
    return (
      <span
        className={`inline-flex items-center justify-center overflow-hidden ${className}`}
        title={title}
        style={{
          ...box,
          background: '#FFFFFF',
          // An inset ring rather than a border: it costs the tile no size, so
          // a 26px logo and a 26px lettered tile are the same 26px.
          boxShadow: 'inset 0 0 0 1px var(--color-border)',
          padding: Math.max(2, Math.round(size * 0.1)),
        }}
      >
        <img
          src={src}
          alt={name ? `${name} logo` : 'Logo'}
          draggable={false}
          onError={() => setFailedSrc(src)}
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
        />
      </span>
    );
  }

  if (fallback === null) return null;

  const initial = (name || '').trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      aria-hidden="true"
      title={title}
      className={`inline-flex items-center justify-center font-display font-bold text-white ${className}`}
      style={{
        ...box,
        background: color,
        fontSize: Math.round(size * 0.46),
        lineHeight: 1,
      }}
    >
      {initial}
    </span>
  );
};

export default EntityLogo;
