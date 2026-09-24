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
import { submissionKey } from "../src/api/submissionKeys";

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
