/**
 * What the screens must re-read once queued work has synced (final review,
 * item 3). A stage completed offline synced later, and the survey tab kept
 * showing "Finish your stage" from its cached village list.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { staleQueriesAfter } from "../src/sync/afterSync.js";

describe("staleQueriesAfter", () => {
  it("marks the village list stale once a stage completion has synced", () => {
    assert.deepEqual(staleQueriesAfter(["survey_stage"]), [["survey", "my-villages"]]);
  });

  it("marks the village list and the filed day stale after a return", () => {
    assert.deepEqual(staleQueriesAfter(["survey_entry"]),
      [["survey", "my-villages"], ["survey", "filed"]]);
  });

  it("lists each key once, and nothing for unrelated work", () => {
    assert.deepEqual(staleQueriesAfter(["survey_stage", "survey_stage", "survey_entry"]),
      [["survey", "my-villages"], ["survey", "filed"]]);
    assert.deepEqual(staleQueriesAfter(["task_comment"]), []);
  });
});
