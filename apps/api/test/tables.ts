/**
 * The tables a test run owns and may truncate between suites.
 *
 * One list, because it used to be thirteen identical copies. Every one had to
 * be updated when a table was added, and the failure when a copy was missed is
 * unhelpful: a foreign key complaint naming neither the new table nor the file
 * that forgot it, which fails every test in the suite at once rather than the
 * one that cares.
 *
 * Order matters — a child is listed before its parent, so a single TRUNCATE
 * satisfies every foreign key without CASCADE. CASCADE is avoided
 * deliberately: it would silently empty a table nobody listed, including the
 * seeded reference data the suites are built on.
 */
export const VOLATILE_TABLES = `
  survey_entry_rovers, survey_entry_values, survey_stage_history,
  survey_project_employees, survey_entries, survey_targets, survey_crew,
  survey_rover_allocations, survey_village_stages,
  survey_villages, survey_projects, survey_measures, survey_stages,
  documents, document_types, roster_entries, work_shifts, resource_allocations,
  stock_count_lines, stock_counts, stock_reservations, payment_run_lines, payment_runs,
  bank_transactions, payment_allocations, payments, financial_periods, project_categories,
  expense_receipt_fingerprints, expense_reimbursements, expense_lines, expense_claims,
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
  stock_transactions, stock_locations, assets, asset_assignments, asset_audits, cycles,
  custom_field_definitions, domain_events, automation_rules, automation_executions,
  webhook_subscriptions, webhook_deliveries, insight_feedback, v2_operations,
  geo_fence_employee_assignments, device_registrations, audit_events, sessions, user_roles,
  idempotency_keys, users, employee_documents, employees, org_units, holidays,
  attendance_exceptions, attendance_records, attendance_events, geo_fences, leave_requests,
  leave_balances, leave_types, mentions, comments, task_evidence, task_dependencies, tasks,
  projects, project_workflows, project_types, workspaces, notifications, task_labels,
  labels, saved_filters, board_columns, boards, payslips, payroll_runs, payroll_policies`.trim().replace(/\s+/g, ' ');
