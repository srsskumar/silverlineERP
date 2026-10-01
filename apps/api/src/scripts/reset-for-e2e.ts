import "../common/env.js";
import { Pool } from "pg";

/**
 * Wipe every organisation's working data for a clean end-to-end testing
 * pass, keeping only ADMIN/SUPER_ADMIN users (and their linked employee
 * row) so there is still a way to log in afterward.
 *
 * A one-off, run by hand -- never by a migration, since "wipe the data"
 * is an operator's decision each time, not a deploy step.
 *
 * The table list is kept in sync with apps/api/test/tables.ts's
 * VOLATILE_TABLES by hand (that file is test-only and not importable from
 * src/). If a migration adds a new org-scoped table, add it to both lists.
 *
 * users and employees are deliberately NOT in the TRUNCATE set below: they
 * get a targeted DELETE instead, keeping ADMIN/SUPER_ADMIN holders. Every
 * other table in the list is fully truncated first, which empties anything
 * that references a non-kept user or employee before those rows are
 * removed -- the same reason it is safe to remove user_roles' own entry
 * too, since deleting from `users` cascades it (001_init.sql's
 * ON DELETE CASCADE).
 *
 *   DATABASE_URL=... npm run reset-for-e2e --workspace=api            # do it
 *   DATABASE_URL=... npm run reset-for-e2e --workspace=api -- --dry-run # count only
 */

