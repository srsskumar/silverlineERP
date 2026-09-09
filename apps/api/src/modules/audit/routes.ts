import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  cursorPageQuerySchema,
  decodeCursor,
  encodeCursor,
  toFieldErrors,
} from "@silverline/shared";
import { buildAuthenticate, requirePermission } from "../../common/auth.js";
import { sendError } from "../../common/httpErrors.js";

export interface AuditRoutesOptions {
  pool: Pool;
  jwtSecret: string;
}

const auditQuerySchema = cursorPageQuerySchema.extend({
  action: z.string().min(1).max(100).optional(),
  /** Filters on entity_type. */
  entity: z.string().min(1).max(100).optional(),
});

interface AuditCursor {
  created_at: string;
  id: string;
}

export async function registerAuditRoutes(
  app: FastifyInstance,
  opts: AuditRoutesOptions,
): Promise<void> {
  const authenticate = buildAuthenticate({
    pool: opts.pool,
    jwtSecret: opts.jwtSecret,
  });
  const canReadAudit = requirePermission(authenticate, "audit.read");

  app.get(
    "/api/v1/audit",
    { preHandler: canReadAudit },
    async (req, reply) => {
      const parsed = auditQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return sendError(reply, req.requestId, {
          status: 422,
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fieldErrors: toFieldErrors(parsed.error),
        });
      }
      const { limit, cursor, action, entity } = parsed.data;
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
      if (action) {
        values.push(action);
        clauses.push(`action = $${values.length}`);
      }
      if (entity) {
        values.push(entity);
        clauses.push(`entity_type = $${values.length}`);
      }
      if (cursor) {
        const decoded = decodeCursor<AuditCursor>(cursor);
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

      const rows = await opts.pool.query(
        `SELECT id, org_id, actor_id, actor_ip, action, entity_type, entity_id,
                before_state, after_state, reason, request_id, created_at
         FROM audit_events
         WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC, id DESC
         LIMIT $${values.length}`,
        values as string[],
      );

      const hasMore = rows.rows.length > limit;
      const page = rows.rows.slice(0, limit) as Array<{
        id: string;
        created_at: Date;
        [key: string]: unknown;
      }>;
      const last = page[page.length - 1];
      return reply.status(200).send({
        data: page.map((r) => ({
          ...r,
          created_at:
            r.created_at instanceof Date
              ? r.created_at.toISOString()
              : r.created_at,
        })),
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
    },
  );
}
