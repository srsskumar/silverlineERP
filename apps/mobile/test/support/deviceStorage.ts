/// <reference types="node" />
/**
 * A device's storage for the node test runner: database files on disk through
 * node:sqlite, SecureStore as a map. Shaped like the slices of expo-sqlite and
 * expo-secure-store that sync/dbCore.ts takes, so the production account store
 * -- opening, the remote wipe, the file delete -- runs unchanged.
 *
 * deleteDatabase behaves as the native module does: it refuses a database that
 * is still open and throws for one that does not exist.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountDatabase, KeyValueStore } from "../../src/sync/dbCore";

type Params = (string | number | null)[];

export interface TestDatabase extends AccountDatabase {
  raw: DatabaseSync;
}

export function deviceStorage() {
  const dir = mkdtempSync(join(tmpdir(), "sl-device-"));
  const open = new Map<string, number>();
  const secure = new Map<string, string>();
  const path = (name: string) => join(dir, name);

  async function openDatabase(name: string): Promise<TestDatabase> {
    const raw = new DatabaseSync(path(name));
    open.set(name, (open.get(name) ?? 0) + 1);
    let closed = false;
    return {
      raw,
      execAsync: async (sql: string) => {
        raw.exec(sql);
      },
      closeAsync: async () => {
        if (closed) return;
        closed = true;
        raw.close();
        open.set(name, open.get(name)! - 1);
      },
      getFirstAsync: async <T>(sql: string, params: Params) =>
        (raw.prepare(sql).get(...params) as T) ?? null,
      getAllAsync: async <T>(sql: string, params: Params) => raw.prepare(sql).all(...params) as T[],
      runAsync: async (sql: string, params: Params) => raw.prepare(sql).run(...params),
    };
  }

  async function deleteDatabase(name: string): Promise<void> {
    if ((open.get(name) ?? 0) > 0) throw new Error(`Unable to delete database '${name}' that is currently open`);
    if (!existsSync(path(name))) throw new Error(`Database '${name}' not found`);
    unlinkSync(path(name));
    for (const suffix of ["-wal", "-shm"]) if (existsSync(path(name) + suffix)) unlinkSync(path(name) + suffix);
  }

  const store: KeyValueStore = {
    getItemAsync: async (key) => secure.get(key) ?? null,
    setItemAsync: async (key, value) => {
      secure.set(key, value);
    },
    deleteItemAsync: async (key) => {
      secure.delete(key);
    },
  };

  return {
    openDatabase,
    deleteDatabase,
    store,
    secure,
    fileExists: (name: string) => existsSync(path(name)),
    isOpen: (name: string) => (open.get(name) ?? 0) > 0,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
