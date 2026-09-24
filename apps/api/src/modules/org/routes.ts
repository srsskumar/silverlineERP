import {mutationRoute} from "../../common/mutationRoute.js";
import { likeContains } from "../../common/like.js";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  ApiError,
  S1_PERMISSIONS,
  cursorPageQuerySchema,
  decodeCursor,
  encodeCursor,
  orgUnitCreateSchema,
  orgUnitPatchSchema,
  toFieldErrors,
  type OrgUnitType,
} from "@silverline/shared";
import { buildAuthenticate, requirePermission } from "../../common/auth.js";
import { writeAudit } from "../../common/audit.js";
import { sendError } from "../../common/httpErrors.js";
import {
  idempotencyKeyOf,
  replayIfSeen,
  storeIdempotentResponse,
} from "../../common/idempotency.js";
import { parseIfMatch } from '../../common/ifMatch.js';

export interface OrgRoutesOptions {
  pool: Pool;
  jwtSecret: string;
}

/**
 * The parent a unit may hang off.
 *
 * A list rather than a single type because a mandal may sit under a district
 * or under a division. The division tier is optional: it is how the revenue
 * department keys its records, and every mandal recorded before it existed
 * has a district for a parent and must keep working.
 */
const EXPECTED_PARENT: Record<OrgUnitType, OrgUnitType[]> = {
  district: [],
  division: ["district"],
  mandal: ["district", "division"],
  village: ["mandal"],
  site: ["village"],
};

/** "a district", or "a district or a division" — for the error message. */
function parentPhrase(types: OrgUnitType[]): string {
  return types.length === 1 ? `a ${types[0]}` : `a ${types.slice(0, -1).join(", a ")} or a ${types[types.length - 1]}`;
}

const listQuerySchema = cursorPageQuerySchema.extend({
  type: z.enum(["district", "division", "mandal", "village", "site"]).optional(),
  parent_id: z.string().uuid().optional(),
  q: z.string().min(1).max(200).optional(),
});

interface PageCursor {
  created_at: string;
  id: string;
}

interface OrgUnitRow {
  id: string;
  type: string;
  code: string;
  name: string;
  parent_id: string | null;
  status: string;
  version: number;
}

function toShape(row: OrgUnitRow) {
  return {
    id: row.id,
    type: row.type,
    code: row.code,
    name: row.name,
    parent_id: row.parent_id,
    status: row.status,
    version: row.version,
  };
}


