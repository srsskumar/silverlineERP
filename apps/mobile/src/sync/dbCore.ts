/**
 * The per-account offline database and its remote wipe, with the storage
 * modules injected so the same code runs on a device (db.ts wires expo-sqlite
 * and SecureStore) and under the node test runner (node:sqlite and a map).
 *
 * Each signed-in account gets its own database file, silverline-<id>.db, and
 * its own encryption key in the vault. A wipe destroys both: the key first, so
 * whatever survives on disk is ciphertext nobody can open, then the rows, then
 * the file itself.
 */
import { SCHEMA_SQL, RECOVER_INTERRUPTED_SQL, applyMigrations } from "./schema";
import { purgeSettledOps, type QueueDatabase } from "./queueCore";

/** The slice of an expo-sqlite database handle this module uses. */
export interface AccountDatabase extends QueueDatabase {
  execAsync(sql: string): Promise<void>;
  closeAsync(): Promise<void>;
}

/** The slice of expo-secure-store this module uses. */
export interface KeyValueStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export interface AccountStoreDeps<D extends AccountDatabase> {
  openDatabase(name: string): Promise<D>;
  /** Deletes a database file that is not open. May throw if there is none. */
  deleteDatabase(name: string): Promise<void>;
  store: KeyValueStore;
  destroyVault(account: string): Promise<void>;
}

const ACCOUNT_KEY = "silverline.account";
/**
 * username -> account id for every account that has signed in on this device.
 * A revoked device is told so at login, before there is a session or an
 * account id; the username typed into the form is all there is to go on.
 */
const KNOWN_ACCOUNTS_KEY = "silverline.known_accounts";

/**
 * Every table a wipe empties. Emptied before the file is deleted so that, if
 * the platform refuses the delete, what remains is an empty database rather
 * than a full one. The *_cache tables were never written to and are dropped by
 * migration; they stay listed for a database that has not been migrated yet.
 */
const WIPED_TABLES = [
  "pending_ops",
  "snapshots",
  "meta",
  "tasks_cache",
  "attendance_cache",
  "projects_cache",
  "leave_cache",
  "notifications_cache",
] as const;

export function databaseName(account: string): string {
  return `silverline-${account}.db`;
}

function normaliseUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function createAccountStore<D extends AccountDatabase>(deps: AccountStoreDeps<D>) {
  const { store } = deps;
  let dbPromise: Promise<D> | null = null;
  let activeAccount: string | null = null;

  async function knownAccounts(): Promise<Record<string, string>> {
    try {
      const raw = await store.getItemAsync(KNOWN_ACCOUNTS_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : {};
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  async function setActiveAccount(id: string | null, username?: string): Promise<void> {
    if (activeAccount !== id) {
      // Close the previous account's handle rather than just forgetting it.
      // expo-sqlite reference-counts open databases and will not delete one
      // with a reference left, so a handle dropped on sign-out would later
      // stop a login-time wipe from removing that account's file.
      const previous = dbPromise;
      dbPromise = null;
      activeAccount = id;
      if (previous) await previous.then((db) => db.closeAsync()).catch(() => undefined);
    }
    if (id) await store.setItemAsync(ACCOUNT_KEY, id);
    else await store.deleteItemAsync(ACCOUNT_KEY);
    if (id && username) {
      const known = await knownAccounts();
      if (known[normaliseUsername(username)] !== id) {
        known[normaliseUsername(username)] = id;
        await store.setItemAsync(KNOWN_ACCOUNTS_KEY, JSON.stringify(known));
      }
    }
  }

  async function getAccount(): Promise<string | null> {
    return activeAccount ?? store.getItemAsync(ACCOUNT_KEY);
  }

  async function getDb(): Promise<D> {
    const account = await getAccount();
    if (!account) throw new Error("Sign in to access offline records");
    if (!dbPromise)
      dbPromise = (async () => {
        const db = await deps.openDatabase(databaseName(account));
        await db.execAsync(SCHEMA_SQL);
        await applyMigrations(async (sql) => db.execAsync(sql));
        await db.runAsync(RECOVER_INTERRUPTED_SQL, []);
        await purgeSettledOps(db);
        return db;
      })().catch((error) => {
        dbPromise = null;
        throw error;
      });
    return dbPromise;
  }

  /**
   * Destroys one account's local data: its vault key, its rows and its
   * database file. With no argument, the signed-in account. Never throws for
   * a missing database -- there being nothing to wipe is a wiped device.
   */
  async function wipeAccount(account?: string | null): Promise<void> {
    const target = account ?? (await getAccount());
    if (!target) return;
    await deps.destroyVault(target);

    let db: D | null = null;
    if (target === (await getAccount())) {
      // The open handle belongs to this account. Forget it and the account
      // together, so nothing reopens -- and recreates -- the file mid-wipe.
      db = dbPromise ? await dbPromise.catch(() => null) : null;
      dbPromise = null;
      activeAccount = null;
      await store.deleteItemAsync(ACCOUNT_KEY).catch(() => undefined);
    }
    if (!db) db = await deps.openDatabase(databaseName(target)).catch(() => null);
    if (db) {
      for (const table of WIPED_TABLES) {
        // One at a time: a table that does not exist in this file must not
        // stop the rest from being emptied.
        await db.execAsync(`DELETE FROM ${table}`).catch(() => undefined);
      }
      // The native module refuses to delete a database that is still open.
      await db.closeAsync().catch(() => undefined);
    }
    await deps.deleteDatabase(databaseName(target)).catch(() => undefined);

    const known = await knownAccounts();
    const remaining = Object.fromEntries(Object.entries(known).filter(([, id]) => id !== target));
    if (Object.keys(remaining).length !== Object.keys(known).length) {
      await store.setItemAsync(KNOWN_ACCOUNTS_KEY, JSON.stringify(remaining));
    }
  }

  /**
   * The login-time half of a remote wipe: the server refused this username on
   * this device, so whatever that user left here goes.
   */
  async function wipeUsername(username: string): Promise<void> {
    const id = (await knownAccounts())[normaliseUsername(username)];
    if (id) await wipeAccount(id);
  }

  return { setActiveAccount, getAccount, getDb, wipeAccount, wipeUsername };
}
