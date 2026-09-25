/**
 * A second "Review" tap on the same queued op reopens it (final review,
 * item 4). The survey tab keyed its effect on the op id alone, so tapping
 * Review again for the same op changed nothing and the sheet stayed shut.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reviewLink, reviewRequest } from "../src/survey/reviewLink.js";

describe("the review deep link", () => {
  it("gives each tap its own request, even for the same op", () => {
    const a = reviewRequest(reviewLink("op-1", 1000).params);
    const b = reviewRequest(reviewLink("op-1", 2000).params);
    assert.ok(a && b);
    assert.equal(a!.clientUuid, "op-1");
    assert.notEqual(a!.key, b!.key);
  });

  it("opens the survey tab", () => {
    assert.equal(reviewLink("op-1", 1).pathname, "/(tabs)/survey");
  });

  it("is nothing without an op id", () => {
    assert.equal(reviewRequest({}), null);
    assert.equal(reviewRequest({ review: "" }), null);
  });
});
