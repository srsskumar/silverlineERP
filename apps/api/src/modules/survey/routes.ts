import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  surveyProjectSchema, surveyVillageSchema, surveyVillageCreateSchema,
  surveyVillageEditSchema, surveyEntrySchema, surveyEntryPatchSchema,
  measureSchema, targetSchema, stageUpdateSchema,
  rollUp, villageState, completion, acresToSqKm, periodBuckets, financialYearRange,
  PERIOD_GRAINS, periodContaining, previousPeriod, comparePeriods,
  STAGE_CODES, REPORT_LEVELS, resolveStage, isOutOfScope, plannedTasksFor,
  tallyByStage, roverUtilisation, roverWindow, rankByWaste, pace, currentStage,
  outOfSequence, stageBlockedBy,
  crewAssignmentSchema, roverAllocationSchema, stageRemarkSchema, STAGE_PIPELINE,
  crewBulkAssignmentSchema, roverBulkAllocationSchema, roverAllocationEditSchema,
  villageMoveSchema,
  checkRoverDay, checkLowProgress, villageStatus, projectEmployeeSchema,
  forecast, findBottlenecks, delayReasonLabel as reasonLabel,
  villageStatusSchema, villagePlanSchema, delayReasonLabel, DELAY_REASONS,
  type MeasureBasis, type PeriodGrain, type ReportLevel, type StageState, type VillageProgress,
  businessDay,
} from '@silverline/shared';
import { buildAuthenticate, requirePermission } from '../../common/auth.js';
import { z } from 'zod';
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
  // The calendar day where the work happens, not in UTC. For the first
  // five and a half hours of every Indian day, UTC is still yesterday.
  const today = () => businessDay();
  // A timestamp becomes the calendar day it fell on *here*, not in UTC. A
  // stage completed at half past midnight would otherwise be dated to the day
  // before on the summary sheet. Date columns land on the same answer either
  // way, so one helper serves both.
  const iso = (v: unknown) =>
    v instanceof Date ? businessDay(v) : v ? String(v).slice(0, 10) : null;
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

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

  /**
   * The stage pipeline as this organisation has it, in order.
   *
   * Read from the database rather than the seeded constant, because a stage
   * may be added or switched off per organisation and the report must follow
   * what is actually configured.
   */
  async function stagePipeline(db: Pool | PoolClient, orgId: string) {
    const rows = (await db.query(
      `SELECT s.code, s.label, s.display_order, s.tracks_daily_progress,
              p.code AS requires
       FROM survey_stages s
       LEFT JOIN survey_stages p ON p.id = s.requires_stage_id
       WHERE s.org_id = $1 AND s.active ORDER BY s.display_order`, [orgId])).rows;
    return rows.length
      ? rows.map(r => ({
        code: String(r.code), label: String(r.label),
        displayOrder: Number(r.display_order),
        requires: r.requires ? String(r.requires) : undefined,
        tracksDailyProgress: Boolean(r.tracks_daily_progress),
      }))
      : STAGE_PIPELINE;
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
              vt.status AS task_status, vt.assignee_id,
              COALESCE(NULLIF(trim(concat_ws(' ', emp.first_name, emp.last_name)), ''), au.username)
                AS assignee_name,
              vt.planned_start_date, vt.planned_end_date,
              v.name AS village_name, v.code AS village_code, v.source_code AS village_source_code,
              m.id AS mandal_id, m.name AS mandal_name, m.code AS mandal_code,
              p.id AS parent_id, p.type AS parent_type, p.name AS parent_name,
              gp.id AS grandparent_id, gp.type AS grandparent_type, gp.name AS grandparent_name
       FROM survey_villages sv
       LEFT JOIN tasks vt ON vt.id = sv.task_id
       LEFT JOIN users au ON au.id = vt.assignee_id
       LEFT JOIN employees emp ON emp.id = au.employee_id
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

    // Stage state comes from the linked task where there is one, and from the
    // stage row's own columns where there is not. `task_id` says which, so the
    // two can never both be in play for the same stage.
    const stages = (await db.query(
      `SELECT vs.survey_village_id, s.code AS stage_code, vs.remarks,
              vs.state AS own_state, vs.started_on AS own_started_on,
              vs.completed_on AS own_completed_on,
              vs.task_id,
              t.status AS task_status, t.actual_start_at, t.actual_end_at
       FROM survey_village_stages vs
       JOIN survey_stages s ON s.id = vs.stage_id
       LEFT JOIN tasks t ON t.id = vs.task_id
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
    const stageDates = new Map<string, Record<string,
      { started: string | null; completed: string | null; remarks?: string | null }>>();
    for (const s of stages) {
      const key = String(s.survey_village_id);
      if (!stage.has(key)) { stage.set(key, {}); stageDates.set(key, {}); }
      const resolved = resolveStage({
        stageCode: String(s.stage_code),
        linked: Boolean(s.task_id),
        taskStatus: s.task_status,
        taskStartedAt: iso(s.actual_start_at),
        taskCompletedAt: iso(s.actual_end_at),
        ownState: s.own_state as StageState,
        ownStartedOn: iso(s.own_started_on),
        ownCompletedOn: iso(s.own_completed_on),
      });
      stage.get(key)![String(s.stage_code)] = resolved.state;
      stageDates.get(key)![String(s.stage_code)] = {
        started: resolved.startedOn, completed: resolved.completedOn,
        remarks: s.remarks ?? null,
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

  /**
   * The programmes this user may see.
   *
   * Null means all of them. The test is organisation-wide oversight rather
   * than any one role: somebody who may shape a programme (`survey.manage`)
   * or who may see management forecasting (`survey.forecast`) is by
   * definition looking across the whole organisation — that covers the
   * administrator, the project manager and the auditor, whose entire job is
   * to read everything.
   *
   * Everyone else — the team lead, the GT user, the QC user — sees the
   * programmes they are assigned to and nothing else, which is what §33 asks
   * for. Without it an employee could read every district's figures.
   *
   * A disabled programme is hidden from everyone but the roles that can
   * re-enable it. Disabling is a visibility decision, and the data stays
   * exactly where it is.
   */
  async function visibleProgrammes(
    db: Pool | PoolClient, u: { orgId: string; id: string; permissions: string[] },
  ): Promise<string[] | null> {
    if (u.permissions.includes('survey.manage')
      || u.permissions.includes('survey.forecast')) return null;
    const rows = (await db.query(
      `SELECT pe.survey_project_id AS id
       FROM survey_project_employees pe
       JOIN users usr ON usr.employee_id = pe.employee_id
       WHERE usr.id = $1 AND pe.org_id = $2 AND pe.released_on IS NULL`,
      [u.id, u.orgId])).rows;
    return rows.map(r => String(r.id));
  }

  async function projectOr404(
    db: Pool | PoolClient, orgId: string, id: string,
    u?: { orgId: string; id: string; permissions: string[] },
  ) {
    const row = await inOrg(db, 'survey_projects', id, orgId);
    if (u) {
      const allowed = await visibleProgrammes(db, u);
      if (allowed !== null && !allowed.includes(String(id))) {
        // 404 rather than 403: telling somebody a programme exists that they
        // may not see is itself a disclosure.
        fail('NOT_FOUND', 'Not found', 404);
      }
    }
    return row;
  }

  /* ------------------------------------------------------- programmes */

  app.get('/api/v1/survey/projects', { preHandler: guard('survey.read') }, async req => {
    const u = actor(req), { limit, offset } = page(req);
    const allowed = await visibleProgrammes(pool, u);
    const values: unknown[] = [u.orgId];
    let where = 'sp.org_id = $1';
    if (allowed !== null) {
      // An employee sees the programmes they are on. An empty list is an
      // empty result rather than every programme, which is what a missing
      // filter would silently produce.
      values.push(allowed);
      where += ` AND sp.id = ANY($${values.length}::uuid[])`;
      where += " AND sp.status <> 'DISABLED'";
    }
    values.push(limit + 1, offset);
    const rows = (await pool.query(
      `SELECT sp.*, (SELECT count(*)::int FROM survey_villages sv
                      WHERE sv.survey_project_id = sp.id) AS village_count
       FROM survey_projects sp WHERE ${where}
       ORDER BY sp.created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`, values)).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit };
  });

  /**
   * Create the project a programme is paired with.
   *
   * Same code and name, so the two read as one thing wherever either
   * appears. The workspace is the one given, or the organisation's only one
   * — with a single workspace there is nothing to choose, and an
   * organisation running several has to say which.
   *
   * A code already taken in Projects gets a suffix rather than failing the
   * whole creation: the programme is what the person asked for, and refusing
   * it because an unrelated project happens to share a code would be the
   * pairing making things worse than not having it.
   */
  async function pairProject(
    db: PoolClient,
    u: { orgId: string; id: string },
    input: { code: string; name: string; workspace_id?: string;
      started_on?: string | null; target_completion_on?: string | null },
  ): Promise<string> {
    let workspaceId = input.workspace_id ?? null;
    if (!workspaceId) {
      const spaces = (await db.query(
        'SELECT id FROM workspaces WHERE org_id = $1 ORDER BY created_at LIMIT 2',
        [u.orgId])).rows;
      if (spaces.length === 0) {
        fail('NO_WORKSPACE',
          'Create a workspace before a survey programme, so its project has somewhere to live',
          422);
      }
      if (spaces.length > 1) {
        fail('WORKSPACE_REQUIRED',
          'This organisation has several workspaces. Say which one the project belongs to.',
          422);
      }
      workspaceId = String(spaces[0].id);
    }

    let code = input.code;
    const clash = await db.query(
      'SELECT 1 FROM projects WHERE org_id = $1 AND code = $2', [u.orgId, code]);
    if (clash.rowCount) code = `${input.code}-SV`;

    return String((await db.query(
      `INSERT INTO projects(org_id, workspace_id, code, name, status,
         planned_start_date, planned_end_date, created_by, updated_by)
       VALUES($1,$2,$3,$4,'ACTIVE',$5::date,$6::date,$7,$7) RETURNING id`,
      [u.orgId, workspaceId, code, input.name,
        input.started_on ?? null, input.target_completion_on ?? null, u.id])).rows[0].id);
  }

  app.post('/api/v1/survey/projects', { preHandler: guard('survey.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(surveyProjectSchema, req.body);
    const row = await mutate(pool, req, 'survey.project.create', 'survey_project', async db => {
      const clash = await db.query(
        'SELECT 1 FROM survey_projects WHERE org_id = $1 AND code = $2', [u.orgId, input.code]);
      if (clash.rowCount) fail('DUPLICATE_CODE', `A survey programme ${input.code} already exists`, 409);
      /*
       * A programme comes with its project (§note 4).
       *
       * The two were separate records with an optional link, so setting up
       * survey work meant creating a programme, creating a project, and
       * remembering to connect them — a step people forget, and then wonder
       * why the board is empty. They are one thing to the person using them,
       * so they are created together.
       *
       * Not merged into one table: every village, return, crew row and rover
       * allocation already points at the programme, and repointing live data
       * risks losing the record it exists to keep. Pairing gets the same
       * result for anybody using it, and leaves a merge possible later
       * without a special case for programmes that have no project.
       */
      let projectId = input.project_id ?? null;
      if (!projectId && input.create_project) {
        projectId = await pairProject(db, u, input);
      }

      return (await db.query(
        `INSERT INTO survey_projects(org_id, code, name, project_id, started_on,
           target_completion_on, notes, created_by, updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
        [u.orgId, input.code, input.name, projectId,
          input.started_on ?? null, input.target_completion_on ?? null,
          input.notes ?? null, u.id])).rows[0];
    });
    reply.code(201);
    return { data: row };
  });

  /**
   * Link the programme to an ordinary project (§59.8).
   *
   * Tasks belong to a project, so the link has to exist before any survey work
   * can appear on a board. Kept as a patch rather than forced at creation:
   * a programme is often set up before anybody decides which project carries
   * its cost.
   */
  app.patch('/api/v1/survey/projects/:id', { preHandler: guard('survey.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(surveyProjectSchema.partial(), req.body);
    return {
      data: await mutate(pool, req, 'survey.project.update', 'survey_project', async db => {
        const row = await inOrg(db, 'survey_projects', id, u.orgId, true);
        version(req, row as { version: number });
        if (input.project_id) await inOrg(db, 'projects', input.project_id, u.orgId);

        const sets: string[] = [], values: unknown[] = [id];
        for (const key of ['code', 'name', 'project_id', 'started_on',
          'target_completion_on', 'notes'] as const) {
          if (input[key] !== undefined) {
            values.push(input[key]);
            sets.push(`${key} = $${values.length}`);
          }
        }
        if (!sets.length) return row;
        values.push(u.id);
        return (await db.query(
          `UPDATE survey_projects SET ${sets.join(', ')}, version = version + 1,
             updated_at = now(), updated_by = $${values.length}
           WHERE id = $1 RETURNING *`, values)).rows[0];
      }),
    };
  });

  /**
   * Put the village work on the task board (§59, extending §S4).
   *
   * One task per village and one subtask per stage. From then on the task's
   * status is what the village's state means, which is why this is the only
   * place the two are wired together — a stage row and a task each holding a
   * status is the spreadsheet's `Today` and `Cumulative` problem one level up.
   *
   * Idempotent, and previewed by default. A full district is thousands of
   * villages and five times as many rows once the stages are counted, so the
   * count is reported before anything is written.
   */
  /**
   * Give an existing programme a project (§note 4).
   *
   * For the ones created before programmes and projects were paired. Says
   * plainly when there is already a project rather than quietly making a
   * second one — two projects for one programme is worse than none, because
   * half the work ends up on a board nobody opens.
   */
  app.post('/api/v1/survey/projects/:id/pair', { preHandler: guard('survey.manage') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(z.object({ workspace_id: z.string().uuid().optional() }), req.body);
      return mutate(pool, req, 'survey.project.pair', 'survey_project', async db => {
        const programme = await projectOr404(db, u.orgId, id);
        if (programme.project_id) {
          fail('ALREADY_PAIRED', 'This programme already has a project', 409);
        }
        const projectId = await pairProject(db, u, {
          code: programme.code, name: programme.name,
          workspace_id: input.workspace_id,
          started_on: programme.started_on ? iso(programme.started_on) : null,
          target_completion_on: programme.target_completion_on
            ? iso(programme.target_completion_on) : null,
        });
        await db.query(
          'UPDATE survey_projects SET project_id = $2, version = version + 1, updated_at = now() WHERE id = $1',
          [id, projectId]);
        return { id, project_id: projectId };
      });
    });

  app.post('/api/v1/survey/projects/:id/generate-tasks',
    { preHandler: guard('survey.manage') }, async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(z.object({
        dry_run: z.boolean().default(true),
        // Limit to one mandal at a time, because generating for a whole
        // district in one go is rarely what somebody means the first time.
        mandal_id: z.string().uuid().optional(),
        include_stages: z.boolean().default(true),
      }), req.body ?? {});

      return mutate(pool, req, 'survey.tasks.generate', 'survey_project', async db => {
        const programme = await inOrg(db, 'survey_projects', id, u.orgId, true);
        if (!programme.project_id) {
          fail('PROJECT_NOT_LINKED',
            'Link this programme to a project first — a task has to belong to one.', 422);
        }
        await db.query('SAVEPOINT preview');

        const stages = (await db.query(
          `SELECT id, code, label FROM survey_stages
           WHERE org_id = $1 AND active ORDER BY display_order`, [u.orgId])).rows;

        const values: unknown[] = [u.orgId, id];
        let where = 'sv.org_id = $1 AND sv.survey_project_id = $2';
        if (input.mandal_id) { values.push(input.mandal_id); where += ` AND v.parent_id = $${values.length}`; }

        const villages = (await db.query(
          `SELECT sv.id, sv.task_id, v.id AS village_id, v.name AS village_name,
                  m.name AS mandal_name
           FROM survey_villages sv
           JOIN org_units v ON v.id = sv.village_id
           LEFT JOIN org_units m ON m.id = v.parent_id
           WHERE ${where} ORDER BY m.name, v.name`, values)).rows;

        let villageTasks = 0, stageTasks = 0, skipped = 0;

        for (const village of villages) {
          if (village.task_id) { skipped += 1; continue; }
          const plan = plannedTasksFor(
            { name: String(village.village_name), mandalName: village.mandal_name },
            stages.map(st => ({ code: String(st.code), label: String(st.label) })));

          const parent = (await db.query(
            `INSERT INTO tasks(org_id, project_id, title, status, village_id,
               created_by, updated_by)
             VALUES($1,$2,$3,'TO_DO',$4,$5,$5) RETURNING id`,
            [u.orgId, programme.project_id, plan.parent, village.village_id, u.id])).rows[0];
          villageTasks += 1;
          await db.query('UPDATE survey_villages SET task_id = $2 WHERE id = $1',
            [village.id, parent.id]);

          if (!input.include_stages) continue;
          for (const child of plan.children) {
            const stage = stages.find(st => String(st.code) === child.stageCode)!;
            const sub = (await db.query(
              `INSERT INTO tasks(org_id, project_id, title, status, parent_task_id,
                 village_id, created_by, updated_by)
               VALUES($1,$2,$3,'TO_DO',$4,$5,$6,$6) RETURNING id`,
              [u.orgId, programme.project_id, child.title, parent.id,
                village.village_id, u.id])).rows[0];
            stageTasks += 1;
            // The stage row now exists only to carry the link; its state is
            // the task's from here on.
            await db.query(
              `INSERT INTO survey_village_stages(org_id, survey_village_id, stage_id, task_id, updated_by)
               VALUES($1,$2,$3,$4,$5)
               ON CONFLICT (survey_village_id, stage_id)
               DO UPDATE SET task_id = EXCLUDED.task_id, updated_at = now()`,
              [u.orgId, village.id, stage.id, sub.id, u.id]);
          }
        }

        if (input.dry_run) await db.query('ROLLBACK TO SAVEPOINT preview');

        return {
          dry_run: input.dry_run,
          villages_considered: villages.length,
          village_tasks: villageTasks,
          stage_tasks: stageTasks,
          // Already on the board; generating again leaves them alone rather
          // than making a second card for the same village.
          already_linked: skipped,
          project_id: programme.project_id,
        };
      });
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
    await projectOr404(pool, u.orgId, id, u);
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
        /*
         * The district, wherever it sits in the chain.
         *
         * A mandal reports either straight to a district or through a
         * division, so the district is the parent in one shape and the
         * grandparent in the other. Reading only one of the two would leave
         * every village in a division-organised district filed as having no
         * district at all — and the Villages filter would then offer a list
         * that silently excluded them.
         */
        district_name: p.row.parent_type === 'district'
          ? p.row.parent_name
          : p.row.grandparent_type === 'district' ? p.row.grandparent_name : null,
        total_extent_ac: p.extentAc,
        // Derived rather than stored: two columns holding one quantity in
        // different units disagree the moment either is edited.
        total_extent_sq_km: p.extentAc === null ? null : acresToSqKm(p.extentAc),
        dgps_base: p.row.dgps_base, dgps_rovers: p.row.dgps_rovers, teams: p.row.teams,
        vill_code_old: p.row.vill_code_old,
        // The task this village stands on the board as, and what it carries
        // that a survey row has nowhere else: who is doing it and when.
        task_id: p.row.task_id ?? null,
        task_status: p.row.task_status ?? null,
        assignee_id: p.row.assignee_id ?? null,
        assignee_name: p.row.assignee_name ?? null,
        planned_start_date: iso(p.row.planned_start_date),
        planned_end_date: iso(p.row.planned_end_date),
        state: villageState(p, codes),
        // The specification's five statuses: a hold or a rework decision
        // overrides what the stages would say, because both are judgements
        // the stages cannot see.
        status: villageStatus(p.stages ?? {}, codes, p.row.status_override),
        status_override: p.row.status_override ?? null,
        status_remarks: p.row.status_remarks ?? null,
        expected_completion_on: iso(p.row.expected_completion_on),
        planned_start_on: iso(p.row.planned_start_on),
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
      const input = parse(surveyVillageCreateSchema, req.body);
      const row = await mutate(pool, req, 'survey.village.add', 'survey_village', async db => {
        await projectOr404(db, u.orgId, id);
        /*
         * Either an existing location, or one created here from a name and a
         * mandal (§note 3).
         *
         * Somebody adding a single village has its name and the mandal it
         * sits in, not a location id. Making them create the location on
         * another screen and come back is the reason a bulk import gets
         * opened for one row.
         */
        let villageId = input.village_id ?? null;
        if (!villageId) {
          const mandal = (await db.query(
            "SELECT id FROM org_units WHERE id = $1 AND org_id = $2 AND type = 'mandal'",
            [input.mandal_id, u.orgId])).rows[0];
          if (!mandal) fail('UNKNOWN_MANDAL', 'That mandal is not in this organisation', 422);
          const existing = (await db.query(
            "SELECT id FROM org_units WHERE org_id = $1 AND type = 'village' AND source_code = $2",
            [u.orgId, input.village_code])).rows[0];
          villageId = existing
            ? String(existing.id)
            : String((await db.query(
              `INSERT INTO org_units(org_id, type, code, name, parent_id, source_code, created_by)
               VALUES($1,'village',$2,$3,$4,$2,$5) RETURNING id`,
              [u.orgId, input.village_code, input.village_name, mandal.id, u.id])).rows[0].id);
        }
        const unit = (await db.query(
          'SELECT * FROM org_units WHERE id = $1 AND org_id = $2', [villageId, u.orgId])).rows[0];
        if (!unit) fail('UNKNOWN_VILLAGE', 'That location is not in this organisation', 422);
        if (unit.type !== 'village') {
          fail('NOT_A_VILLAGE',
            `A survey is listed village by village; ${unit.name} is a ${unit.type}`, 422);
        }
        const clash = await db.query(
          'SELECT 1 FROM survey_villages WHERE survey_project_id = $1 AND village_id = $2',
          [id, villageId]);
        // Twice would double its extent in every denominator above it.
        if (clash.rowCount) fail('ALREADY_LISTED', `${unit.name} is already in this programme`, 409);

        return (await db.query(
          `INSERT INTO survey_villages(org_id, survey_project_id, village_id, total_extent_ac,
             dgps_base, dgps_rovers, teams, vill_code_old, created_by, updated_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
          [u.orgId, id, villageId, input.total_extent_ac ?? null,
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

  /**
   * Move a stage (§59.5).
   *
   * Enforces the pipeline: ground truthing is checked before the drawing is
   * vectorised, so a stage cannot start until the one before it is complete.
   * The refusal names the stage in the way rather than saying "not allowed".
   *
   * Only enforced here. Where the task board drives the state, a card moved
   * out of order is reported in the progress figures instead — the board is
   * not this module's to police, and a fact worth surfacing is better than
   * one hidden behind a rule that cannot be applied.
   */
  app.post('/api/v1/survey/villages/:id/stage', { preHandler: guard('survey.enter') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(stageRemarkSchema, req.body);
    return {
      data: await mutate(pool, req, 'survey.stage.set', 'survey_village_stage', async db => {
        await inOrg(db, 'survey_villages', id, u.orgId);
        const stage = (await db.query(
          'SELECT * FROM survey_stages WHERE org_id = $1 AND code = $2 AND active',
          [u.orgId, input.stage_code])).rows[0];
        if (!stage) fail('UNKNOWN_STAGE', `There is no stage ${input.stage_code}`, 422);
        if (input.state === 'COMPLETED' && !input.completed_on) {
          fail('VALIDATION_ERROR', 'A completed stage needs the date it was completed', 422);
        }

        if (input.state !== 'NOT_STARTED') {
          const pipeline = await stagePipeline(db, u.orgId);
          const current = (await db.query(
            `SELECT s.code, vs.state, vs.task_id, t.status AS task_status
             FROM survey_village_stages vs
             JOIN survey_stages s ON s.id = vs.stage_id
             LEFT JOIN tasks t ON t.id = vs.task_id
             WHERE vs.survey_village_id = $1`, [id])).rows;
          const states: Record<string, StageState> = {};
          for (const row of current) {
            states[String(row.code)] = row.task_id
              ? resolveStage({
                stageCode: String(row.code), linked: true, taskStatus: row.task_status,
              }).state
              : (row.state as StageState);
          }
          const blocker = stageBlockedBy(input.stage_code, states, pipeline);
          if (blocker) {
            const label = pipeline.find(st => st.code === blocker)?.label ?? blocker;
            fail('STAGE_BLOCKED',
              `${stage.label} cannot start until ${label} is complete.`, 422);
          }
        }

        // What it was, before it becomes what it is. The specification asks
        // where time is being spent; the current state has forgotten how long
        // it sat in the last one.
        const previous = (await db.query(
          'SELECT state FROM survey_village_stages WHERE survey_village_id = $1 AND stage_id = $2',
          [id, stage.id])).rows[0];
        if (!previous || previous.state !== input.state) {
          await db.query(
            `INSERT INTO survey_stage_history(org_id, survey_village_id, stage_id,
               from_state, to_state, remarks, changed_by)
             VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [u.orgId, id, stage.id, previous?.state ?? null, input.state,
              input.remarks ?? null, u.id]);
        }

        return (await db.query(
          `INSERT INTO survey_village_stages(org_id, survey_village_id, stage_id, state,
             started_on, completed_on, remarks, updated_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (survey_village_id, stage_id)
           DO UPDATE SET state = EXCLUDED.state, started_on = EXCLUDED.started_on,
                         completed_on = EXCLUDED.completed_on,
                         remarks = EXCLUDED.remarks,
                         updated_at = now(), updated_by = EXCLUDED.updated_by
           RETURNING *`,
          [u.orgId, id, stage.id, input.state,
            input.started_on ?? null, input.completed_on ?? null,
            input.remarks ?? null, u.id])).rows[0];
      }),
    };
  });

  /* --------------------------------------------------------- crew */

  /**
   * Who is working a village, and at which stage (§59.5).
   *
   * Several employees to one village-stage, which is why this is its own
   * table rather than the task's assignee. A task has one owner; a ground
   * truthing crew has six, and the GT crew is not the vectorization team.
   */
  app.get('/api/v1/survey/villages/:id/crew', { preHandler: guard('survey.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    await inOrg(pool, 'survey_villages', id, u.orgId);
    const rows = (await pool.query(
      `SELECT c.*, s.code AS stage_code, s.label AS stage_label,
              e.emp_no,
              COALESCE(NULLIF(trim(concat_ws(' ', e.first_name, e.last_name)), ''), e.emp_no)
                AS employee_name
       FROM survey_crew c
       JOIN survey_stages s ON s.id = c.stage_id
       JOIN employees e ON e.id = c.employee_id
       WHERE c.survey_village_id = $1 AND c.org_id = $2
       ORDER BY s.display_order, employee_name`, [id, u.orgId])).rows;
    return {
      data: rows.map(r => ({
        ...r, assigned_on: iso(r.assigned_on), released_on: iso(r.released_on),
        active: !r.released_on,
      })),
    };
  });

  /**
   * The villages this person is working, and whether today's return is in
   * (§59, phase 2).
   *
   * This is what the punch screen needs and nothing else answers: a crew
   * member has no project to pick from and no list to search, they have the
   * one or two villages they were put on. Punching out asks them to file the
   * day's return, so the app has to know which village that is and whether it
   * is already filed -- before it sends a punch that would be refused.
   *
   * Guarded on survey.enter rather than survey.read: this is the working
   * list of the person asking, not a report about anybody else.
   */
  app.get('/api/v1/survey/me/villages', { preHandler: guard('survey.enter') }, async req => {
    const u = actor(req);
    const workDate = today();
    const rows = (await pool.query(
      `SELECT DISTINCT ON (sv.id)
              sv.id, sv.survey_project_id, sv.total_extent_ac,
              ou.name AS village_name, ou.code AS village_code,
              m.name AS mandal_name, d.name AS district_name,
              p.name AS project_name,
              s.code AS stage_code, s.label AS stage_label,
              EXISTS (SELECT 1 FROM survey_entries se
                      WHERE se.survey_village_id = sv.id
                        AND se.entry_date = $3::date) AS filed_today
       FROM survey_crew c
       JOIN survey_villages sv ON sv.id = c.survey_village_id
       JOIN survey_stages s ON s.id = c.stage_id
       JOIN survey_projects p ON p.id = sv.survey_project_id
       JOIN org_units ou ON ou.id = sv.village_id
       LEFT JOIN org_units m ON m.id = ou.parent_id
       LEFT JOIN org_units d ON d.id = COALESCE(
         (SELECT parent_id FROM org_units WHERE id = m.parent_id), m.parent_id)
       JOIN users usr ON usr.employee_id = c.employee_id
       WHERE c.org_id = $1 AND usr.id = $2
         AND c.released_on IS NULL
         AND p.status = 'ACTIVE'
       ORDER BY sv.id, s.display_order`, [u.orgId, u.id, workDate])).rows;
    return {
      data: rows.map(r => ({
        ...r,
        total_extent_ac: num(r.total_extent_ac),
        filed_today: r.filed_today === true,
      })),
      // So the app can label the question it is about to ask.
      work_date: workDate,
    };
  });

  app.post('/api/v1/survey/villages/:id/crew', { preHandler: guard('survey.manage') },
    async (req, reply) => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(crewAssignmentSchema, req.body);
      const row = await mutate(pool, req, 'survey.crew.assign', 'survey_crew', async db => {
        await inOrg(db, 'survey_villages', id, u.orgId);
        await inOrg(db, 'employees', input.employee_id, u.orgId);
        const stage = (await db.query(
          'SELECT id FROM survey_stages WHERE org_id = $1 AND code = $2 AND active',
          [u.orgId, input.stage_code])).rows[0];
        if (!stage) fail('UNKNOWN_STAGE', `There is no stage ${input.stage_code}`, 422);

        const clash = await db.query(
          `SELECT 1 FROM survey_crew
           WHERE survey_village_id = $1 AND stage_id = $2 AND employee_id = $3
             AND released_on IS NULL`, [id, stage.id, input.employee_id]);
        if (clash.rowCount) {
          fail('ALREADY_ASSIGNED', 'That employee is already on this stage here', 409);
        }
        return (await db.query(
          `INSERT INTO survey_crew(org_id, survey_village_id, stage_id, employee_id,
             assigned_on, released_on, created_by)
           VALUES($1,$2,$3,$4,COALESCE($5::date, CURRENT_DATE),$6,$7) RETURNING *`,
          [u.orgId, id, stage.id, input.employee_id,
            input.assigned_on ?? null, input.released_on ?? null, u.id])).rows[0];
      });
      reply.code(201);
      return { data: row };
    });

  /**
   * Put several people on a stage at once (§note 4).
   *
   * A crew is four or five people and assigning them one form at a time is
   * how the fifth gets forgotten. Somebody already on that stage here is
   * reported rather than failing the request: re-running the list after
   * adding one person is the normal way this gets used.
   */
  app.post('/api/v1/survey/villages/:id/crew/bulk', { preHandler: guard('survey.manage') },
    async (req, reply) => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(crewBulkAssignmentSchema, req.body);
      const out = await mutate(pool, req, 'survey.crew.assign.bulk', 'survey_crew', async db => {
        await inOrg(db, 'survey_villages', id, u.orgId);
        const stage = (await db.query(
          'SELECT id FROM survey_stages WHERE org_id = $1 AND code = $2 AND active',
          [u.orgId, input.stage_code])).rows[0];
        if (!stage) fail('UNKNOWN_STAGE', `There is no stage ${input.stage_code}`, 422);

        const assigned: string[] = [], already: string[] = [], refused: string[] = [];
        for (const employeeId of input.employee_ids) {
          const e = (await db.query(
            'SELECT id, status FROM employees WHERE id = $1 AND org_id = $2',
            [employeeId, u.orgId])).rows[0];
          // Somebody who has left cannot be put on work.
          if (!e || e.status !== 'ACTIVE') { refused.push(employeeId); continue; }
          const done = await db.query(
            `INSERT INTO survey_crew(org_id, survey_village_id, stage_id, employee_id,
               assigned_on, created_by)
             SELECT $1,$2,$3,$4,COALESCE($5::date, CURRENT_DATE),$6
             WHERE NOT EXISTS (
               SELECT 1 FROM survey_crew
               WHERE survey_village_id = $2 AND stage_id = $3 AND employee_id = $4
                 AND released_on IS NULL)
             RETURNING id`,
            [u.orgId, id, stage.id, employeeId, input.assigned_on ?? null, u.id]);
          if (done.rowCount) assigned.push(employeeId); else already.push(employeeId);
        }
        return { assigned: assigned.length, already_assigned: already.length,
          refused: refused.length, refused_ids: refused };
      });
      reply.code(201);
      return { data: out };
    });

  /**
   * Allocate several rovers at once (§note 4).
   *
   * The kit goes out together, so the dates are shared. A rover already out
   * on another village for an overlapping period is reported by name and
   * the rest still go — refusing the whole request because one instrument is
   * busy means doing the other four again by hand.
   */
  app.post('/api/v1/survey/villages/:id/rovers/bulk', { preHandler: guard('survey.manage') },
    async (req, reply) => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(roverBulkAllocationSchema, req.body);
      const out = await mutate(pool, req, 'survey.rover.allocate.bulk',
        'survey_rover_allocation', async db => {
          await inOrg(db, 'survey_villages', id, u.orgId);
          const allocated: string[] = [];
          const clashes: Array<{ asset_id: string; asset_code: string; with_village: string }> = [];

          for (const assetId of input.asset_ids) {
            await db.query('SAVEPOINT rover_row');
            try {
              await db.query(
                `INSERT INTO survey_rover_allocations(org_id, survey_village_id, asset_id,
                   allocated_on, released_on, created_by)
                 VALUES($1,$2,$3,$4::date,$5::date,$6)`,
                [u.orgId, id, assetId, input.allocated_on, input.released_on ?? null, u.id]);
              allocated.push(assetId);
              await db.query('RELEASE SAVEPOINT rover_row');
            } catch (error) {
              await db.query('ROLLBACK TO SAVEPOINT rover_row');
              // 23P01 is the exclusion constraint: this rover is already out
              // somewhere over these dates.
              if ((error as { code?: string }).code !== '23P01') throw error;
              const where = (await db.query(
                `SELECT a.asset_code, ou.name AS village
                   FROM survey_rover_allocations r
                   JOIN assets a ON a.id = r.asset_id
                   JOIN survey_villages sv ON sv.id = r.survey_village_id
                   JOIN org_units ou ON ou.id = sv.village_id
                  WHERE r.asset_id = $1 AND r.released_on IS NULL LIMIT 1`, [assetId])).rows[0];
              clashes.push({
                asset_id: assetId,
                asset_code: where?.asset_code ?? 'unknown',
                with_village: where?.village ?? 'another village',
              });
            }
          }
          return { allocated: allocated.length, clashes };
        });
      reply.code(201);
      return { data: out };
    });

  /**
   * Correct an allocation's dates (§note 4).
   *
   * Recorded with the wrong start, or a release that never happened. The
   * exclusion constraint still applies, so a correction that would put one
   * rover in two villages at once is refused rather than accepted quietly.
   */
  app.patch('/api/v1/survey/rovers/:id', { preHandler: guard('survey.manage') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(roverAllocationEditSchema, req.body);
      return mutate(pool, req, 'survey.rover.update', 'survey_rover_allocation', async db => {
        const row = await inOrg(db, 'survey_rover_allocations', id, u.orgId, true);
        const allocatedOn = input.allocated_on ?? iso(row.allocated_on);
        const releasedOn = input.released_on === undefined
          ? iso(row.released_on) : input.released_on;
        if (releasedOn && allocatedOn && releasedOn < allocatedOn) {
          fail('VALIDATION_ERROR', 'A rover cannot be released before it was allocated', 422);
        }
        try {
          return (await db.query(
            `UPDATE survey_rover_allocations
                SET allocated_on = $2::date, released_on = $3::date
              WHERE id = $1 RETURNING *`, [id, allocatedOn, releasedOn])).rows[0];
        } catch (error) {
          if ((error as { code?: string }).code === '23P01') {
            fail('ROVER_DOUBLE_ALLOCATED',
              'Those dates would put this rover in two villages at once', 409);
          }
          throw error;
        }
      });
    });

  /**
   * Move villages from one programme to another (§note 4).
   *
   * Programmes get split and merged — a district carved out into its own
   * contract, two pilots folded into one. Re-importing the list into the
   * other programme would leave the progress behind, which is the whole
   * record.
   *
   * Everything recorded against a village travels with it, because it all
   * hangs off the village row rather than the programme: the daily returns,
   * the stage states, the crew, the rover allocations. Only the programme
   * changes.
   */
  app.post('/api/v1/survey/projects/:id/villages/move',
    { preHandler: guard('survey.manage') }, async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(villageMoveSchema, req.body);
      return mutate(pool, req, 'survey.villages.move', 'survey_project', async db => {
        await projectOr404(db, u.orgId, id);
        const target = await projectOr404(db, u.orgId, input.to_project_id);
        if (input.to_project_id === id) {
          fail('VALIDATION_ERROR', 'That is the programme they are already in', 422);
        }

        const moved: string[] = [], clashed: string[] = [];
        for (const villageId of input.village_ids) {
          const row = (await db.query(
            `SELECT sv.id, sv.village_id, ou.name
               FROM survey_villages sv JOIN org_units ou ON ou.id = sv.village_id
              WHERE sv.id = $1 AND sv.survey_project_id = $2 AND sv.org_id = $3`,
            [villageId, id, u.orgId])).rows[0];
          if (!row) continue;

          // The same village cannot be listed twice in one programme.
          const already = await db.query(
            'SELECT 1 FROM survey_villages WHERE survey_project_id = $1 AND village_id = $2',
            [input.to_project_id, row.village_id]);
          if (already.rowCount) { clashed.push(String(row.name)); continue; }

          await db.query(
            `UPDATE survey_villages
                SET survey_project_id = $2, version = version + 1,
                    updated_at = now(), updated_by = $3
              WHERE id = $1`, [villageId, input.to_project_id, u.id]);
          // The daily returns carry the programme too, so they move with it
          // or every report on the new programme would be short.
          await db.query(
            'UPDATE survey_entries SET survey_project_id = $2 WHERE survey_village_id = $1',
            [villageId, input.to_project_id]);
          moved.push(String(row.name));
        }

        return {
          moved: moved.length, to: target.name,
          already_there: clashed.length, already_there_names: clashed.slice(0, 20),
        };
      });
    });

  app.post('/api/v1/survey/crew/:id/release', { preHandler: guard('survey.manage') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(z.object({ released_on: z.string().optional() }), req.body ?? {});
      return {
        data: await mutate(pool, req, 'survey.crew.release', 'survey_crew', async db => {
          const row = (await db.query(
            'SELECT * FROM survey_crew WHERE id = $1 AND org_id = $2', [id, u.orgId])).rows[0];
          if (!row) fail('NOT_FOUND', 'Not found', 404);
          // Released rather than deleted, so who surveyed a village last
          // season is still answerable.
          return (await db.query(
            `UPDATE survey_crew SET released_on = COALESCE($2::date, CURRENT_DATE)
             WHERE id = $1 RETURNING *`, [id, input.released_on ?? null])).rows[0];
        }),
      };
    });

  /* -------------------------------------------------------- rovers */

  /**
   * Which instruments are out, and where (§59.5).
   *
   * Rovers are assets, not a number. Naming the instrument is what makes
   * "nineteen idle" a fact somebody can act on rather than arithmetic on two
   * guesses.
   */
  app.get('/api/v1/survey/villages/:id/rovers', { preHandler: guard('survey.read') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      await inOrg(pool, 'survey_villages', id, u.orgId);
      const rows = (await pool.query(
        `SELECT r.*, a.asset_code, a.name AS asset_name, a.serial_number, a.condition
         FROM survey_rover_allocations r
         JOIN assets a ON a.id = r.asset_id
         WHERE r.survey_village_id = $1 AND r.org_id = $2
         ORDER BY r.allocated_on DESC`, [id, u.orgId])).rows;
      return {
        data: rows.map(r => ({
          ...r, allocated_on: iso(r.allocated_on), released_on: iso(r.released_on),
          out: !r.released_on,
        })),
      };
    });

  /**
   * Equipment on this village through the people working it (§note 5).
   *
   * Two ways a thing can be at a village. It can be allocated to the village
   * — that is the rover list, and it is what the daily return accounts for.
   * Or it can be issued to a person who is on the village's crew, which is
   * how a tripod, a radio and a battery usually travel: signed out to a
   * surveyor, not to a place.
   *
   * The second kind was invisible here, so a village's equipment looked like
   * whatever happened to be allocated formally and the rest was somewhere in
   * the asset register under a name. Reported separately rather than merged
   * into the rover list, because the distinction is real: releasing the
   * person from the village does not take the equipment off them.
   */
  app.get('/api/v1/survey/villages/:id/crew-assets',
    { preHandler: guard('survey.read') }, async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      await inOrg(pool, 'survey_villages', id, u.orgId);
      const rows = (await pool.query(
        `SELECT DISTINCT ON (aa.asset_id)
                aa.id AS assignment_id, aa.asset_id, aa.issued_at, aa.due_date,
                a.asset_code, a.name AS asset_name, a.serial_number,
                (SELECT t.label FROM asset_types t WHERE t.id = a.asset_type_id) AS type_label,
                e.id AS employee_id, e.emp_no, e.phone,
                COALESCE(NULLIF(trim(concat_ws(' ', e.first_name, e.last_name)), ''), e.emp_no)
                  AS employee_name,
                s.label AS stage_label,
                -- Already allocated to this village in its own right, so the
                -- daily return accounts for it and it is not a second copy.
                EXISTS (SELECT 1 FROM survey_rover_allocations r
                        WHERE r.survey_village_id = $1 AND r.asset_id = aa.asset_id
                          AND r.released_on IS NULL) AS also_allocated
           FROM survey_crew c
           JOIN employees e ON e.id = c.employee_id
           JOIN asset_assignments aa ON aa.employee_id = e.id AND aa.returned_at IS NULL
           JOIN assets a ON a.id = aa.asset_id
           JOIN survey_stages s ON s.id = c.stage_id
          WHERE c.survey_village_id = $1 AND c.org_id = $2 AND c.released_on IS NULL
          ORDER BY aa.asset_id, aa.issued_at DESC`, [id, u.orgId])).rows;

      return {
        data: rows.map(r => ({ ...r, issued_at: iso(r.issued_at), due_date: iso(r.due_date) })),
      };
    });

  app.post('/api/v1/survey/villages/:id/rovers', { preHandler: guard('survey.manage') },
    async (req, reply) => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(roverAllocationSchema, req.body);
      const row = await mutate(pool, req, 'survey.rover.allocate', 'survey_rover_allocation',
        async db => {
          await inOrg(db, 'survey_villages', id, u.orgId);
          await inOrg(db, 'assets', input.asset_id, u.orgId);
          try {
            return (await db.query(
              `INSERT INTO survey_rover_allocations(org_id, survey_village_id, asset_id,
                 allocated_on, released_on, created_by)
               VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
              [u.orgId, id, input.asset_id, input.allocated_on,
                input.released_on ?? null, u.id])).rows[0];
          } catch (error) {
            // The database refuses an overlap outright; translate it, because
            // "exclusion_violation" tells a user nothing.
            if ((error as { code?: string }).code === '23P01') {
              fail('ROVER_ALREADY_OUT',
                'That rover is already allocated elsewhere for those dates. Release it first.',
                409);
            }
            throw error;
          }
        });
      reply.code(201);
      return { data: row };
    });

  /**
   * Bring a rover back.
   *
   * Closes the allocation rather than writing a second one: two rows for one
   * instrument would double it in the allocated total, which is precisely
   * what the exclusion constraint exists to prevent elsewhere.
   */
  app.post('/api/v1/survey/rovers/:id/release', { preHandler: guard('survey.manage') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(z.object({ released_on: z.string().optional() }), req.body ?? {});
      return {
        data: await mutate(pool, req, 'survey.rover.release', 'survey_rover_allocation',
          async db => {
            const row = (await db.query(
              'SELECT * FROM survey_rover_allocations WHERE id = $1 AND org_id = $2',
              [id, u.orgId])).rows[0];
            if (!row) fail('NOT_FOUND', 'Not found', 404);
            if (row.released_on) {
              fail('ALREADY_RETURNED', 'That allocation is already closed', 409);
            }
            return (await db.query(
              `UPDATE survey_rover_allocations
               SET released_on = COALESCE($2::date, CURRENT_DATE)
               WHERE id = $1 RETURNING *`, [id, input.released_on ?? null])).rows[0];
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

      // A row per rover, with a reason for every idle one. Checked before
      // anything is written so the refusal names every problem at once rather
      // than one per attempt.
      const roverRows = input.rovers ?? [];
      if (roverRows.length) {
        const problems = checkRoverDay(roverRows.map(r => ({
          assetId: r.asset_id, status: r.status,
          idleReason: r.idle_reason, remarks: r.remarks, areaAc: r.area_ac,
        })));
        if (problems.length) fail('ROVER_DAY_INVALID', problems.join(' '), 422);
        for (const r of roverRows) await inOrg(db, 'assets', r.asset_id, u.orgId);
      }

      // Low progress wants a reason, and what counts as low is the
      // programme's to say. With no threshold configured nothing is demanded.
      const programme = await inOrg(db, 'survey_projects', village.survey_project_id, u.orgId);
      const areaToday = Object.entries(input.values)
        .filter(([code]) => m.byCode.get(code)?.basis === 'EXTENT')
        .reduce((t, [, v]) => t + Number(v ?? 0), 0);
      const roversOut = roverRows.length || Number(input.dgps_rovers ?? 0);
      const low = checkLowProgress({
        areaToday,
        threshold: programme.low_progress_threshold_ac === null
          ? null : Number(programme.low_progress_threshold_ac),
        roversOut,
      });
      if (low.needsReason && !input.low_progress_reason) {
        fail('LOW_PROGRESS_REASON_REQUIRED',
          `${areaToday} acres is below the ${low.threshold} acre threshold for this programme. Say why.`,
          422);
      }
      if (input.low_progress_reason === 'OTHER' && !input.low_progress_remarks?.trim()) {
        fail('VALIDATION_ERROR', 'A low-progress reason of "other" must say what happened', 422);
      }

      // The count is derived from the rows when they are given, so the two can
      // never disagree.
      const roversUsed = roverRows.length
        ? roverRows.filter(r => r.status === 'UTILIZED').length
        : (input.dgps_rovers ?? 0);

      const entry = (await db.query(
        `INSERT INTO survey_entries(org_id, survey_project_id, survey_village_id, entry_date,
           teams_deployed, dgps_base, dgps_rovers, notes,
           low_progress_reason, low_progress_remarks,
           punch_in_at, punch_out_at, punch_in_lat, punch_in_lng,
           punch_out_lat, punch_out_lng, created_by, updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17) RETURNING *`,
        [u.orgId, village.survey_project_id, input.survey_village_id, input.entry_date,
          input.teams_deployed ?? 0, input.dgps_base ?? 0, roversUsed,
          input.notes ?? null,
          input.low_progress_reason ?? null, input.low_progress_remarks ?? null,
          input.punch_in_at ?? null, input.punch_out_at ?? null,
          input.punch_in_lat ?? null, input.punch_in_lng ?? null,
          input.punch_out_lat ?? null, input.punch_out_lng ?? null, u.id])).rows[0];

      for (const r of roverRows) {
        await db.query(
          `INSERT INTO survey_entry_rovers(org_id, entry_id, asset_id, status,
             idle_reason, remarks, area_ac, employee_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [u.orgId, entry.id, r.asset_id, r.status,
            r.idle_reason ?? null, r.remarks ?? null, r.area_ac ?? null,
            r.employee_id ?? null]);
      }

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

  /**
   * Which crew had instruments sitting idle, and when (§59.5).
   *
   * Reported per village per day and summed into instrument-days, because
   * "six rovers" means something different over a day and over a fortnight.
   *
   * A day nobody filed a return is counted apart from a day reporting nothing
   * used. The first is a reporting failure and the kit may well have been
   * working; the second is somebody saying it sat there. They need different
   * conversations, so the figures keep them apart.
   */
  app.get('/api/v1/survey/projects/:id/rover-utilisation',
    { preHandler: guard('survey.read') }, async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const { q } = page(req);
      await projectOr404(pool, u.orgId, id, u);

      const to = String(q.to ?? today());
      const from = String(q.from ?? to);
      if (from > to) fail('VALIDATION_ERROR', 'The window starts after it ends', 422);
      const span = Math.round(
        (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
      if (span > 200) {
        fail('RANGE_TOO_WIDE',
          `That window is ${span} days. Narrow it — this is a day-by-day report.`, 422);
      }

      // One row per village per day an instrument was out, with what the crew
      // reported. A LEFT JOIN on the entry is what makes "no return filed"
      // distinguishable from "nothing used".
      const rows = (await pool.query(
        `WITH days AS (SELECT generate_series($3::date, $4::date, interval '1 day')::date AS d)
         SELECT sv.id AS survey_village_id, v.name AS village_name,
                m.name AS mandal_name, days.d AS on_date,
                count(ra.id)::int AS allocated,
                e.dgps_rovers AS used,
                (e.id IS NOT NULL) AS reported
         FROM survey_villages sv
         JOIN org_units v ON v.id = sv.village_id
         LEFT JOIN org_units m ON m.id = v.parent_id
         CROSS JOIN days
         LEFT JOIN survey_rover_allocations ra
           ON ra.survey_village_id = sv.id
          AND ra.allocated_on <= days.d
          AND (ra.released_on IS NULL OR ra.released_on >= days.d)
         LEFT JOIN survey_entries e
           ON e.survey_village_id = sv.id AND e.entry_date = days.d
         WHERE sv.org_id = $1 AND sv.survey_project_id = $2
         GROUP BY sv.id, v.name, m.name, days.d, e.id, e.dgps_rovers
         ORDER BY m.name, v.name, days.d`,
        [u.orgId, id, from, to])).rows;

      // The crew on each village, so the row names who to ask.
      const crew = (await pool.query(
        `SELECT c.survey_village_id,
                COALESCE(NULLIF(trim(concat_ws(' ', e.first_name, e.last_name)), ''), e.emp_no)
                  AS employee_name
         FROM survey_crew c
         JOIN employees e ON e.id = c.employee_id
         JOIN survey_villages sv ON sv.id = c.survey_village_id
         WHERE sv.survey_project_id = $1 AND c.org_id = $2 AND c.released_on IS NULL
         ORDER BY employee_name`, [id, u.orgId])).rows;
      const crewBy = new Map<string, string[]>();
      for (const c of crew) {
        const key = String(c.survey_village_id);
        if (!crewBy.has(key)) crewBy.set(key, []);
        crewBy.get(key)!.push(String(c.employee_name));
      }

      const byVillage = new Map<string, {
        village: string; mandal: string | null;
        days: Array<{ date: string; allocated: number; used: number | null }>;
      }>();
      for (const r of rows) {
        const key = String(r.survey_village_id);
        if (!byVillage.has(key)) {
          byVillage.set(key, {
            village: String(r.village_name),
            mandal: r.mandal_name ? String(r.mandal_name) : null,
            days: [],
          });
        }
        byVillage.get(key)!.days.push({
          date: iso(r.on_date)!,
          allocated: Number(r.allocated),
          used: r.reported ? Number(r.used ?? 0) : null,
        });
      }

      const villages = [...byVillage.entries()].map(([key, v]) => ({
        survey_village_id: key,
        village: v.village,
        mandal: v.mandal,
        crew: crewBy.get(key) ?? [],
        ...roverWindow(v.days),
        // Kept so a single bad day can be found inside a month's window.
        days: v.days.filter(d => d.allocated > 0),
      }));

      // Worst offender first: most idle instrument-days, then the most simply
      // unaccounted for.
      const ranked = rankByWaste(villages);

      // The same window rolled up per day, for the programme as a whole.
      const perDay = new Map<string, { allocated: number; used: number; reported: boolean }>();
      for (const r of rows) {
        const d = iso(r.on_date)!;
        if (!perDay.has(d)) perDay.set(d, { allocated: 0, used: 0, reported: false });
        const slot = perDay.get(d)!;
        slot.allocated += Number(r.allocated);
        if (r.reported) { slot.used += Number(r.used ?? 0); slot.reported = true; }
      }

      return {
        data: {
          from, to,
          villages: ranked,
          days: [...perDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, s]) => ({
            date, ...roverUtilisation({ allocated: s.allocated, used: s.used }),
          })),
          total: roverWindow(
            [...byVillage.values()].flatMap(v => v.days)),
        },
      };
    });

  /**
   * A village's whole stage history (§59.5).
   *
   * The worked example in the specification is a village that took nine days
   * in GT, two in QC and five in vectorization. None of that is answerable
   * from the current state of a stage, which has forgotten everything before
   * now.
   */
  app.get('/api/v1/survey/villages/:id/history', { preHandler: guard('survey.read') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      await inOrg(pool, 'survey_villages', id, u.orgId);
      const rows = (await pool.query(
        `SELECT h.*, s.code AS stage_code, s.label AS stage_label, s.display_order,
                COALESCE(NULLIF(trim(concat_ws(' ', e.first_name, e.last_name)), ''), us.username)
                  AS changed_by_name
         FROM survey_stage_history h
         JOIN survey_stages s ON s.id = h.stage_id
         LEFT JOIN users us ON us.id = h.changed_by
         LEFT JOIN employees e ON e.id = us.employee_id
         WHERE h.survey_village_id = $1 AND h.org_id = $2
         ORDER BY h.changed_at`, [id, u.orgId])).rows;

      // How long each stage has taken, which is the question behind the
      // history rather than the list of movements itself.
      const durations: Record<string, { startedOn: string | null; completedOn: string | null; days: number | null }> = {};
      for (const r of rows) {
        const code = String(r.stage_code);
        if (!durations[code]) durations[code] = { startedOn: null, completedOn: null, days: null };
        const at = iso(r.changed_at);
        if (r.to_state === 'IN_PROGRESS' && !durations[code].startedOn) durations[code].startedOn = at;
        if (r.to_state === 'COMPLETED') durations[code].completedOn = at;
      }
      for (const d of Object.values(durations)) {
        if (d.startedOn && d.completedOn) {
          d.days = Math.round(
            (Date.parse(`${d.completedOn}T00:00:00Z`) - Date.parse(`${d.startedOn}T00:00:00Z`))
            / 86_400_000);
        }
      }

      return {
        data: {
          movements: rows.map(r => ({ ...r, changed_at: r.changed_at, on_date: iso(r.changed_at) })),
          durations,
        },
      };
    });

  /**
   * Put a village on hold, or send it back for rework.
   *
   * Neither is a point on the pipeline: a village in rework has been through
   * it and come back. Both are decisions somebody made, so both demand a
   * reason and both are recorded in the history.
   */
  app.post('/api/v1/survey/villages/:id/status', { preHandler: guard('survey.manage') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(villageStatusSchema, req.body);
      return {
        data: await mutate(pool, req, 'survey.village.status', 'survey_village', async db => {
          const row = await inOrg(db, 'survey_villages', id, u.orgId, true);
          version(req, row as { version: number });
          await db.query(
            `INSERT INTO survey_stage_history(org_id, survey_village_id, stage_id,
               from_state, to_state, remarks, changed_by)
             SELECT $1, $2, s.id, $3, $4, $5, $6 FROM survey_stages s
             WHERE s.org_id = $1 AND s.code = 'REWORK' LIMIT 1`,
            [u.orgId, id, row.status_override ?? 'DERIVED',
              input.status_override ?? 'DERIVED', input.status_remarks ?? null, u.id]);
          return (await db.query(
            `UPDATE survey_villages SET status_override = $2, status_remarks = $3,
               version = version + 1, updated_at = now(), updated_by = $4
             WHERE id = $1 RETURNING *`,
            [id, input.status_override, input.status_remarks ?? null, u.id])).rows[0];
        }),
      };
    });

  /**
   * The extent and the date somebody expects (§59, §25 of the specification).
   *
   * Entered when ground truthing starts, because the import often arrives
   * with the extent column empty, and editable afterwards. Kept apart from
   * the projected date, which is arithmetic and belongs to nobody.
   */
  /**
   * Correcting what the programme records about a village (§note 3).
   *
   * The extent, the allotted instruments and the old code — the fields that
   * arrive wrong from a work list and are otherwise only fixable by
   * re-importing the whole file. The village's own name is editable too,
   * since a misspelling in the source list follows it everywhere.
   *
   * Not the village's place in the hierarchy: moving a village between
   * mandals changes what every report it has ever appeared in means, and
   * that is not a correction, it is a different village.
   */
  app.patch('/api/v1/survey/villages/:id', { preHandler: guard('survey.manage') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(surveyVillageEditSchema, req.body);
      return mutate(pool, req, 'survey.village.update', 'survey_village', async db => {
        const row = await inOrg(db, 'survey_villages', id, u.orgId, true);
        version(req, row as { version: number });
        if (input.village_name) {
          await db.query('UPDATE org_units SET name = $2, updated_at = now() WHERE id = $1',
            [row.village_id, input.village_name]);
        }
        const updated = (await db.query(
          `UPDATE survey_villages SET
             total_extent_ac = COALESCE($2, total_extent_ac),
             dgps_base = COALESCE($3, dgps_base),
             dgps_rovers = COALESCE($4, dgps_rovers),
             teams = COALESCE($5, teams),
             vill_code_old = COALESCE($6, vill_code_old),
             version = version + 1, updated_at = now(), updated_by = $7
           WHERE id = $1 RETURNING *`,
          [id, input.total_extent_ac ?? null, input.dgps_base ?? null,
            input.dgps_rovers ?? null, input.teams ?? null,
            input.vill_code_old ?? null, u.id])).rows[0];
        return { ...updated, total_extent_ac: num(updated.total_extent_ac) };
      });
    });

  app.patch('/api/v1/survey/villages/:id/plan', { preHandler: guard('survey.manage') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(villagePlanSchema, req.body);
      return {
        data: await mutate(pool, req, 'survey.village.plan', 'survey_village', async db => {
          const row = await inOrg(db, 'survey_villages', id, u.orgId, true);
          version(req, row as { version: number });
          const sets: string[] = [], values: unknown[] = [id];
          for (const key of ['total_extent_ac', 'expected_completion_on', 'planned_start_on'] as const) {
            if (input[key] !== undefined) { values.push(input[key]); sets.push(`${key} = $${values.length}`); }
          }
          if (!sets.length) return row;
          values.push(u.id);
          return (await db.query(
            `UPDATE survey_villages SET ${sets.join(', ')}, version = version + 1,
               updated_at = now(), updated_by = $${values.length}
             WHERE id = $1 RETURNING *`, values)).rows[0];
        }),
      };
    });

  /* ------------------------------------------- who is on the programme */

  app.get('/api/v1/survey/projects/:id/employees', { preHandler: guard('survey.read') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      await projectOr404(pool, u.orgId, id, u);
      const rows = (await pool.query(
        `SELECT pe.*, e.emp_no,
                COALESCE(NULLIF(trim(concat_ws(' ', e.first_name, e.last_name)), ''), e.emp_no)
                  AS employee_name,
                e.phone
         FROM survey_project_employees pe
         JOIN employees e ON e.id = pe.employee_id
         WHERE pe.survey_project_id = $1 AND pe.org_id = $2
         ORDER BY pe.project_role, employee_name`, [id, u.orgId])).rows;
      return {
        data: rows.map(r => ({
          ...r, assigned_on: iso(r.assigned_on), released_on: iso(r.released_on),
          active: !r.released_on,
        })),
      };
    });

  /**
   * Put an employee on a programme (§33 of the specification).
   *
   * An employee belongs to several and sees only those. Without this there
   * was nothing for project-scoped visibility to scope by.
   */
  app.post('/api/v1/survey/projects/:id/employees', { preHandler: guard('survey.assign') },
    async (req, reply) => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(projectEmployeeSchema, req.body);
      const row = await mutate(pool, req, 'survey.project.assign', 'survey_project_employee',
        async db => {
          await projectOr404(db, u.orgId, id);
          await inOrg(db, 'employees', input.employee_id, u.orgId);
          return (await db.query(
            `INSERT INTO survey_project_employees(org_id, survey_project_id, employee_id,
               project_role, assigned_on, created_by)
             VALUES($1,$2,$3,$4,COALESCE($5::date, CURRENT_DATE),$6)
             ON CONFLICT (survey_project_id, employee_id)
             DO UPDATE SET project_role = EXCLUDED.project_role, released_on = NULL
             RETURNING *`,
            [u.orgId, id, input.employee_id, input.project_role,
              input.assigned_on ?? null, u.id])).rows[0];
        });
      reply.code(201);
      return { data: row };
    });

  /**
   * What each employee produced (§28 of the specification).
   *
   * Derived entirely from the daily returns. Nothing here is entered: an
   * output figure somebody types is a figure somebody chose.
   */
  app.get('/api/v1/survey/projects/:id/employee-productivity',
    { preHandler: guard('survey.read') }, async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const { q } = page(req);
      await projectOr404(pool, u.orgId, id, u);
      const to = String(q.to ?? today());
      const from = String(q.from ?? '1900-01-01');

      const rows = (await pool.query(
        `SELECT e.id AS employee_id, e.emp_no,
                COALESCE(NULLIF(trim(concat_ws(' ', e.first_name, e.last_name)), ''), e.emp_no)
                  AS employee_name,
                count(DISTINCT er.entry_id)::int             AS days_worked,
                count(DISTINCT se.survey_village_id)::int    AS villages_worked,
                COALESCE(sum(er.area_ac), 0)::numeric        AS area_ac,
                count(*) FILTER (WHERE er.status = 'UTILIZED')::int AS rover_days_used,
                count(*) FILTER (WHERE er.status = 'IDLE')::int     AS rover_days_idle,
                count(DISTINCT er.asset_id)::int             AS rovers_used,
                count(DISTINCT se.id) FILTER (WHERE se.low_progress_reason IS NOT NULL)::int
                  AS low_progress_days
         FROM survey_entry_rovers er
         JOIN survey_entries se ON se.id = er.entry_id
         JOIN employees e ON e.id = er.employee_id
         WHERE se.org_id = $1 AND se.survey_project_id = $2
           AND se.entry_date BETWEEN $3::date AND $4::date
         GROUP BY e.id, e.emp_no, e.first_name, e.last_name
         ORDER BY area_ac DESC`, [u.orgId, id, from, to])).rows;

      return {
        data: {
          from, to,
          employees: rows.map(r => {
            const days = Number(r.days_worked);
            const area = Number(r.area_ac);
            const roverDays = Number(r.rover_days_used) + Number(r.rover_days_idle);
            return {
              ...r,
              area_ac: round2(area),
              // Per day worked, not per calendar day: this measures the
              // person, and the days they were not out are not theirs.
              avg_daily_ac: days > 0 ? round2(area / days) : null,
              rover_utilisation_pct: roverDays > 0
                ? round2((Number(r.rover_days_used) / roverDays) * 100) : null,
            };
          }),
        },
      };
    });

  /**
   * What each rover did (§29 of the specification).
   *
   * Idle days are grouped by the reason given, because "three idle days" is
   * a number and "three idle days, all rover fault" is a maintenance job.
   */
  app.get('/api/v1/survey/projects/:id/rover-productivity',
    { preHandler: guard('survey.read') }, async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const { q } = page(req);
      await projectOr404(pool, u.orgId, id, u);
      const to = String(q.to ?? today());
      const from = String(q.from ?? '1900-01-01');

      const rows = (await pool.query(
        `SELECT a.id AS asset_id, a.asset_code, a.name AS asset_name, a.serial_number,
                count(*) FILTER (WHERE er.status = 'UTILIZED')::int AS utilized_days,
                count(*) FILTER (WHERE er.status = 'IDLE')::int     AS idle_days,
                COALESCE(sum(er.area_ac), 0)::numeric               AS area_ac,
                count(DISTINCT se.survey_village_id)::int           AS villages,
                count(DISTINCT er.employee_id)::int                 AS employees
         FROM survey_entry_rovers er
         JOIN survey_entries se ON se.id = er.entry_id
         JOIN assets a ON a.id = er.asset_id
         WHERE se.org_id = $1 AND se.survey_project_id = $2
           AND se.entry_date BETWEEN $3::date AND $4::date
         GROUP BY a.id, a.asset_code, a.name, a.serial_number
         ORDER BY idle_days DESC, area_ac DESC`, [u.orgId, id, from, to])).rows;

      const reasons = (await pool.query(
        `SELECT er.asset_id, er.idle_reason, count(*)::int AS days
         FROM survey_entry_rovers er
         JOIN survey_entries se ON se.id = er.entry_id
         WHERE se.org_id = $1 AND se.survey_project_id = $2
           AND se.entry_date BETWEEN $3::date AND $4::date
           AND er.status = 'IDLE'
         GROUP BY er.asset_id, er.idle_reason`, [u.orgId, id, from, to])).rows;
      const byAsset = new Map<string, Array<{ reason: string; label: string; days: number }>>();
      for (const r of reasons) {
        const key = String(r.asset_id);
        if (!byAsset.has(key)) byAsset.set(key, []);
        byAsset.get(key)!.push({
          reason: String(r.idle_reason), label: reasonLabel(r.idle_reason), days: Number(r.days),
        });
      }

      return {
        data: {
          from, to,
          rovers: rows.map(r => {
            const assigned = Number(r.utilized_days) + Number(r.idle_days);
            return {
              ...r,
              area_ac: round2(Number(r.area_ac)),
              assigned_days: assigned,
              utilisation_pct: assigned > 0
                ? round2((Number(r.utilized_days) / assigned) * 100) : null,
              idle_reasons: (byAsset.get(String(r.asset_id)) ?? [])
                .sort((a, b) => b.days - a.days),
            };
          }),
        },
      };
    });

  /**
   * Who and what is on this programme, at whatever level is being asked
   * about (§note 3).
   *
   * "Show me the people and the equipment on this project at village, mandal
   * and district level" is one question, and until now it took four screens
   * and a spreadsheet: crew per village here, rover allocations there,
   * employees on the programme somewhere else, and nothing joined them up.
   *
   * People come from two places on purpose. Crew are assigned to a *village*
   * and roll up from there; programme staff are assigned to the programme
   * and belong to every level of it. Counting only the first understates a
   * district that has a manager and no crew yet; counting only the second
   * flattens the village detail the question asks for.
   */
  app.get('/api/v1/survey/projects/:id/deployment',
    { preHandler: guard('survey.read') }, async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const { q } = page(req);
      await projectOr404(pool, u.orgId, id, u);
      const level = (REPORT_LEVELS as readonly string[]).includes(String(q.level))
        ? String(q.level) as ReportLevel : 'mandal';

      const rows = (await pool.query(
        `WITH scope AS (
           SELECT sv.id AS survey_village_id, sv.village_id,
                  ou.name AS village_name,
                  m.id AS mandal_id, m.name AS mandal_name,
                  d.id AS district_id, d.name AS district_name
             FROM survey_villages sv
             JOIN org_units ou ON ou.id = sv.village_id
             LEFT JOIN org_units m ON m.id = ou.parent_id
             LEFT JOIN org_units d ON d.id = COALESCE(
               (SELECT parent_id FROM org_units WHERE id = m.parent_id), m.parent_id)
            WHERE sv.survey_project_id = $1 AND sv.org_id = $2
         )
         SELECT
           CASE $3
             WHEN 'village'  THEN s.village_id
             WHEN 'district' THEN s.district_id
             ELSE s.mandal_id
           END AS unit_id,
           CASE $3
             WHEN 'village'  THEN s.village_name
             WHEN 'district' THEN s.district_name
             ELSE s.mandal_name
           END AS unit_name,
           count(DISTINCT s.survey_village_id)::int AS villages,
           -- Crew on the villages in this unit.
           count(DISTINCT c.employee_id) FILTER (WHERE c.released_on IS NULL)::int AS crew,
           -- Equipment currently out against those villages.
           count(DISTINCT r.asset_id) FILTER (WHERE r.released_on IS NULL)::int AS rovers_out,
           COALESCE(json_agg(DISTINCT jsonb_build_object(
             'employee_id', c.employee_id,
             'name', COALESCE(NULLIF(trim(concat_ws(' ', e.first_name, e.last_name)),''), e.emp_no),
             'emp_no', e.emp_no
           )) FILTER (WHERE c.employee_id IS NOT NULL AND c.released_on IS NULL), '[]') AS people,
           COALESCE(json_agg(DISTINCT jsonb_build_object(
             'asset_id', r.asset_id, 'asset_code', a.asset_code, 'name', a.name
           )) FILTER (WHERE r.asset_id IS NOT NULL AND r.released_on IS NULL), '[]') AS assets
         FROM scope s
         LEFT JOIN survey_crew c ON c.survey_village_id = s.survey_village_id
         LEFT JOIN employees e ON e.id = c.employee_id
         LEFT JOIN survey_rover_allocations r ON r.survey_village_id = s.survey_village_id
         LEFT JOIN assets a ON a.id = r.asset_id
         GROUP BY 1, 2
         ORDER BY 2`, [id, u.orgId, level])).rows;

      // Staff put on the programme itself rather than on a village. They
      // belong to every level of it, so they are reported once alongside
      // rather than divided arbitrarily between units.
      const programmeStaff = (await pool.query(
        `SELECT pe.employee_id, pe.project_role,
                COALESCE(NULLIF(trim(concat_ws(' ', e.first_name, e.last_name)),''), e.emp_no) AS name,
                e.emp_no
           FROM survey_project_employees pe
           JOIN employees e ON e.id = pe.employee_id
          WHERE pe.survey_project_id = $1 AND pe.org_id = $2 AND pe.released_on IS NULL
          ORDER BY name`, [id, u.orgId])).rows;

      return {
        data: {
          level,
          units: rows.map(r => ({
            ...r,
            id: r.unit_id, name: r.unit_name ?? 'Not attributed',
          })),
          programme_staff: programmeStaff,
          totals: {
            villages: rows.reduce((t, r) => t + Number(r.villages), 0),
            crew: new Set(rows.flatMap(r =>
              (r.people as Array<{ employee_id: string }>).map(p => p.employee_id))).size,
            assets: new Set(rows.flatMap(r =>
              (r.assets as Array<{ asset_id: string }>).map(a => a.asset_id))).size,
            programme_staff: programmeStaff.length,
          },
        },
      };
    });

  /**
   * Who was on site and did not file the day's return (§59, phase 2).
   *
   * Attendance already knows who turned up and which village for. Set against
   * the returns actually filed, that difference is the supervisor's chase
   * list, and nothing else produces it: a village with nobody on it is not
   * behind, while a village with four people on it and no return is.
   *
   * A punch that carried a reason is listed with the reason rather than
   * hidden. "No signal all day" is an answer, but a fortnight of it is a
   * finding, and it can only be seen if the days are still on the list.
   */
  app.get('/api/v1/survey/projects/:id/unfiled',
    { preHandler: guard('survey.read') }, async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const { q } = page(req);
      await projectOr404(pool, u.orgId, id, u);
      const from = String(q.from ?? today());
      const to = String(q.to ?? from);

      const rows = (await pool.query(
        `WITH punches AS (
           SELECT ae.survey_village_id,
                  (ae.client_timestamp AT TIME ZONE 'Asia/Kolkata')::date AS work_date,
                  ae.employee_id,
                  -- One person may punch more than once in a day; the reason
                  -- given at the last punch-out is the one that stands.
                  (array_agg(ae.progress_deferred_reason
                             ORDER BY ae.server_timestamp DESC)
                   FILTER (WHERE ae.progress_deferred_reason IS NOT NULL))[1] AS reason,
                  (array_agg(ae.progress_deferred_remarks
                             ORDER BY ae.server_timestamp DESC)
                   FILTER (WHERE ae.progress_deferred_remarks IS NOT NULL))[1] AS remarks
           FROM attendance_events ae
           WHERE ae.survey_village_id IS NOT NULL
             AND (ae.client_timestamp AT TIME ZONE 'Asia/Kolkata')::date
                 BETWEEN $2::date AND $3::date
           GROUP BY 1, 2, 3
         )
         SELECT p.work_date, p.survey_village_id, p.reason, p.remarks,
                ou.name AS village_name, ou.code AS village_code,
                m.name AS mandal_name,
                COALESCE(NULLIF(trim(concat_ws(' ', e.first_name, e.last_name)), ''),
                         e.emp_no) AS employee_name,
                e.emp_no
         FROM punches p
         JOIN survey_villages sv ON sv.id = p.survey_village_id
         JOIN org_units ou ON ou.id = sv.village_id
         LEFT JOIN org_units m ON m.id = ou.parent_id
         JOIN employees e ON e.id = p.employee_id
         WHERE sv.survey_project_id = $1 AND sv.org_id = $4
           AND NOT EXISTS (
             SELECT 1 FROM survey_entries se
             WHERE se.survey_village_id = p.survey_village_id
               AND se.entry_date = p.work_date)
         ORDER BY p.work_date DESC, village_name, employee_name`,
        [id, from, to, u.orgId])).rows;

      return {
        data: rows.map(r => ({ ...r, work_date: iso(r.work_date) })),
        from, to,
        // Days accounted for are still outstanding; the distinction is what
        // makes the list worth reading twice.
        accounted: rows.filter(r => r.reason).length,
        unexplained: rows.filter(r => !r.reason).length,
      };
    });

  /**
   * Where the work has stalled (§26 of the specification).
   *
   * Every reason a village is stuck is reported, not just the first: past its
   * date *and* with idle rovers is a different conversation from merely late.
   */
  app.get('/api/v1/survey/projects/:id/bottlenecks',
    { preHandler: guard('survey.read') }, async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const { q } = page(req);
      const programme = await projectOr404(pool, u.orgId, id, u);
      const asOf = String(q.as_of ?? today());

      const [pipeline, pos] = await Promise.all([
        stagePipeline(pool, u.orgId), positions(pool, u.orgId, id, { asOf }),
      ]);
      const codes = pipeline.map(p => p.code);

      // When each village last filed anything, and how long its current stage
      // has been sitting.
      const activity = (await pool.query(
        `SELECT sv.id,
                max(se.entry_date) AS last_entry_on,
                (SELECT max(h.changed_at) FROM survey_stage_history h
                  WHERE h.survey_village_id = sv.id) AS last_move_at,
                (SELECT COALESCE(sum(CASE WHEN er.status='IDLE' THEN 1 ELSE 0 END),0)
                   FROM survey_entry_rovers er
                   JOIN survey_entries e2 ON e2.id = er.entry_id
                  WHERE e2.survey_village_id = sv.id)::int AS idle_rover_days
         FROM survey_villages sv
         LEFT JOIN survey_entries se ON se.survey_village_id = sv.id
         WHERE sv.org_id = $1 AND sv.survey_project_id = $2
         GROUP BY sv.id`, [u.orgId, id])).rows;
      const act = new Map(activity.map(a => [String(a.id), a]));

      const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
      const found = findBottlenecks(pos.map(p => {
        const a = act.get(p.villageId);
        const lastMove = a?.last_move_at ? iso(a.last_move_at) : null;
        return {
          villageId: p.villageId,
          village: String(p.row.village_name),
          mandal: p.row.mandal_name ? String(p.row.mandal_name) : null,
          status: villageStatus(p.stages ?? {}, codes, p.row.status_override),
          currentStageCode: currentStage(p.stages ?? {}, pipeline)?.code ?? null,
          daysInStage: lastMove
            ? Math.round((asOfMs - Date.parse(`${lastMove}T00:00:00Z`)) / 86_400_000)
            : null,
          plannedStartOn: iso(p.row.planned_start_on),
          expectedCompletionOn: iso(p.row.expected_completion_on),
          lastEntryOn: a?.last_entry_on ? iso(a.last_entry_on) : null,
          idleRoverDays: Number(a?.idle_rover_days ?? 0),
        };
      }), {
        asOf,
        stageSlaDays: Number(programme.stage_sla_days ?? 14),
        silentDays: Number(q.silent_days) || 7,
      });

      return {
        data: {
          as_of: asOf,
          stage_sla_days: Number(programme.stage_sla_days ?? 14),
          bottlenecks: found,
          // Counted by kind, so a dashboard can say what sort of trouble the
          // programme is in rather than only how much.
          by_kind: found.reduce<Record<string, number>>((acc, b) => {
            for (const k of b.kinds) acc[k] = (acc[k] ?? 0) + 1;
            return acc;
          }, {}),
        },
      };
    });

  /**
   * Where the work will land (§25 of the specification).
   *
   * Behind its own permission. The specification is explicit that a GT user
   * does not see management forecasting, and a forecast that leaks to the
   * crew being measured by it stops being a planning tool.
   */
  app.get('/api/v1/survey/projects/:id/forecast',
    { preHandler: guard('survey.forecast') }, async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const { q } = page(req);
      const programme = await projectOr404(pool, u.orgId, id, u);
      const asOf = String(q.as_of ?? today());

      const [m, codes, pos] = await Promise.all([
        measures(pool, u.orgId), stageCodes(pool, u.orgId),
        positions(pool, u.orgId, id, { asOf }),
      ]);
      const whole = rollUp(pos, m.codes, codes, m.basis);

      const window = (await pool.query(
        `SELECT count(DISTINCT entry_date)::int AS active_days, min(entry_date) AS first_day
         FROM survey_entries
         WHERE org_id = $1 AND survey_project_id = $2 AND entry_date <= $3::date`,
        [u.orgId, id, asOf])).rows[0];
      const firstDay = iso(window.first_day) ?? asOf;
      const calendarDays = Math.max(1, Math.round(
        (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${firstDay}T00:00:00Z`)) / 86_400_000) + 1);

      const paceFigures = pace({
        surveyedAc: whole.surveyedAc,
        remainingAc: Math.max(0, whole.extentAc - whole.surveyedAc),
        villagesCompleted: whole.completed,
        activeDays: Number(window.active_days),
        calendarDays,
        asOf,
      });

      // The recent rates the specification asks for. A programme that has
      // sped up or slowed down is invisible in a lifetime average.
      const recent: Record<string, number | null> = {};
      for (const days of [7, 14, 30]) {
        const since = new Date(Date.parse(`${asOf}T00:00:00Z`) - days * 86_400_000)
          .toISOString().slice(0, 10);
        const row = (await pool.query(
          `SELECT COALESCE(sum(ev.quantity), 0)::numeric AS total
           FROM survey_entries e
           JOIN survey_entry_values ev ON ev.entry_id = e.id
           JOIN survey_measures mm ON mm.id = ev.measure_id AND mm.basis = 'EXTENT'
           WHERE e.org_id = $1 AND e.survey_project_id = $2
             AND e.entry_date > $3::date AND e.entry_date <= $4::date`,
          [u.orgId, id, since, asOf])).rows[0];
        recent[`last_${days}_days_ac_per_day`] = round2(Number(row.total) / days);
      }

      const projected = forecast({
        targetDate: iso(programme.target_completion_on),
        remainingAc: Math.max(0, whole.extentAc - whole.surveyedAc),
        acresPerCalendarDay: paceFigures.acresPerCalendarDay,
        asOf,
      });

      return {
        data: {
          as_of: asOf,
          extent_ac: whole.extentAc,
          surveyed_ac: whole.surveyedAc,
          remaining_ac: round2(Math.max(0, whole.extentAc - whole.surveyedAc)),
          // Village completion and area completion are different figures and
          // the specification is explicit that they must not be conflated.
          village_completion_pct: whole.villages > 0
            ? round2((whole.completed / whole.villages) * 100) : null,
          area_completion_pct: whole.overallPct,
          pace: paceFigures,
          recent_pace: recent,
          forecast: projected,
        },
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
      await projectOr404(pool, u.orgId, id, u);

      const level = (REPORT_LEVELS as readonly string[]).includes(String(q.level))
        ? String(q.level) as ReportLevel : 'mandal';
      const asOf = String(q.to ?? q.as_of ?? today());
      const from = q.from ? String(q.from) : undefined;

      const [m, codes, pos, pipeline] = await Promise.all([
        measures(pool, u.orgId), stageCodes(pool, u.orgId),
        positions(pool, u.orgId, id, { asOf }),
        stagePipeline(pool, u.orgId),
      ]);

      // Rovers: allocated on the day against what the crews reported using.
      // Idle is the figure worth having, and neither half of it means
      // anything without the other.
      const roverRow = (await pool.query(
        `SELECT
           (SELECT count(*)::int FROM survey_rover_allocations ra
             JOIN survey_villages sv ON sv.id = ra.survey_village_id
            WHERE sv.survey_project_id = $2 AND ra.org_id = $1
              AND ra.allocated_on <= $3::date
              AND (ra.released_on IS NULL OR ra.released_on >= $3::date)) AS allocated,
           (SELECT COALESCE(sum(e.dgps_rovers), 0)::int FROM survey_entries e
            WHERE e.org_id = $1 AND e.survey_project_id = $2 AND e.entry_date = $3::date)
             AS used`,
        [u.orgId, id, asOf])).rows[0];
      const rovers = {
        as_of: asOf,
        ...roverUtilisation({
          allocated: Number(roverRow.allocated), used: Number(roverRow.used),
        }),
      };

      // Pace over the window asked for, defaulting to the programme's life.
      const paceWindow = (await pool.query(
        `SELECT count(DISTINCT e.entry_date)::int AS active_days,
                min(e.entry_date) AS first_day
         FROM survey_entries e
         WHERE e.org_id = $1 AND e.survey_project_id = $2
           AND e.entry_date <= $3::date ${from ? 'AND e.entry_date >= $4::date' : ''}`,
        from ? [u.orgId, id, asOf, from] : [u.orgId, id, asOf])).rows[0];
      const firstDay = iso(paceWindow.first_day) ?? asOf;
      const calendarDays = Math.max(1, Math.round(
        (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${firstDay}T00:00:00Z`)) / 86_400_000) + 1);
      const whole = rollUp(pos, m.codes, codes, m.basis);
      const paceFigures = pace({
        surveyedAc: whole.surveyedAc,
        remainingAc: Math.max(0, whole.extentAc - whole.surveyedAc),
        villagesCompleted: whole.completed,
        activeDays: Number(paceWindow.active_days),
        calendarDays,
        asOf,
      });

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
          // How many villages sit at each state of each stage. The overall
          // village state cannot answer this: "in progress" covers a village
          // on its first day of GT and one waiting for its LPM.
          by_stage: tallyByStage(g.items, pipeline),
          // Villages whose stages have been moved out of order. Reported
          // rather than prevented, because the task board drives the state
          // and the board is not this module's to police.
          out_of_sequence: g.items
            .filter(i => outOfSequence(i.stages ?? {}, pipeline).length > 0).length,
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
          by_stage: tallyByStage(pos, pipeline),
          rovers,
          pace: paceFigures,
          pipeline: pipeline.map(st => ({
            code: st.code, label: st.label, requires: st.requires ?? null,
            tracks_daily_progress: Boolean(st.tracksDailyProgress),
          })),
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
  /**
   * The daily, weekly and monthly report (§23).
   *
   * One endpoint rather than three, because "what happened in this period"
   * is one question asked at three sizes, and three endpoints would be three
   * places for the same arithmetic to drift apart.
   *
   * What makes it a report rather than a series is the comparison. Four
   * hundred acres this week means nothing on its own; beside last week's
   * three hundred and twenty it means something somebody acts on. The
   * timeline endpoint next door answers a different question -- it draws a
   * line through many periods -- and neither replaces the other.
   *
   * The period is always whole. A weekly report run on Wednesday covers
   * Monday to Sunday, not Monday to Wednesday: clipping it to today would
   * make every week-on-week comparison compare three days against seven.
   */
  app.get('/api/v1/survey/projects/:id/report', { preHandler: guard('survey.read') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const { q } = page(req);
      const programme = await projectOr404(pool, u.orgId, id, u);

      const grain = (PERIOD_GRAINS as readonly string[]).includes(String(q.grain))
        ? String(q.grain) as PeriodGrain : 'DAY';
      const asOf = String(q.as_of ?? today());
      const period = periodContaining(asOf, grain);
      const prior = previousPeriod(period, grain);
      const level = (REPORT_LEVELS as readonly string[]).includes(String(q.level))
        ? String(q.level) as ReportLevel : 'mandal';

      const m = await measures(pool, u.orgId);
      const pipeline = await stagePipeline(pool, u.orgId);

      /** What was recorded in one window, by measure and by village. */
      async function totals(from: string, to: string) {
        return (await pool.query(
          `SELECT e.survey_village_id, mm.code AS measure_code,
                  sum(ev.quantity) AS total
           FROM survey_entries e
           JOIN survey_entry_values ev ON ev.entry_id = e.id
           JOIN survey_measures mm ON mm.id = ev.measure_id
           WHERE e.org_id = $1 AND e.survey_project_id = $2
             AND e.entry_date >= $3::date AND e.entry_date <= $4::date
           GROUP BY 1, 2`, [u.orgId, id, from, to])).rows;
      }

      const [now, before, days, rovers, moved] = await Promise.all([
        totals(period.from, period.to),
        totals(prior.from, prior.to),
        // Days actually worked, which is what a pace figure must divide by.
        // Dividing by calendar days reports a crew that worked four days as
        // though it had worked seven and understates them by nearly half.
        pool.query(
          `SELECT count(DISTINCT e.entry_date)::int AS active_days,
                  count(DISTINCT e.survey_village_id)::int AS villages,
                  COALESCE(sum(e.teams_deployed), 0)::int AS team_days
           FROM survey_entries e
           WHERE e.org_id = $1 AND e.survey_project_id = $2
             AND e.entry_date >= $3::date AND e.entry_date <= $4::date`,
          [u.orgId, id, period.from, period.to]),
        pool.query(
          `SELECT count(*) FILTER (WHERE r.status = 'UTILIZED')::int AS used,
                  count(*) FILTER (WHERE r.status = 'IDLE')::int AS idle,
                  COALESCE(json_agg(DISTINCT r.idle_reason)
                    FILTER (WHERE r.idle_reason IS NOT NULL), '[]') AS idle_reasons
           FROM survey_entry_rovers r
           JOIN survey_entries e ON e.id = r.entry_id
           WHERE e.org_id = $1 AND e.survey_project_id = $2
             AND e.entry_date >= $3::date AND e.entry_date <= $4::date`,
          [u.orgId, id, period.from, period.to]),
        // Stages that moved in the period. A report of quantities alone
        // cannot show that four villages finished ground truthing, which is
        // usually the first thing anybody asks.
        pool.query(
          `SELECT s.code AS stage_code, s.label AS stage_label, h.to_state,
                  count(DISTINCT h.survey_village_id)::int AS villages
           FROM survey_stage_history h
           JOIN survey_stages s ON s.id = h.stage_id
           JOIN survey_villages sv ON sv.id = h.survey_village_id
           WHERE h.org_id = $1 AND sv.survey_project_id = $2
             AND (h.changed_at AT TIME ZONE 'Asia/Kolkata')::date
                 BETWEEN $3::date AND $4::date
           GROUP BY 1, 2, 3, s.display_order
           ORDER BY s.display_order`,
          [u.orgId, id, period.from, period.to]),
      ]);

      const sumBy = (rows: Array<Record<string, any>>, code: string) =>
        rows.filter(r => r.measure_code === code)
          .reduce((t, r) => t + Number(r.total ?? 0), 0);

      // Positions as at the end of the period, so the cumulative column is
      // the programme as it stood then rather than as it stands now. A report
      // for last month that moves every time it is re-run is not a report.
      const pos = await positions(pool, u.orgId, id, { asOf: period.to });
      const overall = rollUp(pos, m.codes, pipeline.map(p => p.code), m.basis);

      const byVillage = new Map(pos.map(p => [p.villageId, p]));
      const groups = new Map<string, { name: string; villages: string[] }>();
      for (const p of pos) {
        const unit = level === 'village' ? { id: p.villageId, name: p.row.village_name }
          : level === 'mandal' ? { id: p.row.mandal_id, name: p.row.mandal_name }
            : level === 'division' ? { id: p.row.division_id, name: p.row.division_name }
              : { id: p.row.district_id, name: p.row.district_name };
        const key = unit?.id ?? '__unattributed__';
        if (!groups.has(key)) {
          groups.set(key, { name: unit?.name ?? 'Not attributed', villages: [] });
        }
        groups.get(key)!.villages.push(p.villageId);
      }

      const units = [...groups.entries()].map(([key, g]) => {
        const mine = new Set(g.villages);
        const inPeriod = now.filter(r => mine.has(String(r.survey_village_id)));
        const inPrior = before.filter(r => mine.has(String(r.survey_village_id)));
        return {
          id: key === '__unattributed__' ? null : key,
          name: g.name,
          villages: g.villages.length,
          period: Object.fromEntries(m.codes.map(c => [c, sumBy(inPeriod, c)])),
          previous: Object.fromEntries(m.codes.map(c => [c, sumBy(inPrior, c)])),
          // Where the programme stands at the end of the period, so the
          // report carries both the movement and the position.
          cumulative: rollUp(
            g.villages.map(v => byVillage.get(v)!).filter(Boolean),
            m.codes, pipeline.map(p => p.code), m.basis),
        };
      }).sort((a, b) => a.name.localeCompare(b.name));

      const extentCodes = m.codes.filter(c => m.basis[c] === 'EXTENT');
      const areaNow = extentCodes.reduce((t, c) => t + sumBy(now, c), 0);
      const areaBefore = extentCodes.reduce((t, c) => t + sumBy(before, c), 0);
      const activeDays = Number(days.rows[0]?.active_days ?? 0);

      return {
        data: {
          grain, level, as_of: asOf,
          period, previous_period: prior,
          programme: { id, name: programme.name, code: programme.code },
          // The headline, and the only line most people read.
          area: {
            ...comparePeriods(round2(areaNow), round2(areaBefore)),
            unit: 'Ac',
          },
          measures: Object.fromEntries(m.codes.map(c => [
            c, comparePeriods(round2(sumBy(now, c)), round2(sumBy(before, c))),
          ])),
          effort: {
            active_days: activeDays,
            calendar_days: Math.round(
              (Date.parse(`${period.to}T00:00:00Z`) - Date.parse(`${period.from}T00:00:00Z`))
              / 86_400_000) + 1,
            villages_worked: Number(days.rows[0]?.villages ?? 0),
            team_days: Number(days.rows[0]?.team_days ?? 0),
            // Per day actually worked, not per day on the calendar.
            area_per_active_day: activeDays ? round2(areaNow / activeDays) : null,
          },
          rovers: {
            utilised: Number(rovers.rows[0]?.used ?? 0),
            idle: Number(rovers.rows[0]?.idle ?? 0),
            idle_reasons: rovers.rows[0]?.idle_reasons ?? [],
          },
          stage_movements: moved.rows,
          units,
          overall,
        },
      };
    });

  app.get('/api/v1/survey/projects/:id/timeline', { preHandler: guard('survey.read') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const { q } = page(req);
      await projectOr404(pool, u.orgId, id, u);

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
      await projectOr404(pool, u.orgId, id, u);
      const [codes, pos, pipeline] = await Promise.all([
        stageCodes(pool, u.orgId), positions(pool, u.orgId, id),
        stagePipeline(pool, u.orgId),
      ]);

      return {
        data: pos.map(p => {
          const dates = p.row.stage_dates as Record<string,
            { started: string | null; completed: string | null; remarks?: string | null }>;
          const surveyed = (p.done.GOVT_LAND_EXTENT_AC ?? 0) + (p.done.PRIVATE_LAND_EXTENT_AC ?? 0);
          return {
            mandal: p.row.mandal_name,
            village: p.row.village_name,
            extent_ac: p.extentAc,
            extent_sq_km: p.extentAc === null ? null : acresToSqKm(p.extentAc),
            // Where the village has actually got to, which is the work
            // waiting rather than the work finished.
            current_stage: currentStage(p.stages ?? {}, pipeline)?.code ?? null,
            current_stage_state: currentStage(p.stages ?? {}, pipeline)?.state ?? null,
            // Why a village is stuck. "Two parcels disputed" is the reason it
            // sits at QC for three weeks, and it belongs on the sheet.
            stage_remarks: Object.fromEntries(
              Object.entries(dates).map(([code, d]) => [code, d.remarks ?? null])
                .filter(([, v]) => v !== null)),
            stages: p.stages ?? {},
            out_of_sequence: outOfSequence(p.stages ?? {}, pipeline),
            gt_status: p.stages?.GROUND_TRUTHING ?? 'NOT_STARTED',
            gt_qc_status: p.stages?.GT_QC ?? 'NOT_STARTED',
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
            // From the linked task, where there is one. The daily entry
            // records a team count; the task records the person.
            assignee_name: p.row.assignee_name ?? null,
            planned_start_date: iso(p.row.planned_start_date),
            planned_end_date: iso(p.row.planned_end_date),
          };
        }),
      };
    });
}
