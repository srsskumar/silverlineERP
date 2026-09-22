'use client';

import * as React from 'react';
import { Button } from '@/components/ui/Button';

/**
 * A long list, shown a page at a time.
 *
 * The survey screens hold every village in a programme -- twelve hundred on
 * the live contract -- and drew every one of them: thirty thousand DOM nodes
 * and two hundred thousand characters of text on the dashboard alone, so the
 * first paint of "how much is done" took longer than reading the answer.
 *
 * The rows are still all there. Filters, sorting, selection and the export
 * work on the whole list, which is what a person means by "the villages";
 * only what is drawn is a page of it. The page is owned here rather than by
 * each screen so it cannot be declared below an early return, which is the
 * mistake this module has made before.
 */
export const PAGE_SIZE = 50;

/** Which page a row sits on, counting from zero. */
export function pageOf(index: number, size = PAGE_SIZE): number {
  return index < 0 ? 0 : Math.floor(index / size);
}

export function Paged<T>({
  rows, size = PAGE_SIZE, noun = 'rows', focusIndex = -1, children,
}: {
  rows: T[];
  size?: number;
  /** What the rows are, for "Showing 1–50 of 1,200 villages". */
  noun?: string;
  /**
   * A row the reader has to be able to see -- the village they arrived on
   * from another screen. When it is off the current page, the page moves.
   */
  focusIndex?: number;
  children: (slice: T[], offset: number) => React.ReactNode;
}) {
  const [page, setPage] = React.useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  // A filter that shrinks the list past the page we were on leaves us on
  // the last page that exists, not on an empty one.
  const current = Math.min(page, pages - 1);
  React.useEffect(() => {
    if (focusIndex >= 0 && pageOf(focusIndex, size) !== current) setPage(pageOf(focusIndex, size));
    // Only when the focused row changes: a reader paging away from it is
    // not asking to be brought back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusIndex, size]);

  const offset = current * size;
  const slice = React.useMemo(() => rows.slice(offset, offset + size), [rows, offset, size]);
  const from = rows.length === 0 ? 0 : offset + 1;
  const to = Math.min(rows.length, offset + size);

  return (
    <>
      {children(slice, offset)}
      {rows.length > size ? (
        <nav
          aria-label={`Pages of ${noun}`}
          className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs text-text-muted"
        >
          <span>
            Showing {from.toLocaleString('en-IN')}–{to.toLocaleString('en-IN')} of{' '}
            {rows.length.toLocaleString('en-IN')} {noun}
          </span>
          <span className="flex items-center gap-1">
            <Button type="button" variant="ghost" size="sm" disabled={current === 0}
              onClick={() => setPage(0)} aria-label="First page">«</Button>
            <Button type="button" variant="ghost" size="sm" disabled={current === 0}
              onClick={() => setPage(current - 1)}>Previous</Button>
            <span className="px-1 tabular-nums" aria-live="polite">
              Page {current + 1} of {pages}
            </span>
            <Button type="button" variant="ghost" size="sm" disabled={current >= pages - 1}
              onClick={() => setPage(current + 1)}>Next</Button>
            <Button type="button" variant="ghost" size="sm" disabled={current >= pages - 1}
              onClick={() => setPage(pages - 1)} aria-label="Last page">»</Button>
          </span>
        </nav>
      ) : null}
    </>
  );
}
