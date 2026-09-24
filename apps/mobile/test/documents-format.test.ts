/// <reference types="node" />
/**
 * documentStateTone (src/documentsFormat.ts) — the badge colour for a
 * register row's derived state.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { documentStateTone, validateDocumentRenew } from "../src/documentsFormat";

describe("documentStateTone", () => {
  it("colours each derived state apps/api's documentState() can produce", () => {
    assert.equal(documentStateTone("VALID"), "success");
    assert.equal(documentStateTone("EXPIRING"), "warning");
    assert.equal(documentStateTone("EXPIRED"), "danger");
    assert.equal(documentStateTone("SUPERSEDED"), "neutral");
  });
});

describe("validateDocumentRenew (B-009)", () => {
  it("accepts a well-formed expiry date with no issued_on", () => {
    assert.equal(validateDocumentRenew({ expires_on: "2027-03-01" }).ok, true);
  });

  it("rejects a blank or malformed expires_on", () => {
    assert.equal(validateDocumentRenew({ expires_on: "" }).ok, false);
    assert.equal(validateDocumentRenew({ expires_on: "01-03-2027" }).ok, false);
    assert.equal(validateDocumentRenew({ expires_on: "2027-13-40" }).ok, false);
  });

  it("rejects a malformed issued_on when one is given", () => {
    const { ok, errors } = validateDocumentRenew({ expires_on: "2027-03-01", issued_on: "not-a-date" });
    assert.equal(ok, false);
    assert.deepEqual(errors, [{ field: "issued_on", message: "Enter the issue date as YYYY-MM-DD" }]);
  });

  it("accepts a well-formed issued_on alongside expires_on", () => {
    assert.equal(
      validateDocumentRenew({ expires_on: "2027-03-01", issued_on: "2026-09-01" }).ok,
      true,
    );
  });
});
