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
      const clauses = ["a.org_id = $1"];
      if (action) {
        values.push(action);
        clauses.push(`a.action = $${values.length}`);
      }
      if (entity) {
        values.push(entity);
        clauses.push(`a.entity_type = $${values.length}`);
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
          `(a.created_at, a.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
        );
      }
      values.push(limit + 1);

      const rows = await opts.pool.query(
        /*
         * impersonator_id rides along (§075).
         *
         * It has been written on every mutation since view-as shipped and
         * read by nothing, which made the accountability half of that
         * feature ornamental: the trail said a team lead did it, and the
         * fact that an administrator was holding their session at the time
         * lived only in a column nobody selected.
         *
         * The name is resolved here rather than left to the client, because
         * an impersonator is often somebody the people list does not carry
         * (an administrator need not be an employee).
         */
        `SELECT a.id, a.org_id, a.actor_id, a.actor_ip, a.action, a.entity_type,
                a.entity_id, a.before_state, a.after_state, a.reason,
                a.request_id, a.created_at,
                a.impersonator_id, i.username AS impersonator_username
         FROM audit_events a
         LEFT JOIN users i ON i.id = a.impersonator_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY a.created_at DESC, a.id DESC
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

  /* =============================================================== §075
   * The view-as register.
   *
   * Starting a session writes a row with a reason and an expiry; until now
   * the only way to read one was psql, which makes it evidence nobody can
   * reach. It belongs on the audit screen rather than the administration
   * one: the question it answers -- "who has been looking through whose
   * eyes, and why" -- is an auditor's question, and audit.read is the
   * permission auditors hold.
   *
   * The write count is the part that matters. A session that looked and
   * left is ordinary; a session that changed thirty things is a thing to
   * ask about, and the number is the only way to tell them apart at a
   * glance.
   */
  app.get(
    "/api/v1/audit/view-as",
    { preHandler: canReadAudit },
    async (req, reply) => {
      const user = req.authUser;
      if (!user) {
        return sendError(reply, req.requestId, {
          status: 401, code: "UNAUTHENTICATED", message: "Authentication required",
        });
      }
      const limit = Math.min(
        Math.max(Number((req.query as { limit?: string } | undefined)?.limit ?? 50) || 50, 1),
        200,
      );
      const rows = await opts.pool.query(
        `SELECT s.id, s.reason, s.started_at, s.ended_at, s.expires_at,
                s.actor_ip, s.request_id,
                s.actor_id,   a.username AS actor_username,
                s.subject_id, b.username AS subject_username,
                (s.ended_at IS NULL AND s.expires_at > now()) AS live,
                (SELECT count(*)::int FROM audit_events e
                  WHERE e.impersonator_id = s.actor_id
                    AND e.created_at >= s.started_at
                    AND e.created_at <= COALESCE(s.ended_at, s.expires_at)) AS writes
           FROM impersonation_sessions s
           JOIN users a ON a.id = s.actor_id
           JOIN users b ON b.id = s.subject_id
          WHERE s.org_id = $1
          ORDER BY s.started_at DESC
          LIMIT $2`,
        [user.orgId, limit],
      );
      return reply.status(200).send({
        data: rows.rows.map((r) => ({
          ...r,
          started_at: (r.started_at as Date)?.toISOString?.() ?? r.started_at,
          ended_at: (r.ended_at as Date | null)?.toISOString?.() ?? r.ended_at,
          expires_at: (r.expires_at as Date)?.toISOString?.() ?? r.expires_at,
        })),
      });
    },
  );
}
