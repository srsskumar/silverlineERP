import { describe, expect, it } from "vitest";
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
