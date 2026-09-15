import "../common/env.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Pool } from "pg";

/** Ordered migrations. Append-only: never reorder or rename entries. */
const MIGRATIONS: Array<{ version: string; file: string }> = [
  { version: "001_init", file: "001_init.sql" },
  { version: "002_s1", file: "002_s1.sql" },
  { version: "003_s2", file: "003_s2.sql" },
  { version: "004_s3", file: "004_s3.sql" },
  { version: "005_s4", file: "005_s4.sql" },
  { version: "006_s5", file: "006_s5.sql" },
  { version: "007_p1", file: "007_p1.sql" },
  { version: "008_scopes", file: "008_scopes.sql" },
  { version: "009_v2", file: "009_v2.sql" },
  { version: "010_delivery", file: "010_delivery.sql" },
  { version: "011_jobs", file: "011_jobs.sql" },
  { version: "012_mutation_receipts", file: "012_mutation_receipts.sql" },
  { version: "013_project_workflows", file: "013_project_workflows.sql" },
  { version: "014_retained_payslips", file: "014_retained_payslips.sql" },
  { version: "015_workflow_defaults", file: "015_workflow_defaults.sql" },
  { version: "016_automation_authority", file: "016_automation_authority.sql" },
  { version: "017_advisory_reviews", file: "017_advisory_reviews.sql" },
  { version: "018_provider_jobs", file: "018_provider_jobs.sql" },
  { version: "019_planning_policies", file: "019_planning_policies.sql" },
  { version: "020_device_signals", file: "020_device_signals.sql" },
  { version: "021_employee_site", file: "021_employee_site.sql" },
  { version: "022_geo_fence_employee_assignments", file: "022_geo_fence_employee_assignments.sql" },
  { version: "023_mfa_replay", file: "023_mfa_replay.sql" },
  { version: "024_employee_pii_uniqueness", file: "024_employee_pii_uniqueness.sql" },
  { version: "025_attendance_fence_version", file: "025_attendance_fence_version.sql" },
  { version: "026_blob_storage", file: "026_blob_storage.sql" },
  { version: "027_client_contact_master", file: "027_client_contact_master.sql" },
  { version: "028_crm_leads", file: "028_crm_leads.sql" },
  { version: "029_tender_bid", file: "029_tender_bid.sql" },
  { version: "030_conversion_lineage", file: "030_conversion_lineage.sql" },
  { version: "031_commercial_permissions", file: "031_commercial_permissions.sql" },
  { version: "032_india_statutory", file: "032_india_statutory.sql" },
  { version: "033_indian_tender_practice", file: "033_indian_tender_practice.sql" },
  { version: "034_ra_billing", file: "034_ra_billing.sql" },
  { version: "035_approvals", file: "035_approvals.sql" },
  { version: "036_gst_invoice_model", file: "036_gst_invoice_model.sql" },
  // Contract phase of the GSTIN move. Run only after the API build that stops
  // touching clients.gstin / vendors.gstin is live — see the file header.
  { version: "037_drop_client_gstin", file: "037_drop_client_gstin.sql" },
  { version: "038_procurement", file: "038_procurement.sql" },
  { version: "039_procurement_enhancements", file: "039_procurement_enhancements.sql" },
  { version: "040_expense_cost_control", file: "040_expense_cost_control.sql" },
  { version: "041_project_category_and_gst", file: "041_project_category_and_gst.sql" },
  { version: "042_financial_control", file: "042_financial_control.sql" },
  { version: "043_inventory_control", file: "043_inventory_control.sql" },
  { version: "044_allocation_roster", file: "044_allocation_roster.sql" },
  { version: "045_pipeline_classification", file: "045_pipeline_classification.sql" },
];

/**
 * The versions this build expects the database to have applied, in order.
 * Exported so a running API can compare itself against `schema_migrations`
 * instead of discovering the drift as a column-not-found 500 in one route.
 */
export const MIGRATION_VERSIONS: readonly string[] = MIGRATIONS.map(
  (m) => m.version,
);

function migrationSql(file: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "migrations", file), "utf8");
}

/**
 * Applies pending migrations in order. Safe to re-run (idempotent DDL +
 * per-version gate).
 */
export async function migrate(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(7814240)');
    await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    for (const {version,file} of MIGRATIONS) {
      if ((await db.query('SELECT 1 FROM schema_migrations WHERE version=$1',[version])).rowCount) continue;
      await db.query(migrationSql(file));
      await db.query('INSERT INTO schema_migrations(version) VALUES($1)',[version]);
    }
    await db.query('COMMIT');
  } catch(error) { await db.query('ROLLBACK');throw error; }
  finally { db.release();await pool.end(); }

}

const invokedAsScript =
  process.argv[1]?.endsWith("migrate.ts") === true ||
  process.argv[1]?.endsWith("migrate.js") === true;

if (invokedAsScript) {
  const databaseUrl =
    process.env["DATABASE_URL"] ?? "postgresql://localhost:5432/silverline_dev";
  await migrate(databaseUrl);
  console.log(
    `migrations applied (${MIGRATIONS.map((m) => m.version).join(",")}) -> database`,
  );
}
