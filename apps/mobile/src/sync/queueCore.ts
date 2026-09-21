/**
 * Offline outbox queue over expo-sqlite pending_ops.
 *
 * - enqueue(): assigns client_uuid + Idempotency-Key (crypto.randomUUID),
 *   dedupes one-active-op per entity+op (returns the existing row when a
 *   QUEUED/BACKOFF/SENDING op with the same dedupe_key exists).
 * - flush(): FIFO, one op at a time; transport failures and 429/5xx get
 *   exponential backoff + jitter (policy.computeBackoffMs); terminal
 *   outcomes (REJECTED/CONFLICT/REVIEW) stop retrying.
 * - PHOTOS: there is NO backend R2-presign endpoint, so photo evidence is
 *   staged LOCALLY (payload carries base64 + `uploadPending: true` +
 *   thumbnail note) and POSTed as plain base64 JSON to
 *   POST /api/v1/tasks/:id/evidence when online. UPGRADE PATH: add
 *   POST /api/v1/uploads/presign returning { url, fields } + switch the
 *   evidence executor to direct-to-R2 PUT, keeping the outbox row until the
 *   confirm callback succeeds.
 */

import { classifySyncResponse, resolveOutcome } from "../api/sync";
import {
  computeBackoffMs,
  dedupeKey,
  isFlushEligible,
  maxRetriesExceeded,
  MAX_QUEUE_RETRIES,
} from "./policy";
import type {PendingOpRow} from "./db";

export type QueueEntity =
  | "attendance_event"
  | "attendance_exception"
  | "task_create"
  | "task_status"
  | "task_comment"
  | "task_evidence"
  | "asset_transition"
  | "asset_assignment"
  | "asset_audit"
  | "leave_request"
  | "leave_decision"
  | "notification_read"
  | "survey_entry"
  | "survey_gcp"
  | "client_error";


/** Executor: performs the network call for one op. Injected by engine.ts. */
export type OpExecutor = (op: PendingOpRow) => Promise<{
  status: number;
  body: unknown;
}>;

export interface FlushResult {
  attempted: number;
  succeeded: number;
  failed: number;
  deferred: number;
}


export interface QueueDatabase {
 getFirstAsync<T>(sql:string,params:(string|number|null)[]):Promise<T|null>;
 getAllAsync<T>(sql:string,params:(string|number|null)[]):Promise<T[]>;
 runAsync(sql:string,params:(string|number|null)[]):Promise<unknown>;
}
type RequestError=Error&{status:number;retryable:boolean;code:string};

/**
 * How long a delivered operation stays visible in the sync queue. Long enough
 * for somebody to check that yesterday's punches went through; short enough
 * that the outbox does not grow for the life of the install.
 */
export const SETTLED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** And never more than this many delivered rows, whatever their age. */
export const SETTLED_KEEP_MAX = 50;

/**
 * Drops delivered operations older than the retention window, and all but the
 * newest SETTLED_KEEP_MAX of them. Only SUCCEEDED rows go: a FAILED row is
 * waiting for the user to retry or discard it, and an active row has not been
 * sent. The newest rows always survive, so a caller that has just flushed can
 * still read back the outcome of the operation it submitted.
 */
export async function purgeSettledOps(db:QueueDatabase,now=Date.now()):Promise<void> {
 await db.runAsync(
  `DELETE FROM pending_ops WHERE state='SUCCEEDED' AND (updated_at < ? OR client_uuid NOT IN (
     SELECT client_uuid FROM pending_ops WHERE state='SUCCEEDED' ORDER BY updated_at DESC, seq DESC LIMIT ?))`,
  [now-SETTLED_RETENTION_MS,SETTLED_KEEP_MAX],
 );
}

/**
 * What the sync queue screen shows. Work that needs the user comes first --
 * failed rows, then rows still waiting to send -- and each group newest first.
 * Oldest-first put a hundred delivered rows ahead of everything else, so a
 * failure that happened after them was never on screen to be retried.
 */
