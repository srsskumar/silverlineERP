import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MFA_DEFAULT_REQUIRED_ROLES, MFA_FLOOR_ROLES } from "@silverline/shared";
import { MIGRATION_VERSIONS } from "../src/database/migrate.js";
import {
  describeSchemaDrift,
  diffMigrations,
  inspectSchema,
  isSchemaCurrent,
  readAppliedMigrations,
  verifySchemaCurrent,
  type Queryable,
} from "../src/database/schemaGuard.js";

/** Stub pool: returns rows, or throws a pg-shaped error with `code`. */
function stubDb(
  versions: string[] | { code: string; message?: string },
): Queryable {
  return {
    async query() {
      if (Array.isArray(versions)) {
        return { rows: versions.map((version) => ({ version })), rowCount: versions.length };
      }
      const error = new Error(versions.message ?? "boom") as Error & { code: string };
      error.code = versions.code;
      throw error;
    },
  };
}

describe("diffMigrations", () => {
  it("reports nothing when the database is level", () => {
    const drift = diffMigrations(["001_init", "002_s1"], ["002_s1", "001_init"]);
    expect(drift).toEqual({ pending: [], ahead: [] });
    expect(isSchemaCurrent(drift)).toBe(true);
  });

  // The shipped failure: the build's attendance routes select device_signals,
  // which only exists after 020, while the database is still at 019.
  it("lists pending versions in registration order, not database order", () => {
    const drift = diffMigrations(
      ["018_provider_jobs", "019_planning_policies", "020_device_signals"],
      ["018_provider_jobs"],
    );
    expect(drift.pending).toEqual(["019_planning_policies", "020_device_signals"]);
  });

  // Rolling deploys run an old instance against a database a new instance has
  // already migrated; additive migrations keep the old routes working.
  it("treats a database ahead of the build as current", () => {
    const drift = diffMigrations(["001_init"], ["001_init", "002_s1"]);
    expect(drift).toEqual({ pending: [], ahead: ["002_s1"] });
    expect(isSchemaCurrent(drift)).toBe(true);
  });
});

describe("describeSchemaDrift", () => {
  it("returns null when nothing is pending", () => {
    expect(describeSchemaDrift({ pending: [], ahead: ["999_future"] })).toBeNull();
  });

  it("names the first pending migration and how to apply it", () => {
    const message = describeSchemaDrift({
      pending: ["020_device_signals"],
      ahead: [],
    });
    expect(message).toContain("020_device_signals");
    expect(message).toContain("migrate.ts");
    expect(message).toContain("out of date");
  });
});

describe("readAppliedMigrations", () => {
  it("reads the recorded versions", async () => {
    expect(await readAppliedMigrations(stubDb(["001_init"]))).toEqual(["001_init"]);
  });

  // A database that has never been migrated has no schema_migrations table;
  // that is drift, not a failure to check.
  it("treats a missing schema_migrations table as nothing applied", async () => {
    expect(await readAppliedMigrations(stubDb({ code: "42P01" }))).toEqual([]);
  });

  it("propagates any other database error", async () => {
    await expect(readAppliedMigrations(stubDb({ code: "28P01" }))).rejects.toThrow();
  });
});

describe("inspectSchema", () => {
  it("defaults to the registered migration list", async () => {
    const drift = await inspectSchema(stubDb([...MIGRATION_VERSIONS]));
    expect(drift).toEqual({ pending: [], ahead: [] });
  });

  it("flags every registered migration when nothing has been applied", async () => {
    const drift = await inspectSchema(stubDb({ code: "42P01" }));
    expect(drift.pending).toEqual([...MIGRATION_VERSIONS]);
  });
});

describe("verifySchemaCurrent", () => {
  it("stays quiet on a current database", async () => {
    const reported: string[] = [];
    await verifySchemaCurrent(stubDb([...MIGRATION_VERSIONS]), {
      report: (m) => reported.push(m),
    });
    expect(reported).toEqual([]);
  });

  it("reports once without throwing by default", async () => {
    const reported: string[] = [];
    const drift = await verifySchemaCurrent(stubDb(["001_init"]), {
      expected: ["001_init", "020_device_signals"],
      report: (m) => reported.push(m),
    });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("020_device_signals");
    expect(drift.pending).toEqual(["020_device_signals"]);
  });

  it("fails fast when the deployment demands a current schema", async () => {
    await expect(
      verifySchemaCurrent(stubDb(["001_init"]), {
        expected: ["001_init", "020_device_signals"],
        report: () => {},
        fatal: true,
      }),
    ).rejects.toThrow(/020_device_signals/);
  });
});

describe("MIGRATION_VERSIONS", () => {
  it("is unique and matches the on-disk file order", () => {
    expect(new Set(MIGRATION_VERSIONS).size).toBe(MIGRATION_VERSIONS.length);
    expect([...MIGRATION_VERSIONS].sort()).toEqual([...MIGRATION_VERSIONS]);
  });
});

describe("the MFA role defaults, in two places that must agree", () => {
  /*
   * Migration 055 seeds mfa_required from a list written in SQL; the seed
   * writes the same list from TypeScript. They cannot import from each other,
   * so the only thing keeping them together is this test — and this codebase
   * has already shipped a seed that overwrote a migration's role data more
   * than once.
   */
  const sql = readFileSync(
    new URL("../src/database/migrations/055_mfa_policy.sql", import.meta.url),
    "utf8",
  );

  it("seeds exactly the roles the shared list names", () => {
    const line = sql.match(/UPDATE roles SET mfa_required = true\s+WHERE code IN \(([^)]+)\)/);
    expect(line, "the migration's seeding statement").toBeTruthy();
    const inSql = [...line![1].matchAll(/'([A-Z_]+)'/g)].map(m => m[1]).sort();
    expect(inSql).toEqual([...MFA_DEFAULT_REQUIRED_ROLES].sort());
  });

  it("keeps the floor role in the defaults", () => {
    // A role the database refuses to set false must be seeded true, or a
    // fresh install cannot write the row at all.
    for (const code of MFA_FLOOR_ROLES) {
      expect(MFA_DEFAULT_REQUIRED_ROLES as readonly string[]).toContain(code);
    }
  });

  it("writes the floor into the table, not only into the API", () => {
    // A policy that holds only while the application is the only writer is
    // not a policy.
    expect(sql).toMatch(/CHECK \(code <> 'SUPER_ADMIN' OR mfa_required\)/);
  });
});
