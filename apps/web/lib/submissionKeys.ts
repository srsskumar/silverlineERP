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

/** Past this, a body is not fingerprinted at all (fix round 2, item 5). */
const MAX_FINGERPRINT_BYTES = 256 * 1024;

/**
 * The size JSON.stringify(value) would produce, without paying to actually
 * produce it -- so a huge body can be sized without allocating a full
 * serialized copy of it just to find out it is huge.
 */
function roughSize(value: unknown, depth = 0): number {
  if (value == null || depth > 8) return 0;
  if (typeof value === 'string') return value.length;
  if (typeof value === 'number' || typeof value === 'boolean') return 8;
  if (Array.isArray(value)) return value.reduce<number>((t, v) => t + roughSize(v, depth + 1), 0);
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .reduce<number>((t, v) => t + roughSize(v, depth + 1), 0);
  }
  return 0;
}

/** A 32-bit FNV-1a hash. Good enough to tell two submissions apart, not to be collision-proof. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * A cheap fingerprint for a submission's body, or null when the body is too
 * large to fingerprint cheaply.
 *
 * JSON.stringify(body), held as-is for the dedup map's key, is fine for an
 * ordinary form post. A 10 MB base64 file upload is a different matter: the
 * original body, the stringified copy made just to fingerprint it, and (once
 * the request itself serializes the body again to send) a third copy would
 * all be alive in memory at once. roughSize walks the body without
 * allocating a serialized copy, so a body past the threshold can be
 * recognised as too large without ever being stringified; dedup is then
 * skipped for it entirely, so a double-tap on a huge upload costs an extra
 * upload rather than every upload paying to avoid one. A body under the
 * threshold is still stringified once, but only a short hash of that string
 * is kept, not the string itself.
 */
export function bodyFingerprint(body: unknown): string | null {
  if (roughSize(body) > MAX_FINGERPRINT_BYTES) return null;
  return hash(JSON.stringify(body ?? null));
}

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
