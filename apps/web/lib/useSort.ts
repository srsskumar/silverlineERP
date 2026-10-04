import * as React from 'react';

export type SortState<K extends string> = { key: K | null; dir: 'asc' | 'desc' };

/**
 * Client-side sort for a table whose rows are already on the page.
 *
 * Every list in the app fetches its (already filtered) rows up front and
 * paginates them client-side, so sorting them the same way — in memory,
 * on click — needs no new API, no server-side ORDER BY per endpoint, and
 * behaves identically everywhere `SortableTH` is used.
 *
 * Clicking the active column flips asc/desc; clicking a different one
 * starts it at asc. `getValue` returning `null`/`undefined` sorts that row
 * to the end regardless of direction, since neither direction has an honest
 * comparison with a value that is not there.
 */
export function useSort<T, K extends string>(
  rows: T[],
  getValue: (row: T, key: K) => string | number | null | undefined,
) {
  const [sort, setSort] = React.useState<SortState<K>>({ key: null, dir: 'asc' });

  const onSort = React.useCallback((key: K) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  }, []);

  const sorted = React.useMemo(() => {
    if (!sort.key) return rows;
    const key = sort.key;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = getValue(a, key);
      const bv = getValue(b, key);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      // Money/decimal columns commonly arrive as numeric strings (Postgres
      // NUMERIC serialized through the JSON API, the same reason money()
      // itself does Number(value) rather than trusting the type) -- sorting
      // those lexicographically put "200000" before "4000". Numeric-looking
      // strings get the same numeric comparison a real number would.
      const an = typeof av === 'number' ? av : av !== '' && Number.isFinite(Number(av)) ? Number(av) : null;
      const bn = typeof bv === 'number' ? bv : bv !== '' && Number.isFinite(Number(bv)) ? Number(bv) : null;
      if (an !== null && bn !== null) return (an - bn) * dir;
      return String(av).toLowerCase().localeCompare(String(bv).toLowerCase()) * dir;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort.key, sort.dir]);

  return { sorted, sort, onSort };
}
