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

/**
 * The organisation's timezone, for code that works out "today" in JS rather
 * than SQL (SV-017). The same setting and the same default as orgZoneSql, so
 * a route and a job cannot disagree about which day it is. Cached briefly:
 * it is read on every survey request and changes about never.
 */
const zoneCache = new Map<string, { zone: string; at: number }>();
export const DEFAULT_ORG_ZONE = 'Asia/Kolkata';
export async function orgTimeZone(
  db: { query: (sql: string, args: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  orgId: string,
): Promise<string> {
  const hit = zoneCache.get(orgId);
  if (hit && Date.now() - hit.at < 60_000) return hit.zone;
  const raw = (await db.query(
    "SELECT settings->>'timezone' AS tz FROM organizations WHERE id = $1", [orgId])).rows[0]?.tz;
  let zone = DEFAULT_ORG_ZONE;
  if (typeof raw === 'string' && raw.trim()) {
    try { new Intl.DateTimeFormat('en-CA', { timeZone: raw.trim() }); zone = raw.trim(); }
    catch { /* an unknown zone falls back, as Postgres would refuse it */ }
  }
  zoneCache.set(orgId, { zone, at: Date.now() });
  return zone;
}
/** The zone last loaded for an organisation, or the default. Synchronous. */
export function cachedOrgZone(orgId: string | null | undefined): string {
  return (orgId && zoneCache.get(orgId)?.zone) || DEFAULT_ORG_ZONE;
}
