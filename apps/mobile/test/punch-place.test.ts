/// <reference types="node" />
/**
 * Where the day's punches were made, on the attendance screen's history.
 *
 * The server names the place after the punch from its coordinates; the row
 * says the name once it has one, that it is being found while it has not,
 * and nothing about a place for a punch that carried no position.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { placeLabel, punchPlaceLine } from "../src/attendance/place";

const clock = (iso: string) => iso.slice(11, 16);

describe("placeLabel", () => {
  it("says the name, or that it is coming, or that none was found", () => {
    assert.equal(placeLabel("Kondapur, Hyderabad, Telangana", "named"), "Kondapur, Hyderabad, Telangana");
    assert.equal(placeLabel(null, "resolving"), "finding the place…");
    assert.equal(placeLabel(null, "unnamed"), "place not found");
    assert.equal(placeLabel(null, "none"), null);
    assert.equal(placeLabel(undefined, undefined), null);
  });
});

describe("punchPlaceLine", () => {
  it("names the place the day was started from", () => {
    assert.equal(
      punchPlaceLine({
        check_in_at: "2026-09-23T03:44:00.000Z", check_in_place_name: "Kondapur, Hyderabad, Telangana", check_in_place_status: "named",
      }, clock),
      "In 03:44 from Kondapur, Hyderabad, Telangana",
    );
  });

  it("says the place once when both punches were made from it, and both when they differ", () => {
    const same = punchPlaceLine({
      check_in_at: "2026-09-23T03:44:00.000Z", check_in_place_name: "Kolluru, Nellore, Andhra Pradesh", check_in_place_status: "named",
      check_out_at: "2026-09-23T12:32:00.000Z", check_out_place_name: "Kolluru, Nellore, Andhra Pradesh", check_out_place_status: "named",
    }, clock);
    assert.equal(same, "In 03:44 from Kolluru, Nellore, Andhra Pradesh · Out 12:32");
    const moved = punchPlaceLine({
      check_in_at: "2026-09-23T03:44:00.000Z", check_in_place_name: "Kolluru, Nellore, Andhra Pradesh", check_in_place_status: "named",
      check_out_at: "2026-09-23T12:32:00.000Z", check_out_place_name: "Nellore, Andhra Pradesh", check_out_place_status: "named",
    }, clock);
    assert.equal(moved, "In 03:44 from Kolluru, Nellore, Andhra Pradesh · Out 12:32 from Nellore, Andhra Pradesh");
  });

  it("says the name is still being found rather than leaving a gap", () => {
    assert.equal(
      punchPlaceLine({ check_in_at: "2026-09-23T03:44:00.000Z", check_in_place_status: "resolving" }, clock),
      "In 03:44 from finding the place…",
    );
  });

  it("says nothing about a place for a punch without a position, and nothing at all for an empty day", () => {
    assert.equal(
      punchPlaceLine({ check_in_at: "2026-09-23T03:44:00.000Z", check_in_place_status: "none" }, clock),
      "In 03:44",
    );
    // A record from an older API, with no place fields at all, reads as it always did.
    assert.equal(punchPlaceLine({ check_in_at: "2026-09-23T03:44:00.000Z" }, clock), "In 03:44");
    assert.equal(punchPlaceLine({}, clock), undefined);
  });
});
