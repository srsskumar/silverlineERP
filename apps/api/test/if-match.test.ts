import { describe, expect, it } from "vitest";
import { parseIfMatch } from "../src/common/ifMatch.js";

/**
 * The version carried in If-Match.
 *
 * An entity-tag is a quoted string (RFC 7232 §2.3). Sending a bare number is
 * not merely untidy: an edge proxy that implements conditional requests reads
 * it as a malformed precondition and answers 412 itself, so the request never
 * reaches the API. Every write in the deployed app failed that way while every
 * local test passed, because tests inject into the framework and never cross
 * the proxy.
 */
describe("parseIfMatch", () => {
  const req = (value?: string) => ({ headers: value === undefined ? {} : { "if-match": value } });

  it("accepts the quoted entity-tag clients now send", () => {
    expect(parseIfMatch(req('"3"'))).toBe(3);
  });

  it("still accepts a bare number from an older client or a script", () => {
    expect(parseIfMatch(req("3"))).toBe(3);
  });

  it("accepts a weak validator, which names the same version", () => {
    expect(parseIfMatch(req('W/"7"'))).toBe(7);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseIfMatch(req('  "12" '))).toBe(12);
  });

  it("refuses a missing header", () => {
    expect(() => parseIfMatch(req())).toThrow();
  });

  it("refuses an empty or non-numeric tag", () => {
    expect(() => parseIfMatch(req(""))).toThrow();
    expect(() => parseIfMatch(req('""'))).toThrow();
    expect(() => parseIfMatch(req('"abc"'))).toThrow();
  });

  it("refuses a version below one, which no record can have", () => {
    expect(() => parseIfMatch(req('"0"'))).toThrow();
    expect(() => parseIfMatch(req('"-2"'))).toThrow();
  });

  it("refuses a fractional version", () => {
    expect(() => parseIfMatch(req('"1.5"'))).toThrow();
  });

  it("refuses the wildcard, which would mean 'any version' and defeat the check", () => {
    // `If-Match: *` is legal HTTP and means "if the resource exists at all".
    // Honouring it here would silently turn optimistic concurrency off.
    expect(() => parseIfMatch(req("*"))).toThrow();
  });
});