export async function registerOrgUnitRoutes(
  app: FastifyInstance,
  opts: OrgRoutesOptions,
): Promise<void> {
  const authenticate = buildAuthenticate({
    pool: opts.pool,
    jwtSecret: opts.jwtSecret,
  });
  const canRead = requirePermission(authenticate, S1_PERMISSIONS.ORG_UNITS_READ);
  const canManage = requirePermission(
    authenticate,
    S1_PERMISSIONS.ORG_UNITS_MANAGE,
  );

  const metaOf = (req: {
    ip: string;
    headers: Record<string, unknown>;
    requestId: string;
  }) => ({
    ip: req.ip,
    userAgent:
      typeof req.headers["user-agent"] === "string"
        ? (req.headers["user-agent"] as string)
        : null,
    requestId: req.requestId,
  });

  // GET /api/v1/org/units
  app.get("/api/v1/org/units", { preHandler: canRead }, async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    const { limit, cursor, type, parent_id, q } = parsed.data;
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const values: unknown[] = [user.orgId];
    const clauses = ["org_id = $1"];
    if (type) {
      values.push(type);
      clauses.push(`type = $${values.length}`);
    }
    if (parent_id) {
      values.push(parent_id);
      clauses.push(`parent_id = $${values.length}::uuid`);
    }
    if (q) {
      values.push(likeContains(q));
      clauses.push(`(code ILIKE $${values.length} OR name ILIKE $${values.length})`);
    }
    if (cursor) {
      const decoded = decodeCursor<PageCursor>(cursor);
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
      values.push(decoded.created_at, decoded.id);
      clauses.push(
        `(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
      );
    }
    values.push(limit + 1);
    const res = await opts.pool.query(
      `SELECT id, type, code, name, parent_id, status, version, created_at
       FROM org_units WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
      values as string[],
    );
    const hasMore = res.rows.length > limit;
    const page = res.rows.slice(0, limit) as Array<
      OrgUnitRow & { created_at: Date }
    >;
    const last = page[page.length - 1];
    return reply.status(200).send({
      data: page.map(toShape),
      next_cursor:
        hasMore && last
          ? encodeCursor({
              created_at:
                last.created_at instanceof Date
                  ? last.created_at.toISOString()
                  : last.created_at,
              id: last.id,
            })
          : null,
      has_more: hasMore,
    });
  });

  // POST /api/v1/org/units
  app.post(
    "/api/v1/org/units",
    { preHandler: canManage },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      if (await replayIfSeen(db, req, reply)) {
        return;
      }
      const parsed = orgUnitCreateSchema.safeParse(req.body);
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
      const { type, code, name, parent_id } = parsed.data;
      const expected = EXPECTED_PARENT[type];
      if (expected.length === 0 && parent_id) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: [
            { field: "parent_id", message: "District units must not have a parent" },
          ],
        });
      }
      if (expected.length > 0 && !parent_id) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: [
            { field: "parent_id", message: `${type} requires ${parentPhrase(expected)} parent` },
          ],
        });
      }
      if (parent_id) {
        const parent = await db.query(
          "SELECT id, type FROM org_units WHERE id = $1::uuid AND org_id = $2",
          [parent_id, user.orgId],
        );
        const prow = parent.rows[0] as { id: string; type: string } | undefined;
        if (!prow) {
          return sendError(reply, req.requestId, {
            status: 422,
            code: "VALIDATION_ERROR",
            message: "Validation failed",
            fieldErrors: [{ field: "parent_id", message: "Parent unit not found" }],
          });
        }
        if (!expected.includes(prow.type as OrgUnitType)) {
          return sendError(reply, req.requestId, {
            status: 422,
            code: "VALIDATION_ERROR",
            message: "Validation failed",
            fieldErrors: [
              {
                field: "parent_id",
                message: `${type} requires ${parentPhrase(expected)} parent, got ${prow.type}`,
              },
            ],
          });
        }
      }
      let row: OrgUnitRow;
      try {
        const ins = await db.query(
          `INSERT INTO org_units (org_id, type, code, name, parent_id, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5::uuid, $6::uuid, $6::uuid)
           RETURNING id, type, code, name, parent_id, status, version`,
          [user.orgId, type, code, name, parent_id ?? null, user.id],
        );
        row = ins.rows[0] as OrgUnitRow;
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          return sendError(reply, req.requestId, {
            status: 409,
            code: "CONFLICT",
            message: "An org unit with this code already exists for this type",
            fieldErrors: [{ field: "code", message: "Code must be unique per org and type" }],
          });
        }
        throw err;
      }
      const body = toShape(row);
      const meta = metaOf(req);
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
        actorIp: meta.ip,
        actorUserAgent: meta.userAgent,
        action: "org_unit.create",
        entityType: "org_unit",
        entityId: row.id,
        afterState: body,
        requestId: req.requestId,
        idempotencyKey: idempotencyKeyOf(req),
      });
      await storeIdempotentResponse(db, req, user.id, 201, body);
      return reply.status(201).send(body);
    
});},
  );

  // GET /api/v1/org/units/:id
  app.get(
    "/api/v1/org/units/:id",
    { preHandler: canRead },
    async (req, reply) => {
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const { id } = req.params as { id: string };
      const res = await opts.pool.query(
        `SELECT id, type, code, name, parent_id, status, version
         FROM org_units WHERE id = $1::uuid AND org_id = $2`,
        [id, user.orgId],
      );
      const row = res.rows[0] as OrgUnitRow | undefined;
      if (!row) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Org unit not found",
        });
      }
      return reply.status(200).send(toShape(row));
    },
  );

  // PATCH /api/v1/org/units/:id
  app.patch(
    "/api/v1/org/units/:id",
    { preHandler: canManage },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const parsed = orgUnitPatchSchema.safeParse(req.body);
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
      const expectedVersion = parseIfMatch(req);
      const { id } = req.params as { id: string };
      const { name, status } = parsed.data;

      const current = await db.query(
        `SELECT id, type, code, name, parent_id, status, version
         FROM org_units WHERE id = $1::uuid AND org_id = $2`,
        [id, user.orgId],
      );
      const cur = current.rows[0] as OrgUnitRow | undefined;
      if (!cur) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Org unit not found",
        });
      }
      if (cur.version !== expectedVersion) {
        return sendError(reply, req.requestId, {
          status: 409,
          code: "VERSION_CONFLICT",
          message: `Version mismatch (current version: ${cur.version})`,
          fieldErrors: [
            {
              field: "version",
              message: `Expected version ${expectedVersion} but current is ${cur.version}`,
              code: "VERSION_MISMATCH",
            },
          ],
        });
      }

      if (status === "INACTIVE" && cur.status !== "INACTIVE") {
        const kids = await db.query(
          `SELECT id FROM org_units WHERE parent_id = $1::uuid AND org_id = $2 AND status = 'ACTIVE' LIMIT 1`,
          [id, user.orgId],
        );
        if ((kids.rowCount ?? 0) > 0) {
          return sendError(reply, req.requestId, {
            status: 422,
            code: "VALIDATION_ERROR",
            message: "Cannot deactivate a unit with active child units",
            fieldErrors: [
              { field: "status", message: "Unit has active child units" },
            ],
          });
        }
        const refs = await db.query(
          `SELECT id FROM employees
           WHERE org_id = $2 AND status = 'ACTIVE'
             AND (district_id = $1::uuid OR mandal_id = $1::uuid OR village_id = $1::uuid OR site_id = $1::uuid)
           LIMIT 1`,
          [id, user.orgId],
        );
        if ((refs.rowCount ?? 0) > 0) {
          return sendError(reply, req.requestId, {
            status: 422,
            code: "VALIDATION_ERROR",
            message: "Cannot deactivate a unit referenced by active employees",
            fieldErrors: [
              { field: "status", message: "Unit is referenced by active employees" },
            ],
          });
        }
      }

      const upd = await db.query(
        `UPDATE org_units SET
           name = COALESCE($3, name),
           status = COALESCE($4, status),
           updated_by = $5::uuid, updated_at = NOW(), version = version + 1
         WHERE id = $1::uuid AND org_id = $2 AND version = $6
         RETURNING id, type, code, name, parent_id, status, version`,
        [id, user.orgId, name ?? null, status ?? null, user.id, expectedVersion],
      );
      const row = upd.rows[0] as OrgUnitRow | undefined;
      if (!row) {
        const fresh = await db.query(
          `SELECT id, type, code, name, parent_id, status, version
           FROM org_units WHERE id = $1::uuid AND org_id = $2`,
          [id, user.orgId],
        );
        const latest = fresh.rows[0] as OrgUnitRow | undefined;
        return sendError(reply, req.requestId, {
          status: 409,
          code: "VERSION_CONFLICT",
          message: `Version mismatch (current version: ${latest?.version ?? "unknown"})`,
          fieldErrors: [
            {
              field: "version",
              message: `Expected version ${expectedVersion} but current is ${latest?.version ?? "unknown"}`,
              code: "VERSION_MISMATCH",
            },
          ],
        });
      }
      const body = toShape(row);
      const meta = metaOf(req);
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id, impersonatorId: user.impersonator?.id ?? null,
        actorIp: meta.ip,
        actorUserAgent: meta.userAgent,
        action: "org_unit.update",
        entityType: "org_unit",
        entityId: row.id,
        beforeState: toShape(cur),
        afterState: body,
        requestId: req.requestId,
      });
      return reply.status(200).send(body);
    
});},
  );
}
