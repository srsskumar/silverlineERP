'use client';

import * as React from 'react';
import { HelpCircle } from 'lucide-react';
import * as Popover from '@radix-ui/react-popover';
import { cn } from '@/lib/cn';

/**
 * What a figure actually means, for the person who did not define it.
 *
 * Half the labels in this system are terms of art — pace, utilisation,
 * projected finish, GT, LPMS — and a number under a term of art is a number
 * two people will read two different ways. The explanation belongs next to
 * the figure rather than in a manual nobody opens while looking at a screen.
 *
 * A popover rather than a tooltip, because a tooltip opens on hover and a
 * field crew is holding a phone. There is no hover on a phone, so the whole
 * glossary would have been invisible to most of the people it was written
 * for. This opens on tap, on click and on Enter, closes on Escape or on a
 * tap outside, and returns focus where it came from.
 */
export function InfoHint({
  children,
  label = 'What this means',
  className,
}: {
  children: React.ReactNode;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          // Hover still opens it on a desktop, where hovering is free and
          // clicking to read one sentence is not.
          onMouseEnter={() => setOpen(true)}
          className={cn(
            'inline-flex shrink-0 rounded text-text-subtle transition-colors',
            'hover:text-text-muted focus:outline-none focus:ring-2 focus:ring-ring',
            className,
          )}
        >
          <HelpCircle className="size-3" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          collisionPadding={8}
          onMouseLeave={() => setOpen(false)}
          className={cn(
            'z-50 max-w-[18rem] rounded-md border border-border bg-overlay px-2.5 py-2',
            'text-xs normal-case leading-relaxed tracking-normal text-text shadow-lg',
            'data-[state=open]:animate-fade-in',
          )}
        >
          {children}
          <Popover.Arrow className="fill-border" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * The house glossary.
 *
 * Kept in one place so the same term is explained the same way wherever it
 * appears — a metric that means one thing on the programme page and another
 * on the report is worse than one nobody explains at all.
 */
export const GLOSSARY: Record<string, string> = {
  pace:
    'How fast the work is actually going: acres finished divided by the days the crew '
    + 'worked. It is a measurement of days already worked, not a target.',
  projectedFinish:
    'When the programme would finish if it carried on at the rate it has managed so far. '
    + 'It moves every time a return is filed, and it is a projection rather than a commitment.',
  utilisation:
    'Of the instruments allocated to villages on this day, the share that a crew reported '
    + 'actually using. Anything allocated and not reported counts as idle.',
  idleRovers:
    'Instruments that were out with a crew and reported as not used that day. Equipment '
    + 'sitting in a village is equipment another village cannot have.',
  teamDays:
    'One team working for one day. Two teams for three days is six team days — it is the '
    + 'labour that went in, not the number of people on the books.',
  daysWorked:
    'Days a return was actually filed for this programme. Days nobody worked are left out, '
    + 'so the per-day figure beside it is not diluted by them.',
  completion:
    'Acres finished as a share of the acres to survey. A village counts towards it as its '
    + 'work lands, not only when the whole village is signed off.',
  extent:
    'The total area to be surveyed, in acres, from the village list. Every percentage on '
    + 'this page is measured against it.',
  stage:
    'Where a village has reached in the pipeline: ground truthing, then QC, then '
    + 'vectorisation, then its own QC, then LPMS. A village sits at one stage at a time.',
  dgps:
    'Differential GPS — the survey instruments. A base station stays put and the rovers '
    + 'move around it, which is why the two are counted separately.',
  lpms:
    'Land Parcel Management System — the state system the finished parcels are published '
    + 'into. A village is not done until its LPMS records are generated.',
};
