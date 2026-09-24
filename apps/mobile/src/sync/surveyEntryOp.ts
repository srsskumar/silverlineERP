/**
 * The outbox executor for a queued survey return (survey_entry), and the
 * rules for chaining several filings of one village-day.
 *
 * Kept apart from engine.ts, which pulls in React Native, so the queue tests
 * can drive it through the real createQueue/flushQueue with a fake server.
 */
import {
  amendmentFor,
  isEmptyAmendment,
  isSecondFiling,
  type EntryAmendment,
  type FiledEntry,
} from "../survey/fieldCrew";

export const DAY_CHANGED = "This day was changed by someone else. Review and re-submit.";

export interface SurveyEntryDeps {
  post(entry: any, idempotencyKey: string): Promise<unknown>;
  getFiled(villageId: string, date: string): Promise<FiledEntry | null>;
  patch(id: string, version: number, body: EntryAmendment, idempotencyKey: string): Promise<unknown>;
  /** A non-retryable 409 the queue records as CONFLICT, carrying `message`. */
  conflict(message: string): Error;
  /**
   * Write the op's payload back before each request goes (rounds 3 and 4),
   * so what was actually sent under which key is on the row if the reply is
   * lost. The outbox's rewriteOp.
   */
  remember?(clientUuid: string, payload: string): Promise<void>;
}

/*
 * What this device may already have delivered for the village-day (round 4).
 *
 * Every request that went, or may have gone, under a key: the op's own POSTs
 * and PATCHes, recorded as they are sent, and those of any op it was chained
 * onto. Carried in the payload as `_prior` and stripped before sending.
 *
 * It replaces round 2/3's single `_sent`/`_sentKey`/`_amend`, which recorded
 * only one body per chain. In a chain (A rewritten, then sent; a behind-op
 * queued; a re-file folded in) that body was often not the one actually sent
 * under the key, and the replay came back IDEMPOTENCY_CONFLICT.
 */
const PRIOR = "_prior";

/**
 * `landed` is the version a request's reply gave, once one came back (the
 * server stores a key only with a request that succeeded). Without it, the
 * request may or may not have landed.
 */
export type PriorRequest =
  | { kind: "post"; key: string; body: Record<string, unknown>; landed?: number }
  | { kind: "patch"; key: string; id: string; base: number; body: EntryAmendment; landed?: number };

const sameRequest = (a: PriorRequest, b: PriorRequest) =>
  a.kind === b.kind && a.key === b.key && JSON.stringify(a.body) === JSON.stringify(b.body);

/*
 * The list is kept to what a replay needs (round 5). It used to gain a full
 * body at every re-file, sent or not, and every retry replayed them all.
 *
 * - Only requests that went, or may have gone, are recorded (see ctx.sent).
 * - A request the server refused (a 409: its key holds another body, or it
 *   was not applied) never landed, and is dropped.
 * - Replay only has to reach the latest version this device made, so of the
 *   requests known to have landed only the one with the highest version is
 *   kept; and a key that has a landed body holds no other.
 * - Past PRIOR_MAX, the oldest may-have-landed entries go, except the first
 *   body sent under each key (the likeliest to be the one the server kept).
 *   Dropping one can only turn a correction into a review, never lose data.
 */
export const PRIOR_MAX = 8;

function trim(list: PriorRequest[]): PriorRequest[] {
  let out: PriorRequest[] = [];
  for (const p of list) {
    const i = out.findIndex(q => sameRequest(q, p));
    if (i < 0) out.push(p);
    else if (p.landed !== undefined) out[i] = p;
  }
  const best = out.reduce<PriorRequest | null>((b, p) =>
    p.landed !== undefined && (b === null || p.landed > (b.landed as number)) ? p : b, null);
  if (best) out = out.filter(p => p === best || (p.landed === undefined && p.key !== best.key));
  while (out.length > PRIOR_MAX) {
    const i = out.findIndex((p, n) => p !== best && out.findIndex(q => q.key === p.key) !== n);
    out.splice(i >= 0 ? i : out.findIndex(p => p !== best), 1);
  }
  return out;
}

function withPrior(list: PriorRequest[], ...more: PriorRequest[]): PriorRequest[] {
  return trim([...list, ...more]);
}

const versionOf = (reply: unknown): number | undefined => {
  const v = (reply as { version?: unknown } | null)?.version;
  return typeof v === "number" ? v : undefined;
};
/** Refused outright: this body never landed under this key. */
const refused = (err: unknown) => (err as { status?: number } | null)?.status === 409;

function split(payload: Record<string, unknown>): { entry: Record<string, unknown>; prior: PriorRequest[] } {
  const { [PRIOR]: prior, ...entry } = payload;
  return { entry, prior: Array.isArray(prior) ? (prior as PriorRequest[]) : [] };
}

/**
 * Fold a new filing into an op already in the chain.
 *
 * The result carries the new figures and everything the older op may have
 * delivered: its recorded requests, plus its current body under its key (it
 * may have gone, or be on the wire now). Used both to rewrite the waiting op
 * in place and to start an op queued behind one that is SENDING.
 */
