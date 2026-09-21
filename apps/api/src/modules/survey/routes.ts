import type { FastifyInstance, FastifyRequest } from 'fastify';
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
  VILLAGE_LADDER, LADDER_NOTES, LADDER_LABELS, villagePosition, tallyByPosition,
  gtStartSchema,
  DELAY_REASON_CODES,
  stageVariance, varianceNote, villageVariances, gtReasonRequired, delayReasonLabel as dLabel,
  earnedMilestones, stageSignedOff, signOffFor,
  surveyContactSchema, surveyContactPatchSchema,
  surveyQuerySchema, surveyAnswerSchema,
  alertSubscriptionSchema, alertSubscriptionPatchSchema, ALERT_KINDS,
  crewAssignmentSchema, roverAllocationSchema, stageRemarkSchema, STAGE_PIPELINE,
  crewBulkAssignmentSchema, roverBulkAllocationSchema, roverAllocationEditSchema,
  villageMoveSchema,
  checkRoverDay, checkLowProgress, villageStatus, projectEmployeeSchema,
  forecast, findBottlenecks, delayReasonLabel as reasonLabel,
  villageStatusSchema, villagePlanSchema, delayReasonLabel, DELAY_REASONS,
  villageBillingSchema, villageBillingPatchSchema, MILESTONE_PERCENT,
  billingDecisionRequired, claimedPercent, type BillingStatus,
  villageBillingBulkSchema,
  summariseStaffing, stageTracksStaffing, priorRange, type StaffingDay,
  milestoneEarned, MILESTONE_REQUIRES, villageFinalsSchema,
  gcpSchema, gcpPatchSchema, checkGcp,
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

  /**
   * A date out of the query string, or a refusal somebody can act on.
   *
   * Every report here takes `from`, `to` or `as_of` and hands it straight to
   * Postgres as `$n::date`. A value that is not a date — a typo, a stale
   * bookmark, a spreadsheet pasting "N/A" — reaches the database, which
   * refuses it with an error nobody upstream is expecting, and the caller
   * gets a 500 and a stack trace where what they need is one sentence about
   * one field.
   *
   * Thirteen endpoints did this. The shape of the mistake was identical in
   * all of them, so the fix is one helper rather than thirteen guards.
   */
  function dateParam(
    req: FastifyRequest, value: unknown, name: string, fallback: string,
  ): string {
    if (value === undefined || value === null || value === '') return fallback;
    const raw = String(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      fail('VALIDATION_ERROR',
        `${name} must be a date written as YYYY-MM-DD. "${raw.slice(0, 40)}" is not one.`, 422);
    }
    // The shape is not the same thing as a date: 2026-13-01 and 2026-02-30
    // both match the pattern and both are refused by Postgres.
    const d = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
      fail('VALIDATION_ERROR', `${name} is not a real date: "${raw.slice(0, 40)}".`, 422);
    }
    return raw;
  }
  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

  /**
   * Who turned up against who was allotted, over a window (§067).
   *
   * One query and one shared summariser, so the report, the progress screen
   * and the village sheet cannot drift apart on what "82% attendance" means.
   * The allocation travels with each day rather than being applied
   * afterwards, because a village restaffed halfway through a month was
   * measured against one number then and another now.
   */
  async function staffingOver(
    db: Pool | PoolClient, orgId: string, projectId: string,
    from: string, to: string, villageIds?: string[],
  ) {
    const args: unknown[] = [orgId, projectId, from, to];
    let scope = '';
    if (villageIds) { args.push(villageIds); scope = ` AND e.survey_village_id = ANY($${args.length}::uuid[])`; }
    const rows = (await db.query(
      `SELECT e.govt_staff_present, e.crew_present,
              sv.gt_govt_staff_allocated, sv.gt_crew_allocated
         FROM survey_entries e
         JOIN survey_villages sv ON sv.id = e.survey_village_id
        WHERE e.org_id = $1 AND e.survey_project_id = $2
          AND e.entry_date BETWEEN $3::date AND $4::date${scope}`, args)).rows;
    return summariseStaffing(rows.map((r): StaffingDay => ({
      govtStaffPresent: r.govt_staff_present === null ? null : Number(r.govt_staff_present),
      crewPresent: r.crew_present === null ? null : Number(r.crew_present),
      govtStaffAllocated: r.gt_govt_staff_allocated === null
        ? null : Number(r.gt_govt_staff_allocated),
      crewAllocated: r.gt_crew_allocated === null ? null : Number(r.gt_crew_allocated),
    })));
  }

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
              gp.id AS grandparent_id, gp.type AS grandparent_type, gp.name AS grandparent_name,
              /*
               * What has been claimed against the village (§066).
               *
               * Carried on the village row rather than fetched per village:
               * the list is filtered on it — "show me everything where the
               * second claim is due" — and a thousand villages is a thousand
               * round trips otherwise. A returned claim counts for nothing,
               * because the milestone is owed again.
               */
              (SELECT COALESCE(json_agg(b.milestone ORDER BY b.milestone), '[]')
                 FROM survey_village_billing b
                WHERE b.survey_village_id = sv.id AND b.status <> 'REJECTED')
                AS claimed_milestones,
              (SELECT COALESCE(sum(b.percent), 0)
                 FROM survey_village_billing b
                WHERE b.survey_village_id = sv.id AND b.status <> 'REJECTED')
                AS claimed_percent
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
              vs.expected_start_on, vs.expected_end_on,
              vs.variance_reason, vs.variance_remarks,
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
    const stageDates = new Map<string, Record<string, {
      started: string | null; completed: string | null; remarks?: string | null;
      /* The plan and the reason it was missed (§072), so any screen showing a
         stage can show what was promised beside what happened. */
      expectedStart?: string | null; expectedEnd?: string | null;
      varianceReason?: string | null; varianceRemarks?: string | null;
    }>>();
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
        expectedStart: iso(s.expected_start_on),
        expectedEnd: iso(s.expected_end_on),
        varianceReason: s.variance_reason ?? null,
        varianceRemarks: s.variance_remarks ?? null,
      };
    }

    /*
     * Certified totals override the running sum, where somebody has set one
     * (§068).
     *
     * A finished village is recounted at handover, and the certified figure
     * is what goes to the department. Applied here so every roll-up,
     * percentage and report agrees on one answer; the daily sum is still on
     * the row beside it, so the difference is never hidden.
     *
     * Only for an unbounded read. A period report asks what was done *in*
     * those dates, and a certified total is a statement about the village,
     * not about the week — folding it into a period would put the whole
     * village's recount into whichever week somebody happened to certify it.
     */
    const certified = opts.from ? new Map<string, Record<string, number>>() :
      (await db.query(
        `SELECT f.survey_village_id, mm.code, f.quantity
           FROM survey_village_finals f
           JOIN survey_measures mm ON mm.id = f.measure_id
           JOIN survey_villages sv ON sv.id = f.survey_village_id
          WHERE f.org_id = $1 AND sv.survey_project_id = $2`, [orgId, projectId])).rows
        .reduce((acc, r) => {
          const key = String(r.survey_village_id);
          (acc.get(key) ?? acc.set(key, {}).get(key)!)[String(r.code)] = Number(r.quantity);
          return acc;
        }, new Map<string, Record<string, number>>());

    return rows.map(r => {
      const recorded = done.get(String(r.id)) ?? {};
      const final = certified.get(String(r.id));
      return {
        villageId: String(r.id),
        extentAc: num(r.total_extent_ac),
        done: final ? { ...recorded, ...final } : recorded,
        targets: target.get(String(r.id)) ?? {},
        stages: stage.get(String(r.id)) ?? {},
        row: {
          ...r,
          stage_dates: stageDates.get(String(r.id)) ?? {},
          // Kept beside the certified figure, never replaced by it.
          recorded_done: recorded,
          certified_done: final ?? null,
        },
      };
    });
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
    db: Pool | PoolClient, u: { orgId: string; id: string; permissions: string[]; roles?: string[] },
  ): Promise<string[] | null> {
    // A client is never on the programme's staff, whatever an enrolment row
    // says: what they are shown is the observer's view, through the routes
    // that serve it (see readsAsObserver), and none of the staff routes --
    // crews, claims, returns, productivity -- is theirs to read.
    if (clientOnly(u)) return [];
    if (u.permissions.includes('survey.manage')
      || u.permissions.includes('survey.forecast')) return null;
    const rows = (await db.query(
      `SELECT pe.survey_project_id AS id
       FROM survey_project_employees pe
       JOIN users usr ON usr.employee_id = pe.employee_id
       WHERE usr.id = $1 AND pe.org_id = $2 AND pe.released_on IS NULL
       UNION
       -- Being put on a village's crew is being on the programme, whatever
       -- the enrolment table says. Crews are assigned village by village from
       -- the village screen, which writes survey_crew and nothing else; read
       -- only the enrolment table and the people actually doing the work see
       -- an empty programme list and cannot file the day they just worked.
       SELECT sv.survey_project_id AS id
       FROM survey_crew sc
       JOIN survey_villages sv ON sv.id = sc.survey_village_id
       JOIN users usr ON usr.employee_id = sc.employee_id
       WHERE usr.id = $1 AND sc.org_id = $2 AND sc.released_on IS NULL`,
      [u.id, u.orgId])).rows;
    return rows.map(r => String(r.id));
  }

  /**
   * Somebody whose only role is CLIENT_VIEWER.
   *
   * The client holds survey.read -- the role is granted it so the survey
   * screen opens for them -- but survey.read is the staff permission and
   * carries crew names, rover codes and the claim register with it. What the
   * client is owed is what the department is owed: where the work has got
   * to. So a client reads as an observer, decided here from the role rather
   * than by withdrawing survey.read from a role other screens rely on.
   */
  function clientOnly(u: { roles?: string[] }): boolean {
    return Array.isArray(u.roles) && u.roles.length > 0
      && u.roles.every(r => r === 'CLIENT_VIEWER');
  }

  /** Whether this reader gets the observer's view: progress only. */
  function readsAsObserver(u: { permissions: string[]; roles?: string[] }): boolean {
    return !u.permissions.includes('survey.read') || clientOnly(u);
  }

  /**
   * The programmes a client may look at: those run against a project they
   * are assigned to. A client is scoped to projects everywhere else in the
   * system, and an observer's "every active programme in the organisation"
   * would show one client another client's work.
   */
  async function clientProgrammes(
    db: Pool | PoolClient, u: { orgId: string; scopes?: Array<{ scope_type: string | null; scope_id: string | null }> },
  ): Promise<string[]> {
    const projects = (u.scopes ?? [])
      .filter(s => s.scope_type === 'project' && s.scope_id)
      .map(s => String(s.scope_id));
    if (!projects.length) return [];
    return (await db.query(
      `SELECT id FROM survey_projects WHERE org_id = $1 AND project_id = ANY($2::uuid[])`,
      [u.orgId, projects])).rows.map(r => String(r.id));
  }

  /**
   * A programme, reached the way an observer reaches it: by permission, not
   * by enrolment -- and, for a client, only if it is one of theirs.
   */
  async function observerProgrammeOr404(
    db: Pool | PoolClient,
    u: { orgId: string; roles?: string[]; scopes?: Array<{ scope_type: string | null; scope_id: string | null }> },
    id: string,
  ) {
    const row = await inOrg(db, 'survey_projects', id, u.orgId);
    if (clientOnly(u) && !(await clientProgrammes(db, u)).includes(String(id))) {
      fail('NOT_FOUND', 'Not found', 404);
    }
    return row;
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

  /**
   * A village, and only if the caller may see the programme it belongs to.
   *
   * inOrg() answers "is this row in your organisation", which is a different
   * and weaker question. Every programme-addressed route already asks the
   * stronger one through projectOr404; the village-addressed routes were
   * asking only the weaker one, so a crew member on one programme could read
   * and write villages on every other programme in the organisation by
   * quoting the id. The scope belongs on the village too.
   */
  async function villageOr404(
    db: Pool | PoolClient, orgId: string, id: string,
    u: { orgId: string; id: string; permissions: string[] },
    lock = false,
  ) {
    const row = await inOrg(db, 'survey_villages', id, orgId, lock);
    const allowed = await visibleProgrammes(db, u);
    if (allowed !== null && !allowed.includes(String(row.survey_project_id))) {
      fail('NOT_FOUND', 'Not found', 404);
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

        const pending = villages.filter(v => !v.task_id);
        const skipped = villages.length - pending.length;

        /*
         * Counted, not written, when it is a preview.
         *
         * The preview used to do the entire job and roll it back, so asking
         * "what would this create" cost exactly as much as creating it —
         * which on this programme was over five minutes and a gateway
         * timeout. A count is arithmetic.
         */
        if (input.dry_run) {
          await db.query('ROLLBACK TO SAVEPOINT preview');
          return {
            dry_run: true,
            villages_considered: villages.length,
            village_tasks: pending.length,
            stage_tasks: input.include_stages ? pending.length * stages.length : 0,
            already_linked: skipped,
            project_id: programme.project_id,
          };
        }

        /*
         * Written in a handful of statements rather than eighteen per
         * village.
         *
         * A task, an update, then a subtask and a stage link for each of
         * eight stages: on 1,182 villages that was 21,276 round trips to a
         * database in another data centre, and the request died long before
         * it finished. The same work is four statements — the titles are
         * worked out here, where they always were, and handed over as arrays.
         */
        let villageTasks = 0, stageTasks = 0;

        if (pending.length > 0) {
          const plans = pending.map(v => ({
            surveyVillageId: String(v.id),
            villageId: String(v.village_id),
            plan: plannedTasksFor(
              { name: String(v.village_name), mandalName: v.mandal_name },
              stages.map(st => ({ code: String(st.code), label: String(st.label) })),
            ),
          }));

          const parents = (await db.query(
            `INSERT INTO tasks(org_id, project_id, title, status, village_id, created_by, updated_by)
             SELECT $1, $2, t.title, 'TO_DO', t.village_id::uuid, $5, $5
               FROM unnest($3::text[], $4::text[]) AS t(title, village_id)
             RETURNING id, village_id`,
            [u.orgId, programme.project_id,
              plans.map(p => p.plan.parent), plans.map(p => p.villageId), u.id])).rows;
          villageTasks = parents.length;

          // village_id is unique within one programme, so it identifies the
          // row the task belongs to without a second lookup.
          const taskByVillage = new Map(parents.map(r => [String(r.village_id), String(r.id)]));

          await db.query(
            `UPDATE survey_villages sv SET task_id = m.task_id::uuid, updated_at = now()
               FROM unnest($1::text[], $2::text[]) AS m(id, task_id)
              WHERE sv.id = m.id::uuid`,
            [plans.map(p => p.surveyVillageId),
              plans.map(p => taskByVillage.get(p.villageId) ?? null)]);

          if (input.include_stages) {
            const titles: string[] = [], parentIds: string[] = [],
              villageIds: string[] = [], surveyVillageIds: string[] = [], stageIds: string[] = [];
            for (const p of plans) {
              const parentId = taskByVillage.get(p.villageId);
              if (!parentId) continue;
              for (const child of p.plan.children) {
                const stage = stages.find(st => String(st.code) === child.stageCode);
                if (!stage) continue;
                titles.push(child.title);
                parentIds.push(parentId);
                villageIds.push(p.villageId);
                surveyVillageIds.push(p.surveyVillageId);
                stageIds.push(String(stage.id));
              }
            }

            if (titles.length > 0) {
              const subs = (await db.query(
                `INSERT INTO tasks(org_id, project_id, title, status, parent_task_id,
                   village_id, created_by, updated_by)
                 SELECT $1, $2, t.title, 'TO_DO', t.parent_id::uuid, t.village_id::uuid, $6, $6
                   FROM unnest($3::text[], $4::text[], $5::text[])
                        WITH ORDINALITY AS t(title, parent_id, village_id, ord)
                  ORDER BY t.ord
                 RETURNING id`,
                [u.orgId, programme.project_id, titles, parentIds, villageIds, u.id])).rows;
              stageTasks = subs.length;

              // RETURNING follows the insert order, which ORDER BY ord fixes,
              // so the nth task belongs to the nth stage link.
              await db.query(
                `INSERT INTO survey_village_stages(org_id, survey_village_id, stage_id, task_id, updated_by)
                 SELECT $1, t.sv::uuid, t.stage::uuid, t.task::uuid, $5
                   FROM unnest($2::text[], $3::text[], $4::text[]) AS t(sv, stage, task)
                 ON CONFLICT (survey_village_id, stage_id)
                 DO UPDATE SET task_id = EXCLUDED.task_id, updated_at = now()`,
                [u.orgId, surveyVillageIds, stageIds,
                  subs.map(r => String(r.id)), u.id]);
            }
          }
        }

        return {
          dry_run: false,
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
    const [m, codes, all] = await Promise.all([
      measures(pool, u.orgId), stageCodes(pool, u.orgId),
      positions(pool, u.orgId, id, { asOf: dateParam(req, q.as_of, 'as_of', today()) }),
    ]);

    /*
     * The whole list by default; a page when one is asked for.
     *
     * This route took a `limit` and ignored it, which at twelve hundred
     * villages is a two-megabyte response to a request for fifty — and a
     * parameter that does nothing is worse than one that does not exist,
     * because the caller believes it worked.
     *
     * The default stays "everything" rather than becoming thirty: the
     * Villages screen filters, sorts and exports what it holds, and a page
     * would silently narrow all three. Callers that want a page now ask for
     * one and are told whether more remain.
     */
    const wantsPage = q.limit !== undefined && q.limit !== '';
    const limit = wantsPage
      ? Math.min(1000, Math.max(1, Number(q.limit) || 30)) : all.length;
    const offset = Math.max(0, Number(q.offset) || 0);
    const pos = wantsPage ? all.slice(offset, offset + limit) : all;

    return {
      total: all.length,
      has_more: wantsPage && offset + pos.length < all.length,
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
        claimed_milestones: (p.row.claimed_milestones ?? []).map(Number),
        claimed_percent: Number(p.row.claimed_percent ?? 0),
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
          await villageOr404(db, u.orgId, id, u);
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
        await villageOr404(db, u.orgId, id, u);
        const stage = (await db.query(
          'SELECT * FROM survey_stages WHERE org_id = $1 AND code = $2 AND active',
          [u.orgId, input.stage_code])).rows[0];
        if (!stage) fail('UNKNOWN_STAGE', `There is no stage ${input.stage_code}`, 422);
        if (input.state === 'COMPLETED' && !input.completed_on) {
          fail('VALIDATION_ERROR', 'A completed stage needs the date it was completed', 422);
        }

        /*
         * Signing ground truthing off late must say why (§074).
         *
         * The other moment the question can be put, and the last one worth
         * putting it at: after the stage closes nobody revisits it, and the
         * explanation that would have cost a sentence today costs a meeting
         * in three months.
         */
        if (input.stage_code === 'GROUND_TRUTHING' && input.state === 'COMPLETED') {
          const prior = (await db.query(
            `SELECT expected_end_on, variance_reason FROM survey_village_stages
              WHERE survey_village_id = $1 AND stage_id = $2`, [id, stage.id])).rows[0];
          const expected = iso(prior?.expected_end_on) ?? input.expected_end_on ?? null;
          const reason = input.variance_reason ?? prior?.variance_reason ?? null;
          if (expected && input.completed_on && input.completed_on > expected && !reason) {
            fail('GT_VARIANCE_REASON_REQUIRED',
              `Ground truthing was due on ${expected} and finished on ${input.completed_on}. `
              + 'Say why before signing it off.', 422);
          }
        }

        /*
         * Starting ground truthing means saying how it is staffed (§067).
         *
         * The one moment anybody knows the answer is now — the mandal has
         * just told us how many of their people we get. Asked once; every
         * day's return afterwards is measured against it, and a programme
         * that started without it can never show the days the department
         * fielded nobody.
         *
         * Only demanded when the village does not already carry the figures,
         * so correcting a stage later does not re-ask a settled question.
         */
        if (stageTracksStaffing(input.stage_code) && input.state === 'IN_PROGRESS') {
          const held = (await db.query(
            `SELECT gt_govt_staff_allocated AS govt, gt_crew_allocated AS crew
               FROM survey_villages WHERE id = $1`, [id])).rows[0];
          const govt = input.gt_govt_staff_allocated ?? held?.govt;
          const crew = input.gt_crew_allocated ?? held?.crew;
          if (govt === null || govt === undefined || crew === null || crew === undefined) {
            fail('STAFFING_REQUIRED',
              'Starting ground truthing needs the staffing agreed with the mandal: '
              + 'how many government staff and how many of our crew. '
              + 'Every day’s attendance is measured against these.', 422);
          }
        }
        if (input.gt_govt_staff_allocated !== undefined
          || input.gt_crew_allocated !== undefined) {
          await db.query(
            `UPDATE survey_villages
                SET gt_govt_staff_allocated = COALESCE($2, gt_govt_staff_allocated),
                    gt_crew_allocated = COALESCE($3, gt_crew_allocated),
                    version = version + 1, updated_at = now(), updated_by = $4
              WHERE id = $1`,
            [id, input.gt_govt_staff_allocated ?? null,
              input.gt_crew_allocated ?? null, u.id]);
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

        /*
         * The plan is left alone unless this call carries one (§072).
         *
         * Somebody recording that a stage finished is answering "what
         * happened", not "what was promised". Copying an absent field over
         * the expected dates would quietly erase the plan the variance is
         * measured against — every time anyone touched the stage.
         */
        const row = (await db.query(
          `INSERT INTO survey_village_stages(org_id, survey_village_id, stage_id, state,
             started_on, completed_on, remarks,
             expected_start_on, expected_end_on, variance_reason, variance_remarks,
             updated_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (survey_village_id, stage_id)
           DO UPDATE SET state = EXCLUDED.state, started_on = EXCLUDED.started_on,
                         completed_on = EXCLUDED.completed_on,
                         remarks = EXCLUDED.remarks,
                         expected_start_on = COALESCE(
                           EXCLUDED.expected_start_on, survey_village_stages.expected_start_on),
                         expected_end_on = COALESCE(
                           EXCLUDED.expected_end_on, survey_village_stages.expected_end_on),
                         variance_reason = COALESCE(
                           EXCLUDED.variance_reason, survey_village_stages.variance_reason),
                         variance_remarks = COALESCE(
                           EXCLUDED.variance_remarks, survey_village_stages.variance_remarks),
                         updated_at = now(), updated_by = EXCLUDED.updated_by
           RETURNING *`,
          [u.orgId, id, stage.id, input.state,
            input.started_on ?? null, input.completed_on ?? null,
            input.remarks ?? null,
            input.expected_start_on ?? null, input.expected_end_on ?? null,
            input.variance_reason ?? null, input.variance_remarks ?? null,
            u.id])).rows[0];

        // Reported back with the row, so the screen that just wrote it can
        // say "eight days late" without asking again.
        const variance = stageVariance({
          state: row.state,
          startedOn: iso(row.started_on),
          completedOn: iso(row.completed_on),
          expectedEndOn: iso(row.expected_end_on),
          varianceReason: row.variance_reason,
        }, today());
        return {
          ...row,
          started_on: iso(row.started_on),
          completed_on: iso(row.completed_on),
          expected_start_on: iso(row.expected_start_on),
          expected_end_on: iso(row.expected_end_on),
          variance_days: variance.days,
          variance_basis: variance.basis,
          variance_note: varianceNote(variance),
          variance_needs_reason: variance.needsReason,
        };
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
  /**
   * Start ground truthing on a village (§071).
   *
   * One call, because it is one decision. Putting the crew on, agreeing the
   * headcounts and setting the dates were three screens and a stage change,
   * and the result was villages that had been worked for a fortnight with no
   * start date, no expected finish and nobody formally on them. Anything that
   * fails here fails all of it — a village half-started is worse than one not
   * started, because it looks done.
   *
   * The control point is asked for but does not block. A crew already walking
   * the boundary is not sent home because a ten-figure coordinate has not
   * been typed yet; the gap is reported instead, on the dashboard, against
   * the village, until somebody closes it.
   */
  app.post('/api/v1/survey/villages/:id/start-gt', { preHandler: guard('survey.manage') },
    async (req, reply) => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(gtStartSchema, req.body);
      const data = await mutate(pool, req, 'survey.village.start_gt', 'survey_village',
        async db => {
          const village = await villageOr404(db, u.orgId, id, u, true);

          const stage = (await db.query(
            `SELECT id FROM survey_stages
              WHERE org_id = $1 AND code = 'GROUND_TRUTHING' AND active`,
            [u.orgId])).rows[0];
          if (!stage) {
            fail('UNKNOWN_STAGE', 'This organisation has no ground truthing stage.', 422);
          }

          const already = (await db.query(
            `SELECT state FROM survey_village_stages
              WHERE survey_village_id = $1 AND stage_id = $2`,
            [id, stage.id])).rows[0];
          if (already && already.state === 'COMPLETED') {
            fail('ALREADY_COMPLETED',
              'Ground truthing is already signed off on this village. Reopen it through '
              + 'rework rather than starting it again.', 409);
          }

          // Every person named has to be real and ours before anything is
          // written, so a typo in the fifth id does not leave the first four
          // assigned to a village that never started.
          for (const employeeId of input.employee_ids) {
            await inOrg(db, 'employees', employeeId, u.orgId);
          }

          // Headcounts live on the village: they govern every day's return
          // afterwards, not just the stage.
          await db.query(
            `UPDATE survey_villages
                SET gt_govt_staff_allocated = COALESCE($2, gt_govt_staff_allocated),
                    gt_crew_allocated = COALESCE($3, gt_crew_allocated),
                    updated_by = $4, updated_at = now()
              WHERE id = $1`,
            [id, input.govt_staff_allocated ?? null,
              input.crew_allocated ?? null, u.id]);

          // Both dates go on the stage row (§072). They are the stage's start
          // and expected finish, and a second copy on the village is how the
          // two come to disagree.
          await db.query(
            `INSERT INTO survey_village_stages
               (org_id, survey_village_id, stage_id, state, started_on,
                expected_start_on, expected_end_on, updated_by)
             VALUES ($1, $2, $3, 'IN_PROGRESS', $4, $4, $5, $6)
             ON CONFLICT (survey_village_id, stage_id) DO UPDATE
               SET state = 'IN_PROGRESS',
                   started_on = COALESCE(survey_village_stages.started_on, EXCLUDED.started_on),
                   expected_start_on = COALESCE(
                     survey_village_stages.expected_start_on, EXCLUDED.expected_start_on),
                   expected_end_on = EXCLUDED.expected_end_on,
                   updated_by = EXCLUDED.updated_by,
                   updated_at = now()`,
            [u.orgId, id, stage.id, input.started_on, input.expected_end_on, u.id]);

          // Already-on-the-village is not an error. Two people starting the
          // same village within a minute of each other is ordinary, and the
          // second one should not be told off for it.
          let added = 0;
          for (const employeeId of input.employee_ids) {
            const r = await db.query(
              `INSERT INTO survey_crew
                 (org_id, survey_village_id, stage_id, employee_id, assigned_on, created_by)
               SELECT $1, $2, $3, $4, $5, $6
                WHERE NOT EXISTS (
                  SELECT 1 FROM survey_crew
                   WHERE survey_village_id = $2 AND stage_id = $3
                     AND employee_id = $4 AND released_on IS NULL)`,
              [u.orgId, id, stage.id, employeeId, input.started_on, u.id]);
            added += r.rowCount ?? 0;
          }

          const gcps = Number((await db.query(
            'SELECT count(*)::int AS n FROM survey_village_gcps WHERE survey_village_id = $1',
            [id])).rows[0].n);

          return {
            id,
            survey_project_id: String(village.survey_project_id),
            started_on: input.started_on,
            expected_end_on: input.expected_end_on,
            crew_added: added,
            crew_named: input.employee_ids.length,
            gcp_count: gcps,
            /*
             * Said plainly rather than refused. A village under way with no
             * control point recorded is a real gap and it is reported
             * everywhere until it is closed, but it is not a reason to stop
             * a crew that is already in the field.
             */
            gcp_note: gcps === 0
              ? 'No control point is recorded for this village yet. Ground truthing has '
                + 'started; record the GCP as soon as the coordinates are to hand — until '
                + 'then the village is flagged on the dashboard.'
              : null,
          };
        });
      reply.code(201);
      return { data };
    });

  app.get('/api/v1/survey/villages/:id/crew', { preHandler: guard('survey.read') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    await villageOr404(pool, u.orgId, id, u);
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
  /*
   * Which villages this person is working. A read, and guarded as one.
   *
   * It was survey.enter, which is the right to record rather than the right
   * to look, and the two are not the same person here: a client viewer and an
   * auditor both appear on crew lists on this programme. They were shown a
   * 403 for the question "what am I on?", which is a question their own crew
   * row already answers. Writing a return is refused where the return is
   * written, on POST /survey/entries.
   */
  app.get('/api/v1/survey/me/villages', { preHandler: guard('survey.read') }, async req => {
    const u = actor(req);
    const workDate = today();
    const rows = (await pool.query(
      `SELECT DISTINCT ON (sv.id)
              sv.id, sv.survey_project_id, sv.total_extent_ac,
              ou.name AS village_name, ou.code AS village_code,
              m.name AS mandal_name, d.name AS district_name,
              p.name AS project_name,
              -- Sent to the device so the app can apply the same low-progress
              -- rule the server will. The return is filed from a village with
              -- no signal and queued, and a refusal that arrives hours later
              -- cannot ask anybody anything: the question has to be put while
              -- the person is still standing there.
              p.low_progress_threshold_ac,
              /*
               * Ground truthing's plan, and whether it has been answered for
               * already (§081).
               *
               * The return route refuses a day on a village whose GT is past
               * its date with no reason given. The device has to apply that
               * rule before it queues anything, for the same reason the
               * low-progress threshold travels here: a refusal that surfaces
               * after the crew has walked out cannot ask them anything, and
               * the outbox discards what the server rejects.
               */
              gt.expected_end_on  AS gt_expected_end_on,
              gt.completed_on     AS gt_completed_on,
              gt.state            AS gt_state,
              gt.variance_reason  AS gt_variance_reason,
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
       LEFT JOIN survey_village_stages gt ON gt.survey_village_id = sv.id
         AND gt.stage_id = (SELECT id FROM survey_stages
                             WHERE org_id = sv.org_id AND code = 'GROUND_TRUTHING')
       WHERE c.org_id = $1 AND usr.id = $2
         AND c.released_on IS NULL
         AND p.status = 'ACTIVE'
       ORDER BY sv.id, s.display_order`, [u.orgId, u.id, workDate])).rows;
    return {
      data: rows.map(r => ({
        ...r,
        total_extent_ac: num(r.total_extent_ac),
        low_progress_threshold_ac: num(r.low_progress_threshold_ac),
        gt_expected_end_on: iso(r.gt_expected_end_on),
        gt_completed_on: iso(r.gt_completed_on),
        gt_state: r.gt_state ?? null,
        gt_variance_reason: r.gt_variance_reason ?? null,
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
        await villageOr404(db, u.orgId, id, u);
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
        // Their instruments come with them (§note 11).
        const kit = await carryKitToVillage(
          db, u.orgId, id, input.employee_id, u.id, input.assigned_on ?? null);
        const crewRow = (await db.query(
          `INSERT INTO survey_crew(org_id, survey_village_id, stage_id, employee_id,
             assigned_on, released_on, created_by)
           VALUES($1,$2,$3,$4,$5::date,$6,$7) RETURNING *`,
          [u.orgId, id, stage.id, input.employee_id,
            input.assigned_on ?? today(), input.released_on ?? null, u.id])).rows[0];
        // Said rather than done silently: somebody who expected to allocate
        // the rovers needs to know it has already happened.
        return { ...crewRow, rovers_brought: kit.brought, rovers_left_elsewhere: kit.elsewhere };
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
        await villageOr404(db, u.orgId, id, u);
        const stage = (await db.query(
          'SELECT id FROM survey_stages WHERE org_id = $1 AND code = $2 AND active',
          [u.orgId, input.stage_code])).rows[0];
        if (!stage) fail('UNKNOWN_STAGE', `There is no stage ${input.stage_code}`, 422);

        const assigned: string[] = [], already: string[] = [], refused: string[] = [];
        const brought: string[] = [], elsewhere: string[] = [];
        for (const employeeId of input.employee_ids) {
          const e = (await db.query(
            'SELECT id, status FROM employees WHERE id = $1 AND org_id = $2',
            [employeeId, u.orgId])).rows[0];
          // Somebody who has left cannot be put on work.
          if (!e || e.status !== 'ACTIVE') { refused.push(employeeId); continue; }
          const done = await db.query(
            `INSERT INTO survey_crew(org_id, survey_village_id, stage_id, employee_id,
               assigned_on, created_by)
             SELECT $1,$2,$3,$4,$5::date,$6
             WHERE NOT EXISTS (
               SELECT 1 FROM survey_crew
               WHERE survey_village_id = $2 AND stage_id = $3 AND employee_id = $4
                 AND released_on IS NULL)
             RETURNING id`,
            [u.orgId, id, stage.id, employeeId, input.assigned_on ?? today(), u.id]);
          if (done.rowCount) {
            assigned.push(employeeId);
            // Their instruments come with them, so nobody allocates the same
            // rovers to the next village by hand every few days.
            const kit = await carryKitToVillage(
              db, u.orgId, id, employeeId, u.id, input.assigned_on ?? null);
            brought.push(...kit.brought);
            elsewhere.push(...kit.elsewhere);
          } else already.push(employeeId);
        }
        return { assigned: assigned.length, already_assigned: already.length,
          refused: refused.length, refused_ids: refused,
          rovers_brought: brought, rovers_left_elsewhere: elsewhere };
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
          await villageOr404(db, u.orgId, id, u);
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
          /*
           * What their posting brought goes back with them.
           *
           * Only that. An instrument allocated to this village in its own
           * right stays: it was a decision about the village, not the person.
           */
          const returned = await releaseKitFromVillage(
            db, u.orgId, String(row.survey_village_id), String(row.employee_id),
            input.released_on ?? null);
          // Released rather than deleted, so who surveyed a village last
          // season is still answerable.
          const released = (await db.query(
            `UPDATE survey_crew SET released_on = $2::date
             WHERE id = $1 RETURNING *`, [id, input.released_on ?? today()])).rows[0];
          return { ...released, rovers_released: returned };
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
      await villageOr404(pool, u.orgId, id, u);
      const rows = (await pool.query(
        `SELECT r.*, a.asset_code, a.name AS asset_name, a.serial_number, a.condition,
                -- So a caller can tell a rover from the tripod that travelled
                -- with it: the kit follows the crew, the daily return does not
                -- ask them to account for a welding set.
                a.category
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
      await villageOr404(pool, u.orgId, id, u);
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

  /**
   * Bring a crew member's kit with them (§note 11).
   *
   * A rover is issued to somebody in the asset register and it goes where
   * they go. Allocating the crew and then allocating each of their
   * instruments to the same village was the same job twice, every few days,
   * as crews move on to the next village — and the day somebody forgot, the
   * village reported instruments it did not have.
   *
   * An instrument already out on another village is left where it is rather
   * than moved: two villages holding the same rover is a worse record than
   * one village missing it, and the register says where it really is.
   *
   * Returns what was brought, so the caller can say so rather than doing it
   * silently.
   */
  async function carryKitToVillage(
    db: PoolClient, orgId: string, villageId: string, employeeId: string, userId: string,
    on?: string | null,
  ): Promise<{ brought: string[]; elsewhere: string[]; startedOn: Record<string, string> }> {
    const kit = (await db.query(
      `SELECT DISTINCT aa.asset_id,
              COALESCE(a.name, a.asset_code) AS label,
              EXISTS (SELECT 1 FROM survey_rover_allocations r
                       WHERE r.asset_id = aa.asset_id AND r.released_on IS NULL
                         AND r.survey_village_id <> $3) AS out_elsewhere,
              EXISTS (SELECT 1 FROM survey_rover_allocations r
                       WHERE r.asset_id = aa.asset_id AND r.released_on IS NULL
                         AND r.survey_village_id = $3) AS already_here
         FROM asset_assignments aa
         JOIN assets a ON a.id = aa.asset_id
        WHERE aa.org_id = $1 AND aa.employee_id = $2 AND aa.returned_at IS NULL`,
      [orgId, employeeId, villageId])).rows;

    const brought: string[] = [], elsewhere: string[] = [];
    const startedOn = new Map<string, string>();
    for (const k of kit) {
      if (k.already_here) continue;
      if (k.out_elsewhere) { elsewhere.push(String(k.label)); continue; }
      /*
       * The day after it left the last village, at the earliest.
       *
       * A rover is accounted to one village per day — the database says so
       * with an exclusion constraint, and the daily return assumes it too.
       * A crew that finishes in the morning and moves that afternoon would
       * otherwise put one instrument on two villages for the same day, and
       * the insert would simply fail. The day it was last out stays with the
       * village it worked; the new posting starts the next day.
       */
      const started = (await db.query(
        `INSERT INTO survey_rover_allocations(org_id, survey_village_id, asset_id,
           allocated_on, created_by, assigned_via_employee_id)
         VALUES($1,$2,$3,
           GREATEST(
             $4::date,
             COALESCE((SELECT max(r.released_on) + 1 FROM survey_rover_allocations r
                        WHERE r.asset_id = $3), '-infinity'::date)
           ),
           $5,$6)
         RETURNING allocated_on`,
        [orgId, villageId, k.asset_id, on ?? today(), userId, employeeId])).rows[0];
      brought.push(String(k.label));
      startedOn.set(String(k.label), String(started.allocated_on).slice(0, 10));
    }
    return { brought, elsewhere, startedOn: Object.fromEntries(startedOn) };
  }

  /**
   * And take it away again when they leave.
   *
   * Only what their posting brought. An instrument somebody allocated to this
   * village in its own right stays: it was a decision about the village, not
   * about the person.
   */
  async function releaseKitFromVillage(
    db: PoolClient, orgId: string, villageId: string, employeeId: string,
    on?: string | null,
  ): Promise<number> {
    return (await db.query(
      `UPDATE survey_rover_allocations
          SET released_on = $4::date
        WHERE org_id = $1 AND survey_village_id = $2
          AND assigned_via_employee_id = $3 AND released_on IS NULL`,
      [orgId, villageId, employeeId, on ?? today()])).rowCount ?? 0;
  }

  app.post('/api/v1/survey/villages/:id/rovers', { preHandler: guard('survey.manage') },
    async (req, reply) => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(roverAllocationSchema, req.body);
      const row = await mutate(pool, req, 'survey.rover.allocate', 'survey_rover_allocation',
        async db => {
          await villageOr404(db, u.orgId, id, u);
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
               SET released_on = $2::date
               WHERE id = $1 RETURNING *`, [id, input.released_on ?? today()])).rows[0];
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
      const village = await villageOr404(db, u.orgId, input.survey_village_id, u);
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

        /*
         * A crew member reports the instrument in their own hands.
         *
         * The rover is issued to a person in the asset register, and the day's
         * figures for it are that person's account of their own work. Letting
         * anybody file against any rover means one crew member's output can be
         * written by another with nothing to say it happened.
         *
         * Supervision is the exception, and a real one: a team lead, a project
         * manager or an administrator files on behalf of somebody whose phone
         * is flat or who is still in the field, and so does the person they
         * report to. Everyone else is limited to what they are carrying.
         */
        const supervises = u.permissions.includes('survey.manage')
          || u.permissions.includes('survey.assign');
        if (!supervises) {
          const mine = (await db.query(
            `SELECT a.asset_id,
                    (holder.reports_to = me.id) AS reports_to_me,
                    (a.employee_id = me.id)     AS is_mine
               FROM asset_assignments a
               JOIN employees holder ON holder.id = a.employee_id
               JOIN users caller ON caller.id = $1
               JOIN employees me ON me.id = caller.employee_id
              WHERE a.org_id = $2 AND a.returned_at IS NULL
                AND a.asset_id = ANY($3::uuid[])`,
            [u.id, u.orgId, roverRows.map(r => r.asset_id)])).rows;
          const allowed = new Map(mine.map(r => [String(r.asset_id), r]));
          for (const r of roverRows) {
            const held = allowed.get(String(r.asset_id));
            if (!held || !(held.is_mine || held.reports_to_me)) {
              fail('ROVER_NOT_YOURS',
                'That instrument is not issued to you. You can record the day for a rover you '
                + 'are carrying, or for somebody who reports to you — anything else has to be '
                + 'filed by their team lead or project manager.', 403);
            }
          }
        }
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

      /*
       * Ground truthing past its date must say why (§074).
       *
       * Demanded here because this is the moment somebody who knows the
       * answer is already typing, and they are exactly the people entitled
       * to give it: the crew on the village, their team lead, the project
       * manager, an administrator — everyone who may record a day at all.
       *
       * Asked once. Once a reason is on the stage the question stops, because
       * the point is to get the explanation on file rather than to hold a
       * crew to ransom every evening for an answer they have already given.
       */
      const gt = (await db.query(
        `SELECT vs.id, vs.state, vs.started_on, vs.completed_on,
                vs.expected_end_on, vs.variance_reason
           FROM survey_village_stages vs
           JOIN survey_stages s ON s.id = vs.stage_id
          WHERE vs.survey_village_id = $1 AND s.code = 'GROUND_TRUTHING'`,
        [input.survey_village_id])).rows[0];
      const gtStage = gt ? {
        state: gt.state as StageState,
        startedOn: iso(gt.started_on), completedOn: iso(gt.completed_on),
        expectedEndOn: iso(gt.expected_end_on), varianceReason: gt.variance_reason,
      } : null;

      if (gtStage && gtReasonRequired(gtStage, today())) {
        if (!input.gt_variance_reason) {
          fail('GT_VARIANCE_REASON_REQUIRED',
            `Ground truthing on this village was due on ${gtStage.expectedEndOn} and is `
            + 'still open. Say why before recording another day — the reason is asked '
            + 'once and goes on the record for the whole stage.', 422);
        }
        await db.query(
          `UPDATE survey_village_stages
              SET variance_reason = $2, variance_remarks = $3,
                  updated_at = now(), updated_by = $4
            WHERE id = $1`,
          [gt.id, input.gt_variance_reason,
            input.gt_variance_remarks?.trim() || null, u.id]);
      } else if (input.gt_variance_reason && gt) {
        // Volunteered before it was demanded. Recorded all the same.
        await db.query(
          `UPDATE survey_village_stages
              SET variance_reason = COALESCE(variance_reason, $2),
                  variance_remarks = COALESCE(variance_remarks, $3),
                  updated_at = now(), updated_by = $4
            WHERE id = $1`,
          [gt.id, input.gt_variance_reason,
            input.gt_variance_remarks?.trim() || null, u.id]);
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
           punch_out_lat, punch_out_lng, govt_staff_present, crew_present,
           created_by, updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19)
         RETURNING *`,
        [u.orgId, village.survey_project_id, input.survey_village_id, input.entry_date,
          input.teams_deployed ?? 0, input.dgps_base ?? 0, roversUsed,
          input.notes ?? null,
          input.low_progress_reason ?? null, input.low_progress_remarks ?? null,
          input.punch_in_at ?? null, input.punch_out_at ?? null,
          input.punch_in_lat ?? null, input.punch_in_lng ?? null,
          input.punch_out_lat ?? null, input.punch_out_lng ?? null,
          // Null and zero are different answers (§067): null is "nobody was
          // asked", zero is "nobody came", and only one of them is a finding.
          input.govt_staff_present ?? null, input.crew_present ?? null,
          u.id])).rows[0];

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

  /**
   * Correct a day already recorded (§note 15).
   *
   * A figure that cannot be corrected gets corrected anyway — in a
   * spreadsheet beside the system, which is where the two versions start to
   * disagree. So amending is allowed, and everything about it is written
   * down.
   *
   * Today's return may be corrected by whoever can record one: a crew member
   * who typed 25 for 250 should not need an administrator, and the day is
   * still theirs. An earlier day needs survey.manage, because by then the
   * figure has been rolled up, reported on and possibly billed, and changing
   * it is a decision about the record rather than a typo.
   */
  app.patch('/api/v1/survey/entries/:id', { preHandler: guard('survey.enter') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(surveyEntryPatchSchema, req.body);
    return {
      data: await mutate(pool, req, 'survey.entry.update', 'survey_entry', async db => {
        const row = await inOrg(db, 'survey_entries', id, u.orgId, true);
        version(req, row as { version: number });

        const entryDay = String(row.entry_date).slice(0, 10);
        if (entryDay !== businessDay() && !u.permissions.includes('survey.manage')) {
          fail('PAST_DAY_AMENDMENT',
            `${entryDay} has already been rolled up and reported on. Correcting an earlier `
            + 'day is a decision about the record rather than a typo, so it needs a '
            + 'programme manager. Ask them, or record the difference on today.', 403);
        }

        const m = await measures(db, u.orgId);

        /*
         * What it was, before it becomes what it is.
         *
         * mutate() writes the after state and nothing else, which is enough
         * for a creation and useless for a correction: "who changed 250 to
         * 25" is the only question anybody asks of an amended figure, and
         * the answer needs both numbers.
         */
        const before = {
          entry_date: entryDay,
          teams_deployed: row.teams_deployed,
          dgps_base: row.dgps_base,
          dgps_rovers: row.dgps_rovers,
          notes: row.notes,
          // Attendance is amended like any other figure, and "who changed
          // four government staff to nought" is exactly the question the
          // trail exists for.
          govt_staff_present: row.govt_staff_present,
          crew_present: row.crew_present,
          values: Object.fromEntries((await db.query(
            `SELECT mm.code, ev.quantity FROM survey_entry_values ev
               JOIN survey_measures mm ON mm.id = ev.measure_id
              WHERE ev.entry_id = $1`, [id])).rows.map(r => [r.code, Number(r.quantity)])),
        };

        const sets: string[] = [], values: unknown[] = [id];
        for (const key of ['teams_deployed', 'dgps_base', 'dgps_rovers', 'notes',
          'govt_staff_present', 'crew_present'] as const) {
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

        const updated = (await db.query(
          'UPDATE survey_entries SET version = version + 1 WHERE id = $1 RETURNING *', [id])).rows[0];

        const after = {
          entry_date: entryDay,
          teams_deployed: updated.teams_deployed,
          dgps_base: updated.dgps_base,
          dgps_rovers: updated.dgps_rovers,
          notes: updated.notes,
          values: Object.fromEntries((await db.query(
            `SELECT mm.code, ev.quantity FROM survey_entry_values ev
               JOIN survey_measures mm ON mm.id = ev.measure_id
              WHERE ev.entry_id = $1`, [id])).rows.map(r => [r.code, Number(r.quantity)])),
        };

        // Its own entry, carrying both states, so the audit screen can show
        // what moved rather than only what it ended up as.
        await db.query(
          `INSERT INTO audit_events(org_id, actor_id, action, entity_type, entity_id,
             before_state, after_state, reason, request_id)
           VALUES($1,$2,'survey.entry.amend','survey_entry',$3,$4,$5,$6,$7)`,
          [u.orgId, u.id, id, JSON.stringify(before), JSON.stringify(after),
           input.amendment_reason ?? null, req.requestId]);

        return updated;
      }),
    };
  });

  app.get('/api/v1/survey/entries', { preHandler: guard('survey.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId];
    let where = 'e.org_id = $1';
    // Only the programmes this reader may see. Unfiltered, every holder of
    // survey.read -- a client among them -- read every crew's returns in the
    // organisation, names included.
    const allowed = await visibleProgrammes(pool, u);
    if (allowed !== null) { values.push(allowed); where += ` AND e.survey_project_id = ANY($${values.length}::uuid[])`; }
    if (q.survey_project_id) { values.push(q.survey_project_id); where += ` AND e.survey_project_id = $${values.length}`; }
    if (q.survey_village_id) { values.push(q.survey_village_id); where += ` AND e.survey_village_id = $${values.length}`; }
    // Validated like every other window in this module: a value that is not a
    // date reaches Postgres as `$n::date` and comes back as a 500.
    if (q.from) {
      values.push(dateParam(req, q.from, 'from', today()));
      where += ` AND e.entry_date >= $${values.length}`;
    }
    if (q.to) {
      values.push(dateParam(req, q.to, 'to', today()));
      where += ` AND e.entry_date <= $${values.length}`;
    }
    values.push(limit + 1, offset);

    const rows = (await pool.query(
      `SELECT e.*, v.name AS village_name, u.username AS recorded_by,
              /*
               * What the instruments did that day.
               *
               * The row carried the number allocated and nothing about how
               * they were used, so a day where every rover sat idle read the
               * same as a day they were all out working.
               */
              (SELECT count(*)::int FROM survey_entry_rovers r
                WHERE r.entry_id = e.id AND r.status = 'UTILIZED') AS rovers_used,
              (SELECT count(*)::int FROM survey_entry_rovers r
                WHERE r.entry_id = e.id AND r.status = 'IDLE') AS rovers_idle,
              COALESCE(NULLIF(trim(concat_ws(' ', emp.first_name, emp.last_name)), ''), u.username) AS recorded_by_name,
              -- What the village was staffed for (§067), so the row can read
              -- "4 of 6" rather than a bare 4 that means nothing on its own.
              sv.gt_govt_staff_allocated, sv.gt_crew_allocated,
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

      const to = dateParam(req, q.to, 'to', today());
      const from = dateParam(req, q.from, 'from', to);
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
      await villageOr404(pool, u.orgId, id, u);
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
          const row = await villageOr404(db, u.orgId, id, u, true);
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
        const row = await villageOr404(db, u.orgId, id, u, true);
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
          const row = await villageOr404(db, u.orgId, id, u, true);
          version(req, row as { version: number });
          const sets: string[] = [], values: unknown[] = [id];
          for (const key of ['total_extent_ac', 'expected_completion_on', 'planned_start_on',
            'gt_govt_staff_allocated', 'gt_crew_allocated'] as const) {
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

  /**
   * A village's stage states, resolved the same way everything else does.
   *
   * Where a stage is driven by a task the task is the truth; where it is
   * not, the stage row is. Reading the row alone would report a village as
   * unfinished when its board says otherwise.
   */
  async function stageStatesOf(
    db: Pool | PoolClient, villageId: string,
  ): Promise<Record<string, StageState>> {
    const rows = (await db.query(
      `SELECT s.code, vs.state, vs.task_id, t.status AS task_status
         FROM survey_village_stages vs
         JOIN survey_stages s ON s.id = vs.stage_id
         LEFT JOIN tasks t ON t.id = vs.task_id
        WHERE vs.survey_village_id = $1`, [villageId])).rows;
    const out: Record<string, StageState> = {};
    for (const row of rows) {
      out[String(row.code)] = row.task_id
        ? resolveStage({
          stageCode: String(row.code), linked: true, taskStatus: row.task_status,
        }).state
        : (row.state as StageState);
    }
    return out;
  }

  /**
   * Refuse a claim the village has not earned yet (§note 17).
   *
   * The contract releases the first claim when ground-truthing QC signs the
   * village off, the second at vectorisation QC, the third when the
   * deliverables have gone in. Claiming earlier is a claim the department
   * returns, and a returned claim costs a month — so this refuses rather
   * than warns.
   */
  async function earnedOr422(
    db: Pool | PoolClient, req: FastifyRequest, orgId: string,
    villageId: string, milestone: number,
  ): Promise<void> {
    const stages = await stageStatesOf(db, villageId);
    if (milestoneEarned(milestone, stages)) return;
    const required = MILESTONE_REQUIRES[milestone];
    const label = (await db.query(
      'SELECT label FROM survey_stages WHERE org_id = $1 AND code = $2',
      [orgId, required])).rows[0]?.label ?? required;
    const at = stages[required] ?? 'NOT_STARTED';
    fail('MILESTONE_NOT_EARNED',
      `Milestone ${milestone} falls due when ${label} is signed off, and it is `
      + `${at === 'NOT_STARTED' ? 'not started' : at.replace(/_/g, ' ').toLowerCase()} `
      + 'on this village. Complete that stage first — a claim raised early is one '
      + 'the department returns.', 422);
  }

  /**
   * Every milestone below this one has to be standing (§080).
   *
   * Milestones are a sequence and the department reconciles them against its
   * own file, so a second claim with no first is one they cannot place. The
   * bulk route has always refused it; this path did not, and the same rule
   * enforced on one way in and not the other is the same as not enforced —
   * the corpus carried fifteen claims stranded above a gap because of it.
   *
   * A rejected claim does not count as standing: the department sent it back,
   * so there is nothing on their file to reconcile against.
   */
  async function inOrderOr422(
    db: Pool | PoolClient, villageId: string, milestone: number,
  ): Promise<void> {
    if (milestone <= 1) return;
    const below = (await db.query(
      `SELECT milestone FROM survey_village_billing
        WHERE survey_village_id = $1 AND milestone < $2 AND status <> 'REJECTED'`,
      [villageId, milestone])).rows.map(r => Number(r.milestone));
    const missing: number[] = [];
    for (let m = 1; m < milestone; m += 1) if (!below.includes(m)) missing.push(m);
    if (missing.length === 0) return;
    fail('MILESTONE_OUT_OF_ORDER',
      `Milestone ${milestone} cannot be claimed before ${
        missing.map(m => `milestone ${m}`).join(' and ')} on this village. `
      + 'The department reconciles claims against its own file in order, and one '
      + 'that arrives out of sequence is one they cannot place.', 422);
  }

  /**
   * A village's returns, day by day, with what was out and who came (§note 19).
   *
   * The summary sheet totals a village's life; this is the working underneath
   * it. "Eighty-two per cent turnout" is a figure somebody queries, and the
   * answer is the six days in the middle of March where the department sent
   * nobody — which is only visible a day at a time.
   *
   * The totals are computed here from the same rows the table shows, so the
   * line at the bottom can never disagree with the lines above it.
   */
  app.get('/api/v1/survey/villages/:id/daily', { preHandler: guard('survey.read') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const { q } = page(req);
      const village = await villageOr404(pool, u.orgId, id, u);
      const to = dateParam(req, q.to, 'to', today());
      const from = dateParam(req, q.from, 'from', '1900-01-01');

      const rows = (await pool.query(
        `SELECT e.id, e.entry_date, e.teams_deployed,
                e.govt_staff_present, e.crew_present,
                e.low_progress_reason, e.notes,
                (SELECT count(*)::int FROM survey_entry_rovers r
                  WHERE r.entry_id = e.id AND r.status = 'UTILIZED') AS rovers_used,
                (SELECT count(*)::int FROM survey_entry_rovers r
                  WHERE r.entry_id = e.id AND r.status = 'IDLE') AS rovers_idle,
                -- Instruments standing against the village on that day, which
                -- is what "used" and "idle" have to be read against.
                (SELECT count(*)::int FROM survey_rover_allocations ra
                  WHERE ra.survey_village_id = e.survey_village_id
                    AND ra.allocated_on <= e.entry_date
                    AND (ra.released_on IS NULL OR ra.released_on >= e.entry_date))
                  AS rovers_allocated,
                (SELECT json_object_agg(mm.code, ev.quantity)
                   FROM survey_entry_values ev
                   JOIN survey_measures mm ON mm.id = ev.measure_id
                  WHERE ev.entry_id = e.id) AS values
           FROM survey_entries e
          WHERE e.org_id = $1 AND e.survey_village_id = $2
            AND e.entry_date BETWEEN $3::date AND $4::date
          ORDER BY e.entry_date`,
        [u.orgId, id, from, to])).rows;

      const m = await measures(pool, u.orgId);
      const days = rows.map(r => ({
        entry_date: iso(r.entry_date),
        teams_deployed: Number(r.teams_deployed ?? 0),
        rovers_allocated: Number(r.rovers_allocated ?? 0),
        rovers_used: Number(r.rovers_used ?? 0),
        rovers_idle: Number(r.rovers_idle ?? 0),
        govt_staff_present: r.govt_staff_present === null ? null : Number(r.govt_staff_present),
        crew_present: r.crew_present === null ? null : Number(r.crew_present),
        low_progress_reason: r.low_progress_reason,
        low_progress_label: r.low_progress_reason ? reasonLabel(r.low_progress_reason) : null,
        notes: r.notes,
        values: r.values ?? {},
      }));

      const sum = (pick: (d: typeof days[number]) => number | null) =>
        days.reduce((t, d) => t + (pick(d) ?? 0), 0);

      return {
        data: {
          village: {
            id: village.id,
            gt_govt_staff_allocated: village.gt_govt_staff_allocated === null
              ? null : Number(village.gt_govt_staff_allocated),
            gt_crew_allocated: village.gt_crew_allocated === null
              ? null : Number(village.gt_crew_allocated),
          },
          from, to,
          days,
          measures: m.rows.map(r => ({
            code: r.code, label: r.label, unit: r.unit, basis: r.basis,
          })),
          // The line at the bottom, from the same rows as the lines above.
          totals: {
            return_days: days.length,
            team_days: sum(d => d.teams_deployed),
            rover_days_used: sum(d => d.rovers_used),
            rover_days_idle: sum(d => d.rovers_idle),
            govt_staff_days: sum(d => d.govt_staff_present),
            crew_days: sum(d => d.crew_present),
            values: Object.fromEntries(m.codes.map(code => [
              code, round2(days.reduce((t, d) =>
                t + Number((d.values as Record<string, number>)[code] ?? 0), 0)),
            ])),
            ...summariseStaffing(days.map((d): StaffingDay => ({
              govtStaffPresent: d.govt_staff_present,
              crewPresent: d.crew_present,
              govtStaffAllocated: village.gt_govt_staff_allocated === null
                ? null : Number(village.gt_govt_staff_allocated),
              crewAllocated: village.gt_crew_allocated === null
                ? null : Number(village.gt_crew_allocated),
            }))),
          },
        },
      };
    });

  /* ----------------------------------------- ground control points (§069) */

  /**
   * The control points a village was surveyed from.
   *
   * A GCP is the fixed, known point the DGPS base sits over, and every
   * measurement in the village is relative to it. Establishing one is a
   * one-time job done before ground truthing starts; there is usually
   * exactly one, and a large or awkward village needs two or three.
   *
   * The coordinates lived in the surveyor's notebook and, with luck, a
   * WhatsApp message. Re-establishing a control point because nobody wrote
   * it down is a day's work with a base station.
   */
  app.get('/api/v1/survey/villages/:id/gcps', { preHandler: guard('survey.read') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      await villageOr404(pool, u.orgId, id, u);
      const rows = (await pool.query(
        `SELECT g.*,
                COALESCE(NULLIF(trim(concat_ws(' ', e.first_name, e.last_name)), ''), usr.username)
                  AS recorded_by_name
           FROM survey_village_gcps g
           LEFT JOIN users usr ON usr.id = g.created_by
           LEFT JOIN employees e ON e.id = usr.employee_id
          WHERE g.org_id = $1 AND g.survey_village_id = $2
          ORDER BY g.point_code`,
        [u.orgId, id])).rows;
      return {
        data: rows.map(r => ({
          ...r,
          latitude: Number(r.latitude),
          longitude: Number(r.longitude),
          elevation_m: num(r.elevation_m),
          easting_m: num(r.easting_m),
          northing_m: num(r.northing_m),
          established_on: iso(r.established_on),
          // Recomputed on read rather than stored: the bounds are a judgement
          // that may be improved, and a stored warning would go stale.
          warnings: checkGcp(Number(r.latitude), Number(r.longitude)),
        })),
      };
    });

  /*
   * Recording a control point is field work, not master data (§070).
   *
   * The point is established by whoever stands on it with the base: a
   * surveyor or a team lead, neither of whom holds survey.manage. Requiring
   * it meant the one person who knows the fix could not enter it, so the
   * coordinates travelled to the office by photograph and were retyped by
   * somebody who had never seen the pillar. Retyping a ten-digit coordinate
   * is exactly where a digit goes missing.
   *
   * So creating and correcting a point is survey.enter, the same right that
   * records the day's figures. Deleting one stays survey.manage: an
   * established point is referenced by everything surveyed from it, and
   * removing it is a decision about the record rather than an observation.
   */
  app.post('/api/v1/survey/villages/:id/gcps', { preHandler: guard('survey.enter') },
    async (req, reply) => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(gcpSchema, req.body);
      const data = await mutate(pool, req, 'survey.gcp.create', 'survey_village_gcp',
        async db => {
          await villageOr404(db, u.orgId, id, u);
          const clash = await db.query(
            'SELECT 1 FROM survey_village_gcps WHERE survey_village_id = $1 AND point_code = $2',
            [id, input.point_code]);
          if (clash.rowCount) {
            fail('POINT_ALREADY_RECORDED',
              `This village already has a point called ${input.point_code}. `
              + 'Open it to correct the coordinates, or give the new point another name.', 409);
          }
          const row = (await db.query(
            `INSERT INTO survey_village_gcps(org_id, survey_village_id, point_code,
               latitude, longitude, elevation_m, easting_m, northing_m, grid_zone,
               remarks, established_on, created_by, updated_by)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *`,
            [u.orgId, id, input.point_code, input.latitude, input.longitude,
              input.elevation_m ?? null,
              input.easting_m ?? null, input.northing_m ?? null,
              input.grid_zone?.trim() || null,
              input.remarks ?? null,
              input.established_on ?? null, u.id])).rows[0];
          return {
            ...row,
            latitude: Number(row.latitude), longitude: Number(row.longitude),
            elevation_m: num(row.elevation_m),
            easting_m: num(row.easting_m), northing_m: num(row.northing_m),
            // Returned so the caller can show what looks odd without asking
            // again. Never a refusal: every one of these is also something a
            // legitimate programme produces.
            warnings: checkGcp(input.latitude, input.longitude),
          };
        });
      reply.code(201);
      return { data };
    });

  app.patch('/api/v1/survey/gcps/:id', { preHandler: guard('survey.enter') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(gcpPatchSchema, req.body);
      return {
        data: await mutate(pool, req, 'survey.gcp.update', 'survey_village_gcp', async db => {
          const row = await inOrg(db, 'survey_village_gcps', id, u.orgId, true);
          if (!row) fail('NOT_FOUND', 'That control point no longer exists.', 404);
          await villageOr404(db, u.orgId, String(row.survey_village_id), u);
          version(req, row as { version: number });

          /*
           * A grid reference needs a zone, counting the one already on the row.
           *
           * The schema can only see the patch; only here can we tell whether
           * setting a northing and easting leaves the point with a zone or
           * without one. Checked before the write so the caller gets a
           * sentence about a field rather than the database's opinion of a
           * check constraint.
           */
          const nextEasting = input.easting_m !== undefined ? input.easting_m : row.easting_m;
          const nextZone = input.grid_zone !== undefined
            ? input.grid_zone : row.grid_zone;
          if (nextEasting !== null && nextEasting !== undefined
            && !String(nextZone ?? '').trim()) {
            fail('VALIDATION_ERROR',
              'Name the grid these are on, such as 44N — without it a northing and '
              + 'easting are two numbers, not a position.', 422);
          }

          const sets: string[] = [], values: unknown[] = [id];
          for (const key of ['point_code', 'latitude', 'longitude', 'elevation_m',
            'easting_m', 'northing_m', 'grid_zone', 'remarks', 'established_on'] as const) {
            if (input[key] !== undefined) { values.push(input[key]); sets.push(`${key} = $${values.length}`); }
          }
          if (!sets.length) return row;
          values.push(u.id);
          const updated = (await db.query(
            `UPDATE survey_village_gcps SET ${sets.join(', ')}, version = version + 1,
               updated_at = now(), updated_by = $${values.length}
             WHERE id = $1 RETURNING *`, values)).rows[0];
          return {
            ...updated,
            latitude: Number(updated.latitude), longitude: Number(updated.longitude),
            elevation_m: num(updated.elevation_m),
            easting_m: num(updated.easting_m), northing_m: num(updated.northing_m),
            warnings: checkGcp(Number(updated.latitude), Number(updated.longitude)),
          };
        }),
      };
    });

  app.delete('/api/v1/survey/gcps/:id', { preHandler: guard('survey.manage') },
    async req => ({
      data: await mutate(pool, req, 'survey.gcp.delete', 'survey_village_gcp', async db => {
        const u = actor(req), id = (req.params as { id: string }).id;
        const row = await inOrg(db, 'survey_village_gcps', id, u.orgId, true);
        if (!row) fail('NOT_FOUND', 'That control point no longer exists.', 404);
        await villageOr404(db, u.orgId, String(row.survey_village_id), u);
        await db.query('DELETE FROM survey_village_gcps WHERE id = $1', [id]);
        return { id, deleted: true };
      }),
    }));

  /**
   * Every control point on a programme, for the sheet that goes with the
   * deliverables.
   *
   * The department asks for the control list with the final submission, and
   * building it village by village off a thousand screens is a day nobody
   * has.
   */
  app.get('/api/v1/survey/projects/:id/gcps', { preHandler: guard('survey.read') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      await projectOr404(pool, u.orgId, id, u);
      const rows = (await pool.query(
        `SELECT g.*, ou.name AS village_name, ou.code AS village_code,
                m.name AS mandal_name
           FROM survey_village_gcps g
           JOIN survey_villages sv ON sv.id = g.survey_village_id
           JOIN org_units ou ON ou.id = sv.village_id
           LEFT JOIN org_units m ON m.id = ou.parent_id
          WHERE g.org_id = $1 AND sv.survey_project_id = $2
          ORDER BY m.name, ou.name, g.point_code`,
        [u.orgId, id])).rows;
      return {
        data: rows.map(r => ({
          ...r,
          latitude: Number(r.latitude), longitude: Number(r.longitude),
          elevation_m: num(r.elevation_m),
          easting_m: num(r.easting_m), northing_m: num(r.northing_m),
          established_on: iso(r.established_on),
          warnings: checkGcp(Number(r.latitude), Number(r.longitude)),
        })),
      };
    });

  /* ------------------------------------- why a crewed village has no kit */

  /**
   * The instruments this village's crew hold, and where they actually are.
   *
   * A rover follows the person it is issued to, so assigning crew to a
   * village usually brings their kit with them. Usually — not always: one
   * person is crew on several villages at once, and an instrument can only
   * be in one place. The database enforces that with an exclusion
   * constraint, so the carry silently skips.
   *
   * The result was a village with four people on it and no instruments, and
   * nothing on the screen explaining why. The answer is never "the software
   * forgot" — it is "that rover is in Koyyuru until Thursday" — and that is
   * a sentence somebody can act on.
   */
  app.get('/api/v1/survey/villages/:id/kit-gap', { preHandler: guard('survey.read') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      await villageOr404(pool, u.orgId, id, u);

      const rows = (await pool.query(
        `SELECT DISTINCT
                aa.asset_id, a.asset_code, COALESCE(a.name, a.asset_code) AS asset_name,
                c.employee_id,
                COALESCE(NULLIF(trim(concat_ws(' ', e.first_name, e.last_name)), ''), e.emp_no)
                  AS employee_name,
                held.survey_village_id AS held_by_village_id,
                ou.name AS held_by_village_name,
                held.allocated_on AS held_since
           FROM survey_crew c
           JOIN employees e ON e.id = c.employee_id
           JOIN asset_assignments aa
             ON aa.employee_id = c.employee_id AND aa.returned_at IS NULL
           JOIN assets a ON a.id = aa.asset_id
           LEFT JOIN survey_rover_allocations held
             ON held.asset_id = aa.asset_id AND held.released_on IS NULL
           LEFT JOIN survey_villages hv ON hv.id = held.survey_village_id
           LEFT JOIN org_units ou ON ou.id = hv.village_id
          WHERE c.survey_village_id = $2 AND c.released_on IS NULL AND c.org_id = $1
            -- Only kit that is not already here. What is here is not a gap.
            AND (held.survey_village_id IS NULL OR held.survey_village_id <> $2)
          ORDER BY employee_name, a.asset_code`,
        [u.orgId, id])).rows;

      return {
        data: rows.map(r => ({
          asset_id: r.asset_id,
          asset_code: r.asset_code,
          asset_name: r.asset_name,
          employee_id: r.employee_id,
          employee_name: r.employee_name,
          // Null where the instrument is simply free — those can be brought
          // here with nothing to release first.
          held_by_village_id: r.held_by_village_id,
          held_by_village_name: r.held_by_village_name,
          held_since: iso(r.held_since),
        })),
      };
    });

  /**
   * Bring named instruments to this village.
   *
   * Releases them from wherever they are as of the day before, because a
   * rover is accounted to one village per day and the day it was last out
   * belongs to the village that worked it. The alternative — refusing
   * because the constraint would fire — is what made the screen look broken.
   */
  app.post('/api/v1/survey/villages/:id/rovers/claim',
    { preHandler: guard('survey.manage') }, async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(z.object({
        asset_ids: z.array(z.string().uuid()).min(1, 'Choose at least one instrument').max(100),
        on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }).strict(), req.body);

      return {
        data: await mutate(pool, req, 'survey.rover.claim', 'survey_rover_allocation', async db => {
          await villageOr404(db, u.orgId, id, u);
          const on = input.on ?? today();
          const brought: string[] = [], refused: Array<{ asset_code: string; why: string }> = [];
          const arriving: Array<{ asset_code: string; on: string }> = [];

          for (const assetId of input.asset_ids) {
            const asset = (await db.query(
              'SELECT asset_code FROM assets WHERE id = $1 AND org_id = $2',
              [assetId, u.orgId])).rows[0];
            if (!asset) { refused.push({ asset_code: assetId, why: 'not found' }); continue; }

            /*
             * Released the day before it arrives here, so no instrument is
             * on two villages for one day.
             *
             * Never before it got there, though: a rover that arrived this
             * morning cannot be released yesterday, and the check constraint
             * on these dates says so. In that case the stint stands as a
             * single day and this village gets it tomorrow — which is what
             * happens on the ground anyway, since somebody has to drive it
             * over.
             */
            await db.query(
              `UPDATE survey_rover_allocations
                  SET released_on = GREATEST(allocated_on, $3::date - 1)
                WHERE org_id = $1 AND asset_id = $2 AND released_on IS NULL`,
              [u.orgId, assetId, on]);

            await db.query('SAVEPOINT claim_row');
            try {
              await db.query(
                `INSERT INTO survey_rover_allocations(org_id, survey_village_id, asset_id,
                   allocated_on, created_by)
                 VALUES($1,$2,$3,
                   GREATEST($4::date,
                     COALESCE((SELECT max(r.released_on) + 1 FROM survey_rover_allocations r
                                WHERE r.asset_id = $3), '-infinity'::date)),
                   $5)`,
                [u.orgId, id, assetId, on, u.id]);
              brought.push(String(asset.asset_code));
              // Said, not assumed: an instrument that cannot arrive until
              // tomorrow is not one the crew has today.
              const landed = (await db.query(
                `SELECT allocated_on FROM survey_rover_allocations
                  WHERE asset_id = $1 AND survey_village_id = $2 AND released_on IS NULL
                  ORDER BY allocated_on DESC LIMIT 1`, [assetId, id])).rows[0];
              if (landed && iso(landed.allocated_on) !== on) {
                arriving.push({
                  asset_code: String(asset.asset_code), on: iso(landed.allocated_on)!,
                });
              }
              await db.query('RELEASE SAVEPOINT claim_row');
            } catch (error) {
              await db.query('ROLLBACK TO SAVEPOINT claim_row');
              if ((error as { code?: string }).code !== '23P01') throw error;
              refused.push({
                asset_code: String(asset.asset_code),
                why: 'still accounted to another village for these dates',
              });
            }
          }
          return { brought: brought.length, brought_codes: brought, refused, arriving };
        }),
      };
    });

  /* --------------------------------- certifying a finished village (§068) */

  /**
   * What a village is certified at, against what its returns add up to.
   *
   * Every figure in this module is the sum of daily returns, and that is the
   * right default. It is not what goes to the department: at handover the
   * village is recounted, parcels merge, a hamlet turns out to have been
   * counted twice, and the certified figure differs from the running sum.
   *
   * Both are always reported. A certified number that silently replaced the
   * record it came from would be the spreadsheet this module exists to
   * replace, just inside the database — and the difference between them is
   * what a reviewer actually looks at.
   */
  app.get('/api/v1/survey/villages/:id/finals', { preHandler: guard('survey.read') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      await villageOr404(pool, u.orgId, id, u);
      const m = await measures(pool, u.orgId);

      const recorded = new Map<string, number>((await pool.query(
        `SELECT mm.code, sum(ev.quantity) AS total
           FROM survey_entries e
           JOIN survey_entry_values ev ON ev.entry_id = e.id
           JOIN survey_measures mm ON mm.id = ev.measure_id
          WHERE e.org_id = $1 AND e.survey_village_id = $2
          GROUP BY mm.code`, [u.orgId, id])).rows
        .map(r => [String(r.code), Number(r.total)]));

      const certified = new Map<string, Record<string, unknown>>((await pool.query(
        `SELECT f.*, mm.code,
                COALESCE(NULLIF(trim(concat_ws(' ', e.first_name, e.last_name)), ''), usr.username)
                  AS certified_by_name
           FROM survey_village_finals f
           JOIN survey_measures mm ON mm.id = f.measure_id
           LEFT JOIN users usr ON usr.id = f.certified_by
           LEFT JOIN employees e ON e.id = usr.employee_id
          WHERE f.org_id = $1 AND f.survey_village_id = $2`, [u.orgId, id])).rows
        .map(r => [String(r.code), r]));

      return {
        data: m.rows.map(mm => {
          const code = String(mm.code);
          const f = certified.get(code);
          const rec = recorded.get(code) ?? 0;
          const cert = f ? Number(f.quantity) : null;
          return {
            code, label: mm.label, group_label: mm.group_label,
            unit: mm.unit, basis: mm.basis,
            // What the daily returns add up to, untouched.
            recorded: round2(rec),
            // What somebody stands behind, where anybody has.
            certified: cert,
            difference: cert === null ? null : round2(cert - rec),
            reason: f ? f.reason : null,
            certified_by_name: f ? f.certified_by_name : null,
            certified_at: f ? iso(f.certified_at) : null,
            final_id: f ? f.id : null,
            version: f ? f.version : null,
          };
        }),
      };
    });

  /**
   * Certify a finished village's totals.
   *
   * Open to the people who ran the work — team leads as well as managers —
   * because closing out a village is part of running it. Deliberately not
   * folded into survey.manage: a team lead certifies what they surveyed
   * without also being able to set the targets they are measured against.
   */
  app.put('/api/v1/survey/villages/:id/finals', { preHandler: guard('survey.certify') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(villageFinalsSchema, req.body);
      return {
        data: await mutate(pool, req, 'survey.village.certify', 'survey_village', async db => {
          await villageOr404(db, u.orgId, id, u);

          /*
           * Only a village that has finished something.
           *
           * Certifying a village still being surveyed would freeze a figure
           * the crews are still adding to, and every day's return after it
           * would widen a difference nobody meant to create.
           */
          const stages = await stageStatesOf(db, id);
          const anyDone = Object.values(stages).some(v => v === 'COMPLETED');
          if (!anyDone) {
            fail('NOTHING_FINISHED',
              'Nothing has been signed off on this village yet. Certified totals are for '
              + 'closing out work that is finished — complete a stage first.', 422);
          }

          const m = await measures(db, u.orgId);
          const written: string[] = [];
          for (const f of input.finals) {
            const measure = m.byCode.get(f.measure_code);
            if (!measure) {
              fail('UNKNOWN_MEASURE', `There is no measure ${f.measure_code}`, 422);
            }
            await db.query(
              `INSERT INTO survey_village_finals(org_id, survey_village_id, measure_id,
                 quantity, reason, certified_by, created_by, updated_by)
               VALUES($1,$2,$3,$4,$5,$6,$6,$6)
               ON CONFLICT (survey_village_id, measure_id)
               DO UPDATE SET quantity = EXCLUDED.quantity, reason = EXCLUDED.reason,
                             certified_by = EXCLUDED.certified_by, certified_at = now(),
                             version = survey_village_finals.version + 1,
                             updated_at = now(), updated_by = EXCLUDED.updated_by`,
              [u.orgId, id, measure.id, f.quantity, f.reason, u.id]);
            written.push(f.measure_code);
          }
          return { certified: written.length, measures: written };
        }),
      };
    });

  /** Take a certified figure back off, so the village reads as its returns again. */
  app.delete('/api/v1/survey/villages/:id/finals/:code',
    { preHandler: guard('survey.certify') }, async req => {
      const u = actor(req);
      const { id, code } = req.params as { id: string; code: string };
      return {
        data: await mutate(pool, req, 'survey.village.certify.clear', 'survey_village', async db => {
          await villageOr404(db, u.orgId, id, u);
          const done = await db.query(
            `DELETE FROM survey_village_finals f
              USING survey_measures mm
              WHERE f.measure_id = mm.id AND mm.code = $3
                AND f.org_id = $1 AND f.survey_village_id = $2`, [u.orgId, id, code]);
          return { cleared: done.rowCount ?? 0, code };
        }),
      };
    });

  /* ----------------------------------------- submitted for billing (§066) */

  /**
   * What has been claimed against a village.
   *
   * A resurvey contract releases a village's value in stages — half at ground
   * truthing, thirty per cent at records, the rest on final submission. The
   * office needs to pull "villages where the first claim went in and the
   * second has not", and that list lived in a spreadsheet until now.
   */
  app.get('/api/v1/survey/villages/:id/billing', { preHandler: guard('survey.read') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      await villageOr404(pool, u.orgId, id, u);
      const rows = (await pool.query(
        `SELECT b.*,
                NULLIF(trim(concat_ws(' ', e.first_name, e.last_name)), '')
                  AS submitted_by_name
           FROM survey_village_billing b
           LEFT JOIN users usr ON usr.id = b.created_by
           LEFT JOIN employees e ON e.id = usr.employee_id
          WHERE b.org_id = $1 AND b.survey_village_id = $2
          ORDER BY b.milestone`,
        [u.orgId, id])).rows;
      const claims = rows.map(r => ({
        ...r,
        percent: num(r.percent),
        extent_ac: num(r.extent_ac),
        submitted_on: iso(r.submitted_on),
        decided_on: iso(r.decided_on),
      }));
      return {
        data: claims,
        // The share released so far, so the screen does not have to know the
        // contract's split to say "80% claimed".
        meta: { claimed_percent: claimedPercent(claims) },
      };
    });

  /**
   * A village's claims may not release more than all of it.
   *
   * Each claim's percent was checked on its own, so three claims of sixty
   * each were all acceptable and the village was billed at 180%. The total is
   * checked here, under a lock on the village row: two claims raised at the
   * same moment would otherwise each read the other's absence and both pass.
   *
   * Returned claims release nothing (claimedPercent says the same), and the
   * claim being amended is left out so that it is counted once, at its new
   * figure.
   */
  async function withinHundredOr422(
    db: PoolClient, villageId: string, adding: number, excludeClaimId: string | null,
  ): Promise<void> {
    await db.query('SELECT id FROM survey_villages WHERE id = $1 FOR UPDATE', [villageId]);
    const standing = Number((await db.query(
      `SELECT COALESCE(sum(percent), 0) AS total FROM survey_village_billing
        WHERE survey_village_id = $1 AND status <> 'REJECTED'
          AND ($2::uuid IS NULL OR id <> $2::uuid)`,
      [villageId, excludeClaimId])).rows[0].total);
    if (Math.round((standing + adding) * 100) > 100 * 100) {
      fail('CLAIMED_OVER_100',
        `This village already has ${standing}% claimed, and ${adding}% more would take it past 100%. `
        + 'Check the percentage, or amend the claim that is already standing.', 422);
    }
  }

  app.post('/api/v1/survey/villages/:id/billing', { preHandler: guard('survey.manage') },
    async (req, reply) => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(villageBillingSchema, req.body);
      const status = (input.status ?? 'SUBMITTED') as BillingStatus;
      if (billingDecisionRequired(status) && !input.decided_on) {
        fail('DECISION_DATE_REQUIRED',
          'A claim recorded as ' + status.toLowerCase() +
          ' needs the date the department decided it. Enter that date, or record it as submitted for now.', 422);
      }
      const data = await mutate(pool, req, 'survey.village.billing', 'survey_village_billing',
        async db => {
          await villageOr404(db, u.orgId, id, u);
          await earnedOr422(db, req, u.orgId, id, input.milestone);
          await inOrderOr422(db, id, input.milestone);
          const existing = await db.query(
            'SELECT milestone FROM survey_village_billing WHERE survey_village_id = $1 AND milestone = $2',
            [id, input.milestone]);
          if (existing.rowCount) {
            fail('MILESTONE_ALREADY_CLAIMED',
              'Milestone ' + input.milestone + ' has already been submitted for this village. ' +
              'Open the claim to change its status or reference number.', 409);
          }
          if (status !== 'REJECTED') {
            await withinHundredOr422(db, id,
              Number(input.percent ?? MILESTONE_PERCENT[input.milestone] ?? 0), null);
          }
          const row = (await db.query(
            `INSERT INTO survey_village_billing(org_id, survey_village_id, milestone,
               percent, status, submitted_on, decided_on, reference_no, extent_ac,
               remarks, created_by, updated_by)
             VALUES($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$11)
             RETURNING *`,
            [u.orgId, id, input.milestone,
              // Defaulted from the milestone so the usual case needs no
              // decision; stored, so a different contract keeps its own split.
              input.percent ?? MILESTONE_PERCENT[input.milestone] ?? 0,
              status, input.submitted_on ?? today(), input.decided_on ?? null,
              input.reference_no ?? null, input.extent_ac ?? null,
              input.remarks ?? null, u.id])).rows[0];
          return { ...row, percent: num(row.percent), extent_ac: num(row.extent_ac) };
        });
      reply.code(201);
      return { data };
    });

  app.patch('/api/v1/survey/billing/:id', { preHandler: guard('survey.manage') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(villageBillingPatchSchema, req.body);
      return {
        data: await mutate(pool, req, 'survey.village.billing.update', 'survey_village_billing', async db => {
          const row = await inOrg(db, 'survey_village_billing', id, u.orgId, true);
          if (!row) fail('NOT_FOUND', 'That billing claim no longer exists.', 404);
          await villageOr404(db, u.orgId, String(row.survey_village_id), u);
          version(req, row as { version: number });
          const status = (input.status ?? row.status) as BillingStatus;
          const decided = input.decided_on !== undefined ? input.decided_on : row.decided_on;
          if (billingDecisionRequired(status) && !decided) {
            fail('DECISION_DATE_REQUIRED',
              'A claim recorded as ' + status.toLowerCase() +
              ' needs the date the department decided it.', 422);
          }
          // Checked whenever the claim will be standing afterwards: a new
          // percent, or a returned claim put back in, both change the total.
          if (status !== 'REJECTED') {
            await withinHundredOr422(db, String(row.survey_village_id),
              Number(input.percent ?? row.percent ?? 0), id);
          }
          const sets: string[] = [], values: unknown[] = [id];
          for (const key of ['percent', 'status', 'submitted_on', 'decided_on',
            'reference_no', 'extent_ac', 'remarks'] as const) {
            if (input[key] !== undefined) { values.push(input[key]); sets.push(`${key} = $${values.length}`); }
          }
          if (!sets.length) return row;
          values.push(u.id);
          const updated = (await db.query(
            `UPDATE survey_village_billing SET ${sets.join(', ')}, version = version + 1,
               updated_at = now(), updated_by = $${values.length}
             WHERE id = $1 RETURNING *`, values)).rows[0];
          return { ...updated, percent: num(updated.percent), extent_ac: num(updated.extent_ac) };
        }),
      };
    });

  app.delete('/api/v1/survey/billing/:id', { preHandler: guard('survey.manage') },
    async req => ({
      data: await mutate(pool, req, 'survey.village.billing.delete', 'survey_village_billing', async db => {
        const u = actor(req), id = (req.params as { id: string }).id;
        const row = await inOrg(db, 'survey_village_billing', id, u.orgId, true);
        if (!row) fail('NOT_FOUND', 'That billing claim no longer exists.', 404);
        await villageOr404(db, u.orgId, String(row.survey_village_id), u);
        await db.query('DELETE FROM survey_village_billing WHERE id = $1', [id]);
        return { id, deleted: true };
      }),
    }));

  /**
   * Villages by what has been claimed on them.
   *
   * The list the office pulls before a review: who is due a second claim, what
   * went in last month, what the department has sat on. Filters are ANDed,
   * and a village appears once per claim that matches.
   */
  app.get('/api/v1/survey/billing', { preHandler: guard('survey.read') },
    async req => {
      const u = actor(req);
      const q = parse(z.object({
        project_id: z.string().uuid().optional(),
        milestone: z.coerce.number().int().min(1).max(9).optional(),
        status: z.enum(['SUBMITTED', 'APPROVED', 'REJECTED', 'PAID']).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        /** Villages with nothing claimed at this milestone yet. */
        outstanding: z.coerce.number().int().min(1).max(9).optional(),
      }).strict(), req.query ?? {});
      // The claim register, for the programmes this reader may see. It was
      // read organisation-wide by anybody holding survey.read, which put what
      // every village is being invoiced for in front of a client.
      const allowed = await visibleProgrammes(pool, u);

      if (q.outstanding !== undefined) {
        const rows = (await pool.query(
          `SELECT v.id, v.survey_project_id, ou.name AS village_name,
                  v.total_extent_ac,
                  (SELECT string_agg(b2.milestone::text, ',' ORDER BY b2.milestone)
                     FROM survey_village_billing b2
                    WHERE b2.survey_village_id = v.id AND b2.status <> 'REJECTED') AS claimed
             FROM survey_villages v
             JOIN org_units ou ON ou.id = v.village_id
            WHERE v.org_id = $1
              AND ($2::uuid IS NULL OR v.survey_project_id = $2)
              AND ($4::uuid[] IS NULL OR v.survey_project_id = ANY($4::uuid[]))
              AND NOT EXISTS (
                SELECT 1 FROM survey_village_billing b
                 WHERE b.survey_village_id = v.id AND b.milestone = $3
                   AND b.status <> 'REJECTED')
            ORDER BY ou.name`,
          [u.orgId, q.project_id ?? null, q.outstanding, allowed])).rows;
        return {
          data: rows.map(r => ({
            ...r, total_extent_ac: num(r.total_extent_ac),
            claimed_milestones: r.claimed ? String(r.claimed).split(',').map(Number) : [],
          })),
        };
      }

      const rows = (await pool.query(
        `SELECT b.*, v.survey_project_id, ou.name AS village_name,
                v.total_extent_ac
           FROM survey_village_billing b
           JOIN survey_villages v ON v.id = b.survey_village_id
           JOIN org_units ou ON ou.id = v.village_id
          WHERE b.org_id = $1
            AND ($2::uuid IS NULL OR v.survey_project_id = $2)
            AND ($3::int IS NULL OR b.milestone = $3)
            AND ($4::text IS NULL OR b.status = $4)
            AND ($5::date IS NULL OR b.submitted_on >= $5)
            AND ($6::date IS NULL OR b.submitted_on <= $6)
            AND ($7::uuid[] IS NULL OR v.survey_project_id = ANY($7::uuid[]))
          ORDER BY b.submitted_on DESC, ou.name`,
        [u.orgId, q.project_id ?? null, q.milestone ?? null, q.status ?? null,
          q.from ?? null, q.to ?? null, allowed])).rows;
      return {
        data: rows.map(r => ({
          ...r, percent: num(r.percent), extent_ac: num(r.extent_ac),
          total_extent_ac: num(r.total_extent_ac),
          submitted_on: iso(r.submitted_on),
          decided_on: iso(r.decided_on),
        })),
      };
    });

  /**
   * Claim, or record a decision on, a batch of villages (§066).
   *
   * Forty villages go into one claim under one covering letter. Recording
   * that a village at a time is how thirty-eight go in and two are found
   * months later, unclaimed, on a programme everybody believes is fully
   * billed.
   *
   * Nothing is written until the caller has seen what would happen. This is
   * the screen where somebody discovers they had the wrong filter applied,
   * and by then two hundred villages are claimed.
   *
   * A village that cannot take the action is named and skipped rather than
   * failing the batch: refusing all forty because two were already claimed
   * means doing the other thirty-eight again by hand.
   */
  app.post('/api/v1/survey/billing/bulk', { preHandler: guard('survey.manage') },
    async req => {
      const u = actor(req);
      const input = parse(villageBillingBulkSchema, req.body);
      const ids = [...new Set(input.survey_village_ids)];

      return {
        data: await mutate(pool, req, 'survey.village.billing.bulk',
          'survey_village_billing', async db => {
            /*
             * Every village in the batch, with what already stands against
             * this milestone. One query rather than one per village: a
             * thousand round trips inside a transaction holds locks for
             * minutes and times the request out.
             *
             * Scoped by org here, and the count of what came back is
             * compared against what was asked for — a village id from
             * another organisation simply is not in the result, and is
             * reported as not found rather than acted on.
             */
            const rows = (await db.query(
              `SELECT sv.id, ou.name AS village_name, sv.total_extent_ac,
                      b.id AS claim_id, b.status AS claim_status, b.version AS claim_version,
                      /*
                       * Whether the village has earned this milestone yet.
                       *
                       * Resolved through the task where the stage is driven
                       * by one, exactly as the rest of the module does it —
                       * reading the stage row alone would call a village
                       * unfinished when its board says otherwise.
                       */
                      EXISTS (
                        SELECT 1 FROM survey_village_stages vs
                          JOIN survey_stages st ON st.id = vs.stage_id
                          LEFT JOIN tasks tk ON tk.id = vs.task_id
                         WHERE vs.survey_village_id = sv.id
                           AND st.code = $4
                           AND CASE WHEN vs.task_id IS NOT NULL
                                    THEN tk.status = 'DONE'
                                    ELSE vs.state = 'COMPLETED' END
                      ) AS earned,
                      (SELECT count(DISTINCT prior.milestone)
                         FROM survey_village_billing prior
                        WHERE prior.survey_village_id = sv.id
                          AND prior.milestone < $3
                          AND prior.status <> 'REJECTED')::int AS priors_in
                 FROM survey_villages sv
                 JOIN org_units ou ON ou.id = sv.village_id
                 LEFT JOIN survey_village_billing b
                        ON b.survey_village_id = sv.id AND b.milestone = $3
                WHERE sv.org_id = $1 AND sv.id = ANY($2::uuid[])
                ORDER BY ou.name`,
              [u.orgId, ids, input.milestone,
                // Null where the contract gates nothing, which no village
                // then matches — handled below rather than in SQL.
                MILESTONE_REQUIRES[input.milestone] ?? null])).rows;

            const found = new Set(rows.map(r => String(r.id)));
            const notFound = ids.filter(id => !found.has(id));

            /*
             * What already stands on each village, read under a lock, so a
             * batch cannot take a village past 100% any more than a single
             * claim can (see withinHundredOr422). Locked in id order, the
             * same order every batch uses, so two batches cannot deadlock.
             * The claim this batch would amend is left out of its own total.
             */
            const standingBy = new Map<string, number>();
            if (input.action === 'SUBMIT' && rows.length) {
              await db.query(
                `SELECT id FROM survey_villages WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
                [rows.map(r => r.id)]);
              const sums = (await db.query(
                `SELECT survey_village_id AS vid, COALESCE(sum(percent), 0) AS total
                   FROM survey_village_billing
                  WHERE survey_village_id = ANY($1::uuid[]) AND status <> 'REJECTED'
                    AND milestone <> $2
                  GROUP BY 1`,
                [rows.map(r => r.id), input.milestone])).rows;
              for (const s of sums) standingBy.set(String(s.vid), Number(s.total));
            }
            const adding = Number(input.percent ?? MILESTONE_PERCENT[input.milestone] ?? 0);

            const eligible: typeof rows = [];
            const skipped: Array<{ village_name: string; reason: string }> = [];

            for (const r of rows) {
              const standing = r.claim_id && r.claim_status !== 'REJECTED';
              if (input.action === 'SUBMIT') {
                // A returned claim is claimable again — the milestone is
                // owed once more — so only a standing one blocks.
                if (standing) {
                  skipped.push({ village_name: String(r.village_name), reason: 'ALREADY_CLAIMED' });
                  continue;
                }
                /*
                 * A milestone the village has not earned is left out, named.
                 *
                 * The single-claim route refuses outright; a batch of four
                 * hundred cannot, or one unfinished village would stop the
                 * other three hundred and ninety-nine. Skipped and counted,
                 * so the preview says exactly how many and why.
                 */
                if (MILESTONE_REQUIRES[input.milestone] && !r.earned) {
                  skipped.push({ village_name: String(r.village_name), reason: 'NOT_EARNED' });
                  continue;
                }
                if (Math.round(((standingBy.get(String(r.id)) ?? 0) + adding) * 100) > 100 * 100) {
                  skipped.push({ village_name: String(r.village_name), reason: 'CLAIMED_OVER_100' });
                  continue;
                }
              } else {
                if (!r.claim_id) {
                  skipped.push({ village_name: String(r.village_name), reason: 'NOTHING_TO_DECIDE' });
                  continue;
                }
                if (String(r.claim_status) === input.status) {
                  skipped.push({
                    village_name: String(r.village_name), reason: 'ALREADY_IN_THAT_STATE',
                  });
                  continue;
                }
              }
              eligible.push(r);
            }

            /*
             * Claiming a milestone with an earlier one outstanding.
             *
             * Not refused — a contract variation can release them in any
             * order, and the department, not this software, decides what it
             * will accept. Counted and reported, because the usual cause is
             * the wrong milestone picked, and finding that out before the
             * letter goes out is the whole point of the preview.
             */
            const outOfOrder = input.action === 'SUBMIT' && input.milestone > 1
              // Every milestone below this one has to be standing. A third
              // claim with the first in and the second outstanding is the
              // mistake worth catching, and "has some earlier claim" would
              // wave it through.
              ? eligible.filter(r => Number(r.priors_in) < input.milestone - 1).length : 0;

            if (input.dry_run) {
              return {
                dry_run: true,
                would_change: eligible.length,
                villages: eligible.slice(0, 20).map(r => String(r.village_name)),
                skipped, not_found: notFound, out_of_order: outOfOrder,
                // Only meaningful when claiming each village's own extent.
                without_extent: input.action === 'SUBMIT' && input.use_village_extent
                  ? eligible.filter(r => r.total_extent_ac === null).length : 0,
              };
            }

            if (input.action === 'SUBMIT') {
              for (const r of eligible) {
                // A milestone claimed, returned, and claimed again keeps one
                // row: the second claim amends the first, or the percentages
                // stop adding to a hundred.
                if (r.claim_id) {
                  await db.query(
                    `UPDATE survey_village_billing
                        SET status = 'SUBMITTED', percent = $2, submitted_on = $3::date,
                            decided_on = NULL, reference_no = $4, extent_ac = $5, remarks = $6,
                            version = version + 1, updated_at = now(), updated_by = $7
                      WHERE id = $1`,
                    [r.claim_id, input.percent ?? MILESTONE_PERCENT[input.milestone] ?? 0,
                      input.submitted_on ?? today(), input.reference_no ?? null,
                      input.use_village_extent ? r.total_extent_ac : null,
                      input.remarks ?? null, u.id]);
                  continue;
                }
                await db.query(
                  `INSERT INTO survey_village_billing(org_id, survey_village_id, milestone,
                     percent, status, submitted_on, reference_no, extent_ac, remarks,
                     created_by, updated_by)
                   VALUES($1,$2,$3,$4,'SUBMITTED',$5::date,$6,$7,$8,$9,$9)`,
                  [u.orgId, r.id, input.milestone,
                    input.percent ?? MILESTONE_PERCENT[input.milestone] ?? 0,
                    input.submitted_on ?? today(), input.reference_no ?? null,
                    input.use_village_extent ? r.total_extent_ac : null,
                    input.remarks ?? null, u.id]);
              }
            } else {
              await db.query(
                `UPDATE survey_village_billing
                    SET status = $2, decided_on = $3::date,
                        remarks = COALESCE($4, remarks),
                        version = version + 1, updated_at = now(), updated_by = $5
                  WHERE id = ANY($1::uuid[])`,
                [eligible.map(r => r.claim_id), input.status, input.decided_on ?? null,
                  input.remarks ?? null, u.id]);
            }

            return {
              dry_run: false,
              updated: eligible.length,
              villages: eligible.slice(0, 20).map(r => String(r.village_name)),
              skipped, not_found: notFound, out_of_order: outOfOrder,
            };
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
             VALUES($1,$2,$3,$4,$5::date,$6)
             ON CONFLICT (survey_project_id, employee_id)
             DO UPDATE SET project_role = EXCLUDED.project_role, released_on = NULL
             RETURNING *`,
            [u.orgId, id, input.employee_id, input.project_role,
              input.assigned_on ?? today(), u.id])).rows[0];
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
      const to = dateParam(req, q.to, 'to', today());
      const from = dateParam(req, q.from, 'from', '1900-01-01');

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
      const to = dateParam(req, q.to, 'to', today());
      const from = dateParam(req, q.from, 'from', '1900-01-01');

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
   * The days one instrument sat idle, and where (§note 16).
   *
   * The productivity table says a rover was idle eleven days. That is a
   * number; "eleven days idle, nine of them in Koyyuru waiting for the VRO"
   * is a conversation with the mandal. Getting from one to the other meant
   * reading the returns village by village.
   *
   * Every idle day, not a summary: eleven rows is a list somebody scans, and
   * summarising them again would lose the dates, which are what an escalation
   * is built on.
   */
  app.get('/api/v1/survey/projects/:id/rovers/:assetId/idle-days',
    { preHandler: guard('survey.read') }, async req => {
      const u = actor(req);
      const { id, assetId } = req.params as { id: string; assetId: string };
      const { q } = page(req);
      await projectOr404(pool, u.orgId, id, u);
      const to = dateParam(req, q.to, 'to', today());
      const from = dateParam(req, q.from, 'from', '1900-01-01');

      const rows = (await pool.query(
        `SELECT se.entry_date, se.survey_village_id, ou.name AS village_name,
                m.name AS mandal_name,
                er.idle_reason, er.remarks,
                COALESCE(NULLIF(trim(concat_ws(' ', e.first_name, e.last_name)), ''), e.emp_no)
                  AS employee_name
           FROM survey_entry_rovers er
           JOIN survey_entries se ON se.id = er.entry_id
           JOIN survey_villages sv ON sv.id = se.survey_village_id
           JOIN org_units ou ON ou.id = sv.village_id
           LEFT JOIN org_units m ON m.id = ou.parent_id
           LEFT JOIN employees e ON e.id = er.employee_id
          WHERE se.org_id = $1 AND se.survey_project_id = $2
            AND er.asset_id = $3::uuid AND er.status = 'IDLE'
            AND se.entry_date BETWEEN $4::date AND $5::date
          ORDER BY se.entry_date DESC`,
        [u.orgId, id, assetId, from, to])).rows;

      const asset = (await pool.query(
        'SELECT asset_code, name FROM assets WHERE id = $1 AND org_id = $2',
        [assetId, u.orgId])).rows[0];

      return {
        data: {
          asset_code: asset?.asset_code ?? null,
          asset_name: asset?.name ?? null,
          from, to,
          days: rows.map(r => ({
            entry_date: iso(r.entry_date),
            survey_village_id: r.survey_village_id,
            village_name: r.village_name,
            mandal_name: r.mandal_name,
            idle_reason: r.idle_reason,
            // The label comes from one place, so the badge on the summary
            // and the row in this list cannot word the same reason
            // differently.
            idle_reason_label: reasonLabel(r.idle_reason),
            remarks: r.remarks,
            employee_name: r.employee_name,
          })),
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
           /*
            * Villages inside this unit with nobody on them, and villages with
            * people but no instrument.
            *
            * A count of crew says how many are deployed; it does not say
            * where nobody is. "Eleven villages in this mandal and four people"
            * reads as coverage until you notice the four are all on one
            * village. These two are the gap, which is what the screen is for.
            */
           count(DISTINCT s.survey_village_id) FILTER (
             WHERE NOT EXISTS (
               SELECT 1 FROM survey_crew c2
                WHERE c2.survey_village_id = s.survey_village_id
                  AND c2.released_on IS NULL))::int AS villages_uncrewed,
           count(DISTINCT s.survey_village_id) FILTER (
             WHERE EXISTS (
               SELECT 1 FROM survey_crew c3
                WHERE c3.survey_village_id = s.survey_village_id
                  AND c3.released_on IS NULL)
               AND NOT EXISTS (
               SELECT 1 FROM survey_rover_allocations r2
                WHERE r2.survey_village_id = s.survey_village_id
                  AND r2.released_on IS NULL))::int AS villages_unequipped,
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
            // The gaps, added across units: a village is in exactly one.
            villages_uncrewed: rows.reduce((t, r) => t + Number(r.villages_uncrewed), 0),
            villages_unequipped: rows.reduce((t, r) => t + Number(r.villages_unequipped), 0),
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
      const from = dateParam(req, q.from, 'from', today());
      const to = dateParam(req, q.to, 'to', from);

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
      const asOf = dateParam(req, q.as_of, 'as_of', today());

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
      const asOf = dateParam(req, q.as_of, 'as_of', today());

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
        // The rate is of all the work done, measured village or not; only
        // the share of the extent is confined to villages that have one.
        surveyedAc: whole.surveyedAc + whole.unweightedSurveyedAc,
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
      const asOf = dateParam(req, q.to ?? q.as_of, q.to ? 'to' : 'as_of', today());
      const from = q.from ? dateParam(req, q.from, 'from', today()) : undefined;

      const [m, codes, all, pipeline] = await Promise.all([
        measures(pool, u.orgId), stageCodes(pool, u.orgId),
        positions(pool, u.orgId, id, { asOf }),
        stagePipeline(pool, u.orgId),
      ]);

      /*
       * Narrowing the programme to part of itself.
       *
       * Applied to the villages before anything is added up, not to the
       * table afterwards: a screen that filters the rows but leaves "42%
       * complete" standing above them is reporting the programme's figure
       * under the district's heading, and somebody will quote it.
       *
       * District and mandal match by name, which is what the picker offers
       * and what a person reads. Names are unique inside a programme's
       * geography; where they are not, the village filter is exact.
       */
      const fDistrict = q.district ? String(q.district) : '';
      const fMandal = q.mandal ? String(q.mandal) : '';
      const fVillage = q.village_id ? String(q.village_id) : '';
      const fStage = q.stage ? String(q.stage) : '';
      // Outstanding means not finished: not started, in progress and on hold
      // together. It is the state people ask about and the one no single
      // stage value holds.
      const fStageState = q.stage_state ? String(q.stage_state) : 'OUTSTANDING';

      const districtOf = (row: Record<string, any>) => row.parent_type === 'district'
        ? row.parent_name
        : row.grandparent_type === 'district' ? row.grandparent_name : null;

      const pos = all.filter(p => {
        if (fDistrict && String(districtOf(p.row) ?? '') !== fDistrict) return false;
        if (fMandal && String(p.row.mandal_name ?? '') !== fMandal) return false;
        if (fVillage && String(p.villageId) !== fVillage) return false;
        if (fStage) {
          const at = String(p.stages?.[fStage] ?? 'NOT_STARTED');
          if (fStageState === 'OUTSTANDING' ? at === 'COMPLETED' : at !== fStageState) return false;
        }
        return true;
      });

      const filtered = pos.length !== all.length;
      const villageIds = pos.map(p => p.villageId);

      /*
       * Rovers and pace, over the same villages.
       *
       * Left unfiltered they would report the whole programme's instruments
       * beside one district's acres, and the utilisation figure that came
       * out would belong to neither.
       */
      const scope = filtered ? ' AND sv.id = ANY($4::uuid[])' : '';
      const entryScope = filtered ? ' AND e.survey_village_id = ANY($4::uuid[])' : '';
      const roverArgs = filtered ? [u.orgId, id, asOf, villageIds] : [u.orgId, id, asOf];

      // Rovers: allocated on the day against what the crews reported using.
      // Idle is the figure worth having, and neither half of it means
      // anything without the other.
      const roverRow = (await pool.query(
        `SELECT
           (SELECT count(*)::int FROM survey_rover_allocations ra
             JOIN survey_villages sv ON sv.id = ra.survey_village_id
            WHERE sv.survey_project_id = $2 AND ra.org_id = $1
              AND ra.allocated_on <= $3::date
              AND (ra.released_on IS NULL OR ra.released_on >= $3::date)${scope}) AS allocated,
           (SELECT COALESCE(sum(e.dgps_rovers), 0)::int FROM survey_entries e
            WHERE e.org_id = $1 AND e.survey_project_id = $2 AND e.entry_date = $3::date${entryScope})
             AS used,
           /*
            * Rovers the day's returns actually speak for.
            *
            * A village that filed nothing has said nothing about its
            * instruments, and counting them as idle told a project manager
            * every morning that his whole fleet was in a store. Counted from
            * the allocations of the villages that did file.
            */
           (SELECT count(*)::int FROM survey_rover_allocations ra
             JOIN survey_villages sv ON sv.id = ra.survey_village_id
            WHERE sv.survey_project_id = $2 AND ra.org_id = $1
              AND ra.allocated_on <= $3::date
              AND (ra.released_on IS NULL OR ra.released_on >= $3::date)${scope}
              AND EXISTS (SELECT 1 FROM survey_entries e2
                           WHERE e2.survey_village_id = sv.id
                             AND e2.entry_date = $3::date)) AS accounted_for`,
        roverArgs)).rows[0];
      const rovers = {
        as_of: asOf,
        ...roverUtilisation({
          allocated: Number(roverRow.allocated), used: Number(roverRow.used),
          accountedFor: Number(roverRow.accounted_for),
        }),
      };

      // Pace over the window asked for, defaulting to the programme's life.
      const paceArgs: unknown[] = [u.orgId, id, asOf];
      let paceClause = '';
      if (from) { paceArgs.push(from); paceClause += ` AND e.entry_date >= $${paceArgs.length}::date`; }
      if (filtered) {
        paceArgs.push(villageIds);
        paceClause += ` AND e.survey_village_id = ANY($${paceArgs.length}::uuid[])`;
      }
      const paceWindow = (await pool.query(
        `SELECT count(DISTINCT e.entry_date)::int AS active_days,
                min(e.entry_date) AS first_day
         FROM survey_entries e
         WHERE e.org_id = $1 AND e.survey_project_id = $2
           AND e.entry_date <= $3::date${paceClause}`,
        paceArgs)).rows[0];
      const firstDay = iso(paceWindow.first_day) ?? asOf;
      const calendarDays = Math.max(1, Math.round(
        (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${firstDay}T00:00:00Z`)) / 86_400_000) + 1);
      const whole = rollUp(pos, m.codes, codes, m.basis);
      const paceFigures = pace({
        // The rate is of all the work done, measured village or not; only
        // the share of the extent is confined to villages that have one.
        surveyedAc: whole.surveyedAc + whole.unweightedSurveyedAc,
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
          // The same villages counted the way the dashboard counts them:
          // one village, one position, eleven positions in all.
          by_position: tallyByPosition(g.items),
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

      /*
       * The geography the pickers should offer.
       *
       * Taken from the programme's own villages, not from a master list: a
       * programme covering three mandals should not offer a picker with two
       * hundred. Mandals narrow to the district once one is chosen, because
       * a picker that offers mandals from elsewhere invites an empty screen.
       */
      const districts = [...new Set(all
        .map(p => String(districtOf(p.row) ?? '')).filter(Boolean))].sort();
      const mandals = [...new Set(all
        .filter(p => !fDistrict || String(districtOf(p.row) ?? '') === fDistrict)
        .map(p => String(p.row.mandal_name ?? '')).filter(Boolean))].sort();
      const villages = all
        .filter(p => (!fDistrict || String(districtOf(p.row) ?? '') === fDistrict)
          && (!fMandal || String(p.row.mandal_name ?? '') === fMandal))
        .map(p => ({ id: p.villageId, name: String(p.row.village_name) }))
        .sort((a, b) => a.name.localeCompare(b.name));

      /*
       * Attendance over the window, for the villages in scope (§067).
       *
       * Bounded by the same dates and the same villages as everything else
       * on the screen, so "82% turnout" and "40% complete" describe the same
       * programme rather than two different slices of it.
       */
      const staffing = await staffingOver(
        pool, u.orgId, id, from ?? '1900-01-01', asOf,
        filtered ? villageIds : undefined);

      return {
        data: {
          level,
          as_of: asOf,
          from: from ?? null,
          staffing,
          // What the figures below cover, so a screen can say so rather than
          // leaving a reader to remember what they picked.
          filter: {
            district: fDistrict || null,
            mandal: fMandal || null,
            village_id: fVillage || null,
            stage: fStage || null,
            stage_state: fStage ? fStageState : null,
            villages: pos.length,
            of_villages: all.length,
          },
          options: { districts, mandals, villages },
          rows,
          // The whole programme, computed from the same villages, so the
          // headline and the rows below it cannot disagree.
          total: rollUp(pos, m.codes, codes, m.basis),
          by_stage: tallyByStage(pos, pipeline),
          by_position: tallyByPosition(pos),
          /* The label and what it means, so the screen never has to carry
             a second copy of the explanation. */
          ladder: VILLAGE_LADDER.map(r => ({
            key: r.key, label: r.label, note: LADDER_NOTES[r.key] ?? null,
          })),
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
  /**
   * The programme at a glance, for somebody outside the company (§071).
   *
   * A separate endpoint rather than a filtered view of /progress, and
   * deliberately so. /progress carries crew lists, rover utilisation, idle
   * reasons and the claim register alongside the figures; building the
   * official's view by removing things from it means the next field added to
   * /progress is exposed by default. This query selects what may be shown and
   * can leak nothing else, because nothing else is in it.
   *
   * No money, no names, no equipment. Villages, extent, and where each one
   * has got to.
   */
  /**
   * The programmes an observer may look at (§071).
   *
   * Its own endpoint rather than relaxing /survey/projects, which returns the
   * whole programme record — thresholds, pairing, status history — and grows
   * whenever somebody adds a column. This returns the three fields a picker
   * needs and can never return a fourth.
   */
  app.get('/api/v1/survey/dashboard/projects',
    { preHandler: guard('survey.dashboard') }, async req => {
      const u = actor(req);
      // A client is offered only the programmes run for them.
      const only = clientOnly(u) ? await clientProgrammes(pool, u) : null;
      const rows = (await pool.query(
        `SELECT id, code, name FROM survey_projects
          WHERE org_id = $1 AND status = 'ACTIVE'
            AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
          ORDER BY name`, [u.orgId, only])).rows;
      return { data: rows };
    });

  app.get('/api/v1/survey/projects/:id/dashboard',
    { preHandler: guard('survey.dashboard') }, async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const q = (req.query ?? {}) as Record<string, string | undefined>;
      // An observer is not enrolled on the programme, so the scoping that
      // governs staff does not apply to them; the permission is the grant.
      // A client reads as an observer too: progress, no names, no money.
      // The department's view: where the work is, never whose desk it is on.
      const observerView = readsAsObserver(u);
      const project = observerView
        ? await observerProgrammeOr404(pool, u, id)
        : await projectOr404(pool, u.orgId, id, u);

      const to = dateParam(req, q.to, 'to', today());
      const from = dateParam(req, q.from, 'from', '');
      const level = (REPORT_LEVELS as readonly string[]).includes(String(q.level ?? ''))
        ? String(q.level) as ReportLevel : 'district';
      const fDistrict = String(q.district ?? '').trim();
      const fMandal = String(q.mandal ?? '').trim();
      const fPosition = String(q.position ?? '').trim();
      /*
       * Drilling into a reason (§073).
       *
       * `reason` is the delay code; `reason_source` says which of the three
       * places it was recorded. Both are needed: "weather" against a stage
       * that missed its date and "weather" against an idle instrument are
       * different facts about different villages, and merging them would
       * hand somebody a list that does not match the number they clicked.
       */
      const fReason = String(q.reason ?? '').trim().toUpperCase();
      const fReasonSource = String(q.reason_source ?? '').trim().toLowerCase();
      if (fReason && !(DELAY_REASON_CODES as string[]).includes(fReason)) {
        fail('VALIDATION_ERROR',
          `"${fReason.slice(0, 40)}" is not a reason this system records. `
          + `Use one of: ${DELAY_REASON_CODES.join(', ')}.`, 422);
      }
      const REASON_SOURCES = ['stage_variance', 'instrument_idle', 'low_progress'];
      if (fReasonSource && !REASON_SOURCES.includes(fReasonSource)) {
        fail('VALIDATION_ERROR',
          `"${fReasonSource.slice(0, 40)}" is not somewhere a reason is recorded. `
          + `Use one of: ${REASON_SOURCES.join(', ')}.`, 422);
      }

      const rows = (await pool.query(
        `SELECT sv.id AS village_id, ou.name AS village_name, ou.code AS village_code,
                sv.total_extent_ac,
                -- Ground truthing's own dates, read from its stage row rather
                -- than from a second copy on the village (§072).
                gt.started_on      AS gt_started_on,
                gt.expected_end_on AS gt_expected_end_on,
                gt.completed_on    AS gt_completed_on,
                m.id AS mandal_id, m.name AS mandal_name,
                pu.id AS parent_id, pu.name AS parent_name, pu.type AS parent_type,
                gp.id AS grandparent_id, gp.name AS grandparent_name, gp.type AS grandparent_type,
                (SELECT count(*)::int FROM survey_village_gcps g
                  WHERE g.survey_village_id = sv.id) AS gcp_count,
                holders.names AS holder_names, holders.people AS holder_count,
                COALESCE(json_object_agg(st.code, vst.state)
                         FILTER (WHERE st.code IS NOT NULL), '{}'::json) AS stages,
                -- Each stage's plan and outcome, so lateness is computed from
                -- the same rows the position is (§072).
                COALESCE(json_agg(json_build_object(
                    'stageCode', st.code, 'state', vst.state,
                    'startedOn', vst.started_on, 'completedOn', vst.completed_on,
                    'expectedStartOn', vst.expected_start_on,
                    'expectedEndOn', vst.expected_end_on,
                    'varianceReason', vst.variance_reason,
                    -- Days spent in the stage: to its finish, or to today for
                    -- work still open. Null before it starts, because a stage
                    -- nobody has begun has not taken any days.
                    'days', CASE WHEN vst.started_on IS NULL THEN NULL
                                 ELSE COALESCE(vst.completed_on, CURRENT_DATE)
                                      - vst.started_on END)
                  ) FILTER (WHERE st.code IS NOT NULL), '[]'::json) AS stage_plan
         FROM survey_villages sv
         JOIN org_units ou ON ou.id = sv.village_id
         LEFT JOIN org_units m  ON m.id = ou.parent_id
         LEFT JOIN org_units pu ON pu.id = m.parent_id
         LEFT JOIN org_units gp ON gp.id = pu.parent_id
         LEFT JOIN survey_village_stages vst ON vst.survey_village_id = sv.id
         LEFT JOIN survey_stages st ON st.id = vst.stage_id AND st.active
         LEFT JOIN LATERAL (
           /*
            * Who the village is with, at the stage it is at.
            *
            * Names rather than ids, and dropped entirely for an observer
            * below — the department is shown where the work is, never whose
            * desk it is on.
            */
           -- A text array, not json: the outer query groups on this column
           -- and json has no equality operator to group by.
           SELECT array_agg(DISTINCT COALESCE(
                    NULLIF(btrim(concat_ws(' ', emp.first_name, emp.last_name)), ''),
                    emp.emp_no)) AS names,
                  count(DISTINCT c.employee_id)::int AS people
             FROM survey_crew c
             JOIN employees emp ON emp.id = c.employee_id
            WHERE c.survey_village_id = sv.id AND c.released_on IS NULL
         ) holders ON true
         LEFT JOIN survey_village_stages gt ON gt.survey_village_id = sv.id
           AND gt.stage_id = (SELECT id FROM survey_stages
                               WHERE org_id = sv.org_id AND code = 'GROUND_TRUTHING')
         WHERE sv.survey_project_id = $1 AND sv.org_id = $2
         GROUP BY sv.id, ou.name, ou.code, m.id, m.name,
                  pu.id, pu.name, pu.type, gp.id, gp.name, gp.type,
                  gt.started_on, gt.expected_end_on, gt.completed_on,
                  holders.names, holders.people`,
        [id, u.orgId])).rows;

      const asOf = today();
      const villages = rows.map(r => {
        const stages = (r.stages ?? {}) as Record<string, StageState>;
        const plan = (r.stage_plan ?? []) as Array<Record<string, string | null>>;
        // The worst stage is the one worth naming on a list of 1,200 villages.
        const worst = villageVariances(plan.map(pl => ({
          stageCode: String(pl.stageCode),
          state: pl.state, startedOn: pl.startedOn, completedOn: pl.completedOn,
          expectedEndOn: pl.expectedEndOn, varianceReason: pl.varianceReason,
        })), asOf)[0] ?? null;
        const stageDays: Record<string, number | null> = {};
        for (const pl of plan) {
          if (pl.stageCode) stageDays[String(pl.stageCode)] = pl.days === null || pl.days === undefined
            ? null : Number(pl.days);
        }
        return {
          row: r,
          worst,
          stageDays,
          holderNames: (r.holder_names ?? []) as string[],
          holderCount: Number(r.holder_count ?? 0),
          villageId: String(r.village_id),
          name: String(r.village_name),
          code: r.village_code ? String(r.village_code) : null,
          extentAc: num(r.total_extent_ac),
          gcpCount: Number(r.gcp_count ?? 0),
          gtStartedOn: iso(r.gt_started_on),
          gtExpectedEndOn: iso(r.gt_expected_end_on),
          gtCompletedOn: iso(r.gt_completed_on),
          stages,
          position: villagePosition(stages),
        };
      });

      /*
       * Villages carrying the reason asked about, where one was asked about.
       *
       * Resolved against the database rather than against what has already
       * been loaded, because two of the three sources live on daily rows and
       * are bounded by the same window as everything else on this screen.
       */
      let reasonVillages: Set<string> | null = null;
      if (fReason) {
        const sources = fReasonSource ? [fReasonSource] : REASON_SOURCES;
        const found = new Set<string>();
        for (const source of sources) {
          const sql = source === 'stage_variance'
            ? `SELECT DISTINCT vs.survey_village_id AS id
                 FROM survey_village_stages vs
                 JOIN survey_villages sv ON sv.id = vs.survey_village_id
                WHERE sv.survey_project_id = $1 AND vs.org_id = $2
                  AND vs.variance_reason = $3`
            : source === 'instrument_idle'
              ? `SELECT DISTINCT e.survey_village_id AS id
                   FROM survey_entry_rovers er
                   JOIN survey_entries e ON e.id = er.entry_id
                  WHERE e.survey_project_id = $1 AND er.org_id = $2
                    AND er.status = 'IDLE' AND er.idle_reason = $3
                    AND ($4 = '' OR e.entry_date >= $4::date)
                    AND e.entry_date <= $5::date`
              : `SELECT DISTINCT e.survey_village_id AS id
                   FROM survey_entries e
                  WHERE e.survey_project_id = $1 AND e.org_id = $2
                    AND e.low_progress_reason = $3
                    AND ($4 = '' OR e.entry_date >= $4::date)
                    AND e.entry_date <= $5::date`;
          const args = source === 'stage_variance'
            ? [id, u.orgId, fReason] : [id, u.orgId, fReason, from, to];
          for (const r of (await pool.query(sql, args)).rows) found.add(String(r.id));
        }
        reasonVillages = found;
      }

      const matches = villages.filter(v => {
        const d = unitAt(v.row, 'district');
        const mn = unitAt(v.row, 'mandal');
        if (fDistrict && d?.id !== fDistrict) return false;
        if (fMandal && mn?.id !== fMandal) return false;
        if (fPosition && v.position.key !== fPosition) return false;
        if (reasonVillages && !reasonVillages.has(v.villageId)) return false;
        return true;
      });

      /*
       * Extent recorded inside the window, against extent overall.
       *
       * The window bounds what was *done in* it. How far the programme has
       * got is always as at the end of the window, because "62% complete" is
       * a statement about the programme rather than about the fortnight.
       */
      const doneRows = (await pool.query(
        `SELECT se.survey_village_id AS vid, COALESCE(sum(sev.quantity), 0) AS ac
         FROM survey_entries se
         JOIN survey_entry_values sev ON sev.entry_id = se.id
         JOIN survey_measures sm ON sm.id = sev.measure_id AND sm.basis = 'EXTENT'
         WHERE se.survey_project_id = $1 AND se.org_id = $2
           AND ($3 = '' OR se.entry_date >= $3::date)
           AND se.entry_date <= $4::date
         GROUP BY 1`,
        [id, u.orgId, from, to])).rows;
      const doneBy = new Map(doneRows.map(r => [String(r.vid), Number(r.ac)]));
      /*
       * Surveyed extent, split by whether it can be weighed.
       *
       * A village with no extent recorded contributes nothing to "extent to
       * survey", so its work cannot go into "surveyed" either: adding one
       * without the other is how a district read 140% of its extent. The work
       * is still reported, apart, because it happened.
       */
      const weighed = (items: typeof villages) => {
        let surveyed = 0, unweighted = 0;
        for (const v of items) {
          const done = doneBy.get(v.villageId) ?? 0;
          if (v.extentAc !== null && v.extentAc !== undefined && v.extentAc > 0) surveyed += done;
          else unweighted += done;
        }
        return { surveyed, unweighted };
      };

      /*
       * Which milestones have been claimed on each village.
       *
       * Read for everybody and reported to nobody outside the company: it
       * feeds the "claimed but not earned" count below, which is ours.
       */
      const claimRows = observerView ? [] : (await pool.query(
        `SELECT b.survey_village_id AS vid,
                array_agg(DISTINCT b.milestone) AS milestones
           FROM survey_village_billing b
           JOIN survey_villages sv ON sv.id = b.survey_village_id
          WHERE sv.survey_project_id = $1 AND b.org_id = $2
            AND b.status <> 'REJECTED'
          GROUP BY 1`, [id, u.orgId])).rows;
      const claimedBy = new Map<string, number[]>(
        claimRows.map(r => [String(r.vid), (r.milestones as number[]).map(Number)]));

      const group = (lvl: ReportLevel) => {
        const g = new Map<string, { id: string | null; name: string; items: typeof matches }>();
        for (const v of matches) {
          const unit = unitAt(v.row, lvl);
          const key = unit?.id ?? '__unattributed__';
          if (!g.has(key)) {
            g.set(key, {
              id: unit?.id ?? null, name: unit?.name ?? 'Not attributed', items: [],
            });
          }
          g.get(key)!.items.push(v);
        }
        return [...g.values()].map(row => ({
          id: row.id,
          name: row.name,
          villages: row.items.length,
          extent_ac: row.items.reduce((t, v) => t + (v.extentAc ?? 0), 0),
          extent_sqkm: acresToSqKm(row.items.reduce((t, v) => t + (v.extentAc ?? 0), 0)),
          surveyed_ac: weighed(row.items).surveyed,
          surveyed_sqkm: acresToSqKm(weighed(row.items).surveyed),
          unweighted_surveyed_ac: weighed(row.items).unweighted,
          // Where each village in this group has got to. The chart and the
          // drill-down read the same numbers.
          by_position: tallyByPosition(row.items),
          completed: row.items.filter(v => v.position.key === 'FINAL_APPROVED').length,
          not_started: row.items.filter(v => v.position.key === 'NOT_STARTED').length,
          late: row.items.filter(v => v.worst?.variance.late).length,
        })).sort((a, b) => a.name.localeCompare(b.name));
      };

      const totalExtent = matches.reduce((t, v) => t + (v.extentAc ?? 0), 0);
      const { surveyed, unweighted: unweightedSurveyed } = weighed(matches);

      /*
       * Why the work is held up, counted three ways (§073).
       *
       * A dashboard that says four hundred villages are behind and stops
       * there gives an official nothing to do about it. The module already
       * collects a reason at three separate moments — when a stage misses
       * its date, when an instrument stands idle for a day, and when a day
       * produces less than the programme expects — and all three draw on the
       * same fixed vocabulary, which is exactly what makes them addable.
       *
       * Counted in three separate queries rather than one union: the units
       * differ and adding them would be nonsense. A stage is a stage, an idle
       * instrument is an instrument-day, and a short day is a day. Each is
       * reported in its own unit and the screen says which.
       */
      const matchedIds = matches.map(v => v.villageId);
      const reasonArgs: unknown[] = [u.orgId, matchedIds, from, to];
      const [stageWhy, idleWhy, shortWhy] = matchedIds.length === 0
        ? [[], [], []]
        : await Promise.all([
          pool.query(
            `SELECT vs.variance_reason AS reason,
                    count(*)::int AS count,
                    count(DISTINCT vs.survey_village_id)::int AS villages
               FROM survey_village_stages vs
              WHERE vs.org_id = $1 AND vs.survey_village_id = ANY($2::uuid[])
                AND vs.variance_reason IS NOT NULL
              GROUP BY 1`, [u.orgId, matchedIds]).then(r => r.rows),
          pool.query(
            `SELECT er.idle_reason AS reason,
                    count(*)::int AS count,
                    count(DISTINCT e.survey_village_id)::int AS villages
               FROM survey_entry_rovers er
               JOIN survey_entries e ON e.id = er.entry_id
              WHERE er.org_id = $1 AND e.survey_village_id = ANY($2::uuid[])
                AND er.status = 'IDLE' AND er.idle_reason IS NOT NULL
                AND ($3 = '' OR e.entry_date >= $3::date)
                AND e.entry_date <= $4::date
              GROUP BY 1`, reasonArgs).then(r => r.rows),
          pool.query(
            `SELECT e.low_progress_reason AS reason,
                    count(*)::int AS count,
                    count(DISTINCT e.survey_village_id)::int AS villages
               FROM survey_entries e
              WHERE e.org_id = $1 AND e.survey_village_id = ANY($2::uuid[])
                AND e.low_progress_reason IS NOT NULL
                AND ($3 = '' OR e.entry_date >= $3::date)
                AND e.entry_date <= $4::date
              GROUP BY 1`, reasonArgs).then(r => r.rows),
        ]);

      /**
       * Every reason in the vocabulary, in a fixed order, including the ones
       * that did not happen.
       *
       * A list that only shows what occurred reads differently every time it
       * is opened, and "no departmental staff" being absent is a finding of
       * its own — but only if the reader can see it was looked for.
       */
      const tally = (
        rows: Array<Record<string, unknown>>,
      ) => {
        const by = new Map(rows.map(r => [String(r.reason), r]));
        return DELAY_REASONS.map(dr => ({
          code: dr.code,
          label: dr.label,
          count: Number(by.get(dr.code)?.count ?? 0),
          villages: Number(by.get(dr.code)?.villages ?? 0),
        }));
      };

      const districts = [...new Map(villages
        .map(v => unitAt(v.row, 'district')).filter(Boolean)
        .map(d => [d!.id, d!])).values()].sort((a, b) => a.name.localeCompare(b.name));
      const mandals = [...new Map(villages
        .filter(v => !fDistrict || unitAt(v.row, 'district')?.id === fDistrict)
        .map(v => unitAt(v.row, 'mandal')).filter(Boolean)
        .map(d => [d!.id, d!])).values()].sort((a, b) => a.name.localeCompare(b.name));

      /*
       * When this was built, and how current what it was built from is (§074).
       *
       * Two different facts and both matter. A dashboard left open on a wall
       * looks identical at nine in the morning and at six in the evening, so
       * it has to say when it was drawn. And a screen drawn at six from
       * returns that stop on Tuesday is not current either — the freshest
       * thing in the programme is what the figures actually reach.
       */
      const currency = (await pool.query(
        `SELECT (SELECT max(entry_date)::text FROM survey_entries
                  WHERE survey_project_id = $1) AS last_return,
                -- Qualified: survey_villages has an updated_at too, and an
                -- unqualified one here is ambiguous.
                (SELECT max(vs.updated_at) FROM survey_village_stages vs
                   JOIN survey_villages sv ON sv.id = vs.survey_village_id
                  WHERE sv.survey_project_id = $1) AS last_stage_change`,
        [id])).rows[0];

      return {
        data: {
          project: { id: String(project.id), name: String(project.name), code: project.code },
          period: { from: from || null, to },
          refreshed: {
            /* When the server built this answer. */
            generated_at: new Date().toISOString(),
            /* The most recent day any crew has filed for. */
            last_return: currency.last_return ?? null,
            /* The last time anybody moved a stage. */
            last_stage_change: currency.last_stage_change
              ? new Date(currency.last_stage_change).toISOString() : null,
          },
          level,
          filter: {
            district: fDistrict || null, mandal: fMandal || null,
            position: fPosition || null,
            reason: fReason || null,
            reason_source: fReasonSource || null,
            villages: matches.length, of_villages: villages.length,
          },
          options: { districts, mandals },
          /* The eleven positions, in order, so a chart never has to sort. */
          /* The label and what it means, so the screen never has to carry
             a second copy of the explanation. */
          ladder: VILLAGE_LADDER.map(r => ({
            key: r.key, label: r.label, note: LADDER_NOTES[r.key] ?? null,
          })),
          totals: {
            villages: matches.length,
            extent_ac: totalExtent,
            extent_sqkm: acresToSqKm(totalExtent),
            surveyed_ac: surveyed,
            surveyed_sqkm: acresToSqKm(surveyed),
            // Surveyed in villages with no extent recorded: outside the
            // percentage, which has nothing to divide it by, but not lost.
            unweighted_surveyed_ac: unweightedSurveyed,
            unweighted_villages: matches.filter(
              v => v.extentAc === null || v.extentAc === undefined || !(v.extentAc > 0)).length,
            by_position: tallyByPosition(matches),
            /*
             * The same eleven rungs with their extent, for the table beside
             * the chart (§076).
             *
             * Sent as figures per rung rather than as a finished total,
             * because the table's last row has to be the sum of the rows
             * above it. A total fetched separately is a total that can
             * disagree with what is on the screen, and the reader has no way
             * to tell which of the two is wrong.
             */
            positions: VILLAGE_LADDER.map(rung => {
              const at = matches.filter(v => v.position.key === rung.key);
              const extent = at.reduce((t, v) => t + (v.extentAc ?? 0), 0);
              const { surveyed: done, unweighted } = weighed(at);
              return {
                key: rung.key,
                label: rung.label,
                villages: at.length,
                extent_ac: extent,
                extent_sqkm: acresToSqKm(extent),
                surveyed_ac: done,
                surveyed_sqkm: acresToSqKm(done),
                unweighted_surveyed_ac: unweighted,
                /* Of the villages on screen, not of the programme. */
                share_pct: matches.length
                  ? Math.round((at.length / matches.length) * 1000) / 10 : 0,
              };
            }),
            // Reported separately from the positions, because on hold is
            // something true about a village at a position rather than a
            // twelfth position.
            on_hold: matches.filter(v => v.position.onHold).length,
            in_rework: matches.filter(v => v.position.inRework).length,
            gcp_missing: matches.filter(
              v => v.position.index > 0 && v.gcpCount === 0).length,
            /*
             * Against plan, across the programme (§072).
             *
             * `unplanned` is reported rather than folded into "on schedule":
             * a village with no expected date is not a village running to
             * time, and counting it as one is how a programme reports itself
             * green while nobody knows when anything is due.
             */
            late: matches.filter(v => v.worst?.variance.late).length,
            late_unexplained: matches.filter(v => v.worst?.variance.needsReason).length,
            unplanned: matches.filter(v => v.worst?.variance.basis === 'NO_PLAN'
              || v.worst === null).length,
            /*
             * Villages whose work has been accepted, per milestone (§078).
             *
             * Finishing a stage and having it accepted are different events
             * and the contract pays on the second, so this counts signatures
             * rather than completions. Reported so every tab reads the same
             * figure as the claim route.
             *
             * Not for the department. "How many villages are eligible for
             * the second milestone" is our commercial position — it says how
             * much we are about to invoice them for — and the observer's view
             * carries no money. The sign-off counts below stay, because work
             * finished and unchecked is progress rather than price.
             */
            ...(observerView ? {} : {
              earned: Object.fromEntries(
                Object.keys(MILESTONE_REQUIRES).map(m => [
                  m, matches.filter(v => milestoneEarned(Number(m), v.stages)).length,
                ])),
              /*
               * Claims standing against work nobody has accepted (§079).
               *
               * Tightening the rule (§078) did not reach backwards, and it
               * should not: a claim already with the department is a fact,
               * not a mistake to be erased. But a rule enforced on new claims
               * and silent about the old ones leaves a programme quietly
               * inconsistent with itself, and the first anybody hears of it
               * is the department asking.
               *
               * Counted, named, and left alone. What to do about them is a
               * decision about money and belongs to somebody who can make it.
               */
              claimed_unearned: Object.fromEntries(
                Object.keys(MILESTONE_REQUIRES).map(m => [
                  m,
                  matches.filter(v =>
                    (claimedBy.get(v.villageId) ?? []).includes(Number(m))
                    && !milestoneEarned(Number(m), v.stages)).length,
                ])),
            }),
            /* Finished but not yet accepted, which is the chase list. */
            awaiting_sign_off: STAGE_PIPELINE
              .filter(st => !st.offSequence && !st.isSignOff)
              .map(st => ({
                code: st.code,
                label: st.label,
                villages: matches.filter(v =>
                  v.stages[st.code] === 'COMPLETED' && !stageSignedOff(st.code, v.stages)).length,
                signed_off_by: signOffFor(st.code),
              })),
          },
          /*
           * How long each stage takes, and how many villages are sitting in
           * it now (§074).
           *
           * The median as well as the mean, because a handful of villages
           * stuck for half a year drags an average somewhere no village
           * actually is — and "half of them clear in eleven days" is the
           * sentence somebody can plan around.
           */
          stage_days: STAGE_PIPELINE.filter(st => !st.offSequence).map(st => {
            const spent = matches
              .map(v => v.stageDays[st.code])
              .filter((d): d is number => typeof d === 'number');
            const sorted = [...spent].sort((a, b) => a - b);
            const here = matches.filter(v => v.position.stage === st.code);
            return {
              code: st.code,
              label: st.label,
              /* Villages that have reached this stage and recorded time in it. */
              villages_measured: spent.length,
              /* Villages whose current position is this stage. */
              villages_here: here.length,
              avg_days: spent.length
                ? Math.round((spent.reduce((a, b) => a + b, 0) / spent.length) * 10) / 10 : null,
              median_days: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
              max_days: sorted.length ? sorted[sorted.length - 1] : null,
              /*
               * Who the villages at this stage are with, biggest load first.
               * Omitted entirely for the department's view.
               */
              ...(observerView ? {} : {
                holders: (() => {
                  const load = new Map<string, number>();
                  for (const v of here) {
                    for (const name of v.holderNames) {
                      if (name) load.set(name, (load.get(name) ?? 0) + 1);
                    }
                  }
                  return [...load.entries()]
                    .sort((a, b) => b[1] - a[1]).slice(0, 8)
                    .map(([name, villages]) => ({ name, villages }));
                })(),
                unassigned: here.filter(v => v.holderCount === 0).length,
              }),
            };
          }),
          /*
           * Reported per source and never summed across them: a stage, an
           * instrument-day and a short day are three different units, and a
           * single total would be a number with no meaning.
           */
          reasons: {
            stage_variance: {
              unit: 'stages',
              note: 'Stages that missed their expected date, by the reason recorded',
              total: stageWhy.reduce((t, r) => t + Number(r.count), 0),
              by_reason: tally(stageWhy),
            },
            instrument_idle: {
              unit: 'instrument-days',
              note: 'Days an allocated instrument was returned as idle, by reason',
              total: idleWhy.reduce((t, r) => t + Number(r.count), 0),
              by_reason: tally(idleWhy),
            },
            low_progress: {
              unit: 'days',
              note: "Days that produced less than the programme's threshold, by reason",
              total: shortWhy.reduce((t, r) => t + Number(r.count), 0),
              by_reason: tally(shortWhy),
            },
          },
          rows: group(level),
          /*
           * The mandal roll-up, always, beside whatever level was asked for.
           *
           * A district tells an official the programme is behind; the mandal
           * tells them which tahsildar to ring. It is the level the work is
           * actually organised at — crews are posted to mandals, the
           * department staffs them by mandal — so it is sent unconditionally
           * rather than only when somebody thinks to change the grouping.
           *
           * Skipped when the grouping already *is* mandal, because two
           * identical tables is not a second view of anything. Parent named
           * on each row, since mandal names repeat across districts and a
           * list of thirty bare names is unreadable.
           */
          by_mandal: level === 'mandal' ? null : group('mandal').map(row => {
            const anyVillage = matches.find(
              v => (unitAt(v.row, 'mandal')?.id ?? null) === row.id);
            return {
              ...row,
              district: anyVillage ? unitAt(anyVillage.row, 'district')?.name ?? null : null,
            };
          }),
          villages: matches
            .map(v => ({
              id: v.villageId, name: v.name, code: v.code,
              district: unitAt(v.row, 'district')?.name ?? null,
              mandal: unitAt(v.row, 'mandal')?.name ?? null,
              extent_ac: v.extentAc,
              extent_sqkm: acresToSqKm(v.extentAc ?? 0),
              surveyed_ac: doneBy.get(v.villageId) ?? 0,
              position: v.position.key,
              position_label: v.position.label,
              on_hold: v.position.onHold,
              in_rework: v.position.inRework,
              gt_started_on: v.gtStartedOn,
              gt_expected_end_on: v.gtExpectedEndOn,
              // What actually happened, beside what was promised (§074).
              gt_completed_on: v.gtCompletedOn,
              surveyed_sqkm: acresToSqKm(doneBy.get(v.villageId) ?? 0),
              // Days spent in each stage it has reached, open stages counted
              // to today so the figure is current rather than final.
              stage_days: v.stageDays,
              days_in_stage: v.position.stage ? v.stageDays[v.position.stage] ?? null : null,
              /*
               * Whose desk it is on — and only for a reader entitled to know.
               * The department is shown where the work is, never who is
               * holding it.
               */
              ...(observerView ? {} : {
                holders: v.holderNames.filter(Boolean),
                holder_count: v.holderCount,
              }),
              gcp_count: v.gcpCount,
              /*
               * How far off plan the village is, and where.
               *
               * One figure rather than five: on a list of twelve hundred
               * villages the question is "which ones are slipping", and the
               * stage responsible is what makes the answer actionable.
               */
              slip_days: v.worst?.variance.days ?? null,
              slip_stage: v.worst && v.worst.variance.late ? v.worst.stageCode : null,
              slip_note: v.worst ? varianceNote(v.worst.variance) : null,
              slip_reason: v.worst?.variance.reason ?? null,
              slip_needs_reason: Boolean(v.worst?.variance.needsReason),
              /*
               * What this village has earned (§078).
               *
               * Computed from the same rule the claim route refuses with, so
               * the screen that greys a button, the bar that narrows a
               * selection and the route that rejects a submission are three
               * readings of one answer rather than three implementations.
               *
               * Dropped for the department along with everything else about
               * what the work is worth.
               */
              ...(observerView ? {} : { earned_milestones: earnedMilestones(v.stages) }),
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        },
      };
    });

  /* ====================================================== §073 contacts */

  /**
   * Who to ring, on both sides.
   *
   * Readable by anybody who can see the programme, the department included:
   * an official looking at a village four months late needs the surveyor's
   * number as much as we need the tahsildar's. Managing the list is
   * survey.manage, because a wrong number on a shared list is worse than no
   * number at all.
   */
  app.get('/api/v1/survey/projects/:id/contacts',
    { preHandler: guard('survey.dashboard') }, async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const q = (req.query ?? {}) as Record<string, string | undefined>;
      // An observer holds no survey.read, so the programme is reached by
      // permission rather than by enrolment — as with the dashboard itself.
      // A client reaches it the same way, and only for their own programmes.
      const scoped = readsAsObserver(u);
      if (scoped) await observerProgrammeOr404(pool, u, id);
      else await projectOr404(pool, u.orgId, id, u);

      const side = String(q.side ?? '').trim().toUpperCase();
      const values: unknown[] = [u.orgId, id];
      let where = 'c.org_id = $1 AND c.survey_project_id = $2 AND c.active';
      if (side === 'GOVT' || side === 'SILVERLINE') {
        values.push(side);
        where += ` AND c.side = $${values.length}`;
      }
      const rows = (await pool.query(
        `SELECT c.*, ou.name AS covers_name, ou.type AS covers_type
           FROM survey_contacts c
           LEFT JOIN org_units ou ON ou.id = c.org_unit_id
          WHERE ${where}
          ORDER BY c.side, ou.name NULLS FIRST, c.name`, values)).rows;
      return { data: rows };
    });

  app.post('/api/v1/survey/projects/:id/contacts',
    { preHandler: guard('survey.manage') }, async (req, reply) => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(surveyContactSchema, req.body);
      const data = await mutate(pool, req, 'survey.contact.create', 'survey_contact',
        async db => {
          await projectOr404(db, u.orgId, id, u);
          if (input.org_unit_id) await inOrg(db, 'org_units', input.org_unit_id, u.orgId);
          return (await db.query(
            `INSERT INTO survey_contacts(org_id, survey_project_id, side, name,
               designation, phone, email, org_unit_id, notes, created_by, updated_by)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *`,
            [u.orgId, id, input.side, input.name, input.designation, input.phone,
              input.email ?? null, input.org_unit_id ?? null, input.notes ?? null,
              u.id])).rows[0];
        });
      reply.code(201);
      return { data };
    });

  app.patch('/api/v1/survey/contacts/:id', { preHandler: guard('survey.manage') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(surveyContactPatchSchema, req.body);
      return {
        data: await mutate(pool, req, 'survey.contact.update', 'survey_contact', async db => {
          const row = await inOrg(db, 'survey_contacts', id, u.orgId, true);
          version(req, row as { version: number });
          const sets: string[] = [];
          const values: unknown[] = [id];
          for (const [col, val] of Object.entries({
            side: input.side, name: input.name, designation: input.designation,
            phone: input.phone, email: input.email, org_unit_id: input.org_unit_id,
            notes: input.notes, active: input.active,
          })) {
            if (val === undefined) continue;
            values.push(val);
            sets.push(`${col} = $${values.length}`);
          }
          if (!sets.length) return row;
          values.push(u.id);
          return (await db.query(
            `UPDATE survey_contacts SET ${sets.join(', ')},
                    version = version + 1, updated_at = now(),
                    updated_by = $${values.length}
              WHERE id = $1 RETURNING *`, values)).rows[0];
        }),
      };
    });

  /* ======================================================== §073 asking */

  /**
   * Raise a question, a clarification or a concern on what the dashboard says.
   *
   * Open to anybody who may look, the department included. They hold nothing
   * but the dashboard and are the most likely people in the programme to have
   * a question about a figure on it — and the ones with no other way to put
   * it than a telephone call nobody writes down.
   *
   * The village's position is captured with the question. "Why is this still
   * at GT QC" stops making sense the moment the village moves.
   */
  app.post('/api/v1/survey/projects/:id/queries',
    { preHandler: guard('survey.query') }, async (req, reply) => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(surveyQuerySchema, req.body);
      const data = await mutate(pool, req, 'survey.query.raise', 'survey_query',
        async db => {
          const scoped = readsAsObserver(u);
          if (scoped) await observerProgrammeOr404(db, u, id);
          else await projectOr404(db, u.orgId, id, u);

          if (input.org_unit_id) {
            // The unit has to be ours and has to be somewhere this programme
            // actually reaches, or the question files against a district in
            // somebody else's contract.
            await inOrg(db, 'org_units', input.org_unit_id, u.orgId);
          }

          let position = input.position_key ?? null;
          if (input.survey_village_id) {
            // Checked against the programme, so a question cannot be filed
            // against a village in somebody else's contract.
            const village = (await db.query(
              `SELECT id FROM survey_villages
                WHERE id = $1 AND org_id = $2 AND survey_project_id = $3`,
              [input.survey_village_id, u.orgId, id])).rows[0];
            if (!village) {
              fail('NOT_FOUND', 'That village is not in this programme.', 404);
            }
            if (!position) {
              position = villagePosition(await stageStatesOf(db, input.survey_village_id)).key;
            }
          }

          const row = (await db.query(
            `INSERT INTO survey_queries(org_id, survey_project_id, survey_village_id,
               org_unit_id, kind, subject, body, position_key, raised_by)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [u.orgId, id, input.survey_village_id ?? null, input.org_unit_id ?? null,
              input.kind, input.subject, input.body, position, u.id])).rows[0];

          /*
           * Told to the people who can answer, now, rather than found later.
           *
           * A question that waits for somebody to open a screen is a question
           * answered next week. The event key is the query itself, so the
           * unique index keeps it to one notice per person however many times
           * anything re-runs.
           */
          const answerers = (await db.query(
            `SELECT DISTINCT u2.id FROM users u2
               JOIN user_roles ur ON ur.user_id = u2.id
               JOIN role_permissions rp ON rp.role_id = ur.role_id
              WHERE u2.org_id = $1 AND u2.auth_status = 'ACTIVE'
                AND rp.permission_code = 'survey.answer'`, [u.orgId])).rows;
          for (const a of answerers) {
            await db.query(
              `INSERT INTO notifications
                 (org_id, recipient_id, type, title, body, entity_type, entity_id, event_key)
               VALUES ($1,$2,'SURVEY_QUERY',$3,$4,'survey_query',$5,$6)
               ON CONFLICT DO NOTHING`,
              [u.orgId, a.id,
                `${input.kind === 'CONCERN' ? 'Concern' : 'Question'} raised: ${input.subject}`,
                input.body.slice(0, 500), row.id, `survey_query:${row.id}`]);
          }
          return row;
        });
      reply.code(201);
      return { data };
    });

  app.get('/api/v1/survey/projects/:id/queries',
    { preHandler: guard('survey.query') }, async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const q = (req.query ?? {}) as Record<string, string | undefined>;
      const scoped = readsAsObserver(u);
      if (scoped) await observerProgrammeOr404(pool, u, id);
      else await projectOr404(pool, u.orgId, id, u);

      const values: unknown[] = [u.orgId, id];
      let where = 'q.org_id = $1 AND q.survey_project_id = $2';
      const status = String(q.status ?? '').trim().toUpperCase();
      if (status) { values.push(status); where += ` AND q.status = $${values.length}`; }
      if (q.village_id) {
        values.push(q.village_id);
        where += ` AND q.survey_village_id = $${values.length}`;
      }
      if (q.org_unit_id) {
        values.push(q.org_unit_id);
        where += ` AND q.org_unit_id = $${values.length}`;
      }
      /*
       * Somebody who can only raise questions sees their own.
       *
       * An official reading the dashboard should find their question and its
       * answer; they have no business reading what another district asked.
       */
      if (scoped) { values.push(u.id); where += ` AND q.raised_by = $${values.length}`; }

      const rows = (await pool.query(
        `SELECT q.*, ou.name AS village_name,
                unit.name AS unit_name, unit.type AS unit_type,
                COALESCE(NULLIF(btrim(concat_ws(' ', ra.first_name, ra.last_name)), ''),
                         rb.username) AS raised_by_name,
                COALESCE(NULLIF(btrim(concat_ws(' ', aa.first_name, aa.last_name)), ''),
                         ab.username) AS answered_by_name
           FROM survey_queries q
           LEFT JOIN survey_villages sv ON sv.id = q.survey_village_id
           LEFT JOIN org_units ou ON ou.id = sv.village_id
           LEFT JOIN org_units unit ON unit.id = q.org_unit_id
           LEFT JOIN users rb ON rb.id = q.raised_by
           LEFT JOIN employees ra ON ra.id = rb.employee_id
           LEFT JOIN users ab ON ab.id = q.answered_by
           LEFT JOIN employees aa ON aa.id = ab.employee_id
          WHERE ${where}
          ORDER BY q.status = 'OPEN' DESC, q.raised_at DESC
          LIMIT 300`, values)).rows;
      return {
        data: rows.map(r => ({
          ...r,
          position_label: r.position_key ? LADDER_LABELS[String(r.position_key)] ?? null : null,
        })),
      };
    });

  app.post('/api/v1/survey/queries/:id/answer',
    { preHandler: guard('survey.answer') }, async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(surveyAnswerSchema, req.body);
      return {
        data: await mutate(pool, req, 'survey.query.answer', 'survey_query', async db => {
          // Locked and checked on status rather than gated on If-Match.
          // Two people answering at once is a real race, and "somebody has
          // already answered this" is a better thing to tell the loser than
          // "the record changed" — it says what happened and what to do.
          const row = await inOrg(db, 'survey_queries', id, u.orgId, true);
          if (row.status !== 'OPEN') {
            fail('QUERY_NOT_OPEN',
              'That question has already been dealt with. Raise a new one rather than '
              + 'overwriting the answer somebody gave.', 409);
          }
          // Closing without answering is a real outcome — asked, then
          // overtaken by events — and it is not the same as an answer.
          const status = input.close_without_answer ? 'CLOSED' : 'ANSWERED';
          const answered = (await db.query(
            `UPDATE survey_queries
                SET status = $2, answer = $3, answered_by = $4, answered_at = now(),
                    version = version + 1
              WHERE id = $1 RETURNING *`,
            [id, status, input.answer, u.id])).rows[0];

          // Told back to whoever asked, so an answer is not something they
          // have to go looking for.
          await db.query(
            `INSERT INTO notifications
               (org_id, recipient_id, type, title, body, entity_type, entity_id, event_key)
             VALUES ($1,$2,'SURVEY_QUERY',$3,$4,'survey_query',$5,$6)
             ON CONFLICT DO NOTHING`,
            [u.orgId, row.raised_by, `Answered: ${row.subject}`,
              input.answer.slice(0, 500), id, `survey_query_answer:${id}`]);
          return answered;
        }),
      };
    });

  /* ======================================================== §073 alerts */

  /** The alert kinds a subscription may choose between. */
  app.get('/api/v1/survey/alert-kinds', { preHandler: guard('survey.read') },
    async () => ({ data: ALERT_KINDS }));

  app.get('/api/v1/survey/alert-subscriptions',
    { preHandler: guard('survey.manage') }, async req => {
      const u = actor(req);
      const q = (req.query ?? {}) as Record<string, string | undefined>;
      const values: unknown[] = [u.orgId];
      let where = 's.org_id = $1';
      if (q.project_id) {
        values.push(q.project_id);
        where += ` AND (s.survey_project_id = $${values.length}`
          + ' OR s.survey_project_id IS NULL)';
      }
      const rows = (await pool.query(
        `SELECT s.*, p.name AS project_name,
                (s.active AND s.active_until >= CURRENT_DATE) AS live,
                (SELECT count(*)::int FROM survey_alert_sent a
                  WHERE a.subscription_id = s.id AND a.status = 'QUEUED') AS queued,
                (SELECT count(*)::int FROM survey_alert_sent a
                  WHERE a.subscription_id = s.id AND a.status = 'SENT') AS sent
           FROM survey_alert_subscriptions s
           LEFT JOIN survey_projects p ON p.id = s.survey_project_id
          WHERE ${where}
          ORDER BY live DESC, s.email`, values)).rows;
      return {
        data: rows.map(r => ({ ...r, active_until: iso(r.active_until) })),
        /*
         * Whether anything can actually send (§073).
         *
         * A screen that lets somebody subscribe and never says the mail is
         * not going anywhere is a screen that lies by omission. Reported as
         * a fact about the deployment rather than hidden in a log.
         */
        meta: {
          mail_configured: Boolean(process.env.SURVEY_MAIL_WEBHOOK_URL),
          queued: rows.reduce((t, r) => t + Number(r.queued ?? 0), 0),
        },
      };
    });

  app.post('/api/v1/survey/alert-subscriptions',
    { preHandler: guard('survey.manage') }, async (req, reply) => {
      const u = actor(req);
      const input = parse(alertSubscriptionSchema, req.body);
      if (input.active_until < today()) {
        fail('VALIDATION_ERROR',
          `An alert that stops on ${input.active_until} has already stopped. `
          + 'Pick a date in the future.', 422);
      }
      const data = await mutate(pool, req, 'survey.alert.subscribe',
        'survey_alert_subscription', async db => {
          if (input.survey_project_id) {
            await projectOr404(db, u.orgId, input.survey_project_id, u);
          }
          return (await db.query(
            `INSERT INTO survey_alert_subscriptions(org_id, survey_project_id, email,
               label, kinds, active_until, created_by, updated_by)
             VALUES($1,$2,$3,$4,$5,$6::date,$7,$7)
             ON CONFLICT (org_id, survey_project_id, email) DO UPDATE
               SET kinds = EXCLUDED.kinds, label = EXCLUDED.label,
                   active_until = EXCLUDED.active_until, active = true,
                   version = survey_alert_subscriptions.version + 1,
                   updated_at = now(), updated_by = EXCLUDED.updated_by
             RETURNING *`,
            [u.orgId, input.survey_project_id ?? null, input.email.toLowerCase(),
              input.label ?? null, input.kinds ?? [], input.active_until, u.id])).rows[0];
        });
      reply.code(201);
      return { data: { ...data, active_until: iso(data.active_until) } };
    });

  app.patch('/api/v1/survey/alert-subscriptions/:id',
    { preHandler: guard('survey.manage') }, async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const input = parse(alertSubscriptionPatchSchema, req.body);
      return {
        data: await mutate(pool, req, 'survey.alert.update',
          'survey_alert_subscription', async db => {
            const row = await inOrg(db, 'survey_alert_subscriptions', id, u.orgId, true);
            version(req, row as { version: number });
            const sets: string[] = [];
            const values: unknown[] = [id];
            for (const [col, val] of Object.entries({
              email: input.email?.toLowerCase(), label: input.label,
              kinds: input.kinds, active_until: input.active_until, active: input.active,
            })) {
              if (val === undefined) continue;
              values.push(val);
              sets.push(`${col} = $${values.length}`);
            }
            if (!sets.length) return { ...row, active_until: iso(row.active_until) };
            values.push(u.id);
            const updated = (await db.query(
              `UPDATE survey_alert_subscriptions SET ${sets.join(', ')},
                      version = version + 1, updated_at = now(),
                      updated_by = $${values.length}
                WHERE id = $1 RETURNING *`, values)).rows[0];
            return { ...updated, active_until: iso(updated.active_until) };
          }),
      };
    });

  app.get('/api/v1/survey/projects/:id/report', { preHandler: guard('survey.read') },
    async req => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const { q } = page(req);
      const programme = await projectOr404(pool, u.orgId, id, u);

      const grain = (PERIOD_GRAINS as readonly string[]).includes(String(q.grain))
        ? String(q.grain) as PeriodGrain : 'DAY';
      const asOf = dateParam(req, q.as_of, 'as_of', today());

      /*
       * A range somebody chose, rather than a calendar period.
       *
       * "The fortnight the minister's visit covered" is not a week and is
       * not a month, and until now reporting on it meant running four weekly
       * reports and adding them up by hand. The comparison period is the
       * same length immediately before it, which is the only honest
       * like-for-like when the period has no calendar meaning.
       */
      const custom = q.from && q.to
        ? {
          from: dateParam(req, q.from, 'from', today()),
          to: dateParam(req, q.to, 'to', today()),
        }
        : null;
      if (custom && custom.from > custom.to) {
        fail('VALIDATION_ERROR', 'The range starts after it ends. Check the dates.', 422);
      }
      const period = custom
        ? { ...custom, label: `${custom.from} to ${custom.to}` }
        : periodContaining(asOf, grain);
      const prior = custom ? priorRange(custom) : previousPeriod(period, grain);
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

      const [now, before, days, rovers, moved, staffNow, staffBefore] = await Promise.all([
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
        staffingOver(pool, u.orgId, id, period.from, period.to),
        staffingOver(pool, u.orgId, id, prior.from, prior.to),
      ]);
      const staffing = { now: staffNow, before: staffBefore };

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
          // The measures with their labels and units, so a report can name
          // what it is counting rather than printing a database code.
          measure_list: m.rows.map(r => ({
            code: r.code, label: r.label, group_label: r.group_label,
            unit: r.unit, basis: r.basis,
          })),
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
          // Who was allotted to ground truthing and who came (§067). The gap
          // is what the department is answerable for and what the programme
          // loses days to.
          staffing: staffing.now,
          previous_staffing: staffing.before,
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
      const from = dateParam(req, q.from, 'from', fy.from);
      const to = dateParam(req, q.to, 'to', today());

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

      /*
       * Attendance per day, bucketed alongside the quantities (§067).
       *
       * One query for the range rather than one per bucket: four hundred
       * buckets is four hundred round trips, and this endpoint already
       * refuses ranges wider than that for the same reason.
       */
      const staffDays = (await pool.query(
        `SELECT e.entry_date, e.govt_staff_present, e.crew_present,
                sv.gt_govt_staff_allocated, sv.gt_crew_allocated
           FROM survey_entries e
           JOIN survey_villages sv ON sv.id = e.survey_village_id
          WHERE e.org_id = $1 AND e.survey_project_id = $2
            AND e.entry_date >= $3 AND e.entry_date <= $4
            AND (e.govt_staff_present IS NOT NULL OR e.crew_present IS NOT NULL)`,
        [u.orgId, id, from, to])).rows;

      const periods = buckets.map(b => {
        const within = rows.filter(r => {
          const d = iso(r.entry_date)!;
          return d >= b.from && d <= b.to;
        });
        const staff = staffDays.filter(r => {
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
          staffing: summariseStaffing(staff.map((r): StaffingDay => ({
            govtStaffPresent: r.govt_staff_present === null ? null : Number(r.govt_staff_present),
            crewPresent: r.crew_present === null ? null : Number(r.crew_present),
            govtStaffAllocated: r.gt_govt_staff_allocated === null
              ? null : Number(r.gt_govt_staff_allocated),
            crewAllocated: r.gt_crew_allocated === null ? null : Number(r.gt_crew_allocated),
          }))),
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

      /*
       * Attendance per village, in one query (§067).
       *
       * A thousand villages is a thousand round trips done the obvious way,
       * and this sheet is the one people pull for a whole programme.
       */
      const attendance = new Map<string, Record<string, number>>(
        (await pool.query(
          `SELECT e.survey_village_id,
                  count(*) FILTER (WHERE e.govt_staff_present IS NOT NULL
                                      OR e.crew_present IS NOT NULL)::int AS days_recorded,
                  COALESCE(sum(e.govt_staff_present), 0)::int AS govt_staff_days,
                  COALESCE(sum(e.crew_present), 0)::int       AS crew_days,
                  count(*) FILTER (WHERE e.govt_staff_present = 0)::int AS days_no_govt_staff,
                  -- Days anybody filed anything at all, which is what the
                  -- rover and team figures below are per.
                  count(*)::int AS return_days,
                  COALESCE(sum(e.teams_deployed), 0)::int AS team_days
             FROM survey_entries e
             JOIN survey_villages sv ON sv.id = e.survey_village_id
            WHERE e.org_id = $1 AND sv.survey_project_id = $2
            GROUP BY 1`, [u.orgId, id])).rows
          .map(r => [String(r.survey_village_id), {
            days_recorded: Number(r.days_recorded),
            govt_staff_days: Number(r.govt_staff_days),
            crew_days: Number(r.crew_days),
            days_no_govt_staff: Number(r.days_no_govt_staff),
            return_days: Number(r.return_days),
            team_days: Number(r.team_days),
          }]));

      /*
       * Instruments and people per village (§note 19).
       *
       * Rover-days come from the per-rover rows on each return, which is the
       * only place that knows an instrument sat idle rather than simply not
       * being mentioned. Allocated is the standing allocation today; used
       * and idle are what the returns say over the village's whole life.
       *
       * Two queries for the whole programme rather than two per village: a
       * thousand villages is two thousand round trips done the obvious way,
       * and this sheet is pulled for a whole programme.
       */
      const kit = new Map<string, Record<string, number>>(
        (await pool.query(
          /*
           * Two aggregates, joined afterwards rather than in one FROM.
           *
           * Joining allocations and rover-days in the same query multiplies
           * one by the other: two instruments out turns three rover-days
           * into six, and the summary silently disagrees with the daily
           * sheet it is summarising.
           */
          `WITH allocated AS (
             SELECT ra.survey_village_id, count(DISTINCT ra.asset_id)::int AS n
               FROM survey_rover_allocations ra
               JOIN survey_villages sv ON sv.id = ra.survey_village_id
              WHERE ra.org_id = $1 AND sv.survey_project_id = $2 AND ra.released_on IS NULL
              GROUP BY 1
           ), worked AS (
             SELECT e.survey_village_id,
                    count(*) FILTER (WHERE er.status = 'UTILIZED')::int AS used,
                    count(*) FILTER (WHERE er.status = 'IDLE')::int     AS idle
               FROM survey_entry_rovers er
               JOIN survey_entries e ON e.id = er.entry_id
               JOIN survey_villages sv ON sv.id = e.survey_village_id
              WHERE e.org_id = $1 AND sv.survey_project_id = $2
              GROUP BY 1
           )
           SELECT sv.id AS survey_village_id,
                  COALESCE(a.n, 0) AS rovers_allocated,
                  COALESCE(wk.used, 0) AS rover_days_used,
                  COALESCE(wk.idle, 0) AS rover_days_idle
             FROM survey_villages sv
             LEFT JOIN allocated a ON a.survey_village_id = sv.id
             LEFT JOIN worked wk ON wk.survey_village_id = sv.id
            WHERE sv.org_id = $1 AND sv.survey_project_id = $2`, [u.orgId, id])).rows
          .map(r => [String(r.survey_village_id), {
            rovers_allocated: Number(r.rovers_allocated),
            rover_days_used: Number(r.rover_days_used),
            rover_days_idle: Number(r.rover_days_idle),
          }]));

      const crewCount = new Map<string, number>(
        (await pool.query(
          `SELECT c.survey_village_id, count(DISTINCT c.employee_id)::int AS crew
             FROM survey_crew c
             JOIN survey_villages sv ON sv.id = c.survey_village_id
            WHERE c.org_id = $1 AND sv.survey_project_id = $2 AND c.released_on IS NULL
            GROUP BY 1`, [u.orgId, id])).rows
          .map(r => [String(r.survey_village_id), Number(r.crew)]));

      return {
        data: pos.map(p => {
          const att = attendance.get(p.villageId);
          const k = kit.get(p.villageId);
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
            // Derived, never stored: two columns holding one quantity in
            // different units disagree the moment either is edited. Every
            // government letter is in square kilometres and the revenue
            // record is in acres, so both are carried.
            actual_extent_sq_km: acresToSqKm(Math.round(surveyed * 10000) / 10000),
            state: villageState(p, codes),
            // From the linked task, where there is one. The daily entry
            // records a team count; the task records the person.
            assignee_name: p.row.assignee_name ?? null,
            planned_start_date: iso(p.row.planned_start_date),
            planned_end_date: iso(p.row.planned_end_date),
            /*
             * Ground-truthing staffing (§067): what was agreed with the
             * mandal, and what turned up. Expected person-days are counted
             * only over days that have a return — multiplying by the
             * calendar would charge the department for Sundays.
             */
            gt_govt_staff_allocated: p.row.gt_govt_staff_allocated === null
              ? null : Number(p.row.gt_govt_staff_allocated),
            gt_crew_allocated: p.row.gt_crew_allocated === null
              ? null : Number(p.row.gt_crew_allocated),
            attendance_days: att?.days_recorded ?? 0,
            govt_staff_days: att?.govt_staff_days ?? 0,
            crew_days: att?.crew_days ?? 0,
            days_no_govt_staff: att?.days_no_govt_staff ?? 0,
            govt_staff_pct: att && att.days_recorded && p.row.gt_govt_staff_allocated
              ? Math.round((att.govt_staff_days
                / (att.days_recorded * Number(p.row.gt_govt_staff_allocated))) * 1000) / 10
              : null,
            crew_pct: att && att.days_recorded && p.row.gt_crew_allocated
              ? Math.round((att.crew_days
                / (att.days_recorded * Number(p.row.gt_crew_allocated))) * 1000) / 10
              : null,
            /*
             * Instruments and people on the village (§note 19).
             *
             * Allocated is what stands today; used and idle are rover-days
             * over the village's whole life, from the per-rover rows on each
             * return. A day nobody filed is in neither — it is a reporting
             * gap, not an idle instrument, and they need different
             * conversations.
             */
            rovers_allocated: k?.rovers_allocated ?? 0,
            rover_days_used: k?.rover_days_used ?? 0,
            rover_days_idle: k?.rover_days_idle ?? 0,
            rover_utilisation_pct: k && (k.rover_days_used + k.rover_days_idle) > 0
              ? Math.round((k.rover_days_used
                / (k.rover_days_used + k.rover_days_idle)) * 1000) / 10
              : null,
            crew_assigned: crewCount.get(p.villageId) ?? 0,
            return_days: att?.return_days ?? 0,
            team_days: att?.team_days ?? 0,
          };
        }),
      };
    });
}