export const LIST_OPS_SQL = `SELECT * FROM pending_ops
  ORDER BY CASE state WHEN 'FAILED' THEN 0 WHEN 'SUCCEEDED' THEN 2 ELSE 1 END,
    created_at DESC, seq DESC
  LIMIT 100`;
export function createQueue({getDb,getAccount,seal,unseal,uuid,isApiError}:{getDb:()=>Promise<QueueDatabase>;getAccount:()=>Promise<string|null>;seal:(account:string,value:string)=>Promise<string>;unseal:(account:string,value:string)=>Promise<string>;uuid:()=>string;isApiError:(e:unknown)=>e is RequestError}) {
const ACTIVE_STATES = ["QUEUED", "SENDING", "BACKOFF"];

function newUuid(): string { return uuid(); }

async function enqueueOp(args: {
  entity: QueueEntity;
  op: string;
  payload: Record<string, unknown>;
  baseVersion?: number;
  idempotencyKey?: string;
}): Promise<PendingOpRow> {
  const db = await getDb();
  const account=await getAccount();if(!account)throw new Error("Sign in first");
  const key = dedupeKey(args.entity, args.op);
  const existing = await db.getFirstAsync<PendingOpRow>(
    `SELECT * FROM pending_ops WHERE dedupe_key = ? AND state IN (${ACTIVE_STATES.map(() => "?").join(",")}) ORDER BY created_at ASC LIMIT 1`,
    [key, ...ACTIVE_STATES],
  );
  if (existing && (await unseal(account,existing.payload)) === JSON.stringify(args.payload)) return existing;
  const now = Date.now();
  // Monotonic within the outbox: two operations enqueued in the same
  // millisecond still have a defined order, which FIFO flush depends on.
  const last = await db.getFirstAsync<{ seq: number }>(
    "SELECT COALESCE(MAX(seq), 0) AS seq FROM pending_ops",
    [],
  );
  const row: PendingOpRow = {
    seq: (last?.seq ?? 0) + 1,
    client_uuid: newUuid(),
    entity: args.entity,
    op: args.op,
    dedupe_key: key,
    payload: await seal(account,JSON.stringify(args.payload)),
    idempotency_key: args.idempotencyKey ?? newUuid(),
    base_version: args.baseVersion ?? null,
    state: "QUEUED",
    decision: null,
    retry_count: 0,
    next_retry_at: null,
    error: null,
    created_at: now,
    updated_at: now,
  };
  await db.runAsync(
    `INSERT INTO pending_ops (seq, client_uuid, entity, op, dedupe_key, payload,
      idempotency_key, base_version, state, decision, retry_count,
      next_retry_at, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.seq, row.client_uuid, row.entity, row.op, row.dedupe_key, row.payload,
      row.idempotency_key, row.base_version, row.state, row.decision,
      row.retry_count, row.next_retry_at, row.error, row.created_at,
      row.updated_at,
    ],
  );
  return row;
}

async function setOp(
  clientUuid: string,
  patch: Partial<Pick<PendingOpRow, "state" | "decision" | "retry_count" | "next_retry_at" | "error" | "payload">>,
  database?:QueueDatabase,
): Promise<void> {
  const db = database??await getDb();
  const sets: string[] = ["updated_at = ?"];
  const vals: Array<string | number | null> = [Date.now()];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`);
    vals.push(v as string | number | null);
  }
  vals.push(clientUuid);
  await db.runAsync(
    `UPDATE pending_ops SET ${sets.join(", ")} WHERE client_uuid = ?`,
    vals,
  );
}

