/**
 * The organisation's calendar day, as SQL (D-013).
 *
 * CURRENT_DATE is the database session's day, and the session runs in UTC:
 * from 00:00 to 05:30 in India it is still yesterday. Anything stamped or
 * counted "today" in SQL uses this instead, the same org-timezone rule the
 * audit filters use (D-006).
 *
 * `orgIdSql` is a column or parameter reference already in the query, never
 * user input.
 */
export function orgZoneSql(orgIdSql: string): string {
  return `COALESCE((SELECT o.settings->>'timezone' FROM organizations o WHERE o.id = ${orgIdSql}), 'Asia/Kolkata')`;
}

export function orgTodaySql(orgIdSql: string): string {
  return `((now() AT TIME ZONE ${orgZoneSql(orgIdSql)})::date)`;
}
