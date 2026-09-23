import { apiRequestRaw } from './apiClient';

const PAGE = 100;
const MAX_PAGES = 20;

/**
 * The people work can be assigned to, by name.
 *
 * Tasks carry a user id, but nobody thinks of a colleague as a UUID — they
 * think of the name on the employee record. Every screen that showed an
 * assignee was printing a truncated id, and every screen that set one asked
 * the user to paste a UUID they had to find somewhere else.
 */
export interface Person {
  id: string;
  username: string;
  employee_id: string | null;
  emp_no: string | null;
  /** Employee name where there is one, else the sign-in name. Never blank. */
  name: string;
  employee_status: string | null;
}

/**
 * The whole directory, page by page.
 *
 * A picker that stops at the first hundred names makes everybody after that
 * unassignable, with nothing on screen to say so.
 */
export async function listPeople(): Promise<Person[]> {
  const out: Person[] = [];
  for (let offset = 0, page = 0; page < MAX_PAGES; page += 1, offset += PAGE) {
    const body = (await apiRequestRaw(`/api/v1/people?limit=${PAGE}&offset=${offset}`)).body as {
      data?: Person[]; has_more?: boolean;
    };
    out.push(...(body?.data ?? []));
    if (!body?.has_more) break;
  }
  return out;
}

/** A user id to the name to print, so a lookup miss degrades to the id, not to blank. */
export function peopleIndex(people: Person[]): Map<string, Person> {
  return new Map(people.map((p) => [String(p.id), p]));
}

/**
 * The label for a user id.
 *
 * Falls back to a short id when the person is not in the directory — a
 * deactivated account still appears on the tasks it once held, and showing
 * nothing there loses the audit trail.
 */
export function personLabel(index: Map<string, Person>, userId: string | null | undefined): string {
  if (!userId) return 'Unassigned';
  const person = index.get(String(userId));
  if (person) return person.name;
  return `${String(userId).slice(0, 8)}…`;
}

/**
 * The people work can actually be given to.
 *
 * A picker listing everybody who ever worked here offers somebody who left in
 * March as this week's assignee, and the write is refused later with an error
 * nobody expected. Filtered here rather than in the fetch because the same
 * list resolves names on historical records — an audit entry or a closed
 * task still has to show who did it, and dropping leavers from the fetch
 * would print those rows blank.
 *
 * Accounts with no employee record stay: an administrator or service login is
 * not an inactive employee, and removing them would make the people who
 * mostly assign work unassignable themselves.
 */
export function assignablePeople(people: Person[] | undefined): Person[] {
  return (people ?? []).filter(
    (p) => p.employee_id === null || p.employee_status === 'ACTIVE',
  );
}

/* ------------------------------------------------------------------
 * One way to print a person, everywhere.
 *
 * Every screen had its own idea: a truncated UUID here, a username there,
 * a name with no employee number somewhere else. The rule is now the same
 * throughout: the name from the employee record, then the employee number
 * after a dot; failing a name, the sign-in name; failing everything, the
 * first eight characters of the id with the whole of it on hover, so support
 * can still copy it.
 */

/** The first eight characters, for an id that has to appear at all. */
export function shortId(id: string | null | undefined): string {
  const s = String(id ?? '');
  return s.length > 12 ? `${s.slice(0, 8)}…` : s;
}

export interface PersonLike {
  id?: string | null;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  emp_no?: string | null;
  designation?: string | null;
}

/** "First Last" from an employee row; blank when the row has no name. */
export function fullName(p: PersonLike | null | undefined): string {
  if (!p) return '';
  const explicit = String(p.name ?? '').trim();
  if (explicit) return explicit;
  return [p.first_name, p.last_name].map((s) => String(s ?? '').trim()).filter(Boolean).join(' ');
}

export interface PersonDisplay {
  /** What to print in the main position. */
  text: string;
  /** The employee number, printed after the name where there is one. */
  empNo: string | null;
  /** True when the text is nothing better than a shortened id. */
  isId: boolean;
}

/**
 * Name, else username, else the shortened id.
 *
 * The employee number is returned separately rather than folded in, so a
 * table can print it muted after the name and a picker can print it as a
 * hint, without either re-splitting a string.
 */
export function personDisplay(p: PersonLike | null | undefined, id?: string | null): PersonDisplay {
  const name = fullName(p);
  const empNo = p?.emp_no ? String(p.emp_no) : null;
  if (name) return { text: name, empNo, isId: false };
  const username = String(p?.username ?? '').trim();
  if (username) return { text: username, empNo, isId: false };
  const raw = id ?? p?.id;
  return { text: raw ? shortId(raw) : '—', empNo, isId: true };
}

/** "First Last · EMP-NO · Designation": what a picker option says. */
export function employeeOptionLabel(e: PersonLike): string {
  return [fullName(e) || e.username || shortId(e.id), e.emp_no, e.designation]
    .map((s) => String(s ?? '').trim()).filter(Boolean).join(' · ');
}
