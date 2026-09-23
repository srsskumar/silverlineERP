/// <reference types="node" />
/**
 * documentStateTone (src/documentsFormat.ts) — the badge colour for a
 * register row's derived state.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { documentStateTone } from "../src/documentsFormat";

describe("documentStateTone", () => {
  it("colours each derived state apps/api's documentState() can produce", () => {
    assert.equal(documentStateTone("VALID"), "success");
    assert.equal(documentStateTone("EXPIRING"), "warning");
    assert.equal(documentStateTone("EXPIRED"), "danger");
    assert.equal(documentStateTone("SUPERSEDED"), "neutral");
  });
});
