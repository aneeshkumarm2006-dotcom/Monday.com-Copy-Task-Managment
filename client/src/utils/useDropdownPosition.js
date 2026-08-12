import { useCallback, useLayoutEffect, useState } from 'react';

const VIEWPORT_MARGIN = 16;
const DEFAULT_MENU_HEIGHT = 260;

/**
 * useDropdownPosition — viewport-aware positioning for portal-rendered dropdowns.
 *
 * Returns a fixed-position rect anchored to `triggerRef` and a boolean
 * `openUpward` flag set when there isn't enough room below the trigger to fit
 * `menuHeight` (default 260px, matching the Dropdown maxHeight).
 *
 * Recomputes on open, on window scroll (capture phase so we catch scroll inside
 * scrollable ancestors), and on window resize.
 *
 *   const { top, left, width, openUpward } = useDropdownPosition(triggerRef, open);
 *   <ul style={{ position: 'fixed', top, left, width }} />
 */
const useDropdownPosition = (
  triggerRef,
  open,
  { menuHeight = DEFAULT_MENU_HEIGHT } = {}
) => {
  const [rect, setRect] = useState({ top: 0, left: 0, width: 0, openUpward: false });

  const recompute = useCallback(() => {
    const node = triggerRef.current;
    if (!node) return;
    const r = node.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const openUpward = spaceBelow < menuHeight + VIEWPORT_MARGIN && r.top > spaceBelow;
    const top = openUpward ? Math.max(VIEWPORT_MARGIN, r.top - menuHeight - 4) : r.bottom + 4;
    // Clamp left so the dropdown never overflows off the right edge of the
    // viewport. Every consumer renders `Math.max(width, 220)`, so clamp against
    // that same effective width — using a flat 220 let a trigger wider than
    // 220px produce a menu that still hung off the right edge.
    const dropdownMinWidth = 220;
    const menuWidth = Math.max(r.width, dropdownMinWidth);
    const left = Math.min(r.left, window.innerWidth - menuWidth - VIEWPORT_MARGIN);
    setRect({ top, left: Math.max(VIEWPORT_MARGIN, left), width: r.width, openUpward });
  }, [triggerRef, menuHeight]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    recompute();
    const onScroll = () => recompute();
    const onResize = () => recompute();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, recompute]);

  return rect;
};

export default useDropdownPosition;
