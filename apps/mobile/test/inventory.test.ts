/// <reference types="node" />
/**
 * Pure logic behind the Inventory screen: the low-stock badge and the
 * client-side pre-check for posting a stock movement.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isLowStock, stockTone } from "../src/inventoryFormat";
import { validateStockTransaction } from "../src/validators";

describe("isLowStock", () => {
  it("flags on-hand at or below the threshold", () => {
    assert.equal(isLowStock(5, 10), true);
    assert.equal(isLowStock(10, 10), true);
    assert.equal(isLowStock(11, 10), false);
  });

  it("never flags a threshold of zero — nothing to compare against", () => {
    assert.equal(isLowStock(0, 0), false);
  });

  it("coerces numeric strings the way the API sends decimals", () => {
    assert.equal(isLowStock("4.0000", "10.0000"), true);
  });
});

describe("stockTone", () => {
  it("reads danger at zero or negative, warning when low, success otherwise", () => {
    assert.equal(stockTone(0, 10), "danger");
    assert.equal(stockTone(-1, 10), "danger");
    assert.equal(stockTone(5, 10), "warning");
    assert.equal(stockTone(50, 10), "success");
  });
});

describe("validateStockTransaction", () => {
  const base = {
    item_id: "11111111-1111-1111-1111-111111111111",
    direction: "OUT" as const,
    quantity: 5,
    reference: "WO-42",
  };

  it("accepts a well-formed posting", () => {
    assert.equal(validateStockTransaction(base).ok, true);
  });

  it("rejects a non-UUID item", () => {
    assert.equal(validateStockTransaction({ ...base, item_id: "nope" }).ok, false);
  });

  it("rejects a zero or negative quantity", () => {
    assert.equal(validateStockTransaction({ ...base, quantity: 0 }).ok, false);
    assert.equal(validateStockTransaction({ ...base, quantity: -3 }).ok, false);
  });

  it("requires a reference", () => {
    assert.equal(validateStockTransaction({ ...base, reference: "" }).ok, false);
  });
});
