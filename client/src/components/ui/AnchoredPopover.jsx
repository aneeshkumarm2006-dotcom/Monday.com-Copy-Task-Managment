import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { placePopover, anchorOffscreen, rectOutside } from '../../utils/popoverPlacement';

/**
 * ANCHORED POPOVER — a panel of arbitrary content hanging off whatever you
 * clicked, rendered where no scroll container can clip it.
 *
 * ---- How this differs from `OptionMenu` ------------------------------------
 *
 * `OptionMenu` is THE list-of-choices menu (pick a value, toggle several, run a
 * command) and every new dropdown of that shape belongs there. This is for the
 * other shape: a small form or a mixed panel — a column's settings with its
 * selects and inputs, a payments list with an add form, a person checklist, a
 * row picker with its own search box. Those have no "options" to hand a menu,
 * but they had the same bug every hand-rolled `position: absolute` panel on the
 * board had: inside the grid's `overflow-x: auto` wrapper and an
 * `overflow: hidden` group card, a panel taller than the group was cut off.
 * One invoice, one short grid, and the column menu's Currency, Summary and
 * Delete were unreachable. So both share the fix — a portal at
 * `position: fixed` — and the placement arithmetic lives in
 * `utils/popoverPlacement.js`, where a test can reach it.
 *
 * ---- Behaviour -------------------------------------------------------------
 *
 *   - anchored to `anchorEl`'s rect: below it by default, flipped above when
 *     there is no room below and more above, clamped inside the viewport, and
 *     scrolling INSIDE itself when even the roomier side is too short;
 *   - closes on a mousedown outside itself and outside the anchor (so the
 *     trigger's own click still toggles), on Escape (focus goes back to the
 *     trigger), and when focus moves somewhere else entirely;
 *   - FOLLOWS its anchor on scroll and resize rather than closing, and closes
 *     only once the anchor has left the screen or been scrolled out of its
 *     scroll container. Closing on every scroll event was the alternative, and
 *     it breaks the one case that matters on a phone: focusing an input inside
 *     the popover raises the keyboard, which resizes and scrolls the page, which
 *     would close the form the person was about to type into.
 *
 * ---- Events do not leak into the cell underneath ----------------------------
 *
 * React bubbles synthetic events through a portal to its React PARENTS, even
 * though the popover is not inside them in the DOM. A click on a checkbox in a
 * person picker therefore reached the cell's own "toggle open" onClick and shut
 * the picker it came from. The root stops click/mousedown/keydown here, after
 * handling Escape itself, so a popover behaves as the separate surface it looks
 * like. The outside-click listener is on the CAPTURE phase for the same reason:
 * it must still see a mousedown that a nested popover stopped.
 *
 * Props:
 *   anchorEl      the trigger's DOM node; null renders nothing (closed)
 *   onClose       () => void
 *   align         'start' | 'end' — which edges line up with the anchor
 *   width         px; clamped to the viewport on a phone
 *   minWidth      px
 *   maxHeight     px cap, before the viewport's own limit (default 400)
 *   role          'dialog' (default) | 'menu' | 'listbox'
 *   ariaLabel     the popover's accessible name
 *   ignore        nodes or refs whose clicks also count as inside
 *   initialFocus  focus the first control (or `[data-autofocus]`) on open
 *   padding       inner padding (default 8)
 */

const MARGIN = 8;
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** Is the anchor hidden by an ancestor that clips it (the grid's scroll area)? */
const clippedByAncestor = (el) => {
  const r = el.getBoundingClientRect();
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = window.getComputedStyle(p);
    if (/(auto|scroll|hidden|clip)/.test(`${s.overflowX} ${s.overflowY}`)) {
      if (rectOutside(r, p.getBoundingClientRect())) return true;
    }
  }
  return false;
};

const nodeOf = (n) => (n && typeof n === 'object' && 'current' in n ? n.current : n);

