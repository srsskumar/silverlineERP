import {SCHEMA_SQL,RECOVER_INTERRUPTED_SQL,applyMigrations} from "./schema";
import {seal,unseal,destroyVault} from "../device/vault";
/**
 * expo-sqlite schema for the offline-first MVP.
 *
 * - Caches are read-through snapshots keyed by server id; `synced_at` marks
 *   freshness. Tokens NEVER go here (SecureStore only — see device/auth.ts).
 * - pending_ops is the outbox: client_uuid PK, idempotency_key UNIQUE,
 *   dedupe_key = "<entity>::<op>" enforced in queue.ts (one active op per
 *   entity+op), base_version for If-Match guarded writes.
 */

import { getRefreshToken } from "../device/auth";
import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";

export const DB_NAME = "silverline.db";

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
let activeAccount: string | null = null;
export async function setActiveAccount(id: string | null): Promise<void> {
  if (activeAccount !== id) { dbPromise = null; activeAccount = id; }
  if (id) await SecureStore.setItemAsync('silverline.account', id);
  else await SecureStore.deleteItemAsync('silverline.account');
}
export async function getAccount(): Promise<string | null> { return activeAccount ?? SecureStore.getItemAsync('silverline.account'); }
export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  const account = await getAccount();
  if (!account) throw new Error('Sign in to access offline records');
  if (!dbPromise) dbPromise = (async () => {
    const db = await SQLite.openDatabaseAsync(`silverline-${account}.db`);
    await db.execAsync(SCHEMA_SQL);
    await applyMigrations(async (sql) => db.execAsync(sql));
    await db.runAsync(RECOVER_INTERRUPTED_SQL);
    return db;
  })().catch(error => { dbPromise=null; throw error; });
  return dbPromise;
}
export async function wipeAccount(): Promise<void> {
 const db=await getDb();
 const account=await getAccount();
 if(account)await destroyVault(account);
 await db.execAsync("DELETE FROM pending_ops; DELETE FROM tasks_cache; DELETE FROM attendance_cache; DELETE FROM projects_cache; DELETE FROM leave_cache; DELETE FROM notifications_cache; DELETE FROM snapshots; DELETE FROM meta;");
}
export async function cachedRead<T>(key:string,fetcher:()=>Promise<T>):Promise<T> {
 const account=await getAccount();if(!account)throw new Error('Sign in first');
 const db=await getDb();
 try { const data=await fetcher();await db.runAsync('INSERT INTO snapshots(key,body) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body',[key,await seal(account,JSON.stringify(data))]);return data; }
 catch(error) { if ((error as {retryable?:boolean}).retryable) {const row=await db.getFirstAsync<{body:string}>('SELECT body FROM snapshots WHERE key=?',[key]);if(row)return JSON.parse(await unseal(account,row.body)) as T;}throw error; }
}



export type PendingOpRow = {
  /** Monotonic enqueue order; the FIFO key the flush sorts on. */
  seq: number;
  client_uuid: string;
  entity: string;
  op: string;
  dedupe_key: string;
  payload: string;
  idempotency_key: string;
  base_version: number | null;
  state: string;
  decision: string | null;
  retry_count: number;
  next_retry_at: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

export async function countPendingOps(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM pending_ops WHERE state IN ('QUEUED','SENDING','BACKOFF')",
  );
  return row?.n ?? 0;
}

/** Operations that can be sent now; future backoff rows should not wake the network. */
export async function countReadyOps(now = Date.now()): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM pending_ops WHERE state='QUEUED' OR (state='BACKOFF' AND (next_retry_at IS NULL OR next_retry_at<=?))",
    [now],
  );
  return row?.n ?? 0;
}

export async function listPendingOps(): Promise<PendingOpRow[]> {
  const db = await getDb();
  return db.getAllAsync<PendingOpRow>(
    "SELECT * FROM pending_ops ORDER BY created_at ASC, client_uuid ASC LIMIT 100",
  );
}
