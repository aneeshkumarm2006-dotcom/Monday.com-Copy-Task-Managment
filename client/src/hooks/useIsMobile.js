import { useEffect, useState } from 'react';

/**
 * True below the app's mobile breakpoint (Tailwind `md`, 768px) — the same
 * line every `md:hidden` in the codebase draws. For the few places where CSS
 * alone can't carry the split (components that must not MOUNT twice, like a
 * fetching list rendered inside a collapsible), this is the JS mirror.
 */
export default function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 768
  );

  useEffect(() => {
    // No sync setState here: the initialiser above already read the live
    // width, so the effect only SUBSCRIBES to future changes.
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