const AnchoredPopover = ({
  anchorEl,
  onClose,
  children,
  align = 'start',
  width = null,
  minWidth = null,
  maxHeight = 400,
  gap = 4,
  role = 'dialog',
  ariaLabel,
  ignore = null,
  initialFocus = false,
  padding = 8,
  className = '',
  style = null,
}) => {
  const ref = useRef(null);
  const frameRef = useRef(0);
  // The latest callbacks, read by long-lived listeners without re-subscribing
  // them on every render (most callers pass an inline arrow).
  const onCloseRef = useRef(onClose);
  const ignoreRef = useRef(ignore);
  useEffect(() => {
    onCloseRef.current = onClose;
    ignoreRef.current = ignore;
  });

  const close = useCallback(() => onCloseRef.current?.(), []);

  const isInside = useCallback(
    (target) => {
      if (!target) return false;
      if (ref.current?.contains(target)) return true;
      if (anchorEl?.contains?.(target)) return true;
      const extra = ignoreRef.current;
      const list = Array.isArray(extra) ? extra : extra ? [extra] : [];
      return list.some((n) => nodeOf(n)?.contains?.(target));
    },
    [anchorEl]
  );

  /**
   * Measure and place. Written straight to the node's style rather than held
   * in state: it runs on every scroll frame, and a re-render of the popover's
   * whole subtree to move it by a pixel buys nothing.
   */
  const place = useCallback(() => {
    const node = ref.current;
    if (!node || !anchorEl) return;
    if (!anchorEl.isConnected) {
      close();
      return;
    }
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const a = anchorEl.getBoundingClientRect();
    if (anchorOffscreen(a, viewport) || clippedByAncestor(anchorEl)) {
      close();
      return;
    }
    const p = placePopover({
      anchor: a,
      // scrollHeight is the CONTENT height even while max-height is squeezing
      // the box, so a popover can grow back when it moves somewhere roomier.
      // Plus the border: the box is border-box, so a max-height set from
      // scrollHeight alone came out 2px short and drew a needless scrollbar.
      size: { width: node.offsetWidth, height: node.scrollHeight + (node.offsetHeight - node.clientHeight) },
      viewport,
      align,
      gap,
      margin: MARGIN,
      maxHeight,
    });
    node.style.top = `${Math.round(p.top)}px`;
    node.style.left = `${Math.round(p.left)}px`;
    node.style.maxHeight = `${Math.floor(p.maxHeight)}px`;
    node.dataset.placement = p.placement;
  }, [anchorEl, align, gap, maxHeight, close]);

  const schedule = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(place);
  }, [place]);

  // First placement before paint, so the popover never flashes at 0,0.
  useLayoutEffect(() => {
    if (!anchorEl) return undefined;
    place();
    if (initialFocus && ref.current) {
      const target =
        ref.current.querySelector('[data-autofocus]') || ref.current.querySelector(FOCUSABLE);
      target?.focus?.();
    }
    return () => cancelAnimationFrame(frameRef.current);
    // `initialFocus` is read on open only — re-focusing on a prop change would
    // yank the cursor out of whatever the person was typing into.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorEl, place]);

  // Follow the anchor; re-place when the content itself changes size (a list
  // that finished loading, an add form that opened).
  useEffect(() => {
    if (!anchorEl) return undefined;
    const onScroll = (e) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      schedule();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', schedule);
    let observer = null;
    if (typeof ResizeObserver === 'function' && ref.current) {
      observer = new ResizeObserver(schedule);
      observer.observe(ref.current);
    }
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', schedule);
      observer?.disconnect();
    };
  }, [anchorEl, schedule]);

  const restoreFocus = useCallback(() => {
    if (!anchorEl) return;
    const focusable = anchorEl.matches?.(FOCUSABLE) ? anchorEl : anchorEl.querySelector?.(FOCUSABLE);
    focusable?.focus?.();
  }, [anchorEl]);

  useEffect(() => {
    if (!anchorEl) return undefined;
    const onDown = (e) => {
      if (!isInside(e.target)) close();
    };
    const onFocusIn = (e) => {
      if (!isInside(e.target)) close();
    };
    // Escape while focus is NOT inside (on the trigger, say). Inside, the root's
    // own onKeyDown handles it — see the header on why it stops propagation.
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      close();
      restoreFocus();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorEl, isInside, close, restoreFocus]);

  if (!anchorEl || typeof document === 'undefined') return null;

  const stop = (e) => e.stopPropagation();

  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={ariaLabel}
      className={className}
      onClick={stop}
      onMouseDown={stop}
      onPointerDown={stop}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
          restoreFocus();
        }
        e.stopPropagation();
      }}
      style={{
        position: 'fixed',
        zIndex: 200,
        boxSizing: 'border-box',
        width: width ? `min(${width}px, calc(100vw - ${MARGIN * 2}px))` : undefined,
        minWidth: minWidth ? `min(${minWidth}px, calc(100vw - ${MARGIN * 2}px))` : undefined,
        maxWidth: `calc(100vw - ${MARGIN * 2}px)`,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-md)',
        padding,
        color: 'var(--color-text-primary)',
        ...(style || {}),
      }}
    >
      {children}
    </div>,
    document.body
  );
};

export default AnchoredPopover;
