import {mutationRoute} from "../../common/mutationRoute.js";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  S1_PERMISSIONS,
  cursorPageQuerySchema,
  decodeCursor,
  encodeCursor,
  holidayCreateSchema,
  holidayPatchSchema,
  resolveEffectiveHolidays,
  toFieldErrors,
} from "@silverline/shared";
import { buildAuthenticate, requirePermission } from "../../common/auth.js";
import { writeAudit } from "../../common/audit.js";
import { sendError } from "../../common/httpErrors.js";

export interface HolidayRoutesOptions {
  pool: Pool;
  jwtSecret: string;
}

const listQuerySchema = cursorPageQuerySchema.extend({
  year: z.coerce.number().int().min(1900).max(2100).optional(),
  scope_type: z.string().max(50).optional(),
  scope_id: z.string().uuid().optional(),
  /**
   * Resolve to the holidays actually in effect for one employee (§8.2).
   *
   * Without it the list is every row, including a district's local holiday and
   * the organization-wide default that falls on the same date — two answers for
   * one day. With it, each date yields the single holiday that applies to this
   * employee's own location chain, finest scope winning.
   */
  employee_id: z.string().uuid().optional(),
});

interface HolidayCursor {
  date: string;
  id: string;
}

interface HolidayRow {
  id: string;
  date: Date | string;
  name: string;
  type: string;
  scope_type: string | null;
  scope_id: string | null;
  created_at: Date | string;
}

function toShape(row: HolidayRow) {
  const date = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10);
  return {
    id: row.id,
    date,
    name: row.name,
    type: row.type,
    scope_type: row.scope_type,
    scope_id: row.scope_id,
  };
}

