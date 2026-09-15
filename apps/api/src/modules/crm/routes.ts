import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  clientBaseSchema,
  clientSchema, contactSchema, contactBaseSchema, leadSchema, leadStageSchema,
  opportunitySchema, interactionSchema, gstRegistrationSchema,
  LEAD_STAGE_TRANSITIONS, type LeadStage, parseGstin,
} from '@silverline/shared';
import { buildAuthenticate, requirePermission } from '../../common/auth.js';
import { actor, parse, page, inOrg, mutate, version, fail } from '../../common/domain.js';

/**
 * CRM: client/contact master, leads, opportunities and the activity timeline
 * (§6.3, §6.5, §7).
 *
 * Scoping note: leads and clients are org-scoped here. scopedReads() builds its
 * CTEs over employees/tasks/projects and knows nothing about these tables, so
 * routing them through it would silently return everything. §4.1 lists a client
 * scope type; wiring it belongs with the scope engine rather than being faked
 * per-module, so until then `owner_id` filtering is offered explicitly and the
 * org boundary is the enforced one.
 */
export async function registerCrmRoutes(app: FastifyInstance, opts: { pool: Pool; jwtSecret: string }) {
  const { pool } = opts;
  const auth = buildAuthenticate(opts);
  const guard = (p: string) => requirePermission(auth, p);

  /**
   * §7.1 / §51.3 duplicate detection against the client master.
   *
   * Advisory, not blocking: the tax identifiers already carry unique indexes,
   * so a true duplicate is rejected by the database. This catches the softer
   * case — same organisation entered under a slightly different spelling — and
   * returns it as a warning the caller can show, because auto-merging parties
   * on a name match would be worse than a duplicate.
   */
  async function duplicateWarnings(db: Pool | PoolClient, orgId: string, input: Record<string, unknown>, excludeId?: string) {
    const clauses: string[] = [], values: unknown[] = [orgId];
    if (input.name) { values.push(String(input.name).trim().toLowerCase()); clauses.push(`lower(c.name) = $${values.length}`); }
    if (input.pan) { values.push(input.pan); clauses.push(`c.pan = $${values.length}`); }
    // GSTIN now lives one row per state in party_gst_registrations, so the
    // match is a subquery rather than a column comparison.
    if (input.gstin) {
      values.push(input.gstin);
      clauses.push(`EXISTS (SELECT 1 FROM party_gst_registrations r
         WHERE r.party_type = 'CLIENT' AND r.party_id = c.id AND r.gstin = $${values.length})`);
    }
    if (!clauses.length) return [];
    let sql = `SELECT c.id, c.code, c.name, c.pan FROM clients c WHERE c.org_id = $1 AND (${clauses.join(' OR ')})`;
    if (excludeId) { values.push(excludeId); sql += ` AND c.id <> $${values.length}`; }
    return (await db.query(`${sql} LIMIT 5`, values)).rows;
  }

  /* -------------------------------------------------------------- clients */

  app.get('/api/v1/clients', { preHandler: guard('client.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId, limit + 1, offset];
    let where = 'org_id = $1';
    if (q.search) { values.push(`%${q.search}%`); where += ` AND (name ILIKE $${values.length} OR code ILIKE $${values.length})`; }
    if (q.client_type) { values.push(q.client_type); where += ` AND client_type = $${values.length}`; }
    if (q.status) { values.push(q.status); where += ` AND status = $${values.length}`; }
    const rows = (await pool.query(
      `SELECT * FROM clients WHERE ${where} ORDER BY name, id LIMIT $2 OFFSET $3`, values)).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit, next_offset: rows.length > limit ? offset + limit : null };
  });

  app.get('/api/v1/clients/:id', { preHandler: guard('client.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const client = await inOrg(pool, 'clients', id, u.orgId);
    const contacts = (await pool.query(
      'SELECT * FROM contacts WHERE client_id = $1 AND status = $2 ORDER BY contact_type, name', [id, 'ACTIVE'])).rows;
    return { data: { ...client, contacts } };
  });

  app.post('/api/v1/clients', { preHandler: guard('client.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(clientSchema, req.body) as Record<string, unknown>;
    const row = await mutate(pool, req, 'client.create', 'client', async db => {
      const warnings = await duplicateWarnings(db, u.orgId, input);
      // `gstin` is accepted on the request for convenience but is not a column
      // on `clients` any more — it becomes the primary registration below.
      const { gstin, ...columns } = input;
      const keys = Object.keys(columns), values = [u.orgId, u.id, ...Object.values(columns)];
      const created = (await db.query(
        `INSERT INTO clients(org_id, created_by, ${keys.join(',')})
         VALUES(${values.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, values)).rows[0];
      // A party holds one GSTIN per state (§6.5). The one given at creation
      // becomes the primary registration; further states are added through the
      // registrations endpoint rather than by overwriting a column.
      if (gstin) {
        const parsed = parseGstin(String(gstin));
        // The schema already validated it, so a parse failure here is a bug
        // rather than bad input — fail loudly instead of dropping it.
        if (!parsed) fail('VALIDATION_ERROR', 'That GSTIN could not be parsed');
        try {
          await db.query(
            `INSERT INTO party_gst_registrations(org_id, created_by, party_type, party_id, gstin, state_code, is_primary)
             VALUES($1,$2,'CLIENT',$3,$4,$5,TRUE)`,
            [u.orgId, u.id, created.id, String(gstin).toUpperCase(), parsed!.stateCode]);
        } catch (error) {
          // Deliberately not ON CONFLICT DO NOTHING: swallowing this would
          // commit a client whose GSTIN silently went nowhere, which looks
          // like success and loses the tax identifier.
          if ((error as { code?: string }).code === '23505') {
            fail('GSTIN_ALREADY_REGISTERED',
              'That GSTIN is already recorded against another party. A GSTIN identifies one registration nationally.', 409);
          }
          throw error;
        }
      }
      return { ...created, duplicate_warnings: warnings };
    });
    return reply.code(201).send({ data: row });
  });

  app.patch('/api/v1/clients/:id', { preHandler: guard('client.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const parsed = parse(clientBaseSchema.partial(), req.body) as Record<string, unknown>;
    if ('gstin' in parsed) {
      fail('VALIDATION_ERROR',
        'A client holds one GSTIN per state. Manage them through /parties/client/:id/gst-registrations.');
    }
    const input = parsed;
    if (!Object.keys(input).length) fail('VALIDATION_ERROR', 'Send at least one field to change');
    return {
      data: await mutate(pool, req, 'client.update', 'client', async db => {
        const current = await inOrg(db, 'clients', id, u.orgId, true);
        version(req, current as { version: number });
        const keys = Object.keys(input);
        const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(',');
        return (await db.query(
          `UPDATE clients SET ${sets}, version = version + 1, updated_at = now(), updated_by = $2
           WHERE id = $1 RETURNING *`, [id, u.id, ...Object.values(input)])).rows[0];
      }),
    };
  });

  /* --------------------------------------------------- GST registrations */

  app.get('/api/v1/parties/:type/:id/gst-registrations', { preHandler: guard('client.read') }, async req => {
    const u = actor(req), { type, id } = req.params as { type: string; id: string };
    const partyType = type.toUpperCase();
    if (!['CLIENT', 'VENDOR'].includes(partyType)) fail('VALIDATION_ERROR', 'Party type must be client or vendor');
    await inOrg(pool, partyType === 'CLIENT' ? 'clients' : 'vendors', id, u.orgId);
    const rows = (await pool.query(
      `SELECT * FROM party_gst_registrations
       WHERE org_id = $1 AND party_type = $2 AND party_id = $3
       ORDER BY is_primary DESC, state_code`, [u.orgId, partyType, id])).rows;
    return { data: rows };
  });

  app.post('/api/v1/parties/:type/:id/gst-registrations', { preHandler: guard('client.manage') }, async (req, reply) => {
    const u = actor(req), { type, id } = req.params as { type: string; id: string };
    const partyType = type.toUpperCase();
    const input = parse(gstRegistrationSchema.omit({ party_type: true, party_id: true }), req.body);
    const parsed = parseGstin(input.gstin);
    if (!parsed) fail('VALIDATION_ERROR', 'That GSTIN fails its check digit or names an unknown state');
    const row = await mutate(pool, req, 'party.gst_registration', 'client', async db => {
      if (!['CLIENT', 'VENDOR'].includes(partyType)) fail('VALIDATION_ERROR', 'Party type must be client or vendor');
      const party = await inOrg(db, partyType === 'CLIENT' ? 'clients' : 'vendors', id, u.orgId, true);
      // The GSTIN embeds its holder's PAN; a mismatch means one of the two
      // records is wrong, and silently accepting it corrupts the tax identity.
      if (party.pan && parsed!.pan !== String(party.pan).toUpperCase()) {
        fail('GSTIN_PAN_MISMATCH',
          `This GSTIN belongs to PAN ${parsed!.pan}, but the party is recorded under ${String(party.pan).toUpperCase()}`);
      }
      try {
        return (await db.query(
          `INSERT INTO party_gst_registrations(org_id, created_by, party_type, party_id, gstin,
             state_code, registration_type, address_line, is_primary, effective_from)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [u.orgId, u.id, partyType, id, input.gstin, parsed!.stateCode,
           input.registration_type, input.address_line ?? null, input.is_primary, input.effective_from ?? null])).rows[0];
      } catch (error) {
        // Two different unique indexes can fire here and they mean opposite
        // things. Reporting the per-party message for a national collision
        // sends the operator to look at the wrong record entirely.
        const violation = error as { code?: string; constraint?: string };
        if (violation.code === '23505') {
          if (violation.constraint === 'uk_pgr_gstin') {
            fail('GSTIN_ALREADY_REGISTERED',
              'That GSTIN is already recorded against another party. A GSTIN identifies one registration nationally, so check whether the two records are the same business.', 409);
          }
          fail('DUPLICATE_REGISTRATION',
            `This party already holds a live registration in ${parsed!.stateName}`, 409);
        }
        throw error;
      }
    });
    return reply.code(201).send({ data: row });
  });

  /* ------------------------------------------------------------- contacts */

  app.get('/api/v1/contacts', { preHandler: guard('client.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId, limit + 1, offset];
    let where = 'org_id = $1';
    if (q.client_id) { values.push(q.client_id); where += ` AND client_id = $${values.length}::uuid`; }
    if (q.search) { values.push(`%${q.search}%`); where += ` AND name ILIKE $${values.length}`; }
    const rows = (await pool.query(
      `SELECT * FROM contacts WHERE ${where} ORDER BY name, id LIMIT $2 OFFSET $3`, values)).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit, next_offset: rows.length > limit ? offset + limit : null };
  });

  app.post('/api/v1/contacts', { preHandler: guard('client.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(contactSchema, req.body) as Record<string, unknown>;
    const row = await mutate(pool, req, 'contact.create', 'contact', async db => {
      if (input.client_id) await inOrg(db, 'clients', String(input.client_id), u.orgId);
      const keys = Object.keys(input), values = [u.orgId, u.id, ...Object.values(input)];
      return (await db.query(
        `INSERT INTO contacts(org_id, created_by, ${keys.join(',')})
         VALUES(${values.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, values)).rows[0];
    });
    return reply.code(201).send({ data: row });
  });

  app.patch('/api/v1/contacts/:id', { preHandler: guard('client.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(contactBaseSchema.partial(), req.body) as Record<string, unknown>;
    if (!Object.keys(input).length) fail('VALIDATION_ERROR', 'Send at least one field to change');
    return {
      data: await mutate(pool, req, 'contact.update', 'contact', async db => {
        const current = await inOrg(db, 'contacts', id, u.orgId, true);
        version(req, current as { version: number });
        const keys = Object.keys(input);
        const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(',');
        return (await db.query(
          `UPDATE contacts SET ${sets}, version = version + 1, updated_at = now(), updated_by = $2
           WHERE id = $1 RETURNING *`, [id, u.id, ...Object.values(input)])).rows[0];
      }),
    };
  });

  /* ---------------------------------------------------------------- leads */

  app.get('/api/v1/leads', { preHandler: guard('lead.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId, limit + 1, offset];
    let where = 'l.org_id = $1';
    if (q.stage) { values.push(q.stage); where += ` AND l.stage = $${values.length}`; }
    if (q.owner_id) { values.push(q.owner_id); where += ` AND l.owner_id = $${values.length}::uuid`; }
    if (q.lead_type) { values.push(q.lead_type); where += ` AND l.lead_type = $${values.length}`; }
    if (q.search) { values.push(`%${q.search}%`); where += ` AND (l.organization_name ILIKE $${values.length} OR l.lead_no ILIKE $${values.length})`; }
    const rows = (await pool.query(
      `SELECT l.*, c.name AS client_name, u.username AS owner_username
       FROM leads l
       LEFT JOIN clients c ON c.id = l.client_id
       LEFT JOIN users u ON u.id = l.owner_id
       WHERE ${where} ORDER BY l.created_at DESC, l.id DESC LIMIT $2 OFFSET $3`, values)).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit, next_offset: rows.length > limit ? offset + limit : null };
  });

  /** §7.5 pipeline value by stage — the board and the report share this shape. */
  app.get('/api/v1/leads/pipeline', { preHandler: guard('lead.read') }, async req => {
    const u = actor(req);
    const rows = (await pool.query(
      `SELECT stage, count(*)::int AS count, COALESCE(sum(estimated_value), 0)::text AS value
       FROM leads WHERE org_id = $1 GROUP BY stage`, [u.orgId])).rows;
    return { data: rows };
  });

  app.get('/api/v1/leads/:id', { preHandler: guard('lead.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const lead = await inOrg(pool, 'leads', id, u.orgId);
    const [opportunities, timeline] = await Promise.all([
      pool.query('SELECT * FROM opportunities WHERE lead_id = $1 ORDER BY created_at DESC', [id]),
      // §7.4 one chronological timeline.
      pool.query(
        `SELECT i.*, u.username AS logged_by_username
         FROM interactions i LEFT JOIN users u ON u.id = i.logged_by
         WHERE i.lead_id = $1 ORDER BY i.occurred_at DESC LIMIT 200`, [id]),
    ]);
    return {
      data: {
        ...lead,
        opportunities: opportunities.rows,
        timeline: timeline.rows,
        // What the stage machine will accept next, so the UI never offers a
        // transition the server is going to refuse.
        allowed_stages: LEAD_STAGE_TRANSITIONS[lead.stage as LeadStage] ?? [],
      },
    };
  });

  app.post('/api/v1/leads', { preHandler: guard('lead.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(leadSchema, req.body) as Record<string, unknown>;
    const row = await mutate(pool, req, 'lead.create', 'lead', async db => {
      if (input.client_id) await inOrg(db, 'clients', String(input.client_id), u.orgId);
      const keys = Object.keys(input), values = [u.orgId, u.id, ...Object.values(input)];
      const created = (await db.query(
        `INSERT INTO leads(org_id, created_by, ${keys.join(',')})
         VALUES(${values.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, values)).rows[0];
      // §7.1 duplicate-detection runs on creation and is surfaced, not enforced.
      const warnings = await duplicateWarnings(db, u.orgId, { name: input.organization_name });
      return { ...created, duplicate_warnings: warnings };
    });
    return reply.code(201).send({ data: row });
  });

  app.patch('/api/v1/leads/:id', { preHandler: guard('lead.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(leadSchema.partial(), req.body) as Record<string, unknown>;
    if (!Object.keys(input).length) fail('VALIDATION_ERROR', 'Send at least one field to change');
    return {
      data: await mutate(pool, req, 'lead.update', 'lead', async db => {
        const current = await inOrg(db, 'leads', id, u.orgId, true);
        version(req, current as { version: number });
        if (current.status === 'CLOSED') fail('LEAD_CLOSED', 'This lead is closed and can no longer be edited');
        const keys = Object.keys(input);
        const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(',');
        return (await db.query(
          `UPDATE leads SET ${sets}, version = version + 1, updated_at = now(), updated_by = $2
           WHERE id = $1 RETURNING *`, [id, u.id, ...Object.values(input)])).rows[0];
      }),
    };
  });

  /**
   * §7.2 stage transition. Separate from PATCH because a stage move is a
   * business event with its own rules and audit action, not a field edit.
   */
  app.post('/api/v1/leads/:id/stage', { preHandler: guard('lead.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(leadStageSchema, req.body);
    return {
      data: await mutate(pool, req, 'lead.stage', 'lead', async db => {
        const current = await inOrg(db, 'leads', id, u.orgId, true);
        version(req, current as { version: number });
        const from = current.stage as LeadStage;
        if (from === input.stage) return current;
        // CONVERTED is reachable only through the conversion endpoint, so that a
        // lead can never be marked converted with no destination and no lineage.
        if (input.stage === 'CONVERTED') {
          fail('INVALID_STAGE_TRANSITION', 'Converting a lead happens through the conversion endpoint so the destination record and its lineage are created together');
        }
        const allowed = LEAD_STAGE_TRANSITIONS[from] ?? [];
        if (!allowed.includes(input.stage)) {
          fail('INVALID_STAGE_TRANSITION',
            allowed.length
              ? `A lead at ${from} can move to ${allowed.join(', ')}`
              : `${from} is a final stage and cannot move again`);
        }
        const terminal = ['LOST', 'DISQUALIFIED'].includes(input.stage);
        return (await db.query(
          `UPDATE leads SET stage = $3, lost_reason = $4, status = $5,
             version = version + 1, updated_at = now(), updated_by = $2
           WHERE id = $1 RETURNING *`,
          [id, u.id, input.stage, input.lost_reason ?? null, terminal ? 'CLOSED' : 'OPEN'])).rows[0];
      }),
    };
  });

  /* -------------------------------------------------------- opportunities */

  app.post('/api/v1/opportunities', { preHandler: guard('lead.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(opportunitySchema, req.body);
    const row = await mutate(pool, req, 'opportunity.create', 'opportunity', async db => {
      const lead = await inOrg(db, 'leads', input.lead_id, u.orgId, true);
      // §7.3: a lead is promoted once value and close date exist, and only from
      // a qualified position — promoting an unqualified lead would put pipeline
      // value behind a record nobody has validated.
      if (!['QUALIFIED', 'TENDER_IDENTIFIED'].includes(String(lead.stage))) {
        fail('LEAD_NOT_QUALIFIED', 'Qualify the lead before promoting it to an opportunity');
      }
      const created = (await db.query(
        `INSERT INTO opportunities(org_id, created_by, lead_id, probability_pct, expected_value, expected_close_date)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [u.orgId, u.id, input.lead_id, input.probability_pct ?? null, input.expected_value, input.expected_close_date])).rows[0];
      await db.query(
        `INSERT INTO record_conversions(org_id, source_type, source_id, target_type, target_id, carried_fields, actor_id)
         VALUES($1,'LEAD',$2,'OPPORTUNITY',$3,$4,$5)`,
        [u.orgId, input.lead_id, created.id,
         JSON.stringify({ expected_value: input.expected_value, expected_close_date: input.expected_close_date }), u.id]);
      return created;
    });
    return reply.code(201).send({ data: row });
  });

  app.get('/api/v1/opportunities', { preHandler: guard('lead.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId, limit + 1, offset];
    let where = 'o.org_id = $1';
    if (q.status) { values.push(q.status); where += ` AND o.status = $${values.length}`; }
    const rows = (await pool.query(
      `SELECT o.*, l.lead_no, l.organization_name, l.lead_type
       FROM opportunities o JOIN leads l ON l.id = o.lead_id
       WHERE ${where} ORDER BY o.expected_close_date, o.id LIMIT $2 OFFSET $3`, values)).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit, next_offset: rows.length > limit ? offset + limit : null };
  });

  /* --------------------------------------------------------- interactions */

  app.post('/api/v1/interactions', { preHandler: guard('lead.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(interactionSchema, req.body) as Record<string, unknown>;
    const row = await mutate(pool, req, 'interaction.log', 'interaction', async db => {
      for (const [key, table] of [['lead_id', 'leads'], ['opportunity_id', 'opportunities'], ['client_id', 'clients'], ['contact_id', 'contacts']] as const) {
        if (input[key]) await inOrg(db, table, String(input[key]), u.orgId);
      }
      const keys = Object.keys(input), values = [u.orgId, u.id, u.id, ...Object.values(input)];
      return (await db.query(
        `INSERT INTO interactions(org_id, created_by, logged_by, ${keys.join(',')})
         VALUES(${values.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, values)).rows[0];
    });
    return reply.code(201).send({ data: row });
  });

  app.get('/api/v1/interactions', { preHandler: guard('lead.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId, limit + 1, offset];
    let where = 'i.org_id = $1';
    for (const key of ['lead_id', 'opportunity_id', 'client_id'] as const) {
      if (q[key]) { values.push(q[key]); where += ` AND i.${key} = $${values.length}::uuid`; }
    }
    const rows = (await pool.query(
      `SELECT i.*, u.username AS logged_by_username
       FROM interactions i LEFT JOIN users u ON u.id = i.logged_by
       WHERE ${where} ORDER BY i.occurred_at DESC, i.id DESC LIMIT $2 OFFSET $3`, values)).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit, next_offset: rows.length > limit ? offset + limit : null };
  });
}
