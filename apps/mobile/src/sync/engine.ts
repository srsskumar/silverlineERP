import {apiFetch} from "../api/client";
/** Flush the encrypted outbox on foreground, periodic and OS background triggers. */

import { AppState, type AppStateStatus } from "react-native";
import { useEffect, useState } from "react";
import { apiBaseUrl } from "../api/client";
import {
  getTask,
  getTaskComments,
  patchTaskStatus,
  postAttendanceEvent,
  postAttendanceException,
  postLeaveRequest,
  postTaskComment,
  postTaskEvidence,
  postTask as apiPostTask,
} from "../api/endpoints";
import { enqueueOp, flushQueue, type OpExecutor } from "./queue";
import { getRefreshToken } from "../device/auth";
import { countPendingOps, countReadyOps, getAccount, getDb, type PendingOpRow } from "./db";

export type EngineStatus = "idle" | "syncing" | "offline" | "error";

let syncing = false;
let listeners = new Set<(s: EngineStatus) => void>();
let lastStatus: EngineStatus = "idle";

function emit(s: EngineStatus): void {
  lastStatus = s;
  for (const l of listeners) l(s);
}

/** Any HTTP response (any status) proves connectivity. */
export async function probeOnline(timeoutMs = 5000): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetch(`${apiBaseUrl()}/api/v1/auth/me`, {
      method: "GET",
      signal: ctrl.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** Map one outbox op onto its endpoint call. Throws on transport failure. */
export const defaultExecutor: OpExecutor = async (op) => {
  const payload = JSON.parse(op.payload) as Record<string, unknown>;
  switch (op.entity) {
    case "attendance_event": {
      const { result, status } = await postAttendanceEvent(
        payload as unknown as Parameters<typeof postAttendanceEvent>[0],
        op.idempotency_key,
      );
      return { status, body: result };
    }
    case "attendance_exception":
      return {
        status: 201,
        body: await postAttendanceException(
          payload as unknown as Parameters<typeof postAttendanceException>[0], op.idempotency_key,
        ),
      };
    case "task_create":
      return {
        status: 201,
        body: await apiPostTask(
          payload as unknown as Parameters<typeof apiPostTask>[0], op.idempotency_key,
        ),
      };
    case "task_status": {
      const updated = await patchTaskStatus(
        String(payload.task_id),
        String(payload.status),
        op.base_version ?? (payload.version as number) ?? 0, op.idempotency_key,
      );
      return { status: 200, body: updated };
    }
    case "task_comment":
      return {
        status: 201,
        body: await postTaskComment(
          String(payload.task_id),
          String(payload.body), op.idempotency_key,
        ),
      };
    case "task_evidence":
      // Staged-local photo → plain base64 POST when online (no R2 presign).
      return {
        status: 201,
        body: await postTaskEvidence(String(payload.task_id), {
          evidence_type: String(payload.evidence_type ?? "photo"),
          file_name: String(payload.file_name),
          content_base64: String(payload.content_base64),
        }, op.idempotency_key),
      };
    case "leave_request":
      return {
        status: 201,
        body: await postLeaveRequest(
          payload as unknown as Parameters<typeof postLeaveRequest>[0], op.idempotency_key,
        ),
      };
    case "notification_read":case "leave_decision":case "client_error": {
      const path=op.entity==='notification_read'?`/api/v1/notifications/${String(payload.notification_id)}/read`:op.entity==='client_error'?'/api/v1/client-errors':`/api/v1/leave/requests/${String(payload.request_id)}/decision`;
      const {request_id,notification_id,...body}=payload;
      const result=await apiFetch(path,{method:'POST',idempotencyKey:op.idempotency_key,headers:op.base_version?{'If-Match':String(op.base_version)}:{},body});return {status:result.status,body:result.data};
    }
    case "asset_transition":case "asset_assignment":case "asset_audit": {
      const {asset_id,...body}=payload;
      const path=op.entity==='asset_audit'?'/api/v1/asset-audits':`/api/v1/assets/${String(asset_id)}/${op.entity==='asset_assignment'?'assign':'transition'}`;
      const result=await apiFetch(path,{method:'POST',idempotencyKey:op.idempotency_key,headers:op.base_version?{'If-Match':String(op.base_version)}:{},body});return {status:result.status,body:result.data};
    }
    default:
      throw new Error(`engine: no executor for entity ${op.entity}`);
  }
};

/** Manual "Sync now" + post-login entry point. Safe to call concurrently. */
export async function syncNow(): Promise<boolean> {
  if (syncing) return false;
  const [refreshToken, account] = await Promise.all([getRefreshToken(), getAccount()]);
  if (!refreshToken || !account || syncing) return false;
  syncing = true;
  try {
    // Most foreground/interval ticks have no work. Avoid a connectivity probe
    // and a queue scan in that common case, including rows still in backoff.
    if ((await countReadyOps()) === 0) {
      emit("idle");
      return true;
    }
    emit("syncing");
    const online = await probeOnline();
    if (!online) {
      emit("offline");
      return false;
    }
    const account = await getAccount();
    const outcome = await flushQueue(async op => {
      if (account !== await getAccount() || !(await getRefreshToken())) throw new Error('Session changed; retry after signing in');
      return defaultExecutor(op);
    });
    emit(outcome.failed || outcome.deferred ? "error" : "idle");
    return !(outcome.failed||outcome.deferred);
  } catch {
    emit("error");
    return false;
  } finally {
    syncing = false;
  }
}

/** Foreground trigger: flush whenever the app becomes active. */
let engineUsers = 0;
let stopSharedEngine: (() => void) | null = null;

export function startEngine(): () => void {
  engineUsers += 1;
  if (!stopSharedEngine) {
    const sub = AppState.addEventListener(
      "change",
      (state: AppStateStatus) => {
        if (state === "active") void syncNow();
      },
    );
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void syncNow();
    }, 15_000);
    stopSharedEngine = () => {
      sub.remove();
      clearInterval(timer);
    };
    void syncNow();
  }

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    engineUsers = Math.max(0, engineUsers - 1);
    if (engineUsers === 0) {
      stopSharedEngine?.();
      stopSharedEngine = null;
    }
  };
}

