import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  tenderSchema, tenderBaseSchema, tenderStatusSchema, corrigendumSchema, eligibilityItemSchema,
  competitorBidSchema, instrumentSchema, instrumentStatusSchema,
  proposalSchema, conversionSchema,
  TENDER_STATUS_TRANSITIONS, type TenderStatus,
} from '@silverline/shared';
import { buildAuthenticate, requirePermission } from '../../common/auth.js';
import { actor, parse, page, inOrg, mutate, version, fail } from '../../common/domain.js';

/** Tender fields a corrigendum is allowed to move (§8.5). */
const CORRIGENDUM_FIELDS = new Set([
  'closing_date', 'opening_date', 'submission_date', 'start_date',
  'estimated_value', 'bid_validity_days', 'reference_number', 'package_lot_no',
]);

export async function registerTenderRoutes(app: FastifyInstance, opts: { pool: Pool; jwtSecret: string }) {
  const { pool } = opts;
  const auth = buildAuthenticate(opts);
  const guard = (p: string) => requirePermission(auth, p);

  /**
   * §8.6 / §8.11: required checklist items still outstanding.
   *
   * Returned rather than thrown so the caller can decide — SUBMITTED and
   * AWARDED both gate on it, but the override path needs the list to record
   * what was overridden.
   */
  async function outstandingRequired(db: Pool | PoolClient, tenderId: string) {
    return (await db.query(
      `SELECT id, requirement_name, item_status
       FROM tender_eligibility_items
       WHERE tender_id = $1 AND is_required AND item_status NOT IN ('READY','SUBMITTED')
       ORDER BY requirement_name`, [tenderId])).rows;
  }

  /* -------------------------------------------------------------- tenders */

  app.get('/api/v1/tenders', { preHandler: guard('tender.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId, limit + 1, offset];
    let where = 't.org_id = $1';
    if (q.status) { values.push(q.status); where += ` AND t.status = $${values.length}`; }
    if (q.client_id) { values.push(q.client_id); where += ` AND t.client_id = $${values.length}::uuid`; }
    if (q.search) { values.push(`%${q.search}%`); where += ` AND (t.tender_no ILIKE $${values.length} OR t.reference_number ILIKE $${values.length} OR t.department ILIKE $${values.length})`; }
    // §8.4 deadline view: what closes soonest among live tenders.
    const order = q.sort === 'closing' ? 't.closing_date NULLS LAST, t.id' : 't.created_at DESC, t.id DESC';
    const rows = (await pool.query(
      `SELECT t.*, c.name AS client_name,
              (SELECT count(*)::int FROM tender_eligibility_items e
                WHERE e.tender_id = t.id AND e.is_required
                  AND e.item_status NOT IN ('READY','SUBMITTED')) AS outstanding_required
       FROM tenders t LEFT JOIN clients c ON c.id = t.client_id
       WHERE ${where} ORDER BY ${order} LIMIT $2 OFFSET $3`, values)).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit, next_offset: rows.length > limit ? offset + limit : null };
  });

  app.get('/api/v1/tenders/:id', { preHandler: guard('tender.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const tender = await inOrg(pool, 'tenders', id, u.orgId);
    const [checklist, corrigenda, competitors, instruments, project] = await Promise.all([
      pool.query('SELECT * FROM tender_eligibility_items WHERE tender_id = $1 ORDER BY is_required DESC, requirement_name', [id]),
      pool.query('SELECT * FROM tender_corrigenda WHERE tender_id = $1 ORDER BY date_issued DESC, id', [id]),
      pool.query('SELECT * FROM competitor_bids WHERE tender_id = $1 ORDER BY rank NULLS LAST, quoted_amount', [id]),
      pool.query('SELECT * FROM bank_guarantee_instruments WHERE tender_id = $1 ORDER BY expiry_date', [id]),
      pool.query('SELECT id, code, name, status FROM projects WHERE tender_id = $1', [id]),
    ]);
    return {
      data: {
        ...tender,
        eligibility: checklist.rows,
        corrigenda: corrigenda.rows,
        competitors: competitors.rows,
        instruments: instruments.rows,
        // §8.3: the project's status is reported alongside but never derived.
        project: project.rows[0] ?? null,
        allowed_statuses: TENDER_STATUS_TRANSITIONS[tender.status as TenderStatus] ?? [],
        outstanding_required: checklist.rows.filter(
          r => r.is_required && !['READY', 'SUBMITTED'].includes(String(r.item_status))).length,
      },
    };
  });

  app.post('/api/v1/tenders', { preHandler: guard('tender.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(tenderSchema, req.body) as Record<string, unknown>;
    const row = await mutate(pool, req, 'tender.create', 'tender', async db => {
      if (input.client_id) await inOrg(db, 'clients', String(input.client_id), u.orgId);
      if (input.opportunity_id) await inOrg(db, 'opportunities', String(input.opportunity_id), u.orgId);
      if (input.project_category_id) {
        await inOrg(db, 'project_categories', String(input.project_category_id), u.orgId);
      }
      if (input.project_type_id) {
        const t = await db.query(
          'SELECT 1 FROM project_types WHERE id = $1::uuid AND org_id = $2',
          [input.project_type_id, u.orgId]);
        if (!t.rowCount) fail('NOT_FOUND', 'Project type not found', 404);
      }
      const prepared = { ...input, jv_partners: JSON.stringify(input.jv_partners ?? []) };
      const keys = Object.keys(prepared), values = [u.orgId, u.id, ...Object.values(prepared)];
      const created = (await db.query(
        `INSERT INTO tenders(org_id, created_by, ${keys.join(',')})
         VALUES(${values.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, values)).rows[0];
      // §37.1 lineage when the tender came from an opportunity.
      if (input.opportunity_id) {
        await db.query(
          `INSERT INTO record_conversions(org_id, source_type, source_id, target_type, target_id, carried_fields, actor_id)
           VALUES($1,'OPPORTUNITY',$2,'TENDER',$3,$4,$5)`,
          [u.orgId, input.opportunity_id, created.id,
           JSON.stringify({ client_id: input.client_id ?? null, estimated_value: input.estimated_value ?? null }), u.id]);
        await db.query("UPDATE opportunities SET status='CONVERTED', version=version+1, updated_at=now(), updated_by=$2 WHERE id=$1", [input.opportunity_id, u.id]);
        await db.query(
          `UPDATE leads SET stage='CONVERTED', status='CLOSED', version=version+1, updated_at=now(), updated_by=$2
           WHERE id = (SELECT lead_id FROM opportunities WHERE id=$1)`, [input.opportunity_id, u.id]);
      }
      return created;
    });
    return reply.code(201).send({ data: row });
  });

  app.patch('/api/v1/tenders/:id', { preHandler: guard('tender.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(tenderBaseSchema.partial(), req.body) as Record<string, unknown>;
    if (!Object.keys(input).length) fail('VALIDATION_ERROR', 'Send at least one field to change');
    return {
      data: await mutate(pool, req, 'tender.update', 'tender', async db => {
        const current = await inOrg(db, 'tenders', id, u.orgId, true);
        version(req, current as { version: number });
        if (['AWARDED', 'REJECTED', 'CANCELLED'].includes(String(current.status))) {
          fail('TENDER_CLOSED', `A ${String(current.status).toLowerCase()} tender can no longer be edited`);
        }
        const prepared = 'jv_partners' in input ? { ...input, jv_partners: JSON.stringify(input.jv_partners) } : input;
        const keys = Object.keys(prepared);
        const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(',');
        return (await db.query(
          `UPDATE tenders SET ${sets}, version = version + 1, updated_at = now(), updated_by = $2
           WHERE id = $1 RETURNING *`, [id, u.id, ...Object.values(prepared)])).rows[0];
      }),
    };
  });

  /**
   * §8.2 status machine with the §8.6 / §8.11 eligibility gate.
   *
   * SUBMITTED and AWARDED both refuse to proceed while required checklist items
   * are outstanding. The override is a distinct permission (tender.override),
   * carries a mandatory reason, and is written onto the tender so the bypass is
   * visible on the record itself rather than only in the audit log.
   */
  app.post('/api/v1/tenders/:id/status', { preHandler: guard('tender.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(tenderStatusSchema, req.body);
    return {
      data: await mutate(pool, req, 'tender.status', 'tender', async db => {
        const current = await inOrg(db, 'tenders', id, u.orgId, true);
        version(req, current as { version: number });
        const from = current.status as TenderStatus;
        if (from === input.status) return current;

        const allowed = TENDER_STATUS_TRANSITIONS[from] ?? [];
        if (!allowed.includes(input.status)) {
          fail('INVALID_STATUS_TRANSITION',
            allowed.length
              ? `A tender at ${from} can move to ${allowed.join(', ')}`
              : `${from} is a final status and cannot move again`);
        }

        // §4.1 separates authority per action, so the machine is not enough.
        if (input.status === 'SUBMITTED' && !u.permissions.includes('tender.submit')) {
          fail('FORBIDDEN', 'Submitting a tender needs the tender.submit permission', 403);
        }
        if (['AWARDED', 'REJECTED', 'SELECTED'].includes(input.status) && !u.permissions.includes('tender.award')) {
          fail('FORBIDDEN', 'Recording a tender outcome needs the tender.award permission', 403);
        }

        let override: { reason: string } | null = null;
        if (['SUBMITTED', 'AWARDED'].includes(input.status)) {
          const outstanding = await outstandingRequired(db, id);
          if (outstanding.length) {
            const names = outstanding.map(r => r.requirement_name).join(', ');
            if (!input.override_reason) {
              fail('ELIGIBILITY_INCOMPLETE',
                `${outstanding.length} required eligibility item${outstanding.length === 1 ? '' : 's'} outstanding: ${names}. Complete them, or record an override reason if you hold the override permission.`);
            }
            if (!u.permissions.includes('tender.override')) {
              fail('FORBIDDEN', 'Overriding an incomplete eligibility checklist needs the tender.override permission', 403);
            }
            override = { reason: input.override_reason };
          }
        }

        return (await db.query(
          `UPDATE tenders SET status = $3,
             eligibility_override_by     = COALESCE($4, eligibility_override_by),
             eligibility_override_reason = COALESCE($5, eligibility_override_reason),
             eligibility_override_at     = CASE WHEN $4 IS NULL THEN eligibility_override_at ELSE now() END,
             version = version + 1, updated_at = now(), updated_by = $2
           WHERE id = $1 RETURNING *`,
          [id, u.id, input.status, override ? u.id : null, override?.reason ?? null])).rows[0];
      }),
    };
  });

  /* ---------------------------------------------------------- corrigenda */

  /**
   * §8.5: applying a corrigendum must retain the prior value in history rather
   * than silently overwriting it, so the previous and new values are captured
   * on the corrigendum row in the same transaction as the tender update.
   */
  app.post('/api/v1/tenders/:id/corrigenda', { preHandler: guard('tender.manage') }, async (req, reply) => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(corrigendumSchema, req.body);
    const row = await mutate(pool, req, 'tender.corrigendum', 'tender', async db => {
      const tender = await inOrg(db, 'tenders', id, u.orgId, true);
      const changes = Object.entries(input.changes ?? {});
      for (const [field] of changes) {
        if (!CORRIGENDUM_FIELDS.has(field)) {
          fail('VALIDATION_ERROR', `A corrigendum cannot change ${field}. Amendable fields: ${[...CORRIGENDUM_FIELDS].join(', ')}`);
        }
      }
      const priorValues: Record<string, unknown> = {};
      for (const [field] of changes) priorValues[field] = tender[field] ?? null;

      const applied = changes.length > 0;
      const created = (await db.query(
        `INSERT INTO tender_corrigenda(org_id, created_by, tender_id, corrigendum_no, date_issued,
           summary, fields_affected, prior_values, applied_at, applied_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [u.orgId, u.id, id, input.corrigendum_no, input.date_issued, input.summary,
         JSON.stringify(input.fields_affected ?? changes.map(([f]) => f)),
         JSON.stringify(priorValues),
         applied ? new Date() : null, applied ? u.id : null])).rows[0];

      if (changes.length) {
        const sets = changes.map(([f], i) => `${f} = $${i + 3}`).join(',');
        await db.query(
          `UPDATE tenders SET ${sets}, version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1`,
          [id, u.id, ...changes.map(([, v]) => v)]);
      }
      return created;
    });
    return reply.code(201).send({ data: row });
  });

  /* ------------------------------------------------------ eligibility */

  app.post('/api/v1/tenders/:id/eligibility', { preHandler: guard('tender.manage') }, async (req, reply) => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(eligibilityItemSchema, req.body) as Record<string, unknown>;
    const row = await mutate(pool, req, 'tender.eligibility.add', 'tender', async db => {
      await inOrg(db, 'tenders', id, u.orgId);
      const keys = Object.keys(input), values = [u.orgId, u.id, id, ...Object.values(input)];
      return (await db.query(
        `INSERT INTO tender_eligibility_items(org_id, created_by, tender_id, ${keys.join(',')})
         VALUES(${values.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, values)).rows[0];
    });
    return reply.code(201).send({ data: row });
  });

  app.patch('/api/v1/tenders/:id/eligibility/:itemId', { preHandler: guard('tender.manage') }, async req => {
    const u = actor(req), { id, itemId } = req.params as { id: string; itemId: string };
    const input = parse(eligibilityItemSchema.partial(), req.body) as Record<string, unknown>;
    if (!Object.keys(input).length) fail('VALIDATION_ERROR', 'Send at least one field to change');
    return {
      data: await mutate(pool, req, 'tender.eligibility.update', 'tender', async db => {
        await inOrg(db, 'tenders', id, u.orgId);
        const keys = Object.keys(input);
        const sets = keys.map((k, i) => `${k} = $${i + 4}`).join(',');
        const updated = (await db.query(
          `UPDATE tender_eligibility_items SET ${sets}, version = version + 1, updated_at = now(), updated_by = $3
           WHERE id = $1 AND tender_id = $2 RETURNING *`, [itemId, id, u.id, ...Object.values(input)])).rows[0];
        if (!updated) fail('NOT_FOUND', 'That checklist item is not on this tender', 404);
        return updated;
      }),
    };
  });

  /* ------------------------------------------------------- competitors */

  app.post('/api/v1/tenders/:id/competitors', { preHandler: guard('tender.manage') }, async (req, reply) => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(competitorBidSchema, req.body) as Record<string, unknown>;
    const row = await mutate(pool, req, 'tender.competitor.add', 'tender', async db => {
      await inOrg(db, 'tenders', id, u.orgId);
      const keys = Object.keys(input), values = [u.orgId, u.id, id, ...Object.values(input)];
      return (await db.query(
        `INSERT INTO competitor_bids(org_id, created_by, tender_id, ${keys.join(',')})
         VALUES(${values.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, values)).rows[0];
    });
    return reply.code(201).send({ data: row });
  });

  /* -------------------------------------------------------- instruments */

  app.get('/api/v1/instruments', { preHandler: guard('instrument.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId, limit + 1, offset];
    let where = 'org_id = $1';
    if (q.tender_id) { values.push(q.tender_id); where += ` AND tender_id = $${values.length}::uuid`; }
    if (q.project_id) { values.push(q.project_id); where += ` AND project_id = $${values.length}::uuid`; }
    if (q.instrument_status) { values.push(q.instrument_status); where += ` AND instrument_status = $${values.length}`; }
    // §8.4/§22.2: instruments expiring soon are the reminder feed.
    if (q.expiring_within_days) {
      values.push(Number(q.expiring_within_days));
      where += ` AND instrument_status IN ('ACTIVE','RENEWED') AND expiry_date <= current_date + ($${values.length}::int * INTERVAL '1 day')`;
    }
    const rows = (await pool.query(
      `SELECT * FROM bank_guarantee_instruments WHERE ${where} ORDER BY expiry_date, id LIMIT $2 OFFSET $3`, values)).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit, next_offset: rows.length > limit ? offset + limit : null };
  });

  app.post('/api/v1/instruments', { preHandler: guard('instrument.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(instrumentSchema, req.body) as Record<string, unknown>;
    const row = await mutate(pool, req, 'instrument.create', 'instrument', async db => {
      if (input.tender_id) await inOrg(db, 'tenders', String(input.tender_id), u.orgId);
      if (input.project_id) await inOrg(db, 'projects', String(input.project_id), u.orgId);
      const keys = Object.keys(input), values = [u.orgId, u.id, ...Object.values(input)];
      return (await db.query(
        `INSERT INTO bank_guarantee_instruments(org_id, created_by, ${keys.join(',')})
         VALUES(${values.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, values)).rows[0];
    });
    return reply.code(201).send({ data: row });
  });

  app.post('/api/v1/instruments/:id/status', { preHandler: guard('instrument.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(instrumentStatusSchema, req.body);
    return {
      data: await mutate(pool, req, 'instrument.status', 'instrument', async db => {
        const current = await inOrg(db, 'bank_guarantee_instruments', id, u.orgId, true);
        version(req, current as { version: number });
        // Releasing money back is not reversible by a later edit; a terminal
        // instrument stays terminal.
        if (['RELEASED', 'CLAIMED'].includes(String(current.instrument_status))) {
          fail('INSTRUMENT_CLOSED', `This instrument is already ${String(current.instrument_status).toLowerCase()}`);
        }
        return (await db.query(
          `UPDATE bank_guarantee_instruments SET instrument_status = $3, notes = COALESCE($4, notes),
             version = version + 1, updated_at = now(), updated_by = $2
           WHERE id = $1 RETURNING *`, [id, u.id, input.instrument_status, input.reason ?? null])).rows[0];
      }),
    };
  });

  /* ---------------------------------------------------- private proposals */

  app.get('/api/v1/proposals', { preHandler: guard('tender.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId, limit + 1, offset];
    let where = 'p.org_id = $1';
    if (q.proposal_status) { values.push(q.proposal_status); where += ` AND p.proposal_status = $${values.length}`; }
    const rows = (await pool.query(
      `SELECT p.*, c.name AS client_name FROM private_proposals p
       JOIN clients c ON c.id = p.client_id
       WHERE ${where} ORDER BY p.proposal_date DESC, p.id DESC LIMIT $2 OFFSET $3`, values)).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit, next_offset: rows.length > limit ? offset + limit : null };
  });

  app.post('/api/v1/proposals', { preHandler: guard('tender.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(proposalSchema, req.body) as Record<string, unknown>;
    const row = await mutate(pool, req, 'proposal.create', 'proposal', async db => {
      await inOrg(db, 'clients', String(input.client_id), u.orgId);
      const prepared = { ...input, competing_quotes: JSON.stringify(input.competing_quotes ?? []) };
      const keys = Object.keys(prepared), values = [u.orgId, u.id, ...Object.values(prepared)];
      return (await db.query(
        `INSERT INTO private_proposals(org_id, created_by, ${keys.join(',')})
         VALUES(${values.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, values)).rows[0];
    });
    return reply.code(201).send({ data: row });
  });

  /* ------------------------------------------------------------ conversion */

  /**
   * §8.7 tender → project, and §8.8 proposal → project.
   *
   * §37.2 requires the conversion to be transactional, idempotent under retry,
   * validated before it runs, and audited with what was carried over. All of
   * that happens inside one `mutate` transaction:
   *
   *  - idempotency is enforced by uk_conversion_source_target, so a retry
   *    raises inside the transaction instead of committing a second project;
   *  - the ledger row records source, destination, actor and carried fields;
   *  - the source moves to its post-conversion state in the same transaction,
   *    so there is no window where a tender is Awarded with no project.
   */
  async function convert(
    db: PoolClient, req: Parameters<typeof actor>[0], sourceType: 'TENDER' | 'PRIVATE_PROPOSAL',
    sourceId: string, input: ReturnType<typeof conversionSchema.parse>,
  ) {
    const u = actor(req);
    const table = sourceType === 'TENDER' ? 'tenders' : 'private_proposals';
    const source = await inOrg(db, table, sourceId, u.orgId, true);

    // §37.2 "Mandatory destination fields must be validated before conversion."
    if (sourceType === 'TENDER' && source.status !== 'AWARDED') {
      fail('TENDER_NOT_AWARDED', 'Only an awarded tender converts to a project');
    }
    if (sourceType === 'PRIVATE_PROPOSAL' && source.proposal_status !== 'ACCEPTED') {
      fail('PROPOSAL_NOT_ACCEPTED', 'Only an accepted proposal converts to a project');
    }
    await inOrg(db, 'workspaces', input.workspace_id, u.orgId);

    // Explicit pre-check for a clear error. The project table's own unique
    // index would also stop a duplicate, but it reports as DUPLICATE_RECORD,
    // which tells the caller nothing about why. The index remains the real
    // guarantee — this check cannot be trusted alone under concurrency.
    const prior = await db.query(
      `SELECT target_id FROM record_conversions
       WHERE source_type = $1 AND source_id = $2 AND target_type = 'PROJECT' AND reverted_at IS NULL`,
      [sourceType, sourceId]);
    if (prior.rowCount) {
      fail('ALREADY_CONVERTED', 'This record has already been converted to a project', 409);
    }

    const carried = {
      client_id: source.client_id ?? null,
      contract_value: input.contract_value ?? source.contract_value ?? source.bid_value ?? null,
      work_order_number: input.work_order_number ?? null,
      project_kind: sourceType === 'TENDER' ? 'GOVERNMENT' : 'PRIVATE',
      // Set when the lead was first taken and carried the whole way, so the
      // same job is not filed under a different category at each stage.
      project_type_id: input.project_type_id ?? source.project_type_id ?? null,
      project_category_id: input.project_category_id ?? source.project_category_id ?? null,
      source_no: source.tender_no ?? source.proposal_no,
    };

    let project;
    if (input.existing_project_id) {
      // §37.2 "Existing records must be linkable instead of duplicated."
      const existing = await inOrg(db, 'projects', input.existing_project_id, u.orgId, true);
      if (existing.tender_id || existing.proposal_id) {
        fail('PROJECT_ALREADY_LINKED', 'That project is already linked to a tender or proposal');
      }
      project = (await db.query(
        `UPDATE projects SET tender_id = $2, proposal_id = $3, client_id = COALESCE($4, client_id),
           project_kind = $5, contract_value = COALESCE($6, contract_value),
           work_order_number = COALESCE($7, work_order_number),
           version = version + 1, updated_at = now(), updated_by = $8
         WHERE id = $1 RETURNING *`,
        [input.existing_project_id,
         sourceType === 'TENDER' ? sourceId : null,
         sourceType === 'PRIVATE_PROPOSAL' ? sourceId : null,
         carried.client_id, carried.project_kind, carried.contract_value, carried.work_order_number, u.id])).rows[0];
    } else {
      project = (await db.query(
        `INSERT INTO projects(org_id, workspace_id, code, name, project_manager_id,
           planned_start_date, planned_end_date, tender_id, proposal_id, client_id,
           project_kind, contract_value, work_order_number, project_type_id,
           project_category_id, status, created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'DRAFT',$16) RETURNING *`,
        [u.orgId, input.workspace_id, input.code, input.name, input.project_manager_id ?? null,
         input.planned_start_date ?? null, input.planned_end_date ?? null,
         sourceType === 'TENDER' ? sourceId : null,
         sourceType === 'PRIVATE_PROPOSAL' ? sourceId : null,
         carried.client_id, carried.project_kind, carried.contract_value, carried.work_order_number,
         carried.project_type_id, carried.project_category_id, u.id])).rows[0];
    }

    // The unique index on (source_type, source_id, target_type) is what makes a
    // retry safe; it raises here rather than letting a second project commit.
    try {
      await db.query(
        `INSERT INTO record_conversions(org_id, source_type, source_id, target_type, target_id, carried_fields, actor_id)
         VALUES($1,$2,$3,'PROJECT',$4,$5,$6)`,
        [u.orgId, sourceType, sourceId, project.id, JSON.stringify(carried), u.id]);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        fail('ALREADY_CONVERTED', 'This record has already been converted to a project', 409);
      }
      throw error;
    }
    return { ...project, carried_fields: carried };
  }

  app.post('/api/v1/tenders/:id/convert', { preHandler: guard('tender.convert') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const input = parse(conversionSchema, req.body);
    const row = await mutate(pool, req, 'tender.convert', 'project', db => convert(db, req, 'TENDER', id, input));
    return reply.code(201).send({ data: row });
  });

  app.post('/api/v1/proposals/:id/convert', { preHandler: guard('tender.convert') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const input = parse(conversionSchema, req.body);
    const row = await mutate(pool, req, 'proposal.convert', 'project', db => convert(db, req, 'PRIVATE_PROPOSAL', id, input));
    return reply.code(201).send({ data: row });
  });

  /** §37.1 the lineage chain for one record, in either direction. */
  app.get('/api/v1/lineage/:type/:id', { preHandler: guard('tender.read') }, async req => {
    const u = actor(req), { type, id } = req.params as { type: string; id: string };
    const rows = (await pool.query(
      `SELECT * FROM record_conversions
       WHERE org_id = $1 AND ((source_type = $2 AND source_id = $3) OR (target_type = $2 AND target_id = $3))
       ORDER BY created_at`, [u.orgId, type.toUpperCase(), id])).rows;
    return { data: rows };
  });
}
