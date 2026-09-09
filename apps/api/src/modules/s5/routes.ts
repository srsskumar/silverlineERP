import {mutationRoute} from "../../common/mutationRoute.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  ApiError,
  S4_PERMISSIONS,
  S5_PERMISSIONS,
  boardColumnsReplaceSchema,
  boardCreateSchema,
  boardPatchSchema,
  cursorPageQuerySchema,
  decodeCursor,
  defaultTaskWorkflow,
  encodeCursor,
  labelCreateSchema,
  savedFilterCreateSchema,
  savedFilterPatchSchema,
  taskLabelAttachSchema,
  toFieldErrors,
  type BoardColumnInput,
} from "@silverline/shared";
import { buildAuthenticate, requirePermission } from "../../common/auth.js";
import { writeAudit } from "../../common/audit.js";
import { sendError } from "../../common/httpErrors.js";
import {
  idempotencyKeyOf,
  replayIfSeen,
  storeIdempotentResponse,
} from "../../common/idempotency.js";
import { redactPiiForAudit } from "../../common/crypto.js";

export interface S5RoutesOptions {
  pool: Pool;
  jwtSecret: string;
}

const BOARD_READ = S5_PERMISSIONS.BOARD_READ;
const BOARD_MANAGE = S5_PERMISSIONS.BOARD_MANAGE;
const FILTER_READ = S5_PERMISSIONS.FILTER_READ;
const FILTER_MANAGE = S5_PERMISSIONS.FILTER_MANAGE;
const LABEL_READ = S5_PERMISSIONS.LABEL_READ;
const LABEL_MANAGE = S5_PERMISSIONS.LABEL_MANAGE;
const NOTIF_READ = S5_PERMISSIONS.NOTIFICATION_READ;
const TASK_UPDATE = S4_PERMISSIONS.TASK_UPDATE;

// ---------------------------------------------------------------------------
// Small helpers (mirroring the work module)
// ---------------------------------------------------------------------------

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
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

/** Error envelope plus a machine-readable rule detail (top-level extras). */
function sendRuleError(
  reply: FastifyReply,
  requestId: string,
  args: {
    status: number;
    code: string;
    message: string;
    fieldErrors?: Array<{ field: string; message: string }>;
    extra?: Record<string, unknown>;
  },
): FastifyReply {
  return reply.status(args.status).send({
    code: args.code,
    message: args.message,
    field_errors: args.fieldErrors ?? [],
    request_id: requestId,
    retryable: false,
    ...(args.extra ?? {}),
  });
}

