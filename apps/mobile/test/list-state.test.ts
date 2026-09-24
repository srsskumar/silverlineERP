/// <reference types="node" />
/**
 * MA-003: listState (src/listState.ts). A failed load must not read as
 * "nothing here".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { listState } from "../src/listState";

describe("listState", () => {
  it("shows loading first", () => {
    assert.equal(listState({ isLoading: true, isError: false }, 0), "loading");
  });
  it("shows an error, not an empty state, when the load failed with nothing to show", () => {
    assert.equal(listState({ isLoading: false, isError: true }, 0), "error");
  });
  it("keeps showing rows it has (cached) even when a refresh failed", () => {
    assert.equal(listState({ isLoading: false, isError: true }, 3), "rows");
  });
  it("is empty only when the load succeeded with no rows", () => {
    assert.equal(listState({ isLoading: false, isError: false }, 0), "empty");
    assert.equal(listState({ isLoading: false, isError: false }, 2), "rows");
  });
});
