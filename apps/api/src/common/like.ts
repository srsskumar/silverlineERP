/**
 * A search term as an ILIKE "contains" pattern, with the term taken literally.
 *
 * `%` and `_` are wildcards to LIKE, and the backslash is its escape. A
 * search box that passed them through turned "50%" into "50 followed by
 * anything" and a lone "_" or "%" into "every row" (D-007). Escaping them
 * with the default backslash escape keeps the term as typed.
 */
export function likeContains(term: string): string {
  return `%${term.replace(/[\%_]/g, (c) => `\${c}`)}%`;
}
