/// <reference types="node" />
/**
 * buildModuleLauncher (src/modulesLauncher.ts): the More tab's grouped list
 * of every OTHER catalog module the caller's roles can see.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildModuleLauncher, LAUNCHER_EXCLUDED_CODES, type CatalogEntryLike } from "../src/modulesLauncher";

const CATALOG: CatalogEntryLike[] = [
  { code: "dashboard", label: "Dashboard", group: "Overview" },
  { code: "my-work", label: "My work", group: "Work" },
  { code: "inbox", label: "Inbox", group: "Work" },
  { code: "documents", label: "Documents", group: "Operations" },
  { code: "survey", label: "Land survey", group: "Operations" },
  { code: "inventory", label: "Inventory", group: "Operations" },
  { code: "attendance", label: "Attendance", group: "People" },
  { code: "leave", label: "Leave", group: "People" },
  { code: "assets", label: "Assets", group: "Operations" },
  { code: "security", label: "Security", group: "Organisation" },
];

describe("buildModuleLauncher", () => {
  it("excludes every code already reachable from its own bottom tab", () => {
    const groups = buildModuleLauncher(CATALOG, {});
    const codes = groups.flatMap((g) => g.items.map((i) => i.code));
    for (const excluded of LAUNCHER_EXCLUDED_CODES) {
      assert.equal(codes.includes(excluded), false, `${excluded} should not appear in the launcher`);
    }
    assert.deepEqual(codes.sort(), ["dashboard", "documents", "inbox", "inventory", "security"].sort());
  });

  it("hides a module an admin switched off, even if it would otherwise show", () => {
    const groups = buildModuleLauncher(CATALOG, { documents: false });
    const codes = groups.flatMap((g) => g.items.map((i) => i.code));
    assert.equal(codes.includes("documents"), false);
    assert.equal(codes.includes("inventory"), true);
  });

  it("groups items in catalog order, one group per distinct `group` value", () => {
    const groups = buildModuleLauncher(CATALOG, {});
    const titles = groups.map((g) => g.title);
    assert.deepEqual(titles, ["Overview", "Work", "Operations", "Organisation"]);
    const ops = groups.find((g) => g.title === "Operations")!;
    assert.deepEqual(ops.items.map((i) => i.code), ["documents", "inventory"]);
  });

  it("marks a built module's route and an unbuilt one as coming soon", () => {
    const groups = buildModuleLauncher(CATALOG, {});
    const documents = groups.flatMap((g) => g.items).find((i) => i.code === "documents")!;
    const dashboard = groups.flatMap((g) => g.items).find((i) => i.code === "dashboard")!;
    assert.equal(documents.comingSoon, false);
    assert.equal(documents.route, "/documents");
    assert.equal(dashboard.comingSoon, true);
    assert.match(dashboard.route, /^\/coming-soon\?/);
  });

  it("respects an absent modules map by showing everything not excluded", () => {
    const groups = buildModuleLauncher(CATALOG, undefined);
    const codes = groups.flatMap((g) => g.items.map((i) => i.code));
    assert.equal(codes.includes("documents"), true);
    assert.equal(codes.includes("security"), true);
  });
});
