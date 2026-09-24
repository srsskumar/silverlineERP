/// <reference types="node" />
/**
 * Fix round 1: whether a failed load is worth retrying (src/listState.ts
 * canRetryLoad/retryAction). A network drop or a 5xx may succeed next time;
 * a 403/404 will not, so no Retry is offered for those.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canRetryLoad, retryAction } from "../src/listState";

const api = (status: number) => ({ status, message: "x" });

describe("canRetryLoad", () => {
  it("offers a retry for a network failure (status 0) or a non-API error", () => {
    assert.equal(canRetryLoad(api(0)), true);
    assert.equal(canRetryLoad(new TypeError("Network request failed")), true);
    assert.equal(canRetryLoad(undefined), true);
  });
  it("offers a retry for 5xx, 408 and 429", () => {
    assert.equal(canRetryLoad(api(500)), true);
    assert.equal(canRetryLoad(api(503)), true);
    assert.equal(canRetryLoad(api(408)), true);
    assert.equal(canRetryLoad(api(429)), true);
  });
  it("offers no retry for 401, 403, 404 or 422", () => {
    assert.equal(canRetryLoad(api(401)), false);
    assert.equal(canRetryLoad(api(403)), false);
    assert.equal(canRetryLoad(api(404)), false);
    assert.equal(canRetryLoad(api(422)), false);
  });
});

describe("retryAction", () => {
  it("hands back a function that calls refetch when a retry can help", () => {
    let calls = 0;
    const fn = retryAction({ error: api(503), refetch: () => { calls += 1; } });
    assert.equal(typeof fn, "function");
    fn!();
    assert.equal(calls, 1);
  });
  it("hands back nothing on a 403", () => {
    assert.equal(retryAction({ error: api(403), refetch: () => undefined }), undefined);
  });
});
