import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parsePatch } from "../src/common/domain.js";

/*
 * zod 4's `.partial()` fills `.default()` values for keys the caller left out
 * (zod 3 left them absent). A PATCH that writes every parsed key would then
 * reset stored flags on every edit; the review of the zod 4 upgrade found
 * seven routes doing exactly that. parsePatch keeps only the keys sent.
 */
const schema = z.object({
  name: z.string().min(1),
  active: z.boolean().default(true),
  tags: z.array(z.string()).default([]),
}).partial();

describe("parsePatch", () => {
  it("keeps only the keys the caller sent, never a schema default", () => {
    expect(parsePatch(schema, { name: "x" })).toEqual({ name: "x" });
  });

  it("still validates and coerces the keys that were sent", () => {
    expect(parsePatch(schema, { active: false })).toEqual({ active: false });
    expect(() => parsePatch(schema, { name: "" })).toThrow();
  });

  it("returns an empty object for an empty body, so 'nothing to change' guards still fire", () => {
    expect(parsePatch(schema, {})).toEqual({});
  });

  it("ignores inherited keys on the body", () => {
    const body = Object.create({ active: false }) as Record<string, unknown>;
    body.name = "y";
    expect(parsePatch(schema, body)).toEqual({ name: "y" });
  });
});
