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

const placeSearchQuerySchema = z.object({
  q: z.string().trim().min(2, "Search needs at least 2 characters").max(200),
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
  employee_ids?: string[];
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
    employee_ids: row.employee_ids ?? [],
  };
}

const CORE_SELECT_COLS = `id, org_id, name, scope_type, scope_id, geometry_type,
  geometry, tolerance_meters, accuracy_threshold_meters, status, version,
  created_at, updated_at`;

const SELECT_COLS = `${CORE_SELECT_COLS}, COALESCE(ARRAY(
  SELECT assignment.employee_id::text
    FROM geo_fence_employee_assignments assignment
   WHERE assignment.org_id = geo_fences.org_id
     AND assignment.geo_fence_id = geo_fences.id
     AND assignment.status = 'ACTIVE'
   ORDER BY assignment.created_at, assignment.employee_id
), ARRAY[]::text[]) AS employee_ids`;

interface PlaceSearchResult {
  id: string;
  display_name: string;
  lat: number;
  lng: number;
  type: string | null;
}

const placeSearchCache = new Map<string, { expiresAt: number; data: PlaceSearchResult[] }>();
let lastPlaceSearchAt = 0;
let placeSearchQueue: Promise<void> = Promise.resolve();

async function waitForPlaceSearchSlot(): Promise<void> {
  const previous = placeSearchQueue;
  let release!: () => void;
  placeSearchQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  const delay = Math.max(0, lastPlaceSearchAt + 1_000 - Date.now());
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  lastPlaceSearchAt = Date.now();
  release();
}

/**
 * A finite coordinate from a provider field, or null.
 *
 * The provider sends coordinates as strings and is not required to send them at
 * all. Only a non-empty value that parses to a finite number counts; null,
 * undefined, "" and "NaN" all mean "this row has no position".
 */
