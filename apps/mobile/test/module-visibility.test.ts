/// <reference types="node" />
/**
 * canSeeModule (rbac.ts): the mobile side of GET /auth/me's `modules` map.
 *
 * Absence — of the whole map, or of one code in it — must default to
 * visible, so a cold app or a device that has not seen a newly-added catalog
 * code never narrows a screen the permission checks already allowed. Only an
 * explicit `false` hides anything.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canSeeModule, TAB_MODULE_CODES } from "../src/rbac";

describe("canSeeModule", () => {
  it("shows everything when the map has not loaded yet", () => {
    assert.equal(canSeeModule(undefined, "documents"), true);
    assert.equal(canSeeModule(null, "documents"), true);
  });

  it("shows a code the map is silent about", () => {
    assert.equal(canSeeModule({}, "documents"), true);
    assert.equal(canSeeModule({ attendance: false }, "documents"), true);
  });

  it("hides only an explicit false", () => {
    assert.equal(canSeeModule({ documents: false }, "documents"), false);
  });

  it("shows an explicit true same as absence", () => {
    assert.equal(canSeeModule({ documents: true }, "documents"), true);
  });
});

describe("TAB_MODULE_CODES", () => {
  it("names a catalog code for every tab that has a one-to-one module", () => {
    assert.equal(TAB_MODULE_CODES.attendance, "attendance");
    assert.equal(TAB_MODULE_CODES.tasks, "my-work");
    assert.equal(TAB_MODULE_CODES.leave, "leave");
    assert.equal(TAB_MODULE_CODES.assets, "assets");
    assert.equal(TAB_MODULE_CODES.survey, "survey");
  });

  it("names none for Home or More — neither maps one-to-one to a catalog code", () => {
    assert.equal(TAB_MODULE_CODES.home, undefined);
    assert.equal(TAB_MODULE_CODES.more, undefined);
  });
});