function isTrueFlag(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

// ---------------------------------------------------------------------------
// Row types + shapes (snake_case, mirroring S4 conventions)
// ---------------------------------------------------------------------------

interface BoardRow {
  id: string;
  org_id: string;
  project_id: string;
  name: string;
  view_type: string;
  filter_config: unknown;
  shared: boolean;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

const BOARD_COLS = `id, org_id, project_id, name, view_type, filter_config,
  shared, version, created_at, updated_at`;

function toBoardShape(row: BoardRow) {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    view_type: row.view_type,
    filter_config: (row.filter_config ?? {}) as Record<string, unknown>,
    shared: row.shared,
    version: row.version,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function toBoardListItem(row: BoardRow) {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    view_type: row.view_type,
    shared: row.shared,
    version: row.version,
  };
}

interface BoardColumnRow {
  id: string;
  board_id: string;
  status_code: string;
  name: string;
  position: number;
  wip_limit: number | null;
  color: string | null;
}

const BOARD_COLUMN_COLS = `id, board_id, status_code, name, position,
  wip_limit, color`;

function toColumnShape(row: BoardColumnRow) {
  return {
    id: row.id,
    status_code: row.status_code,
    name: row.name,
    position: Number(row.position),
    wip_limit: row.wip_limit === null ? null : Number(row.wip_limit),
    color: row.color,
  };
}

interface SavedFilterRow {
  id: string;
  org_id: string;
  owner_id: string;
  project_id: string | null;
  name: string;
  query_definition: unknown;
  shared: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

const FILTER_COLS = `id, org_id, owner_id, project_id, name,
  query_definition, shared, created_at, updated_at`;

function toFilterShape(row: SavedFilterRow) {
  return {
    id: row.id,
    project_id: row.project_id,
    owner_id: row.owner_id,
    name: row.name,
    query_definition: (row.query_definition ?? {}) as Record<string, unknown>,
    shared: row.shared,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

interface LabelRow {
  id: string;
  org_id: string;
  project_id: string | null;
  name: string;
  color: string | null;
}

const LABEL_COLS = `id, org_id, project_id, name, color`;

function toLabelShape(row: LabelRow) {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    color: row.color,
  };
}

interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string;
  entity_type: string | null;
  entity_id: string | null;
  read_at: Date | string | null;
  created_at: Date | string;
}

const NOTIF_COLS = `id, type, title, body, entity_type, entity_id,
  read_at, created_at`;

function toNotificationShape(row: NotificationRow) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    read_at: row.read_at ? iso(row.read_at) : null,
    created_at: iso(row.created_at),
  };
}

interface NotificationCursor {
  created_at: string;
  id: string;
}

const boardsListQuerySchema = z.object({
  project_id: z.string().uuid().optional(),
});

const filtersListQuerySchema = z.object({
  project_id: z.string().uuid().optional(),
});

const labelsListQuerySchema = z.object({
  project_id: z.string().uuid().optional(),
});

const notificationsListQuerySchema = cursorPageQuerySchema.extend({
  unread: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function registerS5Routes(
  app: FastifyInstance,
  opts: S5RoutesOptions,
): Promise<void> {
  const authenticate = buildAuthenticate({
    pool: opts.pool,
    jwtSecret: opts.jwtSecret,
  });
  const canReadBoard = requirePermission(authenticate, BOARD_READ);
  const canManageBoard = requirePermission(authenticate, BOARD_MANAGE);
  const canManageFilter = requirePermission(authenticate, FILTER_MANAGE);
  const canReadLabel = requirePermission(authenticate, LABEL_READ);
  const canManageLabel = requirePermission(authenticate, LABEL_MANAGE);
  const canAttachLabel = requirePermission(authenticate, TASK_UPDATE);
  const canReadNotif = requirePermission(authenticate, NOTIF_READ);

  /** GET /saved-filters: filter.read OR filter.manage (manage implies read). */
  async function canReadOrManageFilter(req: Parameters<typeof authenticate>[0]) {
    await authenticate(req);
    const perms = req.authUser?.permissions ?? [];
    if (!perms.includes(FILTER_READ) && !perms.includes(FILTER_MANAGE)) {
      throw new ApiError({
        status: 403,
        code: "FORBIDDEN",
        message: "Insufficient permissions",
      });
    }
  }

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

  async function findBoard(
    orgId: string,
    id: string,
  ): Promise<BoardRow | undefined> {
    const res = await opts.pool.query(
      `SELECT ${BOARD_COLS} FROM boards WHERE id = $1::uuid AND org_id = $2`,
      [id, orgId],
    );
    return res.rows[0] as BoardRow | undefined;
  }

  async function columnsFor(boardId: string): Promise<BoardColumnRow[]> {
    const res = await opts.pool.query(
      `SELECT ${BOARD_COLUMN_COLS} FROM board_columns
       WHERE board_id = $1::uuid ORDER BY position ASC, id ASC`,
      [boardId],
    );
    return res.rows as BoardColumnRow[];
  }

  /** Workflow statuses for a project: its type's seeded workflow, else default. */
  async function workflowStatusesForProject(
    projectId: string,
    projectTypeId: string | null,
  ): Promise<string[]> {
    const override=await opts.pool.query('SELECT statuses FROM project_workflow_overrides WHERE project_id=$1',[projectId]);
    if(override.rowCount)return override.rows[0].statuses;
    if (projectTypeId) {
      const res = await opts.pool.query(
        `SELECT statuses FROM project_workflows WHERE project_type_id = $1::uuid`,
        [projectTypeId],
      );
      const row = res.rows[0] as { statuses: unknown } | undefined;
      if (row && Array.isArray(row.statuses) && row.statuses.length > 0) {
        return row.statuses as string[];
      }
    }
    void projectId;
    return [...defaultTaskWorkflow().statuses];
  }

  /** Resolves + validates column inputs against the project workflow. */
  function resolveColumns(
    inputs: BoardColumnInput[] | undefined,
    viewType: string,
    workflowStatuses: string[],
    reply: FastifyReply,
    requestId: string,
  ): Array<{
    status_code: string;
    name: string;
    position: number;
    wip_limit: number | null;
    color: string | null;
  }> | null {
    const list: BoardColumnInput[] =
      inputs ??
      (viewType === "KANBAN"
        ? workflowStatuses.map((s) => ({ status_code: s }))
        : []);
    const unknown = [
      ...new Set(list.map((c) => c.status_code)),
    ].filter((s) => !workflowStatuses.includes(s));
    if (unknown.length > 0) {
      sendRuleError(reply, requestId, {
        status: 422,
        code: "UNKNOWN_STATUS",
        message: `Unknown status code(s) for this project: ${unknown.join(", ")}`,
        fieldErrors: unknown.map((s) => ({
          field: "columns",
          message: `Unknown status code: ${s}`,
        })),
        extra: { unknown_statuses: unknown },
      });
      return null;
    }
    return list.map((c, idx) => ({
      status_code: c.status_code,
      name: c.name ?? c.status_code,
      position: c.position ?? idx,
      wip_limit: c.wip_limit ?? null,
      color: c.color ?? null,
    }));
  }

  // ------------------------------------------------ POST /boards
  app.post("/api/v1/boards", { preHandler: canManageBoard }, async (req, reply) => {
    if (await replayIfSeen(opts.pool, req, reply)) {
      return;
    }
    const parsed = boardCreateSchema.safeParse(req.body);
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
    const projRes = await opts.pool.query(
      "SELECT id, project_type_id FROM projects WHERE id = $1::uuid AND org_id = $2",
      [d.project_id, user.orgId],
    );
    const project = projRes.rows[0] as
      | { id: string; project_type_id: string | null }
      | undefined;
    if (!project) {
      return sendError(reply, req.requestId, {
        status: 404,
        code: "NOT_FOUND",
        message: "Project not found",
      });
    }
    const statuses = await workflowStatusesForProject(
      project.id,
      project.project_type_id,
    );
    const columns = resolveColumns(
      d.column_config,
      d.view_type,
      statuses,
      reply,
      req.requestId,
    );
    if (!columns) {
      return;
    }
    const client = await opts.pool.connect();
    let board: BoardRow;
    try {
      await client.query("BEGIN");
      const ins = await client.query(
        `INSERT INTO boards
           (org_id, project_id, name, view_type, filter_config, created_by, updated_by)
         VALUES ($1, $2::uuid, $3, $4, $5, $6::uuid, $6::uuid)
         RETURNING ${BOARD_COLS}`,
        [
          user.orgId,
          project.id,
          d.name,
          d.view_type,
          JSON.stringify(d.filter_config ?? {}),
          user.id,
        ],
      );
      board = ins.rows[0] as BoardRow;
      for (const c of columns) {
        await client.query(
          `INSERT INTO board_columns
             (board_id, status_code, name, position, wip_limit, color)
           VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
          [board.id, c.status_code, c.name, c.position, c.wip_limit, c.color],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore rollback failure
      }
      client.release();
      throw err;
    }
    client.release();
    const body = toBoardShape(board);
    const meta = metaOf(req);
    await writeAudit(opts.pool, {
      orgId: user.orgId,
      actorId: user.id,
      actorIp: meta.ip,
      actorUserAgent: meta.userAgent,
      action: "board.create",
      entityType: "board",
      entityId: board.id,
      afterState: redactPiiForAudit(body),
      requestId: req.requestId,
      idempotencyKey: idempotencyKeyOf(req),
    });
    await storeIdempotentResponse(opts.pool, req, user.id, 201, body);
    return reply.status(201).send(body);
  });

  // ------------------------------------------------ GET /boards
  app.get("/api/v1/boards", { preHandler: canReadBoard }, async (req, reply) => {
    const parsed = boardsListQuerySchema.safeParse(req.query);
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
    const values: unknown[] = [user.orgId];
    const clauses = ["org_id = $1"];
    if (parsed.data.project_id) {
      values.push(parsed.data.project_id);
      clauses.push(`project_id = $${values.length}::uuid`);
    }
    const res = await opts.pool.query(
      `SELECT ${BOARD_COLS} FROM boards WHERE ${clauses.join(" AND ")}
       ORDER BY created_at ASC, id ASC`,
      values as string[],
    );
    return reply
      .status(200)
      .send({ data: (res.rows as BoardRow[]).map(toBoardListItem) });
  });

  // ------------------------------------------------ GET /boards/:id
  app.get("/api/v1/boards/:id", { preHandler: canReadBoard }, async (req, reply) => {
    const user = req.authUser;
    if (!user) {
      return sendError(reply, req.requestId, {
        status: 401,
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    const { id } = req.params as { id: string };
    const board = await findBoard(user.orgId, id);
    if (!board) {
      return sendError(reply, req.requestId, {
        status: 404,
        code: "NOT_FOUND",
        message: "Board not found",
      });
    }
    const columns = await columnsFor(board.id);
    return reply.status(200).send({
      board: toBoardShape(board),
      columns: columns.map(toColumnShape),
    });
  });

  // ------------------------------------------------ PATCH /boards/:id
  app.patch("/api/v1/boards/:id", { preHandler: canManageBoard }, async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
    const parsed = boardPatchSchema.safeParse(req.body);
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
    const cur = await findBoard(user.orgId, id);
    if (!cur) {
      return sendError(reply, req.requestId, {
        status: 404,
        code: "NOT_FOUND",
        message: "Board not found",
      });
    }
    if (cur.version !== expectedVersion) {
      return sendError(reply, req.requestId, {
        status: 409,
        code: "VERSION_CONFLICT",
        message: `Version mismatch (current version: ${cur.version})`,
      });
    }
    const d = parsed.data;
    const upd = await db.query(
      `UPDATE boards SET
         name = COALESCE($3, name),
         filter_config = COALESCE($4, filter_config),
         shared = COALESCE($5, shared),
         updated_by = $6::uuid, updated_at = NOW(), version = version + 1
       WHERE id = $1::uuid AND org_id = $2 AND version = $7
       RETURNING ${BOARD_COLS}`,
      [
        id,
        user.orgId,
        d.name ?? null,
        d.filter_config !== undefined ? JSON.stringify(d.filter_config) : null,
        d.shared ?? null,
        user.id,
        expectedVersion,
      ],
    );
    const row = upd.rows[0] as BoardRow | undefined;
    if (!row) {
      const latest = await findBoard(user.orgId, id);
      return sendError(reply, req.requestId, {
        status: 409,
        code: "VERSION_CONFLICT",
        message: `Version mismatch (current version: ${latest?.version ?? "unknown"})`,
      });
    }
    const body = toBoardShape(row);
    const meta = metaOf(req);
    await writeAudit(db, {
      orgId: user.orgId,
      actorId: user.id,
      actorIp: meta.ip,
      actorUserAgent: meta.userAgent,
      action: "board.update",
      entityType: "board",
      entityId: row.id,
      beforeState: redactPiiForAudit(toBoardShape(cur)),
      afterState: redactPiiForAudit(body),
      requestId: req.requestId,
    });
    return reply.status(200).send(body);
  
});});

  // ------------------------------------------------ PUT /boards/:id/columns
  app.put(
    "/api/v1/boards/:id/columns",
    { preHandler: canManageBoard },
    async (req, reply) => {
      const parsed = boardColumnsReplaceSchema.safeParse(req.body);
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
      const cur = await findBoard(user.orgId, id);
      if (!cur) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Board not found",
        });
      }
      if (cur.version !== expectedVersion) {
        return sendError(reply, req.requestId, {
          status: 409,
          code: "VERSION_CONFLICT",
          message: `Version mismatch (current version: ${cur.version})`,
        });
      }
      const projRes = await opts.pool.query(
        "SELECT id, project_type_id FROM projects WHERE id = $1::uuid AND org_id = $2",
        [cur.project_id, user.orgId],
      );
      const project = projRes.rows[0] as
        | { id: string; project_type_id: string | null }
        | undefined;
      if (!project) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }
      const statuses = await workflowStatusesForProject(
        project.id,
        project.project_type_id,
      );
      const columns = resolveColumns(
        parsed.data.columns,
        cur.view_type,
        statuses,
        reply,
        req.requestId,
      );
      if (!columns) {
        return;
      }
      const client = await opts.pool.connect();
      let board: BoardRow | undefined;
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM board_columns WHERE board_id = $1::uuid", [
          cur.id,
        ]);
        for (const c of columns) {
          await client.query(
            `INSERT INTO board_columns
               (board_id, status_code, name, position, wip_limit, color)
             VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
            [cur.id, c.status_code, c.name, c.position, c.wip_limit, c.color],
          );
        }
        const upd = await client.query(
          `UPDATE boards SET updated_by = $3::uuid, updated_at = NOW(),
             version = version + 1
           WHERE id = $1::uuid AND org_id = $2 AND version = $4
           RETURNING ${BOARD_COLS}`,
          [cur.id, user.orgId, user.id, expectedVersion],
        );
        board = upd.rows[0] as BoardRow | undefined;
        if (!board) {
          await client.query("ROLLBACK");
        } else {
          await client.query("COMMIT");
        }
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // ignore rollback failure
        }
        client.release();
        throw err;
      }
      client.release();
      if (!board) {
        const latest = await findBoard(user.orgId, id);
        return sendError(reply, req.requestId, {
          status: 409,
          code: "VERSION_CONFLICT",
          message: `Version mismatch (current version: ${latest?.version ?? "unknown"})`,
        });
      }
      const freshColumns = await columnsFor(board.id);
      const meta = metaOf(req);
      await writeAudit(opts.pool, {
        orgId: user.orgId,
        actorId: user.id,
        actorIp: meta.ip,
        actorUserAgent: meta.userAgent,
        action: "board.columns.update",
        entityType: "board",
        entityId: board.id,
        afterState: redactPiiForAudit(freshColumns.map(toColumnShape)),
        requestId: req.requestId,
      });
      return reply.status(200).send({
        board: toBoardShape(board),
        columns: freshColumns.map(toColumnShape),
      });
    },
  );

  // ------------------------------------------------ DELETE /boards/:id
  app.delete(
    "/api/v1/boards/:id",
    { preHandler: canManageBoard },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const { id } = req.params as { id: string };
      const cur = await findBoard(user.orgId, id);
      if (!cur) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Board not found",
        });
      }
      // Config delete only: board_columns cascade; tasks are never touched.
      await db.query(
        "DELETE FROM boards WHERE id = $1::uuid AND org_id = $2",
        [id, user.orgId],
      );
      const meta = metaOf(req);
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id,
        actorIp: meta.ip,
        actorUserAgent: meta.userAgent,
        action: "board.delete",
        entityType: "board",
        entityId: id,
        beforeState: redactPiiForAudit(toBoardShape(cur)),
        requestId: req.requestId,
      });
      return reply.status(204).send();
    
});},
  );

  // ------------------------------------------------ POST /saved-filters
  app.post(
    "/api/v1/saved-filters",
    { preHandler: canManageFilter },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const parsed = savedFilterCreateSchema.safeParse(req.body);
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
      if (d.project_id) {
        const proj = await db.query(
          "SELECT id FROM projects WHERE id = $1::uuid AND org_id = $2",
          [d.project_id, user.orgId],
        );
        if ((proj.rowCount ?? 0) === 0) {
          return sendError(reply, req.requestId, {
            status: 404,
            code: "NOT_FOUND",
            message: "Project not found",
          });
        }
      }
      const ins = await db.query(
        `INSERT INTO saved_filters
           (org_id, owner_id, project_id, name, query_definition, shared)
         VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6)
         RETURNING ${FILTER_COLS}`,
        [
          user.orgId,
          user.id,
          d.project_id ?? null,
          d.name,
          JSON.stringify(d.query_definition),
          d.shared,
        ],
      );
      const body = toFilterShape(ins.rows[0] as SavedFilterRow);
      const meta = metaOf(req);
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id,
        actorIp: meta.ip,
        actorUserAgent: meta.userAgent,
        action: "filter.create",
        entityType: "saved_filter",
        entityId: body.id,
        afterState: redactPiiForAudit(body),
        requestId: req.requestId,
      });
      return reply.status(201).send(body);
    
});},
  );

  // ------------------------------------------------ GET /saved-filters
  app.get(
    "/api/v1/saved-filters",
    { preHandler: canReadOrManageFilter },
    async (req, reply) => {
      const parsed = filtersListQuerySchema.safeParse(req.query);
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
      // Own filters union shared ones; an optional project scope keeps
      // global (project-less) filters visible inside that project.
      const values: unknown[] = [user.orgId, user.id];
      const clauses = ["org_id = $1", "(owner_id = $2::uuid OR shared = true)"];
      if (parsed.data.project_id) {
        values.push(parsed.data.project_id);
        clauses.push(`(project_id IS NULL OR project_id = $${values.length}::uuid)`);
      }
      const res = await opts.pool.query(
        `SELECT ${FILTER_COLS} FROM saved_filters WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC, id DESC`,
        values as string[],
      );
      return reply
        .status(200)
        .send({ data: (res.rows as SavedFilterRow[]).map(toFilterShape) });
    },
  );

  function isAdminOverride(roles: string[]): boolean {
    return roles.includes("SUPER_ADMIN") || roles.includes("ADMIN");
  }

  async function findFilter(
    orgId: string,
    id: string,
  ): Promise<SavedFilterRow | undefined> {
    const res = await opts.pool.query(
      `SELECT ${FILTER_COLS} FROM saved_filters WHERE id = $1::uuid AND org_id = $2`,
      [id, orgId],
    );
    return res.rows[0] as SavedFilterRow | undefined;
  }

  // ------------------------------------------------ PATCH /saved-filters/:id
  app.patch(
    "/api/v1/saved-filters/:id",
    { preHandler: authenticate },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const parsed = savedFilterPatchSchema.safeParse(req.body);
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
      const cur = await findFilter(user.orgId, id);
      // Owner-only (+ SUPER_ADMIN/ADMIN override). 404 either way so private
      // filters never leak their existence to strangers.
      if (!cur || (cur.owner_id !== user.id && !isAdminOverride(user.roles))) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Saved filter not found",
        });
      }
      const d = parsed.data;
      const upd = await db.query(
        `UPDATE saved_filters SET
           name = COALESCE($3, name),
           query_definition = COALESCE($4, query_definition),
           updated_at = NOW()
         WHERE id = $1::uuid AND org_id = $2
         RETURNING ${FILTER_COLS}`,
        [
          id,
          user.orgId,
          d.name ?? null,
          d.query_definition !== undefined
            ? JSON.stringify(d.query_definition)
            : null,
        ],
      );
      const body = toFilterShape(upd.rows[0] as SavedFilterRow);
      const meta = metaOf(req);
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id,
        actorIp: meta.ip,
        actorUserAgent: meta.userAgent,
        action: "filter.update",
        entityType: "saved_filter",
        entityId: body.id,
        beforeState: redactPiiForAudit(toFilterShape(cur)),
        afterState: redactPiiForAudit(body),
        requestId: req.requestId,
      });
      return reply.status(200).send(body);
    
});},
  );

  // ------------------------------------------------ DELETE /saved-filters/:id
  app.delete(
    "/api/v1/saved-filters/:id",
    { preHandler: authenticate },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const { id } = req.params as { id: string };
      const cur = await findFilter(user.orgId, id);
      if (!cur || (cur.owner_id !== user.id && !isAdminOverride(user.roles))) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Saved filter not found",
        });
      }
      await db.query(
        "DELETE FROM saved_filters WHERE id = $1::uuid AND org_id = $2",
        [id, user.orgId],
      );
      const meta = metaOf(req);
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id,
        actorIp: meta.ip,
        actorUserAgent: meta.userAgent,
        action: "filter.delete",
        entityType: "saved_filter",
        entityId: id,
        beforeState: redactPiiForAudit(toFilterShape(cur)),
        requestId: req.requestId,
      });
      return reply.status(204).send();
    
});},
  );

  // ------------------------------------------------ POST /labels
  app.post("/api/v1/labels", { preHandler: canManageLabel }, async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
    const parsed = labelCreateSchema.safeParse(req.body);
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
    if (d.project_id) {
      const proj = await db.query(
        "SELECT id FROM projects WHERE id = $1::uuid AND org_id = $2",
        [d.project_id, user.orgId],
      );
      if ((proj.rowCount ?? 0) === 0) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }
    }
    let row: LabelRow;
    try {
      const ins = await db.query(
        `INSERT INTO labels (org_id, project_id, name, color, created_by)
         VALUES ($1, $2::uuid, $3, $4, $5::uuid)
         RETURNING ${LABEL_COLS}`,
        [user.orgId, d.project_id ?? null, d.name, d.color ?? null, user.id],
      );
      row = ins.rows[0] as LabelRow;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        return sendRuleError(reply, req.requestId, {
          status: 409,
          code: "LABEL_EXISTS",
          message: "A label with this name already exists in this scope",
          fieldErrors: [
            { field: "name", message: "Label name already exists in this scope" },
          ],
        });
      }
      throw err;
    }
    const body = toLabelShape(row);
    const meta = metaOf(req);
    await writeAudit(db, {
      orgId: user.orgId,
      actorId: user.id,
      actorIp: meta.ip,
      actorUserAgent: meta.userAgent,
      action: "label.create",
      entityType: "label",
      entityId: row.id,
      afterState: redactPiiForAudit(body),
      requestId: req.requestId,
    });
    return reply.status(201).send(body);
  
});});

  // ------------------------------------------------ GET /labels
  app.get("/api/v1/labels", { preHandler: canReadLabel }, async (req, reply) => {
    const parsed = labelsListQuerySchema.safeParse(req.query);
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
    // Global labels are visible everywhere; project labels only in-project.
    const values: unknown[] = [user.orgId];
    const clauses = ["org_id = $1"];
    if (parsed.data.project_id) {
      values.push(parsed.data.project_id);
      clauses.push(`(project_id IS NULL OR project_id = $${values.length}::uuid)`);
    }
    const res = await opts.pool.query(
      `SELECT ${LABEL_COLS} FROM labels WHERE ${clauses.join(" AND ")}
       ORDER BY name ASC, id ASC`,
      values as string[],
    );
    return reply
      .status(200)
      .send({ data: (res.rows as LabelRow[]).map(toLabelShape) });
  });

  // ------------------------------------------------ POST /tasks/:id/labels
  app.post(
    "/api/v1/tasks/:id/labels",
    { preHandler: canAttachLabel },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const parsed = taskLabelAttachSchema.safeParse(req.body);
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
      const taskRes = await db.query(
        "SELECT id, project_id FROM tasks WHERE id = $1::uuid AND org_id = $2",
        [id, user.orgId],
      );
      const task = taskRes.rows[0] as
        | { id: string; project_id: string }
        | undefined;
      if (!task) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Task not found",
        });
      }
      const labelRes = await db.query(
        `SELECT ${LABEL_COLS} FROM labels WHERE id = $1::uuid AND org_id = $2`,
        [parsed.data.label_id, user.orgId],
      );
      const label = labelRes.rows[0] as LabelRow | undefined;
      if (!label) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Label not found",
        });
      }
      if (label.project_id !== null && label.project_id !== task.project_id) {
        return sendRuleError(reply, req.requestId, {
          status: 422,
          code: "LABEL_SCOPE",
          message: "Label belongs to a different project",
          fieldErrors: [
            { field: "label_id", message: "Label is not visible to this task" },
          ],
        });
      }
      await db.query(
        `INSERT INTO task_labels (task_id, label_id, created_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid)
         ON CONFLICT DO NOTHING`,
        [task.id, label.id, user.id],
      );
      const meta = metaOf(req);
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id,
        actorIp: meta.ip,
        actorUserAgent: meta.userAgent,
        action: "task.label.attach",
        entityType: "task_label",
        entityId: task.id,
        afterState: { task_id: task.id, label_id: label.id },
        requestId: req.requestId,
      });
      return reply.status(201).send({ task_id: task.id, label_id: label.id });
    
});},
  );

  // ------------------------------------------------ DELETE /tasks/:id/labels/:labelId
  app.delete(
    "/api/v1/tasks/:id/labels/:labelId",
    { preHandler: canAttachLabel },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const { id, labelId } = req.params as { id: string; labelId: string };
      const taskRes = await db.query(
        "SELECT id FROM tasks WHERE id = $1::uuid AND org_id = $2",
        [id, user.orgId],
      );
      if ((taskRes.rowCount ?? 0) === 0) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Task not found",
        });
      }
      await db.query(
        "DELETE FROM task_labels WHERE task_id = $1::uuid AND label_id = $2::uuid",
        [id, labelId],
      );
      const meta = metaOf(req);
      await writeAudit(db, {
        orgId: user.orgId,
        actorId: user.id,
        actorIp: meta.ip,
        actorUserAgent: meta.userAgent,
        action: "task.label.detach",
        entityType: "task_label",
        entityId: id,
        afterState: { task_id: id, label_id: labelId },
        requestId: req.requestId,
      });
      return reply.status(204).send();
    
});},
  );

  // ------------------------------------------------ GET /notifications
  app.get(
    "/api/v1/notifications",
    { preHandler: canReadNotif },
    async (req, reply) => {
      const parsed = notificationsListQuerySchema.safeParse(req.query);
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
      const { limit, cursor, unread } = parsed.data;
      const values: unknown[] = [user.orgId, user.id];
      const clauses = ["org_id = $1", "recipient_id = $2::uuid"];
      if (isTrueFlag(unread)) {
        clauses.push("read_at IS NULL");
      }
      if (cursor) {
        const decoded = decodeCursor<NotificationCursor>(cursor);
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
        `SELECT ${NOTIF_COLS} FROM notifications WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
        values as string[],
      );
      const rows = res.rows as NotificationRow[];
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return reply.status(200).send({
        data: page.map(toNotificationShape),
        next_cursor:
          hasMore && last
            ? encodeCursor({ created_at: iso(last.created_at), id: last.id })
            : null,
        has_more: hasMore,
      });
    },
  );

  // ------------------------------------------------ PATCH /notifications/:id/read
  app.patch(
    "/api/v1/notifications/:id/read",
    { preHandler: canReadNotif },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const { id } = req.params as { id: string };
      // Own only: another recipient's row reads as NOT_FOUND (no leak).
      const upd = await db.query(
        `UPDATE notifications SET read_at = COALESCE(read_at, NOW())
         WHERE id = $1::uuid AND org_id = $2 AND recipient_id = $3::uuid
         RETURNING read_at`,
        [id, user.orgId, user.id],
      );
      const row = upd.rows[0] as { read_at: Date | string } | undefined;
      if (!row) {
        return sendError(reply, req.requestId, {
          status: 404,
          code: "NOT_FOUND",
          message: "Notification not found",
        });
      }
      return reply.status(200).send({ id, read_at: iso(row.read_at) });
    
});},
  );

  // ------------------------------------------------ POST /notifications/read-all
  app.post(
    "/api/v1/notifications/read-all",
    { preHandler: canReadNotif },
    async (req, reply) => {return mutationRoute(opts.pool,req,reply,async(db,reply)=>{
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401,
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      }
      const upd = await db.query(
        `UPDATE notifications SET read_at = NOW()
         WHERE org_id = $1 AND recipient_id = $2::uuid AND read_at IS NULL`,
        [user.orgId, user.id],
      );
      return reply.status(200).send({ marked: upd.rowCount ?? 0 });
    
});},
  );
}
