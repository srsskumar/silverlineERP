import {seal,unseal,destroyVault} from "../device/vault";
/**
 * expo-sqlite schema for the offline-first MVP.
 *
 * - snapshots holds sealed read-through copies of API responses, keyed by
 *   request. Tokens NEVER go here (SecureStore only — see device/auth.ts).
 * - The account store itself -- which file, opening, the remote wipe -- is in
 *   dbCore.ts, where it can be tested without a device.
 * - pending_ops is the outbox: client_uuid PK, idempotency_key UNIQUE,
 *   dedupe_key = "<entity>::<op>" enforced in queue.ts (one active op per
 *   entity+op), base_version for If-Match guarded writes.
 */

import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";
import { createAccountStore } from "./dbCore";

export const { setActiveAccount, getAccount, getDb, wipeAccount, wipeUsername } =
  createAccountStore<SQLite.SQLiteDatabase>({
    openDatabase: (name) => SQLite.openDatabaseAsync(name),
    deleteDatabase: (name) => SQLite.deleteDatabaseAsync(name),
    store: SecureStore,
    destroyVault,
  });
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
