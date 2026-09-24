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
  postSurveyEntry,
  postVillageGcp,
  postVillageStage,
  getFiledEntry,
  patchSurveyEntry,
  postTask as apiPostTask,
} from "../api/endpoints";
import { enqueueOp, flushQueue, rewriteOp, type OpExecutor } from "./queue";
import { reviewMessage } from "./queueCore";
import { punchBody } from "./replay";
import { runSurveyEntryOp } from "./surveyEntryOp";
import { ApiError } from "../api/client";
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
      /*
       * Tell the server when this punch is a replay rather than a live one
       * (§59, phase 2).
       *
       * A field punch-out with no progress return filed is refused, so the
       * person is prompted to file it. That prompt only makes sense while
       * they are standing there with the app open. Once the op has waited in
       * the queue -- no signal -- the punch has already happened, and a
       * refusal here would mark the op FAILED and delete a punch that
       * physically occurred. The server accepts a replay and records the
       * unfiled return instead.
       *
       * Decided on the first attempt and written back to the row before the
       * request goes, so a retry sends the same bytes: the server hashes the
       * body under the idempotency key, and a retry with one field more was
       * refused as a different request (see sync/replay.ts).
       */
      const { body, frozen } = punchBody(payload, op);
      if (frozen) await rewriteOp(op.client_uuid, JSON.stringify(body));
      const { result, status } = await postAttendanceEvent(
        body as unknown as Parameters<typeof postAttendanceEvent>[0],
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
    case "survey_entry": {
      /*
       * The day's return, filed from the village.
       *
       * Queued rather than sent directly because the villages this runs in
       * have no signal to speak of, and a return that can only be filed
       * where there are bars is a return that gets written on paper and
       * typed at a desk a week later. The server refuses a second entry for
       * the same village-day outright, so a replay of an op that actually
       * landed is rejected as ALREADY_ENTERED rather than doubling the day.
       *
       * That refusal is not the end of it (SG-003). A second filing for the
       * same day is a correction -- a typo fixed, or a second go queued while
       * the first was still waiting for signal -- and it was being dropped.
       * It becomes an amendment of the day already in, keyed off this op so
       * a retry sends the same request.
       */
      // Only amended when the server still holds the version the crew
      // corrected; otherwise a CONFLICT they review (fix round 1).
      return runSurveyEntryOp(op, {
        post: postSurveyEntry,
        getFiled: getFiledEntry,
        patch: patchSurveyEntry,
        conflict: (message) => new ApiError({
          status: 409, code: "SURVEY_DAY_CHANGED", message, retryable: false,
        }),
      });
    }
    case "survey_stage": {
      // The crew member's own stage, completed from the village (SG-013).
      const { survey_village_id, ...body } = payload;
      return {
        status: 200,
        body: await postVillageStage(String(survey_village_id), body, op.idempotency_key),
      };
    }
    case "survey_gcp": {
      // Established once per village, standing on the point. The village id
      // is in the path rather than the body, so it is peeled off here.
      const { survey_village_id, ...body } = payload;
      return {
        status: 201,
        body: await postVillageGcp(
          String(survey_village_id),
          body as unknown as Parameters<typeof postVillageGcp>[1], op.idempotency_key,
        ),
      };
    }
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
 if (saved?.state === 'SUCCEEDED') return saved.decision === 'REVIEW' ? reviewMessage(saved.error) : 'Saved.';
 return 'Saved on this device. Waiting to sync; keep this account signed in.';
}
