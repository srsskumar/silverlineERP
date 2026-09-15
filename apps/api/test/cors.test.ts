import { describe, expect, it } from "vitest";
import { originAllowed } from "../src/config.js";

/**
 * Which browser origins may call this API.
 *
 * The bug behind these tests: the deployed allow-list held one exact origin,
 * so every `vercel deploy` — which publishes the app on a fresh preview host —
 * left the running app unable to reach its own API. The browser reports only
 * "Failed to fetch", which reads as the server being down rather than as a
 * configuration problem, and the user sees it on every mutation.
 */
describe("originAllowed", () => {
  it("accepts an exact origin", () => {
    expect(originAllowed("https://app.example.com", ["https://app.example.com"])).toBe(true);
  });

  it("refuses an origin that is not listed", () => {
    expect(originAllowed("https://evil.example.com", ["https://app.example.com"])).toBe(false);
  });

  it("accepts a preview host through a project-scoped wildcard", () => {
    const patterns = ["https://silverline-*-silverline4.vercel.app"];
    expect(originAllowed("https://silverline-38nzd8qu8-silverline4.vercel.app", patterns)).toBe(true);
    expect(originAllowed("https://silverline-h81bqys9j-silverline4.vercel.app", patterns)).toBe(true);
  });

  it("does not let a wildcard cross a dot into another host", () => {
    // This API is called with credentials, so a pattern that widened to a
    // subdomain somebody else controls would hand them authenticated access.
    expect(originAllowed("https://a-x.evil.example.com", ["https://a-*.example.com"])).toBe(false);
  });

  it("refuses another team's app on the same shared domain", () => {
    expect(
      originAllowed("https://malicious-abc-otherteam.vercel.app", [
        "https://silverline-*-silverline4.vercel.app",
      ]),
    ).toBe(false);
  });

  it("refuses a bare wildcard from matching a different scheme", () => {
    expect(
      originAllowed("http://silverline-x-silverline4.vercel.app", [
        "https://silverline-*-silverline4.vercel.app",
      ]),
    ).toBe(false);
  });

  it("refuses everything when nothing is configured", () => {
    expect(originAllowed("https://app.example.com", [])).toBe(false);
  });

  it("treats regex characters in a pattern as literals", () => {
    // A dot in a hostname is a dot, not "any character".
    expect(originAllowed("https://appXexample.com", ["https://app.example.com"])).toBe(false);
  });
});
