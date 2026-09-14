export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS snapshots(key TEXT PRIMARY KEY,body TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks_cache (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'TO_DO',
  version INTEGER NOT NULL DEFAULT 0,
  assignee_id TEXT,
  body TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  synced_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_cache_status ON tasks_cache(status);

CREATE TABLE IF NOT EXISTS attendance_cache (
  id TEXT PRIMARY KEY,
  work_date TEXT,
  status TEXT,
  body TEXT NOT NULL DEFAULT '{}',
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS projects_cache (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '{}',
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS leave_cache (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'request',
  status TEXT,
  body TEXT NOT NULL DEFAULT '{}',
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS notifications_cache (
  id TEXT PRIMARY KEY,
  read_at TEXT,
  body TEXT NOT NULL DEFAULT '{}',
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS pending_ops (
  client_uuid TEXT PRIMARY KEY,
  seq INTEGER NOT NULL DEFAULT 0,
  entity TEXT NOT NULL,
  op TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL UNIQUE,
  base_version INTEGER,
  state TEXT NOT NULL DEFAULT 'QUEUED',
  decision TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_ops_state ON pending_ops(state, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_pending_ops_dedupe ON pending_ops(dedupe_key, state);
CREATE INDEX IF NOT EXISTS idx_pending_ops_seq ON pending_ops(seq);
`;

/**
 * Statements applied after SCHEMA_SQL on every open, each independently.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so a statement that has already
 * been applied throws "duplicate column name" — expected, and swallowed by the
 * caller. Keep each one idempotent-by-failure and never destructive.
 */
export const MIGRATIONS_SQL: readonly string[] = [
  // Ordering used to fall back to client_uuid when two operations landed in the
  // same millisecond, which is random. A check-out could then be sent before
  // its own check-in and be rejected as CHECKOUT_WITHOUT_CHECKIN.
  "ALTER TABLE pending_ops ADD COLUMN seq INTEGER NOT NULL DEFAULT 0",
];

/** Applies MIGRATIONS_SQL, ignoring statements already applied. */
export async function applyMigrations(
  run: (sql: string) => Promise<unknown>,
): Promise<void> {
  for (const sql of MIGRATIONS_SQL) {
    try {
      await run(sql);
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (!/duplicate column name|already exists/i.test(message)) throw error;
    }
  }
}

export const RECOVER_INTERRUPTED_SQL="UPDATE pending_ops SET state='QUEUED' WHERE state='SENDING'";
