import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  documentCreateSchema, documentPatchSchema, documentRenewSchema, legalHoldSchema,
  documentPurgeSchema,
  DOCUMENT_IMMUTABLE_DATES,
  documentState, renewalQueue, summarise, canDelete, typeAllowsOwner,
  type DocumentOwner,
  businessDay,
  ApiError,
  cursorPageQuerySchema, encodeCursor, decodeCursor,
} from '@silverline/shared';
import { buildAuthenticate, requirePermission } from '../../common/auth.js';
import { orgTodaySql } from '../../common/orgTime.js';
import { actor, parse, page, inOrg, mutate, version, fail } from '../../common/domain.js';

/**
 * Document governance (§46).
 *
 * A register rather than a store. The bytes stay wherever they already live —
 * employee_documents, task_evidence, the tender tables — and this indexes them
 * so that "what expires in the next thirty days" is one query instead of four
 * that nobody writes.
 *
 * Every state is derived on read. A stored status is a status that is wrong at
 * midnight.
 */
export async function registerDocumentRoutes(
  app: FastifyInstance, opts: { pool: Pool; jwtSecret: string },
) {
  const { pool } = opts;
  const auth = buildAuthenticate(opts);
  const guard = (p: string) => requirePermission(auth, p);
  // The calendar day where the work happens, not in UTC. For the first
  // five and a half hours of every Indian day, UTC is still yesterday.
  const today = () => businessDay();
  const iso = (v: unknown) =>
    v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null;

  /**
   * "Today", in this organisation's own configured timezone -- not
   * businessDay()'s hardcoded Asia/Kolkata default (policy batch fix round
   * 1, item 4). Purge is the one place in this file where getting the day
   * wrong crosses the line from cosmetic to destructive: a document
   * treated as due a day early is a document deleted a day early.
   */
  async function orgToday(db: Pool | PoolClient, orgId: string): Promise<string> {
    const r = await db.query(
      `SELECT to_char(${orgTodaySql('$1')}, 'YYYY-MM-DD') AS today`, [orgId]);
    return String(r.rows[0].today);
  }

  /**
   * The register row as the application sees it.
   *
   * Type rules are joined in rather than copied onto the document, because a
   * notice window is a property of the type: changing it should change every
   * document of that type, not only the ones created afterwards.
   */
  const SELECT = `
    SELECT d.*, t.code AS type_code, t.label AS type_label, t.category,
           t.notice_days, t.blocks_operations, t.retention_years,
           t.confidential, t.basis, t.expiry_required,
           s.id AS superseded_by_id, s.title AS superseded_by_title,
           u.username AS created_by_username
    FROM documents d
    JOIN document_types t ON t.id = d.type_id
    LEFT JOIN documents s ON s.supersedes_id = d.id
    LEFT JOIN users u ON u.id = d.created_by`;

  /** Attach the derived state, and withhold what the reader may not see. */
  function present(
    row: Record<string, any>, asOf: string, canSeeConfidential: boolean,
  ): Record<string, any> {
    const doc = {
      expiresOn: iso(row.expires_on),
      supersededById: row.superseded_by_id ? String(row.superseded_by_id) : null,
      noticeDays: Number(row.notice_days),
    };
    const state = documentState(doc, asOf);
    const retention = canDelete({
      issuedOn: iso(row.issued_on),
      expiresOn: iso(row.expires_on),
      retentionYears: Number(row.retention_years),
      legalHold: Boolean(row.legal_hold),
      asOf,
    });
    return {
      ...row,
      issued_on: iso(row.issued_on),
      valid_from: iso(row.valid_from),
      expires_on: iso(row.expires_on),
      state,
      days_remaining: doc.expiresOn
        ? Math.round(
          (Date.parse(`${doc.expiresOn}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000)
        : null,
      retention,
      // A confidential document is still listed, so its expiry can be chased,
      // but its reference number and notes are withheld. Hiding the row
      // outright would leave a lapsed medical certificate silently missing
      // from the renewal queue.
      ...(row.confidential && !canSeeConfidential
        ? { reference_number: null, notes: null, restricted: true }
        : { restricted: false }),
    };
  }

  /**
   * The table each owner type lives in. Interpolated into SQL below, so this
   * map -- not the request -- is the only source of a table name.
   */
  const OWNER_TABLES: Record<Exclude<DocumentOwner, 'organization'>, string> = {
    employee: 'employees', project: 'projects', client: 'clients',
    vendor: 'vendors', asset: 'assets', tender: 'tenders',
  };

  /**
   * The owner a document is attached to must exist, in this organisation.
   *
   * Without the check a document could be filed against an id that was never
   * anything, or against another tenant's employee: it would sit on the
   * register chasing a renewal for nobody, and the owner's own screens, which
   * look documents up by owner, would never show it.
   */
  async function ownerExists(
    db: PoolClient, orgId: string, ownerType: DocumentOwner, ownerId: string | null,
  ): Promise<void> {
    if (ownerType === 'organization') {
      // The organisation is the tenant itself. An id, if one is sent, can only
      // be this organisation's own.
      if (ownerId && ownerId !== orgId) {
        fail('OWNER_NOT_FOUND',
          'An organisation-level document can only belong to this organisation', 422);
      }
      return;
    }
    const table = OWNER_TABLES[ownerType];
    const found = (await db.query(
      `SELECT 1 FROM ${table} WHERE id = $1 AND org_id = $2`, [ownerId, orgId])).rowCount;
    if (!found) {
      fail('OWNER_NOT_FOUND',
        `There is no ${ownerType} with that id. Choose the ${ownerType} from the list and try again.`,
        422);
    }
  }

  /* ----------------------------------------------------------- types */

  app.get('/api/v1/document-types', { preHandler: guard('document.read') }, async req => {
    const u = actor(req);
    const rows = (await pool.query(
      'SELECT * FROM document_types WHERE org_id = $1 AND active ORDER BY category, label',
      [u.orgId])).rows;
    return { data: rows };
  });

  /* -------------------------------------------------------- register */

  /**
   * The register, filtered.
   *
   * `state` is filtered after the derivation rather than in SQL, because the
   * derivation is where the notice window and supersession are applied, and
   * duplicating that logic in a WHERE clause is how the two drift apart.
   */
  app.get('/api/v1/documents', { preHandler: guard('document.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const asOf = String(q.as_of ?? today());
    const canSeeConfidential = u.permissions.includes('document.confidential');

    const values: unknown[] = [u.orgId];
    let where = 'd.org_id = $1';
    if (q.owner_type) { values.push(q.owner_type); where += ` AND d.owner_type = $${values.length}`; }
    if (q.owner_id) { values.push(q.owner_id); where += ` AND d.owner_id = $${values.length}`; }
    if (q.type_code) { values.push(q.type_code); where += ` AND t.code = $${values.length}`; }
    if (q.category) { values.push(q.category); where += ` AND t.category = $${values.length}`; }
    if (q.blocking === 'true') where += ' AND t.blocks_operations';

    const rows = (await pool.query(
      `${SELECT} WHERE ${where} ORDER BY d.expires_on NULLS LAST, d.created_at DESC`, values)).rows;

    const presented = rows.map(r => present(r, asOf, canSeeConfidential));
    const filtered = q.state
      ? presented.filter(d => d.state === String(q.state).toUpperCase())
      : presented;

    return {
      data: filtered.slice(offset, offset + limit),
      has_more: filtered.length > offset + limit,
      total: filtered.length,
      summary: summarise(rows.map(r => ({
        expiresOn: iso(r.expires_on),
        supersededById: r.superseded_by_id ? String(r.superseded_by_id) : null,
        noticeDays: Number(r.notice_days),
        blocksOperations: Boolean(r.blocks_operations),
      })), asOf),
      as_of: asOf,
    };
  });

  /**
   * What needs renewing (§46.3).
   *
   * A separate endpoint because this is the question the register exists for,
   * and the answer wants a different shape: ordered by urgency, with what
   * stops work counted apart rather than mixed in.
   */
  app.get('/api/v1/documents/renewals', { preHandler: guard('document.read') }, async req => {
    const u = actor(req), { q } = page(req);
    const asOf = String(q.as_of ?? today());
    const within = Math.max(1, Math.min(365, Number(q.within_days) || 60));
    const canSeeConfidential = u.permissions.includes('document.confidential');

    const rows = (await pool.query(`${SELECT} WHERE d.org_id = $1`, [u.orgId])).rows;

    const queue = renewalQueue(rows.map(r => ({
      row: r,
      expiresOn: iso(r.expires_on),
      supersededById: r.superseded_by_id ? String(r.superseded_by_id) : null,
      noticeDays: Number(r.notice_days),
      blocksOperations: Boolean(r.blocks_operations),
    })), asOf, within);

    const items: Array<Record<string, any>> = queue.map(i => ({
      ...present(i.row, asOf, canSeeConfidential),
      days_remaining: i.daysRemaining,
    }));

    return {
      data: items,
      as_of: asOf,
      within_days: within,
      // Counted apart because the difference between a stale PAN scan and a
      // lapsed labour licence is the difference between untidy and unlawful.
      blocking: items.filter(i => i.blocks_operations && i.state === 'EXPIRED').length,
      blocking_soon: items.filter(i => i.blocks_operations && i.state === 'EXPIRING').length,
    };
  });

  app.get('/api/v1/documents/:id', { preHandler: guard('document.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    await inOrg(pool, 'documents', id, u.orgId);
    const row = (await pool.query(
      `${SELECT} WHERE d.id = $1 AND d.org_id = $2`, [id, u.orgId])).rows[0];
    if (!row) fail('NOT_FOUND', 'Not found', 404);
    const canSeeConfidential = u.permissions.includes('document.confidential');

    // The revision this one replaced, so the history reads from one screen.
    const previous = row.supersedes_id
      ? (await pool.query(
        `${SELECT} WHERE d.id = $1 AND d.org_id = $2`, [row.supersedes_id, u.orgId])).rows[0]
      : null;

    return {
      data: {
        ...present(row, today(), canSeeConfidential),
        supersedes: previous ? present(previous, today(), canSeeConfidential) : null,
      },
    };
  });

  app.post('/api/v1/documents', { preHandler: guard('document.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(documentCreateSchema, req.body);
    const row = await mutate(pool, req, 'document.create', 'document', async db => {
      const type = (await db.query(
        'SELECT * FROM document_types WHERE org_id = $1 AND code = $2 AND active',
        [u.orgId, input.type_code])).rows[0];
      if (!type) fail('UNKNOWN_TYPE', `There is no document type ${input.type_code}`, 422);

      if (!typeAllowsOwner({ owners: (type.owners ?? []) as DocumentOwner[] }, input.owner_type)) {
        fail('OWNER_NOT_ALLOWED',
          `A ${type.label} cannot be attached to a ${input.owner_type}`, 422);
      }
      // A labour licence with no recorded expiry is worse than no record at
      // all: it reads as compliant.
      if (type.expiry_required && !input.expires_on) {
        fail('EXPIRY_REQUIRED',
          `A ${type.label} must record an expiry date — without one it reads as compliant forever`,
          422);
      }
      if (input.owner_type !== 'organization' && !input.owner_id) {
        fail('OWNER_REQUIRED', `A document attached to a ${input.owner_type} needs its id`, 422);
      }
      await ownerExists(db, u.orgId, input.owner_type, input.owner_id ?? null);

      return (await db.query(
        `INSERT INTO documents(org_id, type_id, owner_type, owner_id, title, reference_number,
           issuing_authority, issued_on, valid_from, expires_on, revision, notes,
           source_type, source_id, created_by, updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) RETURNING *`,
        [u.orgId, type.id, input.owner_type, input.owner_id ?? null, input.title,
          input.reference_number ?? null, input.issuing_authority ?? null,
          input.issued_on ?? null, input.valid_from ?? null, input.expires_on ?? null,
          input.revision ?? null, input.notes ?? null,
          input.source_type ?? null, input.source_id ?? null, u.id])).rows[0];
    });
    reply.code(201);
    return { data: row };
  });

  app.patch('/api/v1/documents/:id', { preHandler: guard('document.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(documentPatchSchema, req.body);
    return {
      data: await mutate(pool, req, 'document.update', 'document', async db => {
        const row = await inOrg(db, 'documents', id, u.orgId, true);
        version(req, row as { version: number });

        // A superseded row is the record of what was in force before. Editing
        // it rewrites exactly the history a renewal exists to keep.
        const successor = (await db.query(
          'SELECT id FROM documents WHERE supersedes_id = $1', [id])).rows[0];
        if (successor) {
          fail('SUPERSEDED',
            'This revision has been replaced and is kept as it was. Amend the current revision instead.',
            409);
        }

        // The dates are fixed once recorded (§46.6.1). Retention is counted
        // from them, so moving an expiry back makes a document deletable today,
        // and clearing it makes a licence read as never expiring. A new date
        // is a new certificate: renew it. The same value is accepted, so a
        // form that sends every field back unchanged still saves.
        for (const key of DOCUMENT_IMMUTABLE_DATES) {
          if (input[key] !== undefined && (input[key] ?? null) !== iso(row[key])) {
            fail('DATES_IMMUTABLE',
              'Issue, start and expiry dates cannot be changed once recorded. '
              + 'To record a new certificate, renew the document; the current one stays on the register.',
              422);
          }
        }

        const sets: string[] = [], values: unknown[] = [id];
        for (const key of ['title', 'reference_number', 'issuing_authority',
          'revision', 'notes'] as const) {
          if (input[key] !== undefined) {
            values.push(input[key]);
            sets.push(`${key} = $${values.length}`);
          }
        }
        if (!sets.length) return row;
        values.push(u.id);
        return (await db.query(
          `UPDATE documents SET ${sets.join(', ')}, version = version + 1,
             updated_at = now(), updated_by = $${values.length}
           WHERE id = $1 RETURNING *`, values)).rows[0];
      }),
    };
  });

  /**
   * Renew: a new row that supersedes the old one (§46.3.4).
   *
   * Not an edit of the expiry date. The previous certificate existed, an
   * inspector may ask for it, and overwriting the date destroys the only
   * record that the organisation was covered last year.
   */
  app.post('/api/v1/documents/:id/renew', { preHandler: guard('document.manage') },
    async (req, reply) => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(documentRenewSchema, req.body);
      const row = await mutate(pool, req, 'document.renew', 'document', async db => {
        // Locked, but no version header is demanded: a renewal never modifies
        // the old row, it only inserts a successor. The lock serialises two
        // concurrent renewals and the unique index on supersedes_id refuses
        // the second outright, so optimistic concurrency here would be
        // friction that guards nothing.
        const old = await inOrg(db, 'documents', id, u.orgId, true);

        const already = (await db.query(
          'SELECT id FROM documents WHERE supersedes_id = $1', [id])).rows[0];
        if (already) {
          fail('ALREADY_RENEWED',
            'This document has already been renewed. Renew the current revision instead.', 409);
        }
        // Required only where the type requires it. A drawing or an agreement
        // is revised without ever expiring; a labour licence renewed without a
        // new expiry would read as compliant forever.
        const type = (await db.query(
          'SELECT label, expiry_required FROM document_types WHERE id = $1', [old.type_id])).rows[0];
        if (type?.expiry_required && !input.expires_on) {
          fail('EXPIRY_REQUIRED',
            `A ${type.label} must record an expiry date — without one it reads as compliant forever`,
            422);
        }
        const validFrom = input.valid_from ?? iso(old.valid_from);
        if (validFrom && input.expires_on && input.expires_on < validFrom) {
          fail('VALIDATION_ERROR', 'A document cannot expire before it takes effect', 422);
        }

        return (await db.query(
          `INSERT INTO documents(org_id, type_id, owner_type, owner_id, title, reference_number,
             issuing_authority, issued_on, valid_from, expires_on, revision, notes,
             source_type, source_id, supersedes_id, created_by, updated_by)
           SELECT org_id, type_id, owner_type, owner_id, title,
                  COALESCE($2, reference_number), issuing_authority,
                  COALESCE($3::date, issued_on), COALESCE($4::date, valid_from),
                  $5::date, COALESCE($6, revision), COALESCE($7, notes),
                  source_type, source_id, id, $8, $8
           FROM documents WHERE id = $1 RETURNING *`,
          [id, input.reference_number ?? null, input.issued_on ?? null,
            input.valid_from ?? null, input.expires_on ?? null, input.revision ?? null,
            input.notes ?? null, u.id])).rows[0];
      });
      reply.code(201);
      return { data: row };
    });

  /**
   * Place or release a legal hold (§46.6.2).
   *
   * A separate permission from deletion on purpose: an auditor places holds
   * and cannot delete, and an administrator who can delete should not be able
   * to quietly lift somebody else's hold without it being audited.
   *
   * Placing and releasing are separate permissions as well. A hold only ever
   * protects a document; releasing it is the step that makes the document
   * deletable again, and who may take that step is its own decision. The
   * body is parsed before a preHandler runs, so the guard can tell which is
   * asked for; anything that is not plainly a release is held to "place".
   */
  const holdGuard = guard('document.legalhold');
  const releaseGuard = guard('document.legalhold.release');
  const isRelease = (body: unknown) =>
    (body as { legal_hold?: unknown } | null)?.legal_hold === false;
  app.post('/api/v1/documents/:id/legal-hold', {
    preHandler: async req => (isRelease(req.body) ? releaseGuard(req) : holdGuard(req)),
  },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(legalHoldSchema, req.body);
      const action = input.legal_hold ? 'document.legalhold' : 'document.legalhold.release';
      return {
        data: await mutate(pool, req, action, 'document', async db => {
          const row = await inOrg(db, 'documents', id, u.orgId, true);
          version(req, row as { version: number });
          return (await db.query(
            `UPDATE documents SET legal_hold = $2, legal_hold_reason = $3,
               version = version + 1, updated_at = now(), updated_by = $4
             WHERE id = $1 RETURNING *`,
            [id, input.legal_hold, input.legal_hold ? input.reason : null, u.id])).rows[0];
        }),
      };
    });

  /**
   * Delete, if retention allows (§46.6.1).
   *
   * The refusal carries the date rather than a bare "no", because the next
   * question is always when.
   */
  app.delete('/api/v1/documents/:id', { preHandler: guard('document.delete') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    return {
      data: await mutate(pool, req, 'document.delete', 'document', async db => {
        const row = (await db.query(
          `SELECT d.*, t.retention_years FROM documents d
           JOIN document_types t ON t.id = d.type_id
           WHERE d.id = $1 AND d.org_id = $2 FOR UPDATE OF d`, [id, u.orgId])).rows[0];
        if (!row) fail('NOT_FOUND', 'Not found', 404);
        version(req, row as { version: number });

        const check = canDelete({
          issuedOn: iso(row.issued_on),
          expiresOn: iso(row.expires_on),
          retentionYears: Number(row.retention_years),
          legalHold: Boolean(row.legal_hold),
          asOf: today(),
        });
        if (!check.deletable) fail('RETENTION_BLOCKED', check.reason ?? 'Cannot be deleted', 409);

        // A superseded row still has a successor pointing at it; breaking that
        // link would leave the successor claiming to replace nothing.
        const successor = (await db.query(
          'SELECT id FROM documents WHERE supersedes_id = $1', [id])).rows[0];
        if (successor) {
          fail('HAS_SUCCESSOR',
            'A later revision refers to this one. Delete the later revision first.', 409);
        }

        await db.query('DELETE FROM documents WHERE id = $1', [id]);
        return { id, deleted: true };
      }),
    };
  });

  /**
   * Due for purge (owner decision 2026-09-24 #3): past retention, not under
   * legal hold, and not superseded by a later revision (that refusal
   * belongs to the later revision, which still needs this one kept).
   *
   * No scheduled deletion exists anywhere in this codebase, and this route
   * does not add one -- it only answers the question an admin has to see
   * answered before purging anything. Nothing here deletes a row; only
   * POST /documents/purge does that, and only once an admin has picked from
   * this list and confirmed.
   */
  app.get('/api/v1/documents/due-for-purge', { preHandler: guard('document.delete') }, async req => {
    const u = actor(req);
    const { limit, cursor } = parse(cursorPageQuerySchema, req.query);
    const asOf = await orgToday(pool, u.orgId);
    const rows = (await pool.query(`${SELECT} WHERE d.org_id = $1`, [u.orgId])).rows;
    const due = rows
      .map(r => ({
        row: r,
        retention: canDelete({
          issuedOn: iso(r.issued_on), expiresOn: iso(r.expires_on),
          retentionYears: Number(r.retention_years), legalHold: Boolean(r.legal_hold),
          asOf,
        }),
        hasSuccessor: Boolean(r.superseded_by_id),
      }))
      .filter(d => d.retention.deletable && !d.hasSuccessor)
      .map(d => ({
        id: String(d.row.id),
        title: d.row.title,
        type_code: d.row.type_code,
        type_label: d.row.type_label,
        category: d.row.category,
        owner_type: d.row.owner_type,
        owner_id: d.row.owner_id,
        legal_hold: false,
        issued_on: iso(d.row.issued_on),
        expires_on: iso(d.row.expires_on),
        retain_until: d.retention.retainUntil ?? null,
      }))
      .sort((a, b) => {
        const byDate = String(a.retain_until).localeCompare(String(b.retain_until));
        return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
      });

    // Cursor pagination (fix round 1, item 4): an org whose statutory
    // documents span years of retained licences could hand back thousands
    // of rows in one response otherwise. Cursor, not offset, so a purge
    // between page loads cannot shift the page boundary under the reader.
    let page = due;
    if (cursor) {
      const decoded = decodeCursor<{ retain_until: string; id: string }>(cursor);
      if (decoded) {
        page = due.filter(d => {
          const cmp = String(d.retain_until).localeCompare(decoded.retain_until);
          return cmp > 0 || (cmp === 0 && d.id > decoded.id);
        });
      }
    }
    const hasMore = page.length > limit;
    const items = page.slice(0, limit);
    const last = items[items.length - 1];
    return {
      data: items,
      as_of: asOf,
      total: due.length,
      has_more: hasMore,
      next_cursor: hasMore && last
        ? encodeCursor({ retain_until: String(last.retain_until), id: last.id })
        : null,
    };
  });

  /**
   * Purge, explicitly (owner decision 2026-09-24 #3).
   *
   * The confirm is the request itself: an admin selects rows off the
   * due-for-purge report above and sends this with a reason, which is
   * required and is what makes the batch's audit row explain itself later.
   * Refuses the whole selection -- nothing is deleted -- the moment any one
   * of the chosen documents is on legal hold, not yet past retention, or
   * superseded, so a mixed selection cannot half-succeed and leave the
   * admin unsure what was actually destroyed.
   */
  app.post('/api/v1/documents/purge', { preHandler: guard('document.delete') }, async req => {
    const u = actor(req), input = parse(documentPurgeSchema, req.body);
    const result = await mutate(pool, req, 'document.purge', 'document_purge', async db => {
      const ids = [...new Set(input.ids)];
      const rows = (await db.query(
        `SELECT d.id, d.title, d.legal_hold, d.issued_on, d.expires_on,
                d.owner_type, d.owner_id, d.source_type, d.source_id,
                t.retention_years, t.code AS type_code, t.basis,
                (SELECT id FROM documents s WHERE s.supersedes_id = d.id) AS successor_id
           FROM documents d JOIN document_types t ON t.id = d.type_id
          WHERE d.id = ANY($1::uuid[]) AND d.org_id = $2 FOR UPDATE OF d`,
        [ids, u.orgId])).rows;

      const asOf = await orgToday(db, u.orgId);
      const foundIds = new Set(rows.map(r => String(r.id)));
      /*
       * An id this org's register does not currently hold -- already
       * purged, never existed, or (indistinguishably, on purpose) another
       * organisation's -- is a clean no-op, not a reason to refuse ids in
       * the same request that DO qualify (fix round 1, item 4): retrying a
       * purge that partly landed, or a stale selection with one row someone
       * else already purged, should not have to be refused and reattempted
       * by hand. It is still reported, with a reason, never silently.
       */
      const skipped: Array<{ id: string; reason: string }> = ids
        .filter(id => !foundIds.has(id))
        .map(id => ({ id, reason: 'Not found -- already purged, or never on this register' }));

      // Legal hold, not-yet-due and superseded stay all-or-nothing: those
      // are live business refusals the admin needs to see and act on, not
      // ids that can be quietly dropped from the batch.
      const refused: Array<{ field: string; message: string }> = [];
      for (const row of rows) {
        if (row.successor_id) {
          refused.push({
            field: String(row.id),
            message: 'A later revision refers to this one. Purge the later revision first.',
          });
          continue;
        }
        const check = canDelete({
          issuedOn: iso(row.issued_on), expiresOn: iso(row.expires_on),
          retentionYears: Number(row.retention_years), legalHold: Boolean(row.legal_hold),
          asOf,
        });
        if (!check.deletable) {
          refused.push({ field: String(row.id), message: check.reason ?? 'Not yet due for purge' });
          continue;
        }
        // Carried straight into the audit row below (§46.6.3, controller
        // ruling: purge removes only the register row -- never the source
        // content -- so the audit trail is what has to let anyone later
        // reconstruct exactly what was removed and where its content lived).
        row.retain_until = check.retainUntil ?? null;
      }
      if (refused.length > 0) {
        throw new ApiError({
          status: 409,
          code: 'PURGE_REFUSED',
          message: `${refused.length} of ${ids.length} selected document(s) cannot be purged`,
          fieldErrors: refused,
        });
      }

      const purged = rows.map(r => ({
        id: String(r.id),
        title: r.title,
        type_code: r.type_code,
        owner_type: r.owner_type,
        owner_id: r.owner_id ? String(r.owner_id) : null,
        source_type: r.source_type ?? null,
        source_id: r.source_id ? String(r.source_id) : null,
        issued_on: iso(r.issued_on),
        expires_on: iso(r.expires_on),
        basis: r.basis ?? null,
        retain_until: r.retain_until ?? null,
      }));
      if (purged.length > 0) {
        await db.query('DELETE FROM documents WHERE id = ANY($1::uuid[])', [rows.map(r => r.id)]);
      }
      return {
        purged, skipped, reason: input.reason, purged_by: u.id,
        purged_count: purged.length, skipped_count: skipped.length,
      };
    });
    return { data: result };
  });
}
