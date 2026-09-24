import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGE_SIZE, canGoNewer, canGoOlder, newerOffset, olderOffset } from "../src/paging";

test("olderOffset steps forward by one page", () => {
  assert.equal(olderOffset(0), PAGE_SIZE);
  assert.equal(olderOffset(50), 100);
  assert.equal(olderOffset(0, 20), 20);
});

test("newerOffset steps back by one page, clamped at zero", () => {
  assert.equal(newerOffset(100), 50);
  assert.equal(newerOffset(50), 0);
  assert.equal(newerOffset(0), 0);
  assert.equal(newerOffset(10, 20), 0);
});

test("canGoNewer is false only at the first page", () => {
  assert.equal(canGoNewer(0), false);
  assert.equal(canGoNewer(50), true);
});

test("canGoOlder mirrors the server's has_more exactly", () => {
  assert.equal(canGoOlder(true), true);
  assert.equal(canGoOlder(false), false);
  assert.equal(canGoOlder(undefined), false);
});
