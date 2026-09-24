/**
 * One Idempotency-Key per submission, not per tap (D-015).
 *
 * A double tap on a write is two calls. With a key minted per call they
 * reach the server as two submissions and both take effect. An identical
 * write (same method, path and body) started while an earlier one is still
 * in flight is the same submission: it gets the same key, so the server
 * serialises it and replays the first answer. When every tap of it has
 * settled the entry is dropped, and the next submission gets a fresh key.
 */
const inFlight = new Map<string, { key: string; count: number }>();

export function submissionKey(fingerprint: string, mint: () => string): { key: string; done: () => void } {
  let entry = inFlight.get(fingerprint);
  if (!entry) {
    entry = { key: mint(), count: 0 };
    inFlight.set(fingerprint, entry);
  }
  entry.count += 1;
  const held = entry;
  let released = false;
  return {
    key: held.key,
    done: () => {
      if (released) return;
      released = true;
      held.count -= 1;
      if (held.count <= 0 && inFlight.get(fingerprint) === held) inFlight.delete(fingerprint);
    },
  };
}
