import { describe, expect, it } from 'vitest';
import { bodyFingerprint } from '../lib/submissionKeys';

describe('bodyFingerprint (fix round 2, item 5)', () => {
  it('gives an ordinary body a stable fingerprint', () => {
    expect(bodyFingerprint({ amount: 600, mode: 'NEFT' })).toBe(bodyFingerprint({ amount: 600, mode: 'NEFT' }));
  });

  it('gives different bodies different fingerprints', () => {
    expect(bodyFingerprint({ n: 1 })).not.toBe(bodyFingerprint({ n: 2 }));
  });

  it('returns null, skipping dedup, for a body over ~256 KB rather than stringifying it', () => {
    // A 10 MB base64 upload held as {file: base64string, ...} would otherwise
    // be JSON.stringify'd just to fingerprint it, on top of the original body
    // and the copy the request itself serializes to send -- three copies of
    // a multi-MB string alive in memory at once.
    const huge = { file: 'x'.repeat(300 * 1024) };
    expect(bodyFingerprint(huge)).toBeNull();
  });

  it('still fingerprints a body comfortably under the threshold', () => {
    const small = { note: 'x'.repeat(1000) };
    expect(bodyFingerprint(small)).not.toBeNull();
  });
});
