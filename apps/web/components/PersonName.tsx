import * as React from 'react';
import { cn } from '@/lib/cn';
import { personDisplay, type Person, type PersonLike } from '@/lib/people';

/**
 * A person, printed the same way on every screen.
 *
 * Give it whatever the record carries -- a `*_name` from a JOIN, a
 * `username`, an employee row -- and, where the record only has a user id,
 * the people index to look it up in. It prints the name, the employee number
 * muted after it, and keeps the id on hover; when nothing better is known it
 * prints the shortened id in monospace so it reads as an id and not as a
 * name nobody recognises.
 */
export function PersonName({
  id, name, username, empNo, index, person, unknown = '—', className,
}: {
  id?: string | null;
  name?: string | null;
  username?: string | null;
  empNo?: string | null;
  /** A user-id → person index (see `peopleIndex`) for records that carry only the id. */
  index?: Map<string, Person>;
  /** A whole record, when one is to hand. */
  person?: PersonLike | null;
  /** Printed when there is neither a name nor an id. */
  unknown?: string;
  className?: string;
}) {
  const key = id ? String(id) : null;
  const fromIndex = key && index ? index.get(key) ?? null : null;
  const source: PersonLike = {
    ...(person ?? {}),
    ...(fromIndex ?? {}),
    ...(name ? { name } : {}),
    ...(username ? { username } : {}),
    ...(empNo ? { emp_no: empNo } : {}),
  };
  if (!key && !name && !username && !person) return <span className={className}>{unknown}</span>;
  const shown = personDisplay(source, key);
  return (
    <span title={key ?? undefined} className={cn(shown.isId ? 'font-mono text-xs' : undefined, className)}>
      {shown.text}
      {shown.empNo && !shown.isId ? (
        <span className="ml-1 text-xs text-text-subtle">· {shown.empNo}</span>
      ) : null}
    </span>
  );
}
