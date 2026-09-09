import {mutationRoute} from "../../common/mutationRoute.js";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  ApiError,
  S2_PERMISSIONS,
  cursorPageQuerySchema,
  decodeCursor,
  encodeCursor,
  geoFenceCreateSchema,
  geoFencePatchSchema,
  toFieldErrors,
} from "@silverline/shared";
import { buildAuthenticate, requirePermission } from "../../common/auth.js";
import { writeAudit } from "../../common/audit.js";
import { sendError } from "../../common/httpErrors.js";
import {
  idempotencyKeyOf,
  replayIfSeen,
  storeIdempotentResponse,
} from "../../common/idempotency.js";

export interface GeoFenceRoutesOptions {
  pool: Pool;
  jwtSecret: string;
}

const listQuerySchema = cursorPageQuerySchema.extend({
  scope_type: z.enum(["district", "mandal", "village", "site"]).optional(),
  scope_id: z.string().uuid().optional(),
});

interface PageCursor {
  created_at: string;
  id: string;
}

interface GeoFenceRow {
  id: string;
  org_id: string;
  name: string;
  scope_type: string;
  scope_id: string;
  geometry_type: string;
  geometry: unknown;
  tolerance_meters: number;
  accuracy_threshold_meters: number | null;
  status: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function toShape(row: GeoFenceRow) {
  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    scope_type: row.scope_type,
    scope_id: row.scope_id,
    geometry_type: row.geometry_type,
    geometry: row.geometry,
    tolerance_meters: Number(row.tolerance_meters),
    accuracy_threshold_meters:
      row.accuracy_threshold_meters === null ||
      row.accuracy_threshold_meters === undefined
        ? null
        : Number(row.accuracy_threshold_meters),
    status: row.status,
    version: row.version,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

const SELECT_COLS = `id, org_id, name, scope_type, scope_id, geometry_type,
  geometry, tolerance_meters, accuracy_threshold_meters, status, version,
  created_at, updated_at`;

function ifMatchVersion(req: { headers: Record<string, unknown> }): number {
  const raw = req.headers["if-match"];
  const text = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  const n = text === undefined || text === "" ? NaN : Number(text);
  if (!Number.isInteger(n) || n < 1) {
    throw new ApiError({
      status: 422,
      code: "VALIDATION_ERROR",
      message: "Validation failed",
      fieldErrors: [
        {
          field: "If-Match",
          message: "If-Match header with the current version is required",
          code: "missing_version",
        },
      ],
    });
  }
  return n;
}

export async function registerGeoFenceRoutes(
  app: FastifyInstance,
  opts: GeoFenceRoutesOptions,
): Promise<void> {
  const authenticate = buildAuthenticate({
    pool: opts.pool,
    jwtSecret: opts.jwtSecret,
  });
  const canRead = requirePermission(authenticate, S2_PERMISSIONS.GEO_READ);
  const canManage = requirePermission(authenticate, S2_PERMISSIONS.GEO_MANAGE);

  // GET /api/v1/geo-fences?scope_type=&scope_id=
  app.get("/api/v1/geo-fences", { preHandler: canRead }, async (req, reply) => {
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
    const { limit, cursor, scope_type, scope_id } = parsed.data;
    const values: unknown[] = [user.orgId];
    const clauses = ["org_id = $1"];
    if (scope_type) {
      values.push(scope_type);
      clauses.push(`scope_type = $${values.length}`);
    }
    if (scope_id) {
      values.push(scope_id);
      clauses.push(`scope_id = $${values.length}::uuid`);
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
      `SELECT ${SELECT_COLS} FROM geo_fences WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
      values as string[],
    );
    const hasMore = res.rows.length > limit;
    const page = res.rows.slice(0, limit) as GeoFenceRow[];
    const last = page[page.length - 1];
    return reply.status(200).send({
      data: page.map(toShape),
      next_cursor:
        hasMore && last
          ? encodeCursor({ created_at: iso(last.created_at), id: last.id })
          : null,
      has_more: hasMore,
    });
  });

  // POST /api/v1/geo-fences (Idempotency-Key supported)
  app.post("/api/v1/geo-fences", { preHandler: canManage }, async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
    if (await replayIfSeen(db, req, reply)) {
      return;
    }
    const parsed = geoFenceCreateSchema.safeParse(req.body);
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
    const d = parsed.data;
    const scope = await db.query(
      "SELECT id, type FROM org_units WHERE id = $1::uuid AND org_id = $2",
      [d.scope_id, user.orgId],
    );
    const scopeRow = scope.rows[0] as { id: string; type: string } | undefined;
    if (!scopeRow) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: [{ field: "scope_id", message: "Scoped unit not found" }],
      });
    }
    if (scopeRow.type !== d.scope_type) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: [
          {
            field: "scope_type",
            message: `scope_type must match the unit type, got ${scopeRow.type}`,
          },
        ],
      });
    }
    const ins = await db.query(
      `INSERT INTO geo_fences
         (org_id, name, scope_type, scope_id, geometry_type, geometry,
          tolerance_meters, accuracy_threshold_meters, created_by, updated_by)
       VALUES ($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9::uuid,$9::uuid)
       RETURNING ${SELECT_COLS}`,
      [
        user.orgId,
        d.name,
        d.scope_type,
        d.scope_id,
        d.geometry_type,
        JSON.stringify(d.geometry),
        d.tolerance_meters ?? 0,
        d.accuracy_threshold_meters ?? null,
        user.id,
      ],
    );
    const row = ins.rows[0] as GeoFenceRow;
    const body = toShape(row);
    await writeAudit(db, {
      orgId: user.orgId,
      actorId: user.id,
      actorIp: req.ip,
      actorUserAgent:
        typeof req.headers["user-agent"] === "string"
          ? (req.headers["user-agent"] as string)
          : null,
      action: "geo_fence.create",
      entityType: "geo_fence",
      entityId: row.id,
      afterState: body,
      requestId: req.requestId,
      idempotencyKey: idempotencyKeyOf(req),
    });
    await storeIdempotentResponse(db, req, user.id, 201, body);
    return reply.status(201).send(body);
  
});});

  // PATCH /api/v1/geo-fences/:id (If-Match version, in-place bump for S2)
  app.patch(
    "/api/v1/geo-fences/:id",
    { preHandler: canManage },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const parsed = geoFencePatchSchema.safeParse(req.body);
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
      const expectedVersion = ifMatchVersion(req);
      const { id } = req.params as { id: string };
      const current = await db.query(
        `SELECT ${SELECT_COLS} FROM geo_fences WHERE id = $1::uuid AND org_id = $2`,
        [id, user.orgId],
      );
      const cur = current.rows[0] as GeoFenceRow | undefined;
      if (!cur) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Geo-fence not found",
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
      const { name, tolerance_meters, accuracy_threshold_meters, status } =
        parsed.data;
      const upd = await db.query(
        `UPDATE geo_fences SET
           name = COALESCE($3, name),
           tolerance_meters = COALESCE($4, tolerance_meters),
           accuracy_threshold_meters = COALESCE($5, accuracy_threshold_meters),
           status = COALESCE($6, status),
           updated_by = $7::uuid, updated_at = NOW(), version = version + 1
         WHERE id = $1::uuid AND org_id = $2 AND version = $8
         RETURNING ${SELECT_COLS}`,
        [
          id,
          user.orgId,
          name ?? null,
          tolerance_meters ?? null,
          accuracy_threshold_meters ?? null,
          status ?? null,
          user.id,
          expectedVersion,
        ],
      );
      const row = upd.rows[0] as GeoFenceRow | undefined;
      if (!row) {
        const fresh = await db.query(
          "SELECT version FROM geo_fences WHERE id = $1::uuid AND org_id = $2",
          [id, user.orgId],
        );
        const latest = fresh.rows[0] as { version: number } | undefined;
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
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id,
        actorIp: req.ip,
        actorUserAgent:
          typeof req.headers["user-agent"] === "string"
            ? (req.headers["user-agent"] as string)
            : null,
        action: "geo_fence.update",
        entityType: "geo_fence",
        entityId: row.id,
        beforeState: toShape(cur),
        afterState: body,
        requestId: req.requestId,
      });
      return reply.status(200).send(body);
    
});},
  );
}
