/**
 * D-015: one submission, one Idempotency-Key, however many taps.
 *
 * The client minted a key per call, so a double tap on a write sent two keys
 * and the server did the work twice. A second identical write started while
 * the first is still in flight is the same submission and must reuse its key;
 * once the first settles, the next submission gets a fresh one.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { submissionKey, bodyFingerprint } from "../src/api/submissionKeys";

let n = 0;
const mint = () => `k${++n}`;

describe("submissionKey", () => {
  it("hands an identical write in flight the same key", () => {
    const a = submissionKey("POST /x {\"amount\":600}", mint);
    const b = submissionKey("POST /x {\"amount\":600}", mint);
    assert.equal(b.key, a.key);
    a.done(); b.done();
  });

  it("gives a different write its own key", () => {
    const a = submissionKey("POST /x {\"n\":1}", mint);
    const b = submissionKey("POST /x {\"n\":2}", mint);
    assert.notEqual(b.key, a.key);
    a.done(); b.done();
  });

  it("gives the next submission a new key once the first has settled", () => {
    const a = submissionKey("POST /y {}", mint);
    a.done();
    const b = submissionKey("POST /y {}", mint);
    assert.notEqual(b.key, a.key);
    b.done();
  });

  it("keeps the key while any tap of the submission is still in flight", () => {
    const a = submissionKey("POST /z {}", mint);
    const b = submissionKey("POST /z {}", mint);
    a.done();
    const c = submissionKey("POST /z {}", mint);
    assert.equal(c.key, a.key);
    b.done(); c.done();
    assert.notEqual(submissionKey("POST /z {}", mint).key, a.key);
  });

  it("is what the API client uses to key its writes", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "api", "client.ts"), "utf8");
    assert.match(src, /submissionKey\(/);
  });
});

describe("bodyFingerprint (fix round 2, item 5)", () => {
  it("gives an ordinary body a stable fingerprint", () => {
    assert.equal(bodyFingerprint({ amount: 600, mode: "NEFT" }), bodyFingerprint({ amount: 600, mode: "NEFT" }));
  });

  it("gives different bodies different fingerprints", () => {
    assert.notEqual(bodyFingerprint({ n: 1 }), bodyFingerprint({ n: 2 }));
  });

  it("returns null, skipping dedup, for a body over ~256 KB rather than stringifying it", () => {
    // A 10 MB base64 upload held as {photo: base64string, ...} would
    // otherwise be JSON.stringify'd just to fingerprint it, on top of the
    // original body and the copy the request itself serializes to send --
    // three copies of a multi-MB string alive at once on a phone.
    const huge = { photo: "x".repeat(300 * 1024) };
    assert.equal(bodyFingerprint(huge), null);
  });

  it("still fingerprints a body comfortably under the threshold", () => {
    const small = { note: "x".repeat(1000) };
    assert.notEqual(bodyFingerprint(small), null);
  });
});
