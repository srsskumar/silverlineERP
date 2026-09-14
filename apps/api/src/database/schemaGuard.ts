import { MIGRATION_VERSIONS } from "./migrate.js";

/**
 * Startup guard against an un-migrated database.
 *
 * A deployment that is one migration behind does not fail visibly: it fails
 * one route at a time, whenever a SELECT first names a column the database
 * does not have yet, and the client sees an opaque 500 with no hint that a
 * migration is pending. (Shipped instance: attendance's EVENT_COLS gained
 * `device_signals` in 020, the database was still at 019, and only
 * GET /attendance/records/:id broke.) Comparing the migrations this build
 * registers against `schema_migrations` turns that into one specific,
 * actionable message at boot.
 */

/** Minimal surface used here, so tests can pass a stub instead of a Pool. */
export interface Queryable {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export interface SchemaDrift {
  /** Registered migrations the database has not applied yet, in order. */
  pending: string[];
  /** Applied versions this build does not know about (database is ahead). */
  ahead: string[];
}

/** Postgres "relation does not exist" — the database was never migrated. */
const UNDEFINED_TABLE = "42P01";

/**
 * Pure diff of expected versus applied migration versions. Order comes from
 * the registered list, never from the database, so the message names the
 * migration an operator has to run first.
 */
export function diffMigrations(
  expected: readonly string[],
  applied: readonly string[],
): SchemaDrift {
  const appliedSet = new Set(applied);
  const expectedSet = new Set(expected);
  return {
    pending: expected.filter((v) => !appliedSet.has(v)),
    ahead: applied.filter((v) => !expectedSet.has(v)).sort(),
  };
}

/** True when the database is level with this build (extra versions are fine). */
export function isSchemaCurrent(drift: SchemaDrift): boolean {
  return drift.pending.length === 0;
}

/**
 * Operator-facing message, or null when nothing is wrong. `ahead` alone is
 * not an error: an older instance during a rolling deploy sees a database a
 * newer instance already migrated, and additive migrations keep it working.
 */
export function describeSchemaDrift(drift: SchemaDrift): string | null {
  if (isSchemaCurrent(drift)) {
    return null;
  }
  const [first] = drift.pending;
  return (
    `Database schema is out of date: ${drift.pending.length} migration(s) pending, ` +
    `starting with ${first}. Routes that read the columns it adds will fail with ` +
    `an opaque 500 until it runs. Apply with: ` +
    `DATABASE_URL=... npx tsx src/database/migrate.ts ` +
    `(pending: ${drift.pending.join(", ")}).`
  );
}

/**
 * Versions recorded in `schema_migrations`. Returns [] when the table is
 * absent, which means nothing has ever been migrated rather than an error.
 */
export async function readAppliedMigrations(
  db: Queryable,
): Promise<string[]> {
  try {
    const res = await db.query("SELECT version FROM schema_migrations");
    return (res.rows as Array<{ version: string }>).map((r) => r.version);
  } catch (error) {
    if ((error as { code?: string })?.code === UNDEFINED_TABLE) {
      return [];
    }
    throw error;
  }
}

/** Read the applied set and diff it against the registered migrations. */
export async function inspectSchema(
  db: Queryable,
  expected: readonly string[] = MIGRATION_VERSIONS,
): Promise<SchemaDrift> {
  return diffMigrations(expected, await readAppliedMigrations(db));
}

export interface VerifySchemaOptions {
  expected?: readonly string[];
  /** Receives one ready-to-read line when the database is behind. */
  report: (message: string) => void;
  /**
   * Throw instead of only reporting. Opt-in: an instance that is merely
   * behind still serves every route the pending migration does not touch,
   * so refusing to boot is a deployment policy, not a default.
   */
  fatal?: boolean;
}

/**
 * Startup check. Never masks a connectivity failure as schema drift — if the
 * state cannot be read at all the error propagates to the caller, which
 * already handles an unreachable database.
 */
export async function verifySchemaCurrent(
  db: Queryable,
  options: VerifySchemaOptions,
): Promise<SchemaDrift> {
  const drift = await inspectSchema(db, options.expected ?? MIGRATION_VERSIONS);
  const message = describeSchemaDrift(drift);
  if (message) {
    options.report(message);
    if (options.fatal) {
      throw new Error(message);
    }
  }
  return drift;
}
