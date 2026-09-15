import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  surveyProjectSchema, surveyVillageSchema, surveyEntrySchema, surveyEntryPatchSchema,
  measureSchema, targetSchema, stageUpdateSchema,
  rollUp, villageState, completion, acresToSqKm, periodBuckets, financialYearRange,
  STAGE_CODES, REPORT_LEVELS,
  type MeasureBasis, type PeriodGrain, type ReportLevel, type StageState, type VillageProgress,
} from '@silverline/shared';
import { buildAuthenticate, requirePermission } from '../../common/auth.js';
import { actor, parse, page, inOrg, mutate, version, fail } from '../../common/domain.js';

/**
 * Land survey progress (§59).
 *
 * Replaces the workbook a DGPS cadastral resurvey is run from. The two things
 * it does that the workbook cannot: it derives every cumulative figure rather
 * than accepting a typed one, and it rolls percentages up weighted by extent
 * rather than averaging them.
 */
export async function registerSurveyRoutes(
  app: FastifyInstance, opts: { pool: Pool; jwtSecret: string },
) {
  const { pool } = opts;
  const auth = buildAuthenticate(opts);
  const guard = (p: string) => requirePermission(auth, p);
  const today = () => new Date().toISOString().slice(0, 10);
  const iso = (v: unknown) =>
    v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null;
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

  /** The organisation's measures, by id and by code. */
  async function measures(db: Pool | PoolClient, orgId: string) {
    const rows = (await db.query(
      `SELECT * FROM survey_measures WHERE org_id = $1 AND active
       ORDER BY display_order, label`, [orgId])).rows;
    return {
      rows,
      byCode: new Map(rows.map(r => [String(r.code), r])),
      byId: new Map(rows.map(r => [String(r.id), r])),
      codes: rows.map(r => String(r.code)),
      basis: Object.fromEntries(
        rows.map(r => [String(r.code), String(r.basis) as MeasureBasis])),
    };
  }

  async function stageCodes(db: Pool | PoolClient, orgId: string): Promise<string[]> {
    const rows = (await db.query(
      'SELECT code FROM survey_stages WHERE org_id = $1 AND active ORDER BY display_order',
      [orgId])).rows;
    return rows.length ? rows.map(r => String(r.code)) : [...STAGE_CODES];
  }

  /**
   * Every village in a programme with its position as at a date.
   *
   * The cumulative quantities are summed here from the daily entries. There
   * is no stored running total to disagree with them, and a backdated entry
   * therefore corrects every figure above it without anything being
   * recomputed.
   */
  async function positions(
    db: Pool | PoolClient, orgId: string, projectId: string,
    opts: { asOf?: string; from?: string } = {},
  ): Promise<Array<VillageProgress & { row: Record<string, any> }>> {
    const asOf = opts.asOf ?? today();
    const values: unknown[] = [orgId, projectId, asOf];
    // `from` bounds what was done *in* a period. Cumulative and percentage
    // complete always run from the beginning, because "40% done" is a
    // statement about the programme rather than about the week.
    let periodClause = '';
    if (opts.from) { values.push(opts.from); periodClause = `AND e.entry_date >= $${values.length}`; }

    const rows = (await db.query(
      `SELECT sv.*,
              v.name AS village_name, v.code AS village_code, v.source_code AS village_source_code,
              m.id AS mandal_id, m.name AS mandal_name, m.code AS mandal_code,
              p.id AS parent_id, p.type AS parent_type, p.name AS parent_name,
              gp.id AS grandparent_id, gp.type AS grandparent_type, gp.name AS grandparent_name
       FROM survey_villages sv
       JOIN org_units v ON v.id = sv.village_id
       LEFT JOIN org_units m ON m.id = v.parent_id
       LEFT JOIN org_units p ON p.id = m.parent_id
       LEFT JOIN org_units gp ON gp.id = p.parent_id
       WHERE sv.org_id = $1 AND sv.survey_project_id = $2
       ORDER BY m.name, v.name`, [orgId, projectId])).rows;

    const cumulative = (await db.query(
      `SELECT e.survey_village_id, mm.code AS measure_code, sum(ev.quantity) AS total
       FROM survey_entries e
       JOIN survey_entry_values ev ON ev.entry_id = e.id
       JOIN survey_measures mm ON mm.id = ev.measure_id
       WHERE e.org_id = $1 AND e.survey_project_id = $2 AND e.entry_date <= $3 ${periodClause}
       GROUP BY e.survey_village_id, mm.code`, values)).rows;

    const targets = (await db.query(
      `SELECT t.survey_village_id, mm.code AS measure_code, t.target_quantity
       FROM survey_targets t
       JOIN survey_measures mm ON mm.id = t.measure_id
       WHERE t.org_id = $1`, [orgId])).rows;

    const stages = (await db.query(
      `SELECT vs.survey_village_id, s.code AS stage_code, vs.state, vs.started_on, vs.completed_on
       FROM survey_village_stages vs
       JOIN survey_stages s ON s.id = vs.stage_id
       WHERE vs.org_id = $1`, [orgId])).rows;

    const done = new Map<string, Record<string, number>>();
    for (const c of cumulative) {
      const key = String(c.survey_village_id);
      if (!done.has(key)) done.set(key, {});
      done.get(key)![String(c.measure_code)] = Number(c.total);
    }
    const target = new Map<string, Record<string, number>>();
    for (const t of targets) {
      const key = String(t.survey_village_id);
      if (!target.has(key)) target.set(key, {});
      target.get(key)![String(t.measure_code)] = Number(t.target_quantity);
    }
    const stage = new Map<string, Record<string, StageState>>();
    const stageDates = new Map<string, Record<string, { started: string | null; completed: string | null }>>();
    for (const s of stages) {
      const key = String(s.survey_village_id);
      if (!stage.has(key)) { stage.set(key, {}); stageDates.set(key, {}); }
      stage.get(key)![String(s.stage_code)] = String(s.state) as StageState;
      stageDates.get(key)![String(s.stage_code)] = {
        started: iso(s.started_on), completed: iso(s.completed_on),
      };
    }

    return rows.map(r => ({
      villageId: String(r.id),
      extentAc: num(r.total_extent_ac),
      done: done.get(String(r.id)) ?? {},
      targets: target.get(String(r.id)) ?? {},
      stages: stage.get(String(r.id)) ?? {},
      row: { ...r, stage_dates: stageDates.get(String(r.id)) ?? {} },
    }));
  }

  /**
   * Which unit a village rolls up into at a given level.
   *
   * The division tier is optional, so a mandal's parent may be a division or
   * a district. Asking for the division of a village whose mandal hangs
   * straight off a district returns nothing, and it is grouped as
   * unattributed rather than being silently filed under the district — a
   * hole in the master data should be visible.
   */
  function unitAt(row: Record<string, any>, level: ReportLevel): { id: string; name: string } | null {
    if (level === 'village') return { id: String(row.village_id), name: String(row.village_name) };
    if (level === 'mandal') {
      return row.mandal_id ? { id: String(row.mandal_id), name: String(row.mandal_name) } : null;
    }
    if (level === 'division') {
      return row.parent_type === 'division'
        ? { id: String(row.parent_id), name: String(row.parent_name) } : null;
    }
    if (level === 'district') {
      if (row.parent_type === 'district') return { id: String(row.parent_id), name: String(row.parent_name) };
      if (row.grandparent_type === 'district') {
        return { id: String(row.grandparent_id), name: String(row.grandparent_name) };
      }
      return null;
    }
    return null;
  }

  async function projectOr404(db: Pool | PoolClient, orgId: string, id: string) {
    return inOrg(db, 'survey_projects', id, orgId);
  }

  /* ------------------------------------------------------- programmes */

  app.get('/api/v1/survey/projects', { preHandler: guard('survey.read') }, async req => {
    const u = actor(req), { limit, offset } = page(req);
    const rows = (await pool.query(
      `SELECT sp.*, (SELECT count(*)::int FROM survey_villages sv
                      WHERE sv.survey_project_id = sp.id) AS village_count
       FROM survey_projects sp WHERE sp.org_id = $1
       ORDER BY sp.created_at DESC LIMIT $2 OFFSET $3`, [u.orgId, limit + 1, offset])).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit };
  });

  app.post('/api/v1/survey/projects', { preHandler: guard('survey.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(surveyProjectSchema, req.body);
    const row = await mutate(pool, req, 'survey.project.create', 'survey_project', async db => {
      const clash = await db.query(
        'SELECT 1 FROM survey_projects WHERE org_id = $1 AND code = $2', [u.orgId, input.code]);
      if (clash.rowCount) fail('DUPLICATE_CODE', `A survey programme ${input.code} already exists`, 409);
      return (await db.query(
        `INSERT INTO survey_projects(org_id, code, name, project_id, started_on,
           target_completion_on, notes, created_by, updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
        [u.orgId, input.code, input.name, input.project_id ?? null,
          input.started_on ?? null, input.target_completion_on ?? null,
          input.notes ?? null, u.id])).rows[0];
    });
    reply.code(201);
    return { data: row };
  });

  /* ---------------------------------------------------------- measures */

  app.get('/api/v1/survey/measures', { preHandler: guard('survey.read') }, async req => {
    const u = actor(req);
    const [m, stages] = await Promise.all([
      measures(pool, u.orgId),
      pool.query('SELECT * FROM survey_stages WHERE org_id = $1 AND active ORDER BY display_order',
        [u.orgId]),
    ]);
    return { data: { measures: m.rows, stages: stages.rows } };
  });

  /**
   * Add a measure (§59.4.3).
   *
   * The reason measures are rows rather than columns: the request is explicit
   * that more get added on the fly, and a new column would be a migration and
   * a deployment for what should be a form.
   */
  app.post('/api/v1/survey/measures', { preHandler: guard('survey.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(measureSchema, req.body);
    const row = await mutate(pool, req, 'survey.measure.create', 'survey_measure', async db => {
      const existing = (await db.query(
        'SELECT * FROM survey_measures WHERE org_id = $1 AND code = $2',
        [u.orgId, input.code])).rows[0];
      // Returned rather than refused: adding a measure that already exists is
      // what somebody does when two people set one up at once, and it is not
      // an error worth stopping them for.
      if (existing) return existing;
      return (await db.query(
        `INSERT INTO survey_measures(org_id, code, label, group_label, unit, basis, display_order)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [u.orgId, input.code, input.label, input.group_label ?? null,
          input.unit, input.basis, input.display_order ?? 100])).rows[0];
    });
    reply.code(201);
    return { data: row };
  });

  /* ---------------------------------------------------------- villages */

  app.get('/api/v1/survey/projects/:id/villages', { preHandler: guard('survey.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const { q } = page(req);
    await projectOr404(pool, u.orgId, id);
    const [m, codes, pos] = await Promise.all([
      measures(pool, u.orgId), stageCodes(pool, u.orgId),
      positions(pool, u.orgId, id, { asOf: String(q.as_of ?? today()) }),
    ]);

    return {
      data: pos.map(p => ({
        id: p.villageId,
        village_id: p.row.village_id,
        village_name: p.row.village_name,
        village_code: p.row.village_source_code ?? p.row.village_code,
        mandal_name: p.row.mandal_name,
        division_name: p.row.parent_type === 'division' ? p.row.parent_name : null,
        total_extent_ac: p.extentAc,
        // Derived rather than stored: two columns holding one quantity in
        // different units disagree the moment either is edited.
        total_extent_sq_km: p.extentAc === null ? null : acresToSqKm(p.extentAc),
        dgps_base: p.row.dgps_base, dgps_rovers: p.row.dgps_rovers, teams: p.row.teams,
        vill_code_old: p.row.vill_code_old,
        state: villageState(p, codes),
        stages: p.stages,
        stage_dates: p.row.stage_dates,
        done: p.done,
        targets: p.targets,
        measures: Object.fromEntries(m.codes.map(code => [
          code,
          completion(
            p.done[code] ?? 0,
            m.basis[code] === 'EXTENT' ? p.extentAc : p.targets?.[code] ?? null),
        ])),
        version: p.row.version,
      })),
    };
  });

  app.post('/api/v1/survey/projects/:id/villages', { preHandler: guard('survey.manage') },
    async (req, reply) => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(surveyVillageSchema, req.body);
      const row = await mutate(pool, req, 'survey.village.add', 'survey_village', async db => {
        await projectOr404(db, u.orgId, id);
        const unit = (await db.query(
          'SELECT * FROM org_units WHERE id = $1 AND org_id = $2', [input.village_id, u.orgId])).rows[0];
        if (!unit) fail('UNKNOWN_VILLAGE', 'That location is not in this organisation', 422);
        if (unit.type !== 'village') {
          fail('NOT_A_VILLAGE',
            `A survey is listed village by village; ${unit.name} is a ${unit.type}`, 422);
        }
        const clash = await db.query(
          'SELECT 1 FROM survey_villages WHERE survey_project_id = $1 AND village_id = $2',
          [id, input.village_id]);
        // Twice would double its extent in every denominator above it.
        if (clash.rowCount) fail('ALREADY_LISTED', `${unit.name} is already in this programme`, 409);

        return (await db.query(
          `INSERT INTO survey_villages(org_id, survey_project_id, village_id, total_extent_ac,
             dgps_base, dgps_rovers, teams, vill_code_old, created_by, updated_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
          [u.orgId, id, input.village_id, input.total_extent_ac ?? null,
            input.dgps_base ?? 0, input.dgps_rovers ?? 0, input.teams ?? 0,
            input.vill_code_old ?? null, u.id])).rows[0];
      });
      reply.code(201);
      return { data: row };
    });

  /**
   * Set the target a measure's completion is divided by (§59.1.3).
   *
   * A separate permission from recording progress on purpose: a crew that
   * could move its own denominator is not being measured.
   */
  app.post('/api/v1/survey/villages/:id/targets', { preHandler: guard('survey.target') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(targetSchema, req.body);
      return {
        data: await mutate(pool, req, 'survey.target.set', 'survey_target', async db => {
          await inOrg(db, 'survey_villages', id, u.orgId);
          const m = (await measures(db, u.orgId)).byCode.get(input.measure_code);
          if (!m) fail('UNKNOWN_MEASURE', `There is no measure ${input.measure_code}`, 422);
          if (m.basis === 'EXTENT') {
            fail('EXTENT_HAS_NO_TARGET',
              `${m.label} is measured against the village extent, which is already recorded`, 422);
          }
          return (await db.query(
            `INSERT INTO survey_targets(org_id, survey_village_id, measure_id, target_quantity, updated_by)
             VALUES($1,$2,$3,$4,$5)
             ON CONFLICT (survey_village_id, measure_id)
             DO UPDATE SET target_quantity = EXCLUDED.target_quantity,
                           updated_at = now(), updated_by = EXCLUDED.updated_by
             RETURNING *`,
            [u.orgId, id, m.id, input.target_quantity, u.id])).rows[0];
        }),
      };
    });

  app.post('/api/v1/survey/villages/:id/stage', { preHandler: guard('survey.enter') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(stageUpdateSchema, req.body);
    return {
      data: await mutate(pool, req, 'survey.stage.set', 'survey_village_stage', async db => {
        await inOrg(db, 'survey_villages', id, u.orgId);
        const stage = (await db.query(
          'SELECT * FROM survey_stages WHERE org_id = $1 AND code = $2 AND active',
          [u.orgId, input.stage_code])).rows[0];
        if (!stage) fail('UNKNOWN_STAGE', `There is no stage ${input.stage_code}`, 422);
        return (await db.query(
          `INSERT INTO survey_village_stages(org_id, survey_village_id, stage_id, state,
             started_on, completed_on, updated_by)
           VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (survey_village_id, stage_id)
           DO UPDATE SET state = EXCLUDED.state, started_on = EXCLUDED.started_on,
                         completed_on = EXCLUDED.completed_on,
                         updated_at = now(), updated_by = EXCLUDED.updated_by
           RETURNING *`,
          [u.orgId, id, stage.id, input.state,
            input.started_on ?? null, input.completed_on ?? null, u.id])).rows[0];
      }),
    };
  });

  /* ------------------------------------------------------- daily entry */

  /**
   * Record a day's progress (§59.4).
   *
   * Only today's figures are accepted. The cumulative is derived on read, so
   * there is nothing here to type it into and nothing to fall out of step
   * with the daily rows.
   */
  app.post('/api/v1/survey/entries', { preHandler: guard('survey.enter') }, async (req, reply) => {
    const u = actor(req), input = parse(surveyEntrySchema, req.body);
    const row = await mutate(pool, req, 'survey.entry.create', 'survey_entry', async db => {
      const village = await inOrg(db, 'survey_villages', input.survey_village_id, u.orgId);
      const m = await measures(db, u.orgId);

      for (const code of Object.keys(input.values)) {
        if (!m.byCode.has(code)) {
          fail('UNKNOWN_MEASURE',
            `There is no measure ${code}. Add it first, or correct the spelling.`, 422);
        }
      }

      const clash = await db.query(
        'SELECT id FROM survey_entries WHERE survey_village_id = $1 AND entry_date = $2',
        [input.survey_village_id, input.entry_date]);
      if (clash.rowCount) {
        // Refused rather than merged: a second entry for the same day would
        // double that day in every cumulative figure, and the right fix is to
        // amend the entry that exists.
        fail('ALREADY_ENTERED',
          `Progress for ${input.entry_date} is already recorded for this village. Amend it instead.`,
          409);
      }

      const entry = (await db.query(
        `INSERT INTO survey_entries(org_id, survey_project_id, survey_village_id, entry_date,
           teams_deployed, dgps_base, dgps_rovers, notes, created_by, updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
        [u.orgId, village.survey_project_id, input.survey_village_id, input.entry_date,
          input.teams_deployed ?? 0, input.dgps_base ?? 0, input.dgps_rovers ?? 0,
          input.notes ?? null, u.id])).rows[0];

      for (const [code, quantity] of Object.entries(input.values)) {
        if (!quantity) continue;
        await db.query(
          'INSERT INTO survey_entry_values(org_id, entry_id, measure_id, quantity) VALUES($1,$2,$3,$4)',
          [u.orgId, entry.id, m.byCode.get(code)!.id, quantity]);
      }
      return entry;
    });
    reply.code(201);
    return { data: row };
  });

  app.patch('/api/v1/survey/entries/:id', { preHandler: guard('survey.enter') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(surveyEntryPatchSchema, req.body);
    return {
      data: await mutate(pool, req, 'survey.entry.update', 'survey_entry', async db => {
        const row = await inOrg(db, 'survey_entries', id, u.orgId, true);
        version(req, row as { version: number });
        const m = await measures(db, u.orgId);

        const sets: string[] = [], values: unknown[] = [id];
        for (const key of ['teams_deployed', 'dgps_base', 'dgps_rovers', 'notes'] as const) {
          if (input[key] !== undefined) { values.push(input[key]); sets.push(`${key} = $${values.length}`); }
        }
        if (sets.length) {
          values.push(u.id);
          await db.query(
            `UPDATE survey_entries SET ${sets.join(', ')}, updated_at = now(),
               updated_by = $${values.length} WHERE id = $1`, values);
        }

        if (input.values) {
          for (const [code, quantity] of Object.entries(input.values)) {
            const measure = m.byCode.get(code);
            if (!measure) fail('UNKNOWN_MEASURE', `There is no measure ${code}`, 422);
            if (quantity === 0) {
              // Zero removes the value rather than storing a zero row, so a
              // measure never recorded and one corrected to nothing read the
              // same way on the entry form.
              await db.query('DELETE FROM survey_entry_values WHERE entry_id = $1 AND measure_id = $2',
                [id, measure.id]);
              continue;
            }
            await db.query(
              `INSERT INTO survey_entry_values(org_id, entry_id, measure_id, quantity)
               VALUES($1,$2,$3,$4)
               ON CONFLICT (entry_id, measure_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
              [u.orgId, id, measure.id, quantity]);
            }
        }

        return (await db.query(
          'UPDATE survey_entries SET version = version + 1 WHERE id = $1 RETURNING *', [id])).rows[0];
      }),
    };
  });

  app.get('/api/v1/survey/entries', { preHandler: guard('survey.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId];
    let where = 'e.org_id = $1';
    if (q.survey_project_id) { values.push(q.survey_project_id); where += ` AND e.survey_project_id = $${values.length}`; }
    if (q.survey_village_id) { values.push(q.survey_village_id); where += ` AND e.survey_village_id = $${values.length}`; }
    if (q.from) { values.push(q.from); where += ` AND e.entry_date >= $${values.length}`; }
    if (q.to) { values.push(q.to); where += ` AND e.entry_date <= $${values.length}`; }
    values.push(limit + 1, offset);

    const rows = (await pool.query(
      `SELECT e.*, v.name AS village_name, u.username AS recorded_by,
              COALESCE(NULLIF(trim(concat_ws(' ', emp.first_name, emp.last_name)), ''), u.username) AS recorded_by_name,
              (SELECT json_object_agg(mm.code, ev.quantity)
                 FROM survey_entry_values ev JOIN survey_measures mm ON mm.id = ev.measure_id
                WHERE ev.entry_id = e.id) AS values
       FROM survey_entries e
       JOIN survey_villages sv ON sv.id = e.survey_village_id
       JOIN org_units v ON v.id = sv.village_id
       LEFT JOIN users u ON u.id = e.created_by
       LEFT JOIN employees emp ON emp.id = u.employee_id
       WHERE ${where}
       ORDER BY e.entry_date DESC, v.name
       LIMIT $${values.length - 1} OFFSET $${values.length}`, values)).rows;

    return {
      data: rows.slice(0, limit).map(r => ({
        ...r, entry_date: iso(r.entry_date), values: r.values ?? {},
      })),
      has_more: rows.length > limit,
    };
  });

  /* ------------------------------------------------------------ report */

  /**
   * Progress at any level (§59.6).
   *
   * Villages are rolled up into the requested level and every percentage is
   * computed from summed quantities over summed denominators. A mandal's
   * completion is its total done over its total target, never the mean of its
   * villages' percentages — that would count a five-acre village equally with
   * a five-hundred-acre one.
   */
  app.get('/api/v1/survey/projects/:id/progress', { preHandler: guard('survey.read') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const { q } = page(req);
      await projectOr404(pool, u.orgId, id);

      const level = (REPORT_LEVELS as readonly string[]).includes(String(q.level))
        ? String(q.level) as ReportLevel : 'mandal';
      const asOf = String(q.to ?? q.as_of ?? today());
      const from = q.from ? String(q.from) : undefined;

      const [m, codes, pos] = await Promise.all([
        measures(pool, u.orgId), stageCodes(pool, u.orgId),
        positions(pool, u.orgId, id, { asOf }),
      ]);

      // A second pass bounded by `from` gives what was done *in* the period,
      // reported beside the position rather than instead of it.
      const inPeriod = from
        ? await positions(pool, u.orgId, id, { asOf, from })
        : null;
      const periodDone = new Map<string, Record<string, number>>(
        (inPeriod ?? []).map(p => [p.villageId, p.done]));

      const groups = new Map<string, { name: string; items: typeof pos }>();
      for (const p of pos) {
        const unit = unitAt(p.row, level);
        // A village whose geography is incomplete is reported as
        // unattributed rather than quietly filed somewhere plausible.
        const key = unit?.id ?? '__unattributed__';
        if (!groups.has(key)) {
          groups.set(key, { name: unit?.name ?? 'Not attributed', items: [] });
        }
        groups.get(key)!.items.push(p);
      }

      const rows = [...groups.entries()].map(([key, g]) => {
        const summary = rollUp(g.items, m.codes, codes, m.basis);
        return {
          id: key === '__unattributed__' ? null : key,
          name: g.name,
          ...summary,
          period_done: from
            ? Object.fromEntries(m.codes.map(code => [
              code,
              g.items.reduce((t, i) => t + (periodDone.get(i.villageId)?.[code] ?? 0), 0),
            ]))
            : null,
        };
      }).sort((a, b) => a.name.localeCompare(b.name));

      return {
        data: {
          level,
          as_of: asOf,
          from: from ?? null,
          rows,
          // The whole programme, computed from the same villages, so the
          // headline and the rows below it cannot disagree.
          total: rollUp(pos, m.codes, codes, m.basis),
          measures: m.rows.map(r => ({
            code: r.code, label: r.label, group_label: r.group_label,
            unit: r.unit, basis: r.basis,
          })),
        },
      };
    });

  /**
   * The same figures split into periods (§59.6.2).
   *
   * Weekly, monthly, yearly or a given range. Each period reports what was
   * done in it; the percentage complete is as at the end of the period,
   * because it describes the programme rather than the week.
   */
  app.get('/api/v1/survey/projects/:id/timeline', { preHandler: guard('survey.read') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const { q } = page(req);
      await projectOr404(pool, u.orgId, id);

      const grain = (['DAY', 'WEEK', 'MONTH', 'YEAR'] as const).includes(String(q.grain) as PeriodGrain)
        ? String(q.grain) as PeriodGrain : 'MONTH';
      const fy = financialYearRange(today());
      const from = String(q.from ?? fy.from);
      const to = String(q.to ?? today());

      const buckets = periodBuckets(from, to, grain);
      if (buckets.length > 400) {
        fail('RANGE_TOO_WIDE',
          `That range is ${buckets.length} periods. Choose a coarser grain or a shorter range.`, 422);
      }

      const m = await measures(pool, u.orgId);
      const rows = (await pool.query(
        `SELECT e.entry_date, mm.code AS measure_code, sum(ev.quantity) AS total,
                count(DISTINCT e.survey_village_id)::int AS villages,
                sum(e.teams_deployed)::int AS teams
         FROM survey_entries e
         JOIN survey_entry_values ev ON ev.entry_id = e.id
         JOIN survey_measures mm ON mm.id = ev.measure_id
         WHERE e.org_id = $1 AND e.survey_project_id = $2
           AND e.entry_date >= $3 AND e.entry_date <= $4
         GROUP BY e.entry_date, mm.code
         ORDER BY e.entry_date`, [u.orgId, id, from, to])).rows;

      const periods = buckets.map(b => {
        const within = rows.filter(r => {
          const d = iso(r.entry_date)!;
          return d >= b.from && d <= b.to;
        });
        return {
          ...b,
          villages: Math.max(0, ...within.map(r => Number(r.villages))),
          measures: Object.fromEntries(m.codes.map(code => [
            code, within.filter(r => r.measure_code === code)
              .reduce((t, r) => t + Number(r.total), 0),
          ])),
        };
      });

      return { data: { grain, from, to, periods, financial_year: fy } };
    });

  /**
   * The summary sheet (§59.5).
   *
   * Village by village with its stages and dates — the second table in the
   * workbook this replaces. Extent appears in both units from the one stored
   * figure.
   */
  app.get('/api/v1/survey/projects/:id/summary', { preHandler: guard('survey.read') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      await projectOr404(pool, u.orgId, id);
      const [codes, pos] = await Promise.all([
        stageCodes(pool, u.orgId), positions(pool, u.orgId, id),
      ]);

      return {
        data: pos.map(p => {
          const dates = p.row.stage_dates as Record<string, { started: string | null; completed: string | null }>;
          const surveyed = (p.done.GOVT_LAND_EXTENT_AC ?? 0) + (p.done.PRIVATE_LAND_EXTENT_AC ?? 0);
          return {
            mandal: p.row.mandal_name,
            village: p.row.village_name,
            extent_ac: p.extentAc,
            extent_sq_km: p.extentAc === null ? null : acresToSqKm(p.extentAc),
            gt_status: p.stages?.GROUND_TRUTHING ?? 'NOT_STARTED',
            gt_started_on: dates.GROUND_TRUTHING?.started ?? null,
            gt_completed_on: dates.GROUND_TRUTHING?.completed ?? null,
            vectorization_status: p.stages?.VECTORIZATION ?? 'NOT_STARTED',
            points: (p.done.GOVT_LAND_POINTS ?? 0) + (p.done.PRIVATE_LAND_POINTS ?? 0)
              + (p.done.VILLAGE_BOUNDARY_POINTS ?? 0) + (p.done.HABITATION_BOUNDARY_POINTS ?? 0),
            lpms: p.done.LPMS_GENERATED ?? 0,
            // What was actually surveyed, against what was expected. The gap
            // between the two is the point of the column.
            actual_extent_ac: Math.round(surveyed * 10000) / 10000,
            state: villageState(p, codes),
          };
        }),
      };
    });
}