const TRUNCATE_TABLES = `
  impersonation_sessions,
  project_supply_lines, catalogue_items,
  role_scope_policies, role_module_visibility,
  password_reset_requests,
  task_collaborators,
  survey_alert_sent, survey_alert_subscriptions, survey_queries, survey_contacts,
  survey_boq_links, survey_village_billing, survey_village_finals, survey_village_gcps,
  survey_entry_rovers, survey_entry_values, survey_stage_history,
  survey_project_employees, survey_entries, survey_targets, survey_crew,
  survey_rover_allocations, survey_village_stages,
  survey_villages, survey_projects, survey_measures, survey_stages,
  documents, document_types, roster_entries, work_shifts, resource_allocations,
  stock_count_lines, stock_counts, stock_reservations, payment_run_lines, payment_runs,
  bank_transactions, payment_allocations, payments, financial_periods, project_categories,
  expense_receipts, expense_receipt_fingerprints, expense_reimbursements, expense_lines, expense_claims,
  expense_policies, project_cost_entries, project_budgets, cost_heads, vendor_return_lines,
  vendor_returns, vendor_quote_lines, vendor_quotes, rfq_vendors, rfq_lines, rfqs,
  invoice_match_results, grn_lines, goods_receipt_notes, po_amendments,
  purchase_order_lines, purchase_orders, requisition_lines, purchase_requisitions,
  invoice_lines, approval_steps, approval_instances, approval_levels, approval_policies,
  approval_delegations, retention_ledger, ra_bill_deductions, ra_bill_items, ra_bills,
  project_advances, project_billing_policies, boq_items, party_gst_registrations,
  record_conversions, bank_guarantee_instruments, competitor_bids,
  tender_eligibility_items, tender_corrigenda, private_proposals, tenders, interactions,
  opportunities, leads, contacts, clients, provider_jobs, advisory_cases,
  payslip_revisions, project_workflow_overrides, notification_deliveries, report_registry,
  report_schedules, payslip_documents, vendors, inventory_items, invoices,
  stock_transactions, stock_locations, asset_assignments, asset_audits, assets,
  asset_types, asset_categories, cycles,
  custom_field_definitions, domain_events, automation_rules, automation_executions,
  webhook_subscriptions, webhook_deliveries, insight_feedback, v2_operations,
  geo_fence_employee_assignments, device_registrations, audit_events, sessions,
  idempotency_keys, employee_documents, designations, org_units, holidays,
  attendance_exceptions, attendance_records, attendance_events, geo_fences, leave_requests,
  leave_balances, leave_year_open_runs, leave_types, mentions, comments, task_evidence, task_dependencies, tasks,
  projects, project_workflows, project_types, workspaces, notifications, task_labels,
  labels, saved_filters, board_columns, boards, payslips, payroll_runs, payroll_policies
`.trim().replace(/\s+/g, " ");

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const pool = new Pool({
    connectionString: process.env["DATABASE_URL"] ?? "postgresql://localhost:5432/silverline_dev",
  });
  try {
    const kept = await pool.query(
      `SELECT u.id AS user_id, u.org_id, u.username, u.employee_id
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
        WHERE r.code IN ('ADMIN', 'SUPER_ADMIN') AND r.org_id IS NULL`,
    );
    const keptUserIds = kept.rows.map(r => String(r.user_id));
    const keptEmployeeIds = kept.rows
      .map(r => r.employee_id)
      .filter((id): id is string => id !== null)
      .map(String);

    console.log(`Keeping ${keptUserIds.length} ADMIN/SUPER_ADMIN user(s) across ${new Set(kept.rows.map(r => r.org_id)).size} organisation(s):`);
    for (const r of kept.rows) console.log(`  ${r.org_id}  ${r.username}`);

    if (keptUserIds.length === 0) {
      console.error("No ADMIN/SUPER_ADMIN users found anywhere -- refusing to run (would delete every login in the database).");
      process.exitCode = 1;
      return;
    }

    const before = await pool.query("SELECT count(*)::int AS n FROM users");
    console.log(`\n${before.rows[0].n} total user(s) in the database before this runs.`);

    if (dryRun) {
      console.log("--dry-run: nothing written.");
      return;
    }

    await pool.query("BEGIN");
    try {
      // employees and users are deliberately kept out of the truncate set
      // (they get a targeted delete below, to preserve ADMIN/SUPER_ADMIN
      // rows), but either can hold its own FK into a table that IS being
      // truncated -- employees.designation_id -> designations is one,
      // found by running this the first time.
      //
      // TRUNCATE's FK check is structural, not data-based: it refuses a
      // table with an incoming FK from a table outside the TRUNCATE list
      // regardless of whether any row actually points at it, so nulling
      // the referencing column first (tried first, still failed the same
      // way) does not help. The tables on the other end of such an FK get
      // DELETEd instead of TRUNCATEd below -- once the referencing column
      // is null, DELETE's row-level check passes. Discovered from
      // pg_constraint rather than hard-coded, so a schema change doesn't
      // silently stop being handled.
      // Also covers employees.exit_approved_by/created_by/updated_by ->
      // users: those don't block a TRUNCATE (nothing truncates users), but
      // do block the row-level DELETE FROM users below once a kept
      // employee's own history points at a user being removed -- found by
      // running this a second time. Nulling them is harmless: this is a
      // full data wipe, and "who approved this exit" doesn't need to
      // survive it.
      const tableNames = TRUNCATE_TABLES.split(",").map(t => t.trim());
      const crossFks = await pool.query(
        `SELECT conrelid::regclass::text AS referencing_table,
                a.attname AS referencing_column,
                confrelid::regclass::text AS referenced_table
           FROM pg_constraint c
           JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
          WHERE c.contype = 'f'
            AND conrelid::regclass::text IN ('employees', 'users')
            AND confrelid::regclass::text = ANY($1::text[])`,
        [[...tableNames, "users"]],
      );
      const deleteInstead = new Set<string>();
      for (const row of crossFks.rows as Array<{
        referencing_table: string; referencing_column: string; referenced_table: string;
      }>) {
        console.log(`Clearing ${row.referencing_table}.${row.referencing_column} (points into ${row.referenced_table})`);
        await pool.query(`UPDATE ${row.referencing_table} SET ${row.referencing_column} = NULL`);
        if (row.referenced_table !== "users") deleteInstead.add(row.referenced_table);
      }

      const truncateOnly = tableNames.filter(t => !deleteInstead.has(t));
      await pool.query(`TRUNCATE TABLE ${truncateOnly.join(", ")}`);
      for (const table of deleteInstead) {
        console.log(`Deleting ${table} (TRUNCATE refuses it structurally while employees/users reference it)`);
        await pool.query(`DELETE FROM ${table}`);
      }
      // A kept employee's own manager chain could point at a non-kept
      // employee about to be deleted; clear it first rather than let the
      // FK on employees.reports_to refuse the delete below. (This one is
      // employees -> employees, so the query above never finds it --
      // confrelid is "employees" itself, not a truncated table.)
      await pool.query("UPDATE employees SET reports_to = NULL WHERE id = ANY($1::uuid[])", [keptEmployeeIds]);
      const deletedUsers = await pool.query(
        "DELETE FROM users WHERE NOT (id = ANY($1::uuid[]))",
        [keptUserIds],
      );
      const deletedEmployees = await pool.query(
        "DELETE FROM employees WHERE NOT (id = ANY($1::uuid[]))",
        [keptEmployeeIds],
      );
      await pool.query("COMMIT");
      console.log(`Deleted ${deletedUsers.rowCount} user(s) and ${deletedEmployees.rowCount} employee(s). Every other org-scoped table is empty.`);
    } catch (err) {
      await pool.query("ROLLBACK");
      throw err;
    }
  } finally {
    await pool.end();
  }
}

await main();
