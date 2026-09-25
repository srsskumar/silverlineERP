-- Org-wide fallback approval ladders for requisitions and purchase orders
-- (owner decision 2026-09-24).
--
-- submitForApproval() (apps/api/src/common/approvalRouting.ts) already falls
-- back to a project_id IS NULL policy when a project has none of its own --
-- the routing query has always ordered `project_id NULLS LAST`. The gap was
-- never the fallback logic: no organisation had ever been given an org-wide
-- policy for PURCHASE_REQUISITION or PURCHASE_ORDER to fall back to, so a
-- project-less requisition or PO had nothing to route to at all and
-- NO_APPROVAL_POLICY refused it outright.
--
-- Backfills one minimal org-wide policy per organisation and document type
-- that has never had one: a single step, approver role ADMIN, no amount
-- band (the whole point is that it never leaves anything unrouted). An
-- org-wide policy that exists but is inactive counts as configured, the
-- same rule seed.ts applies -- an administrator who deliberately
-- deactivated it must not find it resurrected (review A, 4(c)). Re-run
-- safe: after one run every organisation has a row, so a second finds
-- nothing left to insert.
WITH doc_types AS (
  SELECT unnest(ARRAY['PURCHASE_REQUISITION', 'PURCHASE_ORDER']) AS document_type
), missing AS (
  SELECT o.id AS org_id, d.document_type
    FROM organizations o CROSS JOIN doc_types d
   WHERE NOT EXISTS (
     SELECT 1 FROM approval_policies p
      WHERE p.org_id = o.id AND p.document_type = d.document_type
        AND p.project_id IS NULL
   )
), inserted AS (
  INSERT INTO approval_policies(org_id, document_type, name, mode, project_id, active)
  SELECT org_id, document_type,
         'Org default -- ' || initcap(replace(document_type, '_', ' ')),
         'CUMULATIVE', NULL, true
    FROM missing
  RETURNING id, org_id, document_type
)
INSERT INTO approval_levels(org_id, policy_id, sequence, min_amount, max_amount, approver_role)
SELECT org_id, id, 1, 0, NULL, 'ADMIN' FROM inserted;
