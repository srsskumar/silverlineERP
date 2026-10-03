import * as React from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Wrap a table so wide content scrolls inside the card, never the page.
 *
 * `tall` also caps the height, which is what makes a wide table usable.
 * A thousand rows in a box that grows to fit them puts the horizontal
 * scrollbar a thousand rows down: to move a wide table sideways you first
 * scroll to the bottom of the page, drag, then scroll back up to read what
 * you uncovered. Capping the height keeps the bar in view, and the sticky
 * header keeps the column names with it.
 *
 * Not the default, because a short table in a fixed-height box looks broken
 * and scrolls a list that would have fitted on the screen.
 */
export function TableWrap({
  className, tall, ...rest
}: React.HTMLAttributes<HTMLDivElement> & { tall?: boolean }) {
  return (
    <div
      className={cn(
        'w-full overflow-x-auto',
        /*
         * Sized to the space actually left below it, not to a fraction of
         * the window. 70vh still overshot: the app header, the page header
         * and a wrapped filter bar take about 22rem before the table starts,
         * so the scrollbar landed just under the fold and the problem —
         * having to scroll to reach it — survived in miniature.
         *
         * The floor stops it collapsing to a slit on a short laptop screen;
         * there it is a normal scroll again, which is the honest trade.
         */
        tall && 'max-h-[calc(100vh-22rem)] min-h-[18rem] overflow-y-auto',
        className,
      )}
      {...rest}
    />
  );
}

export function Table({ className, ...rest }: React.TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn('w-full caption-bottom border-collapse text-sm', className)} {...rest} />;
}

export function THead({ className, ...rest }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn('sticky top-0 z-10 bg-surface-sunken [&_th]:border-b [&_th]:border-border', className)}
      {...rest}
    />
  );
}

export function TBody({ className, ...rest }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('divide-y divide-border', className)} {...rest} />;
}

export function TR({ className, ...rest }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('row-hover', className)} {...rest} />;
}

export function TH({
  className,
  align = 'left',
  ...rest
}: React.ThHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' | 'center' }) {
  return (
    <th
      scope="col"
      className={cn(
        'h-8 whitespace-nowrap px-3 text-2xs font-semibold uppercase tracking-wide text-text-subtle',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        align === 'left' && 'text-left',
        className,
      )}
      {...rest}
    />
  );
}

/**
 * A column header that sorts the table when clicked.
 *
 * No table in the app had this -- every list depended on filters, a fixed
 * default order, and the CSV/Excel export for anything else. That is enough
 * for a filtered, exported report; it is not enough for scanning a table
 * already on screen to find the largest or the oldest. One component so
 * every table gets the same click-to-sort, the same arrow, and the same
 * three-state cycle (asc, desc, back to the table's own order) rather than
 * each screen inventing its own.
 */
export function SortableTH<K extends string>({
  children, sortKey, sort, onSort, align = 'left', className,
}: {
  children: React.ReactNode;
  sortKey: K;
  sort: { key: K | null; dir: 'asc' | 'desc' };
  onSort: (key: K) => void;
  align?: 'left' | 'right' | 'center';
  className?: string;
}) {
  const active = sort.key === sortKey;
  const Icon = active ? (sort.dir === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown;
  return (
    <TH align={align} className={cn('p-0', className)}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={cn(
          'flex h-8 w-full items-center gap-1 px-3 text-2xs font-semibold uppercase tracking-wide',
          'text-text-subtle hover:text-text focus-visible:outline-none focus-visible:ring-2',
          'focus-visible:ring-ring focus-visible:ring-inset',
          align === 'right' && 'flex-row-reverse text-right',
          align === 'center' && 'justify-center',
        )}
      >
        {children}
        <Icon className={cn('size-3 shrink-0', !active && 'opacity-40')} />
      </button>
    </TH>
  );
}

/**
 * A cell, at the one size a table row is written in.
 *
 * `tone` rather than a size class. Sixty-two call sites used to set their own
 * — text-xs here, text-2xs there, picked by eye — so a single row could carry
 * three different sizes across its columns and two tables on one screen never
 * matched. What those sites actually meant was *this column matters less*,
 * which is a question about emphasis and belongs to the cell, not to whoever
 * happened to be writing that screen.
 *
 * The size is fixed by the table. Colour is what changes.
 */
export function TD({
  className,
  align = 'left',
  tone = 'default',
  mono = false,
  ...rest
}: React.TdHTMLAttributes<HTMLTableCellElement> & {
  align?: 'left' | 'right' | 'center';
  /** How much weight this column carries beside the ones around it. */
  tone?: 'default' | 'muted' | 'subtle' | 'danger' | 'warning' | 'success';
  /** Codes, references and identifiers, which are compared character by character. */
  mono?: boolean;
}) {
  return (
    <td
      className={cn(
        'h-row px-3',
        tone === 'default' && 'text-text',
        tone === 'muted' && 'text-text-muted',
        tone === 'subtle' && 'text-text-subtle',
        tone === 'danger' && 'text-danger',
        tone === 'warning' && 'text-warning',
        tone === 'success' && 'text-success',
        mono && 'font-mono',
        align === 'right' && 'text-right tabular',
        align === 'center' && 'text-center',
        className,
      )}
      {...rest}
    />
  );
}
