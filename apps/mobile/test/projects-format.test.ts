/// <reference types="node" />
/**
 * Pure display rules behind the Projects screen.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatProjectKind, isTerminalProjectStatus, projectStatusTone } from "../src/projectsFormat";

describe("projectStatusTone", () => {
  it("mirrors the web's projectStatusBadgeTone map", () => {
    assert.equal(projectStatusTone("DRAFT"), "neutral");
    assert.equal(projectStatusTone("ACTIVE"), "info");
    assert.equal(projectStatusTone("ON_HOLD"), "warning");
    assert.equal(projectStatusTone("COMPLETED_PENDING_CLOSE"), "warning");
    assert.equal(projectStatusTone("CLOSED"), "success");
    assert.equal(projectStatusTone("CANCELLED"), "danger");
  });

  it("falls back to neutral for anything unrecognised", () => {
    assert.equal(projectStatusTone("SOMETHING_NEW"), "neutral");
  });
});

describe("isTerminalProjectStatus", () => {
  it("flags closed and cancelled as terminal", () => {
    assert.equal(isTerminalProjectStatus("CLOSED"), true);
    assert.equal(isTerminalProjectStatus("CANCELLED"), true);
    assert.equal(isTerminalProjectStatus("ACTIVE"), false);
  });
});

describe("formatProjectKind", () => {
  it("labels government and private tracks", () => {
    assert.equal(formatProjectKind("GOVERNMENT"), "Government");
    assert.equal(formatProjectKind("PRIVATE"), "Private");
  });

  it("returns null when no kind is set", () => {
    assert.equal(formatProjectKind(null), null);
    assert.equal(formatProjectKind(undefined), null);
  });
});