export function supersedeSurveyEntry(
  pending: Record<string, unknown>,
  next: Record<string, unknown>,
  ctx?: { idempotencyKey: string; sent?: boolean; sending?: boolean },
): Record<string, unknown> {
  const older = split(pending);
  const newer = split(next);
  /*
   * The older op's own body counts only if it may have gone (round 5). An op
   * on the wire is sending exactly its body. One that was tried and is
   * waiting again may hold a re-file that never went; the executor records
   * each request before it goes, so if its key has a record, that says what
   * was sent, and the body is added only when there is none.
   */
  const own = ctx && ctx.sent !== false &&
    (ctx.sending || !older.prior.some(p => p.key === ctx.idempotencyKey))
    ? [{ kind: "post" as const, key: ctx.idempotencyKey, body: older.entry }] : [];
  const prior = withPrior(newer.prior, ...older.prior, ...own);
  return { ...newer.entry, [PRIOR]: prior };
}

/**
 * The chain rules the outbox applies to survey_entry (round 4): how to fold
 * a new filing in, and how an op settling hands what it sent to the op
 * behind it (the same fold, keeping the newer figures).
 */
export const surveyEntryChain = {
  supersede: supersedeSurveyEntry,
  handOver: (older: Record<string, unknown>, newer: Record<string, unknown>, ctx: { idempotencyKey: string; sent?: boolean; sending?: boolean }) =>
    supersedeSurveyEntry(older, newer, ctx),
};

/** A short, stable fingerprint, so a changed correction gets a key of its own. */
function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function isKeyReused(err: unknown): boolean {
  const e = err as { status?: number; code?: string } | null;
  return Boolean(e && e.status === 409 && e.code === "IDEMPOTENCY_CONFLICT");
}

export async function runSurveyEntryOp(
  op: { client_uuid?: string; payload: string; idempotency_key: string; base_version: number | null },
  deps: SurveyEntryDeps,
): Promise<{ status: number; body: unknown }> {
  const { entry, prior: carried } = split(JSON.parse(op.payload) as Record<string, unknown>);
  let prior = trim(carried);
  const save = async () => {
    if (deps.remember && op.client_uuid) {
      await deps.remember(op.client_uuid, JSON.stringify({ ...entry, [PRIOR]: prior }));
    }
  };
  const record = async (p: PriorRequest) => {
    prior = withPrior(prior, p);
    await save();
  };
  /** What came of a request: landed (with its version), refused, or unknown. */
  const learn = (p: PriorRequest, outcome: { reply: unknown } | { err: unknown }) => {
    const i = prior.findIndex(q => sameRequest(q, p));
    if (i < 0) return;
    if ("reply" in outcome) {
      const landed = versionOf(outcome.reply);
      if (landed !== undefined) prior = trim(prior.map((q, n) => (n === i ? { ...q, landed } : q)));
    } else if (refused(outcome.err)) {
      prior = prior.filter((_, n) => n !== i);
    }
  };

  const post: PriorRequest = { kind: "post", key: op.idempotency_key, body: entry };
  await record(post);
  try {
    const reply = await deps.post(entry, op.idempotency_key);
    // Handed to an op queued behind this one, so it knows the version made.
    learn(post, { reply });
    await save().catch(() => undefined);
    return { status: 201, body: reply };
  } catch (err) {
    learn(post, { err });
    if (!isSecondFiling(err) && !isKeyReused(err)) throw err;
    try {
      return await amend(err);
    } finally {
      await save().catch(() => undefined);
    }
  }

  async function amend(err: unknown): Promise<{ status: number; body: unknown }> {
    const villageId = String(entry.survey_village_id), date = String(entry.entry_date);
    let filed = await deps.getFiled(villageId, date);
    if (!filed) throw err;
    let amendment = amendmentFor(filed, entry as never);
    // Already reads as the form does: a retry after a lost response.
    if (isEmptyAmendment(amendment)) return { status: 200, body: filed };

    /*
     * Amend only a day whose latest change is one the crew made (rounds 1-4).
     *
     * Either the version the form was opened from, or one of this device's
     * own earlier requests for the day. Those are replayed under their keys:
     * a request that landed hands back its stored reply and the version it
     * made; one that never landed is refused and ignored. If the day's
     * version is ours after that, the day is corrected; otherwise somebody
     * else changed it and the crew reviews it.
     */
    let base = op.base_version;
    if (base !== filed.version) {
      let ours: number | null = null;
      for (const p of [...prior]) {
        if (sameRequest(p, post)) continue;
        try {
          const reply = p.kind === "post"
            ? await deps.post(p.body, p.key)
            : await deps.patch(p.id, p.base, p.body, p.key);
          const v = versionOf(reply);
          if (v !== undefined) ours = Math.max(ours ?? 0, v);
          learn(p, { reply });
        } catch (e) { learn(p, { err: e }); /* never landed, or not ours */ }
      }
      filed = (await deps.getFiled(villageId, date)) ?? filed;
      if (ours !== null && ours === filed.version) base = filed.version;
      amendment = amendmentFor(filed, entry as never);
      if (isEmptyAmendment(amendment)) return { status: 200, body: filed };
    }
    if (base === null || base === undefined || base !== filed.version) {
      throw deps.conflict(DAY_CHANGED);
    }
    // Each distinct correction gets a key of its own, so a superseded one is
    // never sent under a key that already carried a different body.
    const key = `${op.idempotency_key}:amend:${fingerprint([base, amendment])}`;
    const patch: PriorRequest = { kind: "patch", key, id: filed.id, base, body: amendment };
    await record(patch);
    try {
      const reply = await deps.patch(filed.id, base, amendment, key);
      learn(patch, { reply });
      return { status: 200, body: reply };
    } catch (e) {
      learn(patch, { err: e });
      throw e;
    }
  }
}
