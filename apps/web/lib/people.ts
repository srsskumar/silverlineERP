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
