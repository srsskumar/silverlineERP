import type { FastifyInstance } from "fastify";
import { likeContains } from "../../common/like.js";
import type { Pool, PoolClient } from "pg";
import {
  ApiError,
  GST_STATE_CODES,
  catalogueItemSchema,
  supplyScheduleSchema,
  scheduleTotals,
  lineTotals,
  isSupplyProject,
  toFieldErrors,
} from "@silverline/shared";
import { buildAuthenticate, requirePermission } from "../../common/auth.js";
import { actor, mutate, version } from "../../common/domain.js";

/**
 * §077 -- the catalogue, and what was agreed for a project.
 *
 * A field-work project is measured and billed off a bill of quantities. A
 * goods, services or AMC project is supplied against a list agreed in
 * advance, and the only question anybody asks of it is "what is the total,
 * with GST, in words".
 *
 * The prices are computed here rather than stored. Storing a line total is
 * storing the same fact twice, and the second copy is the one that goes
 * stale the moment somebody edits a quantity.
 */

/** Name to GST state code, for the place of supply. */
const STATE_CODE_BY_NAME = new Map(
  Object.entries(GST_STATE_CODES).map(([code, name]) => [name.toLowerCase(), code]),
);

export async function registerCatalogueRoutes(
  app: FastifyInstance,
  opts: { pool: Pool; jwtSecret: string },
): Promise<void> {
  const { pool } = opts;
  const authenticate = buildAuthenticate(opts);
  const guard = (permission: string) => requirePermission(authenticate, permission);

  function parse<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: unknown } }, body: unknown): T {
    const result = schema.safeParse(body);
    if (!result.success) {
      throw new ApiError({
        status: 422, code: "VALIDATION_ERROR", message: "Validation failed",
        fieldErrors: toFieldErrors(result.error as never),
      });
    }
    return result.data as T;
  }

  /* ==================================================== the catalogue */

  app.get("/api/v1/catalogue-items", { preHandler: guard("catalogue.read") }, async (req) => {
    const u = actor(req);
    const q = (req.query ?? {}) as { kind?: string; q?: string; include_archived?: string };
    const values: unknown[] = [u.orgId];
    const clauses = ["org_id = $1"];
    if (q.include_archived !== "true") clauses.push("status = 'ACTIVE'");
    if (q.kind) { values.push(q.kind); clauses.push(`kind = $${values.length}`); }
    if (q.q) {
      values.push(likeContains(q.q));
      clauses.push(`(name ILIKE $${values.length} ESCAPE '!' OR code ILIKE $${values.length} ESCAPE '!')`);
    }
    const rows = await pool.query(
      `SELECT id, code, name, kind, uom, hsn_sac,
              standard_rate::float8 AS standard_rate, gst_rate::float8 AS gst_rate,
              notes, status, version
         FROM catalogue_items
        WHERE ${clauses.join(" AND ")}
        ORDER BY kind, name
        LIMIT 1000`,
      values,
    );
    return { data: rows.rows };
  });

  app.post("/api/v1/catalogue-items", { preHandler: guard("catalogue.manage") },
    async (req, reply) => {
      const u = actor(req);
      const input = parse(catalogueItemSchema, req.body);
      const row = await mutate(pool, req, "catalogue.item.create", "catalogue_item", async (db) => {
        const clash = await db.query(
          "SELECT 1 FROM catalogue_items WHERE org_id=$1 AND code=$2 AND status='ACTIVE'",
          [u.orgId, input.code]);
        if (clash.rowCount) {
          throw new ApiError({
            status: 409, code: "DUPLICATE_CODE",
            message: `There is already a live catalogue item with the code ${input.code}`,
          });
        }
        return (await db.query(
          `INSERT INTO catalogue_items(org_id, code, name, kind, uom, hsn_sac,
             standard_rate, gst_rate, notes, created_by, updated_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
           RETURNING id, code, name, kind, uom, hsn_sac,
                     standard_rate::float8 AS standard_rate, gst_rate::float8 AS gst_rate,
                     notes, status, version`,
          [u.orgId, input.code, input.name, input.kind, input.uom, input.hsn_sac ?? null,
           input.standard_rate, input.gst_rate, input.notes ?? null, u.id])).rows[0];
      });
      reply.code(201);
      return { data: row };
    });

  app.patch("/api/v1/catalogue-items/:id", { preHandler: guard("catalogue.manage") },
    async (req) => {
      const u = actor(req), id = (req.params as { id: string }).id;
      const body = (req.body ?? {}) as Record<string, unknown>;
      /*
       * Archiving is a status change, not a delete. A contract that quoted
       * this item still points at it, and the point of pointing at it is to
       * be able to say where the line came from.
       */
      const archiving = body.status === "ARCHIVED" || body.status === "ACTIVE";
      const input = archiving && Object.keys(body).length === 1
        ? null
        : parse(catalogueItemSchema.partial(), body);
      const row = await mutate(pool, req, "catalogue.item.update", "catalogue_item", async (db) => {
        // Locked (D-009): the whole row is written back below, so a read that
        // raced another edit wrote that edit's field back to its old value.
        const existing = await db.query(
          "SELECT * FROM catalogue_items WHERE id=$1 AND org_id=$2 FOR UPDATE", [id, u.orgId]);
        if (!existing.rowCount) {
          throw new ApiError({ status: 404, code: "NOT_FOUND", message: "No such catalogue item" });
        }
        const before = existing.rows[0] as Record<string, unknown>;
        // Optimistic concurrency when the caller holds a version; callers that
        // predate it still get the row lock, which is what keeps fields safe.
        if (req.headers["if-match"] !== undefined) version(req, before as { version: number });
        const next = { ...before, ...(input ?? {}), ...(archiving ? { status: body.status } : {}) };
        return (await db.query(
          `UPDATE catalogue_items
              SET code=$3, name=$4, kind=$5, uom=$6, hsn_sac=$7, standard_rate=$8,
                  gst_rate=$9, notes=$10, status=$11,
                  version = version + 1, updated_at = now(), updated_by = $12
            WHERE id=$1 AND org_id=$2
            RETURNING id, code, name, kind, uom, hsn_sac,
                      standard_rate::float8 AS standard_rate, gst_rate::float8 AS gst_rate,
                      notes, status, version`,
          [id, u.orgId, next.code, next.name, next.kind, next.uom, next.hsn_sac ?? null,
           next.standard_rate, next.gst_rate, next.notes ?? null, next.status, u.id])).rows[0];
      });
      return { data: row };
    });

  /* ============================================ a project's own schedule */

  async function projectOr404(db: Pool | PoolClient, orgId: string, id: string) {
    const row = await db.query(
      `SELECT p.id, p.name, p.code, pt.code AS type_code, p.client_id, c.name AS client_name,
              c.state AS client_state
         FROM projects p
         LEFT JOIN project_types pt ON pt.id = p.project_type_id
         LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.id = $1 AND p.org_id = $2`,
      [id, orgId]);
    if (!row.rowCount) {
      throw new ApiError({ status: 404, code: "NOT_FOUND", message: "No such project" });
    }
    return row.rows[0] as {
      id: string; name: string; code: string; type_code: string | null;
      client_name: string | null; client_state: string | null;
    };
  }

  /**
   * Where the tax heads come from.
   *
   * Both are needed, and a guess is a wrong tax head on a real invoice --
   * so a missing one leaves the split null and the screen says which one is
   * missing. That is more use than a confident wrong answer.
   */
  async function placeOfSupply(orgId: string, clientState: string | null) {
    const org = await pool.query(
      "SELECT settings->>'gst_state_code' AS code FROM organizations WHERE id=$1", [orgId]);
    const supplier = (org.rows[0]?.code as string | null) ?? null;
    const pos = clientState ? STATE_CODE_BY_NAME.get(clientState.trim().toLowerCase()) ?? null : null;
    const missing: string[] = [];
    if (!supplier) missing.push('your own GST state, under Administration → Organisation settings');
    if (!pos) missing.push("the client's state");
    return { supplier, pos, missing };
  }

  app.get("/api/v1/projects/:id/supply", { preHandler: guard("projects.read") }, async (req) => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const project = await projectOr404(pool, u.orgId, id);
    const rows = (await pool.query(
      `SELECT l.id, l.line_no, l.catalogue_item_id, l.description, l.hsn_sac, l.uom,
              l.quantity::float8 AS quantity, l.unit_price::float8 AS unit_price,
              l.gst_rate::float8 AS gst_rate, l.price_includes_gst, l.notes,
              ci.code AS catalogue_code,
              ci.standard_rate::float8 AS standard_rate
         FROM project_supply_lines l
         LEFT JOIN catalogue_items ci ON ci.id = l.catalogue_item_id
        WHERE l.project_id = $1 AND l.org_id = $2
        ORDER BY l.line_no`, [id, u.orgId])).rows;

    const place = await placeOfSupply(u.orgId, project.client_state);
    const totals = scheduleTotals(rows, {
      supplierStateCode: place.supplier, placeOfSupplyCode: place.pos,
    });

    return {
      data: {
        project: {
          id: project.id, code: project.code, name: project.name,
          type_code: project.type_code, client_name: project.client_name,
        },
        /*
         * A measured contract has a bill of quantities instead; saying so
         * is more use than an empty table that looks like missing data.
         */
        applies: isSupplyProject(project.type_code),
        lines: rows.map((r) => ({ ...r, totals: lineTotals(r) })),
        totals,
        /* What stops us naming the tax heads, if anything. */
        split_blocked_by: totals.treatment ? [] : place.missing,
      },
    };
  });

  app.put("/api/v1/projects/:id/supply", { preHandler: guard("projects.manage") }, async (req) => {
    const u = actor(req), id = (req.params as { id: string }).id;
    const input = parse(supplyScheduleSchema, req.body);
    return mutate(pool, req, "project.supply.set", "project", async (db) => {
      const project = await projectOr404(db, u.orgId, id);
      if (!isSupplyProject(project.type_code)) {
        throw new ApiError({
          status: 409, code: "NOT_A_SUPPLY_PROJECT",
          message: "This project is measured rather than supplied, so it is billed from its bill of quantities",
        });
      }
      for (const line of input.lines) {
        if (!line.catalogue_item_id) continue;
        const found = await db.query(
          "SELECT 1 FROM catalogue_items WHERE id=$1 AND org_id=$2",
          [line.catalogue_item_id, u.orgId]);
        if (!found.rowCount) {
          throw new ApiError({
            status: 422, code: "INVALID_ITEM", message: "No such catalogue item",
          });
        }
      }
      /*
       * Replaced wholesale. The schedule is one agreed document, and
       * reconciling an edited list line by line invents identity for rows
       * that have none -- the client agreed to the list, not to row four.
       */
      await db.query("DELETE FROM project_supply_lines WHERE project_id=$1 AND org_id=$2",
        [id, u.orgId]);
      let n = 0;
      for (const line of input.lines) {
        n += 1;
        await db.query(
          `INSERT INTO project_supply_lines(org_id, project_id, catalogue_item_id, line_no,
             description, hsn_sac, uom, quantity, unit_price, gst_rate, price_includes_gst,
             notes, created_by, updated_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
          [u.orgId, id, line.catalogue_item_id ?? null, n, line.description,
           line.hsn_sac ?? null, line.uom, line.quantity, line.unit_price, line.gst_rate,
           line.price_includes_gst, line.notes ?? null, u.id]);
      }
      const place = await placeOfSupply(u.orgId, project.client_state);
      const totals = scheduleTotals(input.lines, {
        supplierStateCode: place.supplier, placeOfSupplyCode: place.pos,
      });
      return { id, lines: input.lines.length, totals };
    });
  });
}
