/// <reference types="node" />
/**
 * buildModuleLauncher (src/modulesLauncher.ts): the More tab's grouped list
 * of every OTHER catalog module the caller's roles can see.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BUILT_MODULE_ROUTES,
  buildModuleLauncher,
  LAUNCHER_EXCLUDED_CODES,
  WEB_ONLY_CODES,
  type CatalogEntryLike,
} from "../src/modulesLauncher";

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
  { code: "pipeline", label: "Pipeline", group: "Commercial" },
  { code: "clients", label: "Clients", group: "Commercial" },
  { code: "tenders", label: "Tenders", group: "Commercial" },
  { code: "employees", label: "Directory", group: "People" },
  { code: "attendance-exceptions", label: "Exceptions", group: "People" },
];

describe("buildModuleLauncher", () => {
  it("excludes every code already reachable from its own bottom tab", () => {
    const groups = buildModuleLauncher(CATALOG, {});
    const codes = groups.flatMap((g) => g.items.map((i) => i.code));
    for (const excluded of LAUNCHER_EXCLUDED_CODES) {
      assert.equal(codes.includes(excluded), false, `${excluded} should not appear in the launcher`);
    }
    assert.deepEqual(
      codes.sort(),
      [
        "dashboard",
        "documents",
        "inbox",
        "inventory",
        "security",
        "pipeline",
        "clients",
        "tenders",
        "employees",
        "attendance-exceptions",
      ].sort(),
    );
  });

  it("never lists a web-only module such as Org locations, not even as Coming soon", () => {
    const groups = buildModuleLauncher(
      [...CATALOG, { code: "org-locations", label: "Locations", group: "Organisation" }],
      {},
    );
    const codes = groups.flatMap((g) => g.items.map((i) => i.code));
    assert.equal(codes.includes("org-locations"), false);
    assert.equal(WEB_ONLY_CODES.includes("org-locations"), true);
    assert.equal("org-locations" in BUILT_MODULE_ROUTES, false);
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
    assert.deepEqual(titles, ["Overview", "Work", "Operations", "Organisation", "Commercial", "People"]);
    const ops = groups.find((g) => g.title === "Operations")!;
    assert.deepEqual(ops.items.map((i) => i.code), ["documents", "inventory"]);
    const commercial = groups.find((g) => g.title === "Commercial")!;
    assert.deepEqual(commercial.items.map((i) => i.code), ["pipeline", "clients", "tenders"]);
    const people = groups.find((g) => g.title === "People")!;
    assert.deepEqual(people.items.map((i) => i.code), ["employees", "attendance-exceptions"]);
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

  it("wires this round's five CRM/HR modules to their real routes", () => {
    const groups = buildModuleLauncher(CATALOG, {});
    const byCode = new Map(groups.flatMap((g) => g.items).map((i) => [i.code, i]));
    for (const code of ["pipeline", "clients", "tenders", "employees", "attendance-exceptions"]) {
      const item = byCode.get(code)!;
      assert.equal(item.comingSoon, false, `${code} should be built`);
      assert.equal(item.route, BUILT_MODULE_ROUTES[code]);
    }
  });

  it("respects an absent modules map by showing everything not excluded", () => {
    const groups = buildModuleLauncher(CATALOG, undefined);
    const codes = groups.flatMap((g) => g.items.map((i) => i.code));
    assert.equal(codes.includes("documents"), true);
    assert.equal(codes.includes("security"), true);
  });
});
