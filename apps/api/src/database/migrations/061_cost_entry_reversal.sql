-- A source document can touch more than one project, and a posting can be
-- taken back (§note 10).
--
-- uk_cost_entry_source made one live entry per (source document, head,
-- nature) — no project in the key. That was right for the documents it was
-- written for: an expense claim or a purchase order belongs to one project,
-- so the project added nothing. A payroll run does not. One month's wages are
-- earned across every project the crews worked on, and posting the second of
-- them collided with the first.
--
-- Adding project_id keeps the original intent exactly — one entry per source
-- document per project — and only relaxes it where a document genuinely spans
-- projects.

ALTER TABLE project_cost_entries
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz;

/*
 * Whether an entry still counts, as a column rather than a question.
 *
 * "Has anything reversed this?" was a NOT EXISTS subquery, which a partial
 * index cannot express — so a reversed entry went on occupying its unique
 * slot and the run could never be posted again. That is the whole point of
 * reversing rather than deleting: the correction is a legitimate re-post.
 */
UPDATE project_cost_entries e
   SET reversed_at = r.created_at
  FROM project_cost_entries r
 WHERE r.reversal_of = e.id
   AND e.reversed_at IS NULL;

DROP INDEX IF EXISTS uk_cost_entry_source;

CREATE UNIQUE INDEX uk_cost_entry_source
  ON project_cost_entries(source_type, source_id, project_id, cost_head_id, nature)
  WHERE source_id IS NOT NULL
    AND reversal_of IS NULL
    AND reversed_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_cost_entry_live_source
  ON project_cost_entries(org_id, source_type, source_id)
  WHERE reversal_of IS NULL AND reversed_at IS NULL;
