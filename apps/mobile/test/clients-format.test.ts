import { test } from "node:test";
import assert from "node:assert/strict";
import { validateClientCreate } from "../src/clientsFormat";

test("validateClientCreate accepts a name and a valid client_type", () => {
  assert.equal(validateClientCreate({ name: "Acme Infra", client_type: "PRIVATE" }).ok, true);
  assert.equal(validateClientCreate({ name: "State PWD", client_type: "GOVERNMENT" }).ok, true);
});

test("validateClientCreate rejects a blank name", () => {
  const { ok, errors } = validateClientCreate({ name: "  ", client_type: "PRIVATE" });
  assert.equal(ok, false);
  assert.deepEqual(errors, [{ field: "name", message: "A name is required" }]);
});

test("validateClientCreate rejects a client_type outside GOVERNMENT/PRIVATE", () => {
  assert.equal(validateClientCreate({ name: "Acme", client_type: "NGO" }).ok, false);
});

test("validateClientCreate reports both fields when both are missing", () => {
  assert.equal(validateClientCreate({ name: "", client_type: "" }).errors.length, 2);
});
