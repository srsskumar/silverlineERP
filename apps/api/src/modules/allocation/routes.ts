import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  resourceAllocationSchema, shiftSchema, rosterEntrySchema, rosterBulkSchema,
  findCapacityConflict, utilisation, shiftHours, isRestDay, dayPay,
  ALLOCATION_TRANSITIONS,
  type Allocation, type AllocationState, type Weekday,
  businessDay,
} from '@silverline/shared';
import { buildAuthenticate, requirePermission } from '../../common/auth.js';
import { actor, parse, page, inOrg, mutate, version, fail, employeeAccess } from '../../common/domain.js';

/**
 * Workforce allocation and rostering (§47).
 *
 * Capacity is checked before a promise is made rather than reported
 * afterwards: the point of the warning is that the planner can still choose
 * somebody else.
 */
export async function registerAllocationRoutes(app: FastifyInstance, opts: { pool: Pool; jwtSecret: string }) {
  const { pool } = opts;
  const auth = buildAuthenticate(opts);
  const guard = (p: string) => requirePermission(auth, p);
  const iso = (v: unknown) =>
    v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  // The calendar day where the work happens, not in UTC. For the first
  // five and a half hours of every Indian day, UTC is still yesterday.
  const today = () => businessDay();

  /** Live allocations for a person, in the shape the pure layer wants. */
  async function allocationsFor(db: Pool | PoolClient, orgId: string, employeeId: string): Promise<Allocation[]> {
    return (await db.query(
      `SELECT id, employee_id, project_id, percentage, starts_on, ends_on, state
       FROM resource_allocations WHERE org_id = $1 AND employee_id = $2`, [orgId, employeeId]))
      .rows.map(r => ({
        id: String(r.id),
        employeeId: String(r.employee_id),
        projectId: String(r.project_id),
        percentage: Number(r.percentage),
        startsOn: iso(r.starts_on),
        endsOn: iso(r.ends_on),
        state: r.state as AllocationState,
      }));
  }

  /* --------------------------------------------------------- allocations */

  app.get('/api/v1/allocations', { preHandler: guard('allocation.read') }, async req => {
    const u = actor(req), { limit, offset, q } = page(req);
    const values: unknown[] = [u.orgId, limit + 1, offset];
    let where = 'a.org_id = $1';
    if (q.project_id) { values.push(q.project_id); where += ` AND a.project_id = $${values.length}::uuid`; }
    if (q.employee_id) { values.push(q.employee_id); where += ` AND a.employee_id = $${values.length}::uuid`; }
    if (q.state) { values.push(q.state); where += ` AND a.state = $${values.length}`; }
    if (q.on) {
      values.push(q.on);
      where += ` AND a.starts_on <= $${values.length}::date AND a.ends_on >= $${values.length}::date`;
    }
    const rows = (await pool.query(
      `SELECT a.*, p.code AS project_code, p.name AS project_name,
              trim(concat_ws(' ', e.first_name, e.last_name)) AS employee_name, e.emp_no
       FROM resource_allocations a
       JOIN projects p ON p.id = a.project_id
       JOIN employees e ON e.id = a.employee_id
       WHERE ${where} ORDER BY a.starts_on DESC LIMIT $2 OFFSET $3`, values)).rows;
    return { data: rows.slice(0, limit), has_more: rows.length > limit };
  });

  app.post('/api/v1/allocations', { preHandler: guard('allocation.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(resourceAllocationSchema, req.body);
    await employeeAccess(pool, req, input.employee_id);
    const row = await mutate(pool, req, 'allocation.create', 'resource_allocation', async db => {
      await inOrg(db, 'employees', input.employee_id, u.orgId);
      await inOrg(db, 'projects', input.project_id, u.orgId);

      const conflict = findCapacityConflict({
        existing: await allocationsFor(db, u.orgId, input.employee_id),
        proposed: {
          employeeId: input.employee_id, projectId: input.project_id,
          percentage: input.percentage, startsOn: input.starts_on,
          endsOn: input.ends_on, state: 'PLANNED',
        },
      });

      let overrideReason: string | null = null;
      if (conflict) {
        // Checked before the promise is made, not reported afterwards: the
        // point of the warning is that the planner can still pick somebody
        // else.
        if (!u.permissions.includes('allocation.override')) {
          fail('CAPACITY_EXCEEDED',
            `That would commit this person to ${conflict.totalPercentage}% on ${conflict.date}. Reduce the share, shorten the dates, or have somebody with the override permission approve it.`);
        }
        if (!input.override_reason) {
          fail('OVERRIDE_REASON_REQUIRED',
            `That would commit this person to ${conflict.totalPercentage}% on ${conflict.date}. Say why the over-commitment is acceptable.`);
        }
        overrideReason = input.override_reason;
      }

      const created = (await db.query(
        `INSERT INTO resource_allocations(org_id, created_by, employee_id, project_id, percentage,
           starts_on, ends_on, role_on_project, planned_hours, notes, override_reason, override_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [u.orgId, u.id, input.employee_id, input.project_id, input.percentage,
         input.starts_on, input.ends_on, input.role_on_project ?? null,
         input.planned_hours ?? null, input.notes ?? null,
         overrideReason, overrideReason ? u.id : null])).rows[0];
      return { ...created, conflict };
    });
    reply.code(201);
    return { data: row };
  });

  app.post('/api/v1/allocations/:id/status', { preHandler: guard('allocation.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const body = req.body as { state?: AllocationState };
    return {
      data: await mutate(pool, req, 'allocation.status', 'resource_allocation', async db => {
        const allocation = await inOrg(db, 'resource_allocations', id, u.orgId, true);
        version(req, allocation as { version: number });
        const from = allocation.state as AllocationState;
        if (!body.state || !(ALLOCATION_TRANSITIONS[from] ?? []).includes(body.state)) {
          fail('INVALID_TRANSITION',
            `An allocation cannot go from ${from.toLowerCase()} to ${String(body.state ?? '').toLowerCase()}`);
        }
        return (await db.query(
          `UPDATE resource_allocations SET state=$2, version=version+1,
             updated_at=now(), updated_by=$3 WHERE id=$1 RETURNING *`,
          [id, body.state, u.id])).rows[0];
      }),
    };
  });

  /**
   * Who is idle, who is full and who is over-committed, on a given day.
   *
   * The view a planner opens before promising anybody: an over-allocation
   * found here costs a conversation, and the same one found on the morning
   * costs a day of two sites waiting.
   */
  app.get('/api/v1/allocations/utilisation', { preHandler: guard('allocation.read') }, async req => {
    const u = actor(req), { q } = page(req);
    const on = String(q.on ?? today());
    const rows = (await pool.query(
      `SELECT e.id, e.emp_no,
              trim(concat_ws(' ', e.first_name, e.last_name)) AS name,
              COALESCE(json_agg(json_build_object(
                'id', a.id, 'project_id', a.project_id, 'project_code', p.code,
                'percentage', a.percentage, 'starts_on', a.starts_on,
                'ends_on', a.ends_on, 'state', a.state
              ) ORDER BY a.starts_on) FILTER (WHERE a.id IS NOT NULL), '[]') AS allocations
       FROM employees e
       LEFT JOIN resource_allocations a
         ON a.employee_id = e.id AND a.state IN ('PLANNED','ACTIVE')
       LEFT JOIN projects p ON p.id = a.project_id
       WHERE e.org_id = $1 AND e.status = 'ACTIVE'
       GROUP BY e.id ORDER BY name`, [u.orgId])).rows;

    const people = rows.map(r => {
      const allocations: Allocation[] = (r.allocations as Record<string, unknown>[]).map(a => ({
        id: String(a.id), employeeId: String(r.id), projectId: String(a.project_id),
        percentage: Number(a.percentage), startsOn: iso(a.starts_on), endsOn: iso(a.ends_on),
        state: a.state as AllocationState,
      }));
      return {
        employee_id: r.id, emp_no: r.emp_no, name: r.name,
        ...utilisation(allocations, on),
        allocations: allocations.filter(a => a.startsOn <= on && on <= a.endsOn),
      };
    });

    return {
      data: {
        on,
        over_committed: people.filter(p => p.over).length,
        idle: people.filter(p => p.allocated === 0).length,
        people,
      },
    };
  });

  /* -------------------------------------------------------------- shifts */

  app.get('/api/v1/shifts', { preHandler: guard('roster.read') }, async req => {
    const u = actor(req);
    const rows = (await pool.query(
      'SELECT * FROM work_shifts WHERE org_id = $1 ORDER BY code', [u.orgId])).rows;
    return {
      data: rows.map(r => ({
        ...r,
        // Computed rather than stored: a night shift's span depends on a rule,
        // and a stored figure would drift the moment the times were edited.
        shift_hours: shiftHours({
          code: String(r.code), startsAt: String(r.starts_at).slice(0, 5),
          endsAt: String(r.ends_at).slice(0, 5), breakMinutes: Number(r.break_minutes),
        }),
      })),
    };
  });

  app.post('/api/v1/shifts', { preHandler: guard('roster.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(shiftSchema, req.body);
    const row = await mutate(pool, req, 'shift.create', 'work_shift', async db => {
      const clash = await db.query(
        'SELECT 1 FROM work_shifts WHERE org_id = $1 AND code = $2', [u.orgId, input.code]);
      if (clash.rowCount) fail('DUPLICATE_SHIFT', `Shift ${input.code} already exists`, 409);
      return (await db.query(
        `INSERT INTO work_shifts(org_id, created_by, code, name, starts_at, ends_at,
           break_minutes, rest_days, daily_threshold_hours, overtime_multiplier,
           rest_day_multiplier, effective_from, effective_to, active)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [u.orgId, u.id, input.code, input.name, input.starts_at, input.ends_at,
         input.break_minutes, JSON.stringify(input.rest_days), input.daily_threshold_hours,
         input.overtime_multiplier, input.rest_day_multiplier ?? null,
         input.effective_from, input.effective_to ?? null, input.active])).rows[0];
    });
    reply.code(201);
    return { data: row };
  });

  /* -------------------------------------------------------------- roster */

  app.get('/api/v1/roster', { preHandler: guard('roster.read') }, async req => {
    const u = actor(req), { q } = page(req);
    const from = String(q.from ?? today());
    const to = String(q.to ?? from);
    const values: unknown[] = [u.orgId, from, to];
    let where = 'r.org_id = $1 AND r.roster_date BETWEEN $2::date AND $3::date';
    if (q.employee_id) { values.push(q.employee_id); where += ` AND r.employee_id = $${values.length}::uuid`; }
    if (q.project_id) { values.push(q.project_id); where += ` AND r.project_id = $${values.length}::uuid`; }
    return {
      data: (await pool.query(
        `SELECT r.*, s.code AS shift_code, s.name AS shift_name, s.starts_at, s.ends_at,
                trim(concat_ws(' ', e.first_name, e.last_name)) AS employee_name, e.emp_no,
                p.code AS project_code
         FROM roster_entries r
         JOIN work_shifts s ON s.id = r.shift_id
         JOIN employees e ON e.id = r.employee_id
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE ${where} ORDER BY r.roster_date, employee_name`, values)).rows,
    };
  });

  app.post('/api/v1/roster', { preHandler: guard('roster.manage') }, async (req, reply) => {
    const u = actor(req), input = parse(rosterEntrySchema, req.body);
    const row = await mutate(pool, req, 'roster.create', 'roster_entry', async db => {
      await inOrg(db, 'employees', input.employee_id, u.orgId);
      await inOrg(db, 'work_shifts', input.shift_id, u.orgId);
      const clash = await db.query(
        'SELECT 1 FROM roster_entries WHERE employee_id = $1 AND roster_date = $2',
        [input.employee_id, input.roster_date]);
      if (clash.rowCount) {
        // Two shifts on one day makes "which shift were they on" unanswerable
        // and doubles the overtime calculation.
        fail('ALREADY_ROSTERED', 'That person is already rostered on that day', 409);
      }
      return (await db.query(
        `INSERT INTO roster_entries(org_id, created_by, employee_id, shift_id, roster_date,
           project_id, notes)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [u.orgId, u.id, input.employee_id, input.shift_id, input.roster_date,
         input.project_id ?? null, input.notes ?? null])).rows[0];
    });
    reply.code(201);
    return { data: row };
  });

  /**
   * Roster a group across a window.
   *
   * Rest days are skipped rather than refused: a fortnight's roster for a
   * crew is one action, and failing the whole thing because it happens to
   * contain a Sunday would make the endpoint useless.
   */
  app.post('/api/v1/roster/bulk', { preHandler: guard('roster.manage') }, async req => {
    const u = actor(req), input = parse(rosterBulkSchema, req.body);
    return {
      data: await mutate(pool, req, 'roster.bulk', 'roster_entry', async db => {
        const shift = await inOrg(db, 'work_shifts', input.shift_id, u.orgId);
        const restDays = (Array.isArray(shift.rest_days) ? shift.rest_days : []) as Weekday[];
        const summary = { created: 0, skipped_rest_day: 0, already_rostered: 0 };

        for (const employeeId of input.employee_ids) {
          await inOrg(db, 'employees', employeeId, u.orgId);
          const cursor = new Date(`${input.starts_on}T00:00:00Z`);
          const end = new Date(`${input.ends_on}T00:00:00Z`);
          while (cursor <= end) {
            const date = cursor.toISOString().slice(0, 10);
            cursor.setUTCDate(cursor.getUTCDate() + 1);
            if (isRestDay({
              code: String(shift.code), startsAt: String(shift.starts_at).slice(0, 5),
              endsAt: String(shift.ends_at).slice(0, 5), restDays,
            }, date)) {
              summary.skipped_rest_day += 1;
              continue;
            }
            const inserted = await db.query(
              `INSERT INTO roster_entries(org_id, created_by, employee_id, shift_id, roster_date, project_id)
               VALUES($1,$2,$3,$4,$5,$6)
               ON CONFLICT (employee_id, roster_date) DO NOTHING RETURNING id`,
              [u.orgId, u.id, employeeId, input.shift_id, date, input.project_id ?? null]);
            if (inserted.rowCount) summary.created += 1;
            else summary.already_rostered += 1;
          }
        }
        return summary;
      }),
    };
  });

  /**
   * Approve a rostered day and compute what payroll should price (§47.3).
   *
   * Payroll consumes this, not the raw attendance events. Those say where a
   * phone was, which is evidence; the roster and its overtime rules turn that
   * into a decision about what somebody is owed, and only the approved result
   * should reach a payslip.
   */
  app.post('/api/v1/roster/:id/approve', { preHandler: guard('roster.manage') }, async req => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const body = req.body as { worked_hours?: number };
    if (body?.worked_hours === undefined) {
      fail('VALIDATION_ERROR', 'Say how many hours were actually worked');
    }
    return {
      data: await mutate(pool, req, 'roster.approve', 'roster_entry', async db => {
        const entry = (await db.query(
          `SELECT r.*, s.daily_threshold_hours, s.overtime_multiplier, s.rest_day_multiplier,
                  s.rest_days, s.code AS shift_code, s.starts_at, s.ends_at
           FROM roster_entries r JOIN work_shifts s ON s.id = r.shift_id
           WHERE r.id = $1 AND r.org_id = $2 FOR UPDATE OF r`, [id, u.orgId])).rows[0];
        if (!entry) fail('NOT_FOUND', 'Roster entry not found', 404);
        version(req, entry as { version: number });
        if (entry.approved_at) fail('ALREADY_APPROVED', 'That day is already approved');

        const restDay = isRestDay({
          code: String(entry.shift_code), startsAt: String(entry.starts_at).slice(0, 5),
          endsAt: String(entry.ends_at).slice(0, 5),
          restDays: (Array.isArray(entry.rest_days) ? entry.rest_days : []) as Weekday[],
        }, iso(entry.roster_date));

        const pay = dayPay({
          workedHours: Number(body.worked_hours),
          rule: {
            dailyThresholdHours: Number(entry.daily_threshold_hours),
            multiplier: Number(entry.overtime_multiplier),
            restDayMultiplier: entry.rest_day_multiplier === null
              ? undefined : Number(entry.rest_day_multiplier),
          },
          onRestDay: restDay,
        });

        return (await db.query(
          `UPDATE roster_entries SET approved_at=now(), approved_by=$2, worked_hours=$3,
             overtime_hours=$4, payable_hours=$5, version=version+1,
             updated_at=now(), updated_by=$2 WHERE id=$1 RETURNING *`,
          [id, u.id, Number(body.worked_hours), pay.overtimeHours, pay.payableHours])).rows[0];
      }),
    };
  });
}
