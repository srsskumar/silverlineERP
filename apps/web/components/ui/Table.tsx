import * as React from 'react';
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
        // Tall enough to read, short enough that the scrollbar is reachable
        // without leaving the rows behind.
        tall && 'max-h-[70vh] overflow-y-auto',
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

export function TD({
  className,
  align = 'left',
  ...rest
}: React.TdHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' | 'center' }) {
  return (
    <td
      className={cn(
        'h-row px-3 text-text',
        align === 'right' && 'text-right tabular',
        align === 'center' && 'text-center',
        className,
      )}
      {...rest}
    />
  );
}
