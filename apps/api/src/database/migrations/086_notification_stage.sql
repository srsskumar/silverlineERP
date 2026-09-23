/*
 * §086 — a stage after "final deliverables", not a rename of one.
 *
 * Every stage §071 introduced was the same checkpoint under a new name; the
 * work it named already existed and only the label on the position moved.
 * This one is not that. The department's acceptance of the final
 * deliverables turns out not to be the end of the contract: it issues a
 * notification afterwards, and until now nothing in this system had
 * anywhere to record that happening. A village sitting at "final
 * deliverables approved" for months with the last 20% still unpaid was this
 * gap, not a stalled village.
 *
 * No data is migrated onto this stage, unlike §071's DATA_SUBMISSION and
 * FINAL_DELIVERABLES: no existing row was ever recording notification under
 * some other name, because there was no other name for it.
 */

INSERT INTO survey_stages (org_id, code, label, display_order)
SELECT o.id, 'NOTIFICATION', 'Notification', 60
FROM organizations o
ON CONFLICT (org_id, code) DO NOTHING;

/* Wire it onto the end of the sequence, after final deliverables. */
UPDATE survey_stages s SET requires_stage_id = p.id
FROM survey_stages p
WHERE p.org_id = s.org_id
  AND s.code = 'NOTIFICATION' AND p.code = 'FINAL_DELIVERABLES';