/** FIFO flush of all eligible ops. Never throws (per-op errors recorded). */
async function flushQueue(executor: OpExecutor): Promise<FlushResult> {
  const db = await getDb();
  const account=await getAccount();if(!account)throw new Error("Sign in first");
  const update=(id:string,patch:Parameters<typeof setOp>[1])=>setOp(id,patch,db);
  const now = Date.now();
  const rows = await db.getAllAsync<PendingOpRow>(
    "SELECT * FROM pending_ops WHERE state='QUEUED' OR (state='BACKOFF' AND (next_retry_at IS NULL OR next_retry_at<=?)) ORDER BY seq ASC, created_at ASC, client_uuid ASC LIMIT 50", [now],
  );
  const result: FlushResult = { attempted: 0, succeeded: 0, failed: 0, deferred: 0 };
  for (const op of rows) {
    if(account!==await getAccount())break;
    if (!isFlushEligible(op.state, op.next_retry_at, now)) {
      result.deferred += 1;
      continue;
    }
    result.attempted += 1;
    await update(op.client_uuid, { state: "SENDING", error: null });
    // Decryption is not a network step: a payload this account's key cannot
    // open never will be, so it fails immediately rather than burning the whole
    // retry budget on a request that can never be built.
    let payload: string;
    try {
      payload = await unseal(account, op.payload);
    } catch {
      result.failed += 1;
      await update(op.client_uuid, {
        state: "FAILED",
        decision: "REJECTED",
        error: "payload could not be decrypted for the signed-in account",
      });
      continue;
    }
    try {
      const { status, body } = await executor({ ...op, payload });
      const decision = classifySyncResponse(status, body);
      const outcome = resolveOutcome(decision);
      if (outcome.state === "SUCCEEDED") {
        result.succeeded += 1;
        // The server has it now, so the sealed body -- a photo can be megabytes
        // of base64 -- has no further use on the device. The row itself stays
        // for a while so the queue screen can show that it went.
        await update(op.client_uuid, { state: "SUCCEEDED", decision, payload: "{}" });
      } else if (outcome.state === "BACKOFF") {
        const retryCount = op.retry_count + 1;
        if (maxRetriesExceeded(retryCount, MAX_QUEUE_RETRIES)) {
          result.failed += 1;
          await update(op.client_uuid, {
            state: "FAILED", decision, retry_count: retryCount,
            error: `max retries (${MAX_QUEUE_RETRIES}) exceeded`,
          });
        } else {
          result.deferred += 1;
          await update(op.client_uuid, {
            state: "BACKOFF", decision, retry_count: retryCount,
            next_retry_at: Date.now() + computeBackoffMs(retryCount),
          });
        }
      } else {
        result.failed += 1;
        const code =
          typeof body === "object" && body !== null && "code" in body
            ? String((body as { code: unknown }).code)
            : `http_${status}`;
        await update(op.client_uuid, {
          state: "FAILED", decision, error: code,
        });
      }
    } catch (err) {
      if (isApiError(err) && !err.retryable && err.status !== 401) {
        result.failed += 1;
        await update(op.client_uuid, { state: "FAILED", decision: err.status === 409 ? "CONFLICT" : "REJECTED", error: `${err.code}: ${err.message}` });
        continue;
      }
      // Transport failure (network down, timeout): back off, keep op.
      const retryCount = op.retry_count + 1;
      const message =
        isApiError(err)
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : "unknown error";
      if (maxRetriesExceeded(retryCount, MAX_QUEUE_RETRIES)) {
        result.failed += 1;
        await update(op.client_uuid, {
          state: "FAILED", retry_count: retryCount, error: message,
        });
      } else {
        result.deferred += 1;
        await update(op.client_uuid, {
          state: "BACKOFF", retry_count: retryCount,
          next_retry_at: Date.now() + computeBackoffMs(retryCount),
          error: message,
        });
      }
    }
  }
  await purgeSettledOps(db);
  return result;
}

async function retryOp(clientUuid:string):Promise<void> {
 const db=await getDb();
 const row=await db.getFirstAsync<PendingOpRow>('SELECT * FROM pending_ops WHERE client_uuid=?',[clientUuid]);
 if(!row||row.decision==='CONFLICT'||row.decision==='REJECTED')throw new Error('Review and correct this operation before submitting a new request.');
 await db.runAsync("UPDATE pending_ops SET state='QUEUED',retry_count=0,next_retry_at=NULL,error=NULL WHERE client_uuid=? AND state='FAILED'",[clientUuid]);
}

async function listOps():Promise<PendingOpRow[]> {
 return (await getDb()).getAllAsync<PendingOpRow>(LIST_OPS_SQL,[]);
}

return {enqueueOp,flushQueue,retryOp,listOps};
}
