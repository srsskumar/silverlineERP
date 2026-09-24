/**
 * A search term as an ILIKE "contains" pattern, with the term taken literally.
 *
 * `%` and `_` are wildcards to LIKE. A search box that passed them through
 * turned "50%" into "50 followed by anything" and a lone "%" or "_" into
 * "every row" (D-007). They are escaped with `!`, and every query using this
 * pattern must say so: `col ILIKE $n ESCAPE '!'`. `!` rather than a
 * backslash, so the SQL never depends on how a backslash in a string literal
 * is read, and so this source cannot be mangled by a shell or template
 * literal the way the first version was.
 */
export function likeContains(term: string): string {
  return "%" + term.replace(/[!%_]/g, (c) => "!" + c) + "%";
}