export async function registerHolidayRoutes(
  app: FastifyInstance,
  opts: HolidayRoutesOptions,
): Promise<void> {
  const authenticate = buildAuthenticate({
    pool: opts.pool,
    jwtSecret: opts.jwtSecret,
  });
  const canRead = requirePermission(authenticate, S1_PERMISSIONS.HOLIDAY_READ);
  const canManage = requirePermission(
    authenticate,
    S1_PERMISSIONS.HOLIDAY_MANAGE,
  );

  // GET /api/v1/holidays?year=&scope_type=&scope_id=
  app.get("/api/v1/holidays", { preHandler: canRead }, async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const { limit, cursor, year, scope_type, scope_id } = parsed.data;
    const values: unknown[] = [user.orgId];
    const clauses = ["org_id = $1", "active = true"];
    if (year !== undefined) {
      values.push(year);
      clauses.push(`EXTRACT(YEAR FROM date) = $${values.length}`);
    }
    if (scope_type !== undefined) {
      values.push(scope_type);
      clauses.push(`scope_type = $${values.length}`);
    }
    if (scope_id !== undefined) {
      values.push(scope_id);
      clauses.push(`scope_id = $${values.length}::uuid`);
    }
    if (cursor) {
      const decoded = decodeCursor<HolidayCursor>(cursor);
      if (!decoded) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: [
            { field: "cursor", message: "Invalid cursor", code: "invalid_string" },
          ],
        });
      }
      values.push(decoded.date, decoded.id);
      clauses.push(
        `(date, id) > ($${values.length - 1}::date, $${values.length}::uuid)`,
      );
    }
    if (parsed.data.employee_id) {
      const employee = await opts.pool.query(
        `SELECT site_id, village_id, mandal_id, district_id FROM employees
          WHERE id = $1::uuid AND org_id = $2`,
        [parsed.data.employee_id, user.orgId],
      );
      const row = employee.rows[0] as
        | {
            site_id: string | null;
            village_id: string | null;
            mandal_id: string | null;
            district_id: string | null;
          }
        | undefined;
      if (!row) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Employee not found",
        });
      }
      // Resolution needs every candidate for the period, so this branch does
      // not paginate; a year of holidays is a short list by construction.
      const all = await opts.pool.query(
        `SELECT id, date, name, type, scope_type, scope_id, created_at
           FROM holidays WHERE ${clauses.join(" AND ")}
          ORDER BY date ASC, id ASC LIMIT 1000`,
        values as string[],
      );
      const candidates = (all.rows as HolidayRow[]).map((holiday) => ({
        ...toShape(holiday),
        date: toShape(holiday).date,
      }));
      const effective = resolveEffectiveHolidays(candidates, [
        row.site_id,
        row.village_id,
        row.mandal_id,
        row.district_id,
      ]);
      return reply.status(200).send({
        data: effective,
        next_cursor: null,
        has_more: false,
      });
    }

    values.push(limit + 1);
    const res = await opts.pool.query(
      `SELECT id, date, name, type, scope_type, scope_id, created_at
       FROM holidays WHERE ${clauses.join(" AND ")}
       ORDER BY date ASC, id ASC LIMIT $${values.length}`,
      values as string[],
    );
    const hasMore = res.rows.length > limit;
    const page = (res.rows as HolidayRow[]).slice(0, limit);
    const last = page[page.length - 1];
    return reply.status(200).send({
      data: page.map(toShape),
      next_cursor:
        hasMore && last
          ? encodeCursor({
              date:
                last.date instanceof Date
                  ? last.date.toISOString().slice(0, 10)
                  : String(last.date).slice(0, 10),
              id: last.id,
            })
          : null,
      has_more: hasMore,
    });
  });

  // POST /api/v1/holidays
  app.post("/api/v1/holidays", { preHandler: canManage }, async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
    const parsed = holidayCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const { date, name, type, scope_type, scope_id } = parsed.data;
    let row: HolidayRow;
    try {
      const ins = await db.query(
        `INSERT INTO holidays (org_id, date, name, type, scope_type, scope_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::uuid, $7::uuid)
         RETURNING id, date, name, type, scope_type, scope_id, created_at`,
        [user.orgId, date, name, type, scope_type ?? null, scope_id ?? null, user.id],
      );
      row = ins.rows[0] as HolidayRow;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        return sendError(reply, req.requestId, {
          status: 409,
          code: "CONFLICT",
          message: "A holiday already exists for this date and scope",
          fieldErrors: [{ field: "date", message: "Duplicate holiday for this date and scope" }],
        });
      }
      throw err;
    }
    const body = toShape(row);
    await writeAudit(db, {
      orgId: user.orgId,
      actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
      actorIp: req.ip,
      actorUserAgent:
        typeof req.headers["user-agent"] === "string"
          ? (req.headers["user-agent"] as string)
          : null,
      action: "holiday.create",
      entityType: "holiday",
      entityId: row.id,
      afterState: body,
      requestId: req.requestId,
    });
    return reply.status(201).send(body);
  
});});

  /**
   * PATCH /api/v1/holidays/:id -- correct a holiday, or withdraw it.
   *
   * There was no way to fix a holiday entered on the wrong date: it could
   * only be added, so the wrong one stayed and paid people a day off that
   * was not one. Withdrawing sets active = false and the list stops showing
   * it; the row stays, and the audit trail records who changed what, from
   * what, and why.
   */
  app.patch("/api/v1/holidays/:id", { preHandler: canManage }, async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
    const parsed = holidayPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return sendError(reply, req.requestId, {
        status: 404,
        code: "NOT_FOUND",
        message: "Holiday not found",
      });
    }
    const curRes = await db.query(
      `SELECT id, date, name, type, scope_type, scope_id, created_at, active
         FROM holidays WHERE id = $1::uuid AND org_id = $2 FOR UPDATE`,
      [id, user.orgId],
    );
    const cur = curRes.rows[0] as (HolidayRow & { active: boolean }) | undefined;
    if (!cur) {
      return sendError(reply, req.requestId, {
        status: 404,
        code: "NOT_FOUND",
        message: "Holiday not found",
      });
    }
    const { date, name, type, active, reason } = parsed.data;
    let row: HolidayRow & { active: boolean };
    try {
      const upd = await db.query(
        `UPDATE holidays SET
           date = COALESCE($3::date, date),
           name = COALESCE($4, name),
           type = COALESCE($5, type),
           active = COALESCE($6::boolean, active)
         WHERE id = $1::uuid AND org_id = $2
         RETURNING id, date, name, type, scope_type, scope_id, created_at, active`,
        [id, user.orgId, date ?? null, name ?? null, type ?? null, active ?? null],
      );
      row = upd.rows[0] as HolidayRow & { active: boolean };
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        return sendError(reply, req.requestId, {
          status: 409,
          code: "CONFLICT",
          message: "A holiday already exists for this date and scope",
          fieldErrors: [{ field: "date", message: "Duplicate holiday for this date and scope" }],
        });
      }
      throw err;
    }
    const before = { ...toShape(cur), active: cur.active };
    const body = { ...toShape(row), active: row.active };
    await writeAudit(db, {
      orgId: user.orgId,
      actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
      actorIp: req.ip,
      actorUserAgent:
        typeof req.headers["user-agent"] === "string"
          ? (req.headers["user-agent"] as string)
          : null,
      action: cur.active && !row.active ? "holiday.deactivate" : "holiday.update",
      entityType: "holiday",
      entityId: row.id,
      beforeState: before,
      afterState: body,
      reason,
      requestId: req.requestId,
    });
    return reply.status(200).send(body);
  
});});
}
