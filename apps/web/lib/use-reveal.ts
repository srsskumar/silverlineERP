'use client';

import * as React from 'react';

/**
 * Bring what was just opened into view.
 *
 * These screens list records in a table and open the selected one's detail
 * and forms *below* it. On a register of a few hundred rows that reads as
 * the click doing nothing: the panels are there, a long way down, and
 * finding them means scrolling past everything already on screen. The click
 * and its result should not be in two different places.
 *
 * Keyed on what is open rather than firing on every render, because
 * re-scrolling while somebody is filling in one of those forms would fight
 * them for the viewport. Honours prefers-reduced-motion — a smooth scroll is
 * a nicety, and for some people it is worse than none.
 *
 *   const detail = useReveal(selected?.id);
 *   …
 *   <div ref={detail} className="scroll-mt-4" />
 */
export function useReveal(key: string | null | undefined) {
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!key || !ref.current) return;
    const gentle = typeof window !== 'undefined'
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    ref.current.scrollIntoView({ behavior: gentle ? 'smooth' : 'auto', block: 'start' });
  }, [key]);

  return ref;
}

/**
 * Wrap a detail panel so it appears and is scrolled to together.
 *
 * This existed already, local to the automation screen, where it was written
 * for exactly this problem and then not shared — so five other screens went
 * on opening their detail somewhere below the fold. It lives here now, and
 * honours prefers-reduced-motion, which the original did not.
 *
 * Use it where the panel is wrapped anyway. Where the detail is several
 * siblings, or conditional in more than one place, useReveal with a bare
 * anchor div is less invasive.
 */
export function Revealed(
  { on, children }: { on?: string | null; children: React.ReactNode },
) {
  const ref = useReveal(on);
  if (!on) return null;
  return React.createElement('div', { ref, className: 'space-y-6 scroll-mt-4' }, children);
}