/** Sync pill state for Home/More screens. */
export function useSyncEngine(): {
  status: EngineStatus;
  pending: number;
  syncNow: () => Promise<void>;
} {
  const [status, setStatus] = useState<EngineStatus>(lastStatus);
  const [pending, setPending] = useState(0);
  useEffect(() => {
    listeners.add(setStatus);
    const stop = startEngine();
    let alive = true;
    const refresh = async () => {
      try {
        const n = await countPendingOps();
        if (alive) setPending(n);
      } catch {
        // DB not ready yet; pill shows 0 until next sync.
      }
    };
    void refresh();
    const id = setInterval(refresh, 5000);
    return () => {
      alive = false;
      listeners.delete(setStatus);
      clearInterval(id);
      stop();
    };
  }, []);
  return {
    status,
    pending,
    syncNow: async () => {
      await syncNow();
      try {
        setPending(await countPendingOps());
      } catch {
        // ignore
      }
    },
  };
}

// Re-exported so task screens can refresh caches after a status advance.
export { getTask, getTaskComments };

/** Persist before the first request. A lost response always retries the same operation. */
export async function submitQueued(args: Parameters<typeof enqueueOp>[0]): Promise<string> {
 const op = await enqueueOp(args);
 await syncNow();
 const saved = await (await getDb()).getFirstAsync<PendingOpRow>('SELECT * FROM pending_ops WHERE client_uuid=?',[op.client_uuid]);
 if (saved?.state === 'FAILED') throw new Error(saved.error ?? 'The server rejected this change. Review it in More → Sync queue.');
 if (saved?.state === 'SUCCEEDED') return saved.decision === 'REVIEW' ? 'Submitted for review.' : 'Saved.';
 return 'Saved on this device. Waiting to sync; keep this account signed in.';
}
