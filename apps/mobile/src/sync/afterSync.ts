/**
 * The query keys a screen must re-read once queued work has synced (final
 * review, item 3).
 *
 * A stage completed offline synced later, and the survey tab kept showing
 * "Finish your stage" from its cached village list; a return synced later
 * left the list saying "due". Invalidated by prefix, so ["survey", "filed"]
 * covers every village-day.
 */
const STALE: Record<string, string[][]> = {
  survey_stage: [["survey", "my-villages"]],
  survey_entry: [["survey", "my-villages"], ["survey", "filed"]],
};

export function staleQueriesAfter(entities: string[]): string[][] {
  const out: string[][] = [];
  for (const e of entities) {
    for (const key of STALE[e] ?? []) {
      if (!out.some(k => k.join("\u0000") === key.join("\u0000"))) out.push(key);
    }
  }
  return out;
}

type Listener = (keys: string[][]) => void;
const listeners = new Set<Listener>();

/** Called by the root layout with its QueryClient's invalidate. */
export function onStaleQueries(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Called by the sync engine with the entities it just sent. */
export function notifySynced(entities: string[]): void {
  const keys = staleQueriesAfter(entities);
  if (keys.length) for (const l of listeners) l(keys);
}
