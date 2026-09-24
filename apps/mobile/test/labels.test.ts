/// <reference types="node" />
/**
 * MA-010: codeLabel (src/labels.ts), the phone's copy of web's statusLabel()
 * (apps/web/lib/board-visuals.ts), so a status reads the same words on both.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { codeLabel } from "../src/labels";

describe("codeLabel", () => {
  it("matches web statusLabel for the codes these screens show", () => {
    assert.equal(codeLabel("IN_PROGRESS"), "In progress");
    assert.equal(codeLabel("UNDER_EVALUATION"), "Under evaluation");
    assert.equal(codeLabel("PROJECT_MANAGER"), "Project manager");
    assert.equal(codeLabel("APPROVED"), "Approved");
    assert.equal(codeLabel("GOVERNMENT"), "Government");
  });
  it("returns an empty string for nothing", () => {
    assert.equal(codeLabel(""), "");
    assert.equal(codeLabel(null), "");
    assert.equal(codeLabel(undefined), "");
  });
});
