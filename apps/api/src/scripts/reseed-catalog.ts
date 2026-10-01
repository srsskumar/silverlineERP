import "../common/env.js";
import { Pool } from "pg";
import { DOCUMENT_TYPE_SEEDS, PROJECT_CATEGORY_SEEDS, MEASURE_SEEDS, STAGE_PIPELINE } from "@silverline/shared";

/**
 * Re-seed the per-org catalog rows that reset-for-e2e.ts wipes along with
 * everything else -- document_types, leave_types, project_categories,
 * survey_measures, survey_stages -- for every organisation that still has
 * an ADMIN/SUPER_ADMIN user.
 *
 * None of these tables have a REST API to create them (only
 * src/database/seed.ts inserts them, and only for the one hardcoded demo
 * org). Without this, a reset org's documents, leave and survey modules
 * are all dead: every document/leave-request create 404s at the type
 * lookup, and crewing a village fails UNKNOWN_STAGE, with no way for an
 * org admin to fix any of it themselves.
 *
 * Re-runnable: every insert here is the same ON CONFLICT ... DO UPDATE
 * seed.ts itself uses, so running this twice converges rather than
 * duplicating or erroring.
 *
 *   DATABASE_URL=... npm run reseed-catalog --workspace=api
 */

const LEAVE_TYPE_SEEDS = [
  { code: "CL", name: "Casual Leave", isPaid: true, entitlement: 12, requiresBalance: true },
  { code: "SL", name: "Sick Leave", isPaid: true, entitlement: 12, requiresBalance: true },
  { code: "EL", name: "Earned Leave", isPaid: true, entitlement: 15, requiresBalance: true },
  { code: "LOP", name: "Loss of Pay", isPaid: false, entitlement: 0, requiresBalance: false },
];

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env["DATABASE_URL"] ?? "postgresql://localhost:5432/silverline_dev",
  });
  try {
    const orgs = await pool.query(
      `SELECT DISTINCT o.id, o.name
         FROM organizations o
         JOIN users u ON u.org_id = o.id
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
        WHERE r.code IN ('ADMIN', 'SUPER_ADMIN') AND r.org_id IS NULL
        ORDER BY o.name`,
    );
    if (orgs.rowCount === 0) {
      console.error("No organisation has an ADMIN/SUPER_ADMIN user -- nothing to seed for.");
      process.exitCode = 1;
      return;
    }

    for (const org of orgs.rows as Array<{ id: string; name: string }>) {
      for (const t of DOCUMENT_TYPE_SEEDS) {
        await pool.query(
          `INSERT INTO document_types (org_id, code, label, category, owners, notice_days,
             expiry_required, blocks_operations, retention_years, confidential, basis)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (org_id, code) DO UPDATE SET
             label = EXCLUDED.label, category = EXCLUDED.category, owners = EXCLUDED.owners,
             notice_days = EXCLUDED.notice_days, expiry_required = EXCLUDED.expiry_required,
             blocks_operations = EXCLUDED.blocks_operations,
             retention_years = EXCLUDED.retention_years, confidential = EXCLUDED.confidential,
             basis = EXCLUDED.basis, updated_at = NOW()`,
          [org.id, t.code, t.label, t.category, t.owners, t.noticeDays, t.expiryRequired,
            t.blocksOperations, t.retentionYears, t.confidential, t.basis ?? null],
        );
      }
      for (const t of LEAVE_TYPE_SEEDS) {
        await pool.query(
          `INSERT INTO leave_types (org_id, code, name, is_paid, annual_entitlement, requires_balance, active)
           VALUES ($1, $2, $3, $4, $5, $6, true)
           ON CONFLICT (org_id, code) DO UPDATE SET
             name = EXCLUDED.name, is_paid = EXCLUDED.is_paid,
             annual_entitlement = EXCLUDED.annual_entitlement, requires_balance = EXCLUDED.requires_balance,
             active = true, updated_at = NOW()`,
          [org.id, t.code, t.name, t.isPaid, t.entitlement, t.requiresBalance],
        );
      }
      for (const c of PROJECT_CATEGORY_SEEDS) {
        await pool.query(
          `INSERT INTO project_categories (org_id, code, name)
           VALUES ($1, $2, $3)
           ON CONFLICT (org_id, code) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()`,
          [org.id, c.code, c.name],
        );
      }
      for (const m of MEASURE_SEEDS) {
        await pool.query(
          `INSERT INTO survey_measures (org_id, code, label, group_label, unit, basis, display_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (org_id, code) DO UPDATE SET
             label = EXCLUDED.label, group_label = EXCLUDED.group_label, unit = EXCLUDED.unit,
             basis = EXCLUDED.basis, display_order = EXCLUDED.display_order, updated_at = NOW()`,
          [org.id, m.code, m.label, m.groupLabel, m.unit, m.basis, m.displayOrder],
        );
      }
      for (const s of STAGE_PIPELINE) {
        await pool.query(
          `INSERT INTO survey_stages (org_id, code, label, display_order, tracks_daily_progress)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (org_id, code) DO UPDATE SET
             label = EXCLUDED.label, display_order = EXCLUDED.display_order,
             tracks_daily_progress = EXCLUDED.tracks_daily_progress`,
          [org.id, s.code, s.label, s.displayOrder, Boolean(s.tracksDailyProgress)],
        );
      }
      // The chain, once every stage exists -- same two-pass approach as
      // seed.ts, since a stage can require one not yet inserted.
      for (const s of STAGE_PIPELINE) {
        if (!s.requires) continue;
        await pool.query(
          `UPDATE survey_stages child SET requires_stage_id = parent.id
           FROM survey_stages parent
           WHERE child.org_id = $1 AND child.code = $2
             AND parent.org_id = $1 AND parent.code = $3`,
          [org.id, s.code, s.requires],
        );
      }
      console.log(`${org.name}: ${DOCUMENT_TYPE_SEEDS.length} document type(s), ${LEAVE_TYPE_SEEDS.length} leave type(s), ${PROJECT_CATEGORY_SEEDS.length} project category/categories, ${MEASURE_SEEDS.length} survey measure(s), ${STAGE_PIPELINE.length} survey stage(s).`);
    }
    console.log(`\nDone across ${orgs.rowCount} organisation(s).`);
  } finally {
    await pool.end();
  }
}

await main();