function coordinate(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function searchPlaces(query: string): Promise<PlaceSearchResult[]> {
  const key = query.toLocaleLowerCase("en-IN");
  const cached = placeSearchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  await waitForPlaceSearchSlot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const base = (process.env["GEOCODING_BASE_URL"] ?? "https://nominatim.openstreetmap.org").replace(/\/$/, "");
    const url = new URL(`${base}/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "6");
    url.searchParams.set("addressdetails", "1");
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Language": "en-IN,en;q=0.8",
        "User-Agent": process.env["GEOCODING_USER_AGENT"] ?? "SilverlineERP/1.0",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Geocoder returned ${response.status}`);
    const body = await response.json() as Array<Record<string, unknown>>;
    const data = body.flatMap((item): PlaceSearchResult[] => {
      const lat = coordinate(item["lat"]);
      const lng = coordinate(item["lon"]);
      // A row missing a coordinate is dropped, not centred on the null island:
      // Number(null) is 0, so coercing a missing longitude would place the
      // result at 0°E and the map would recentre somewhere plausible-looking.
      if (lat === null || lng === null) return [];
      return [{
        id: `${String(item["osm_type"] ?? "place")}:${String(item["osm_id"] ?? `${lat},${lng}`)}`,
        display_name: String(item["display_name"] ?? query),
        lat,
        lng,
        type: typeof item["type"] === "string" ? item["type"] : null,
      }];
    });
    if (placeSearchCache.size >= 200) placeSearchCache.delete(placeSearchCache.keys().next().value ?? "");
    placeSearchCache.set(key, { expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1_000, data });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

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

  // Deliberately button-triggered by the Web UI: the public geocoder forbids
  // client-side autocomplete. Requests are serialized to one/second and cached
  // for seven days; GEOCODING_BASE_URL keeps the provider replaceable.
  app.get("/api/v1/geo/search", { preHandler: canManage }, async (req, reply) => {
    const parsed = placeSearchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    try {
      return reply.status(200).send({ data: await searchPlaces(parsed.data.q) });
    } catch (error) {
      req.log.warn({ err: error }, "place search provider failed");
      return sendError(reply, req.requestId, {
        status: 502,
        code: "GEOCODER_UNAVAILABLE",
        message: "Location search is temporarily unavailable",
      });
    }
  });

  // A field employee may read only the active fences that apply to their own
  // assigned site/location chain. This avoids granting org-wide geo.read just
  // so the attendance screen can explain its decision before a punch.
  app.get("/api/v1/geo-fences/effective", { preHandler: authenticate }, async (req, reply) => {
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const res = await opts.pool.query(
      `WITH RECURSIVE current_employee AS (
         SELECT e.id, e.site_id, e.village_id, e.mandal_id, e.district_id
           FROM users u
           JOIN employees e ON e.id = u.employee_id AND e.org_id = u.org_id
          WHERE u.id = $2::uuid AND u.org_id = $1 AND e.status = 'ACTIVE'
       ), starting_units AS (
         SELECT unnest(array_remove(ARRAY[e.site_id,e.village_id,e.mandal_id,e.district_id]::uuid[],NULL)) AS id
           FROM current_employee e
       ), assigned_units AS (
         SELECT ou.id, ou.type, ou.parent_id
           FROM org_units ou
           JOIN starting_units start ON start.id = ou.id
          WHERE ou.org_id = $1 AND ou.status = 'ACTIVE'
         UNION
         SELECT parent.id, parent.type, parent.parent_id
           FROM org_units parent
           JOIN assigned_units child ON child.parent_id = parent.id
          WHERE parent.org_id = $1 AND parent.status = 'ACTIVE'
       )
       SELECT ${SELECT_COLS}
         FROM geo_fences
        WHERE org_id = $1 AND status = 'ACTIVE'
          AND (
            EXISTS (
              SELECT 1
                FROM geo_fence_employee_assignments direct
                JOIN current_employee employee ON employee.id = direct.employee_id
               WHERE direct.org_id = $1
                 AND direct.geo_fence_id = geo_fences.id
                 AND direct.status = 'ACTIVE'
            )
            OR EXISTS (
              SELECT 1 FROM assigned_units unit
               WHERE unit.id = geo_fences.scope_id AND unit.type = geo_fences.scope_type
            )
          )
        ORDER BY CASE WHEN EXISTS (
          SELECT 1 FROM geo_fence_employee_assignments direct
           JOIN current_employee employee ON employee.id = direct.employee_id
          WHERE direct.org_id = $1 AND direct.geo_fence_id = geo_fences.id
            AND direct.status = 'ACTIVE'
        ) THEN 0 ELSE CASE scope_type
          WHEN 'site' THEN 1 WHEN 'village' THEN 2 WHEN 'mandal' THEN 3 ELSE 4 END
        END,
          created_at DESC, id DESC
        LIMIT 100`,
      [user.orgId, user.id],
    );
    return reply.status(200).send({
      data: (res.rows as GeoFenceRow[]).map(toShape),
      next_cursor: null,
      has_more: false,
    });
  });

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
    const employeeIds = [...new Set(d.employee_ids ?? [])];
    if (employeeIds.length > 0) {
      const employees = await db.query(
        `SELECT id FROM employees
          WHERE org_id = $1 AND status = 'ACTIVE' AND id = ANY($2::uuid[])`,
        [user.orgId, employeeIds],
      );
      const found = new Set((employees.rows as Array<{ id: string }>).map((employee) => employee.id));
      if (employeeIds.some((id) => !found.has(id))) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: [{
            field: "employee_ids",
            message: "Every assigned employee must be active and belong to this organization",
          }],
        });
      }
    }
    const ins = await db.query(
      `INSERT INTO geo_fences
         (org_id, name, scope_type, scope_id, geometry_type, geometry,
          tolerance_meters, accuracy_threshold_meters, created_by, updated_by)
       VALUES ($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9::uuid,$9::uuid)
       RETURNING ${CORE_SELECT_COLS}`,
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
    const inserted = ins.rows[0] as GeoFenceRow;
    if (employeeIds.length > 0) {
      await db.query(
        `UPDATE geo_fence_employee_assignments
            SET status = 'INACTIVE', updated_at = NOW(), updated_by = $3::uuid,
                version = version + 1
          WHERE org_id = $1 AND employee_id = ANY($2::uuid[]) AND status = 'ACTIVE'`,
        [user.orgId, employeeIds, user.id],
      );
      for (const employeeId of employeeIds) {
        await db.query(
          `INSERT INTO geo_fence_employee_assignments
             (org_id, geo_fence_id, employee_id, created_by, updated_by)
           VALUES ($1,$2::uuid,$3::uuid,$4::uuid,$4::uuid)
           ON CONFLICT (org_id, geo_fence_id, employee_id) DO UPDATE SET
             status = 'ACTIVE', updated_at = NOW(), updated_by = EXCLUDED.updated_by,
             version = geo_fence_employee_assignments.version + 1`,
          [user.orgId, inserted.id, employeeId, user.id],
        );
      }
    }
    const created = await db.query(
      `SELECT ${SELECT_COLS} FROM geo_fences WHERE id = $1::uuid AND org_id = $2`,
      [inserted.id, user.orgId],
    );
    const row = created.rows[0] as GeoFenceRow;
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
         RETURNING ${CORE_SELECT_COLS}`,
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
      const updated = upd.rows[0] as GeoFenceRow | undefined;
      if (!updated) {
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
      const refreshed = await db.query(
        `SELECT ${SELECT_COLS} FROM geo_fences WHERE id = $1::uuid AND org_id = $2`,
        [id, user.orgId],
      );
      const row = refreshed.rows[0] as GeoFenceRow;
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
