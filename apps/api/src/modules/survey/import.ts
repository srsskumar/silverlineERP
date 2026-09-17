import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { buildAuthenticate, requirePermission } from '../../common/auth.js';
import { actor, parse, mutate, inOrg, fail } from '../../common/domain.js';
import { writeAudit } from '../../common/audit.js';

/**
 * Importing the villages to be surveyed (§59.3.3).
 *
 * The list arrives from the revenue department as a spreadsheet, several
 * thousand rows long, keyed on its own codes. Retyping it is not a plan, and
 * neither is adding the villages one at a time through a form.
 *
 * The import does two things at once: it builds the geography the villages
 * hang off — district, optional division, mandal — and it lists the villages
 * in the programme. Doing them separately would mean importing the same
 * spreadsheet twice into two screens and keeping them in step by hand.
 */

/**
 * A row of the village list.
 *
 * Only the village itself is required. §48 of the specification asks that a
 * list upload where columns are empty, and it is right: the file arrives from
 * the revenue department with gaps, and refusing the whole row because a
 * division was not filled in means the village never gets surveyed in the
 * system at all. What is missing is reported, not fatal.
 *
 * A village with no district or mandal is filed under a placeholder for that
 * tier so the hierarchy still resolves, and appears in the report as
 * unattributed rather than silently lost.
 */
const rowSchema = z.object({
  district_code: z.string().trim().max(64).optional().or(z.literal('')),
  district_name: z.string().trim().max(255).optional().or(z.literal('')),
  // The division tier is optional: some mandals report straight to the
  // district, and the source list leaves those columns empty.
  division_code: z.string().trim().max(64).optional().or(z.literal('')),
  division_name: z.string().trim().max(255).optional().or(z.literal('')),
  mandal_code: z.string().trim().max(64).optional().or(z.literal('')),
  mandal_name: z.string().trim().max(255).optional().or(z.literal('')),
  village_code: z.string().trim().min(1).max(64),
  village_name: z.string().trim().min(1).max(255),
  vill_code_old: z.string().trim().max(64).optional().or(z.literal('')),
  // The denominator for every extent-based percentage. Optional, because the
  // source list does not always carry it and a village with no extent is
  // still a village that has to be surveyed — it is reported as unweighted
  // rather than refused.
  total_extent_ac: z.coerce.number().finite().positive().optional(),
  dgps_base: z.coerce.number().int().min(0).optional(),
  dgps_rovers: z.coerce.number().int().min(0).optional(),
  teams: z.coerce.number().int().min(0).optional(),
});

type Row = z.infer<typeof rowSchema>;

class RowError extends Error {}

export async function registerSurveyImport(
  app: FastifyInstance, opts: { pool: Pool; jwtSecret: string },
) {
  const auth = buildAuthenticate(opts);
  const guard = (p: string) => requirePermission(auth, p);

  /**
   * Find or create one unit of the geography.
   *
   * Matched on the source code rather than the name, because the source code
   * is what the revenue department reconciles against and names are not
   * unique — two villages called Ramapuram in one district is ordinary. A
   * name change upstream should update the row, not create a second one.
   */
  async function upsertUnit(
    db: PoolClient, orgId: string, userId: string,
    type: string, sourceCode: string, name: string,
    parentId: string | null, oldCode?: string | null,
    /*
     * Units already resolved during this import.
     *
     * A work list of 1,400 villages holds a handful of districts and a few
     * dozen mandals, and without this every row looked all of them up again:
     * around ten round trips per row, which against a managed database in
     * another data centre is a fifth of a second each and three quarters of
     * an hour for the file. The geography a row needs is nearly always the
     * geography the row before it needed.
     *
     * Only ids are cached, and only within one request, so a name changed
     * upstream is still picked up on the next import.
     */
    cache?: Map<string, string>,
  ): Promise<{ id: string; created: boolean }> {
    const cacheKey = `${type}:${sourceCode}`;
    const cached = cache?.get(cacheKey);
    if (cached) return { id: cached, created: false };

    /*
     * The unit and the code clash in one query rather than two.
     *
     * The second was only ever needed to know whether `code` was already
     * taken by a different unit of the same type, which is the same table and
     * the same trip.
     */
    const probe = await db.query(
      `SELECT id, name, source_code FROM org_units
        WHERE org_id = $1 AND type = $2 AND (source_code = $3 OR code = $3)
        LIMIT 2`,
      [orgId, type, sourceCode]);
    const found = probe.rows.find(r => r.source_code === sourceCode);
    if (found) {
      if (found.name !== name) {
        await db.query('UPDATE org_units SET name = $2, updated_at = now() WHERE id = $1',
          [found.id, name]);
      }
      cache?.set(cacheKey, String(found.id));
      return { id: String(found.id), created: false };
    }

    // `code` is the organisation's own unique key and is separate from the
    // source code; keeping them equal where possible makes the two systems
    // legible side by side, and the suffix only appears on a genuine clash.
    let code = sourceCode;
    // Anything the probe found that was not this unit is holding the code.
    if (probe.rows.some(r => r.source_code !== sourceCode)) {
      code = `${sourceCode}-${Date.now().toString(36).slice(-4)}`;
    }

    const row = (await db.query(
      `INSERT INTO org_units(org_id, type, code, name, parent_id, source_code, source_code_old, created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [orgId, type, code, name, parentId, sourceCode, oldCode || null, userId])).rows[0];
    cache?.set(cacheKey, String(row.id));
    return { id: String(row.id), created: true };
  }

  /**
   * Import the work list (§59.3.3).
   *
   * Previewed by default. An import that silently creates several thousand
   * rows of geography on a typo in one column is not one anybody would run
   * twice, so `dry_run` defaults to true and the caller has to ask for the
   * write.
   */
  app.post('/api/v1/survey/projects/:id/villages/import',
    { preHandler: guard('survey.manage') }, async req => {
      const u = actor(req);
      const projectId = (req.params as { id: string }).id;
      const input = parse(z.object({
        rows: z.array(z.unknown()).min(1).max(5000),
        dry_run: z.boolean().default(true),
      }), req.body);

      return mutate(opts.pool, req, 'survey.villages.import', 'survey_village_import', async db => {
        await inOrg(db, 'survey_projects', projectId, u.orgId);
        await db.query('SAVEPOINT preview');

        const results: Array<{
          row: number; village_code?: string; status: string; message?: string;
        }> = [];
        // Geography resolved once per import rather than once per row.
        const units = new Map<string, string>();
        let created = { districts: 0, divisions: 0, mandals: 0, villages: 0 };

        for (const [index, raw] of input.rows.entries()) {
          const rowNo = index + 1;
          const parsed = rowSchema.safeParse(raw);
          if (!parsed.success) {
            results.push({
              row: rowNo, status: 'REJECTED',
              message: parsed.error.issues
                .map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
            });
            continue;
          }
          const v: Row = parsed.data;
          await db.query('SAVEPOINT import_row');
          try {
            // A missing tier gets a placeholder rather than losing the village.
            // It shows up as "Not attributed" in every report, which is a
            // visible gap somebody can fill in rather than a silent absence.
            const districtCode = v.district_code || 'UNATTRIBUTED';
            const districtName = v.district_name || 'Not attributed';
            const mandalCode = v.mandal_code || `${districtCode}-UNATTRIBUTED`;
            const mandalName = v.mandal_name || 'Not attributed';

            const district = await upsertUnit(
              db, u.orgId, u.id, 'district', districtCode, districtName, null, null, units);
            if (district.created) created.districts += 1;

            // The mandal hangs off the division where the source list gives
            // one, and off the district where it does not.
            let parentOfMandal = district.id;
            if (v.division_code && v.division_name) {
              const division = await upsertUnit(
                db, u.orgId, u.id, 'division', v.division_code, v.division_name, district.id,
                null, units);
              if (division.created) created.divisions += 1;
              parentOfMandal = division.id;
            }

            const mandal = await upsertUnit(
              db, u.orgId, u.id, 'mandal', mandalCode, mandalName, parentOfMandal, null, units);
            if (mandal.created) created.mandals += 1;

            const village = await upsertUnit(
              db, u.orgId, u.id, 'village', v.village_code, v.village_name, mandal.id,
              v.vill_code_old);
            if (village.created) created.villages += 1;

            /*
             * Listed and inserted in one statement.
             *
             * The separate "is it already there" query doubled the cost of
             * the commonest row and still raced: two imports of the same file
             * could both read "not listed" and then one would fail on the
             * constraint. Letting the constraint answer it is both faster and
             * correct — no row back means it was already in the programme.
             */
            const inserted = await db.query(
              `INSERT INTO survey_villages(org_id, survey_project_id, village_id,
                 total_extent_ac, dgps_base, dgps_rovers, teams, vill_code_old,
                 created_by, updated_by)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
               ON CONFLICT (survey_project_id, village_id) DO NOTHING
               RETURNING id`,
              [u.orgId, projectId, village.id, v.total_extent_ac ?? null,
                v.dgps_base ?? 0, v.dgps_rovers ?? 0, v.teams ?? 0,
                v.vill_code_old || null, u.id]);

            if (!inserted.rowCount) {
              // Not an error: re-running an import after fixing a few rows is
              // the normal way this gets used.
              results.push({
                row: rowNo, village_code: v.village_code, status: 'ALREADY_LISTED',
                message: `${v.village_name} is already in this programme`,
              });
              await db.query('RELEASE SAVEPOINT import_row');
              continue;
            }

            // What the row did not carry, so somebody can come back to it.
            const missing = [
              !v.district_code && 'district', !v.mandal_code && 'mandal',
              !v.total_extent_ac && 'extent',
            ].filter(Boolean) as string[];
            results.push({
              row: rowNo, village_code: v.village_code,
              status: input.dry_run ? 'VALIDATED' : 'IMPORTED',
              ...(missing.length ? { message: `Imported without ${missing.join(', ')}` } : {}),
            });
            await db.query('RELEASE SAVEPOINT import_row');
          } catch (error) {
            await db.query('ROLLBACK TO SAVEPOINT import_row');
            const code = (error as { code?: string }).code;
            // A constraint the row genuinely violates is a rejected row; a
            // fault anywhere else is a fault and must not be swallowed as one.
            if (code && !['23505', '23503', '23514'].includes(code)) throw error;
            if (!code && !(error instanceof RowError)) throw error;
            results.push({
              row: rowNo, village_code: v.village_code, status: 'REJECTED',
              message: code
                ? 'The row violates a data constraint'
                : (error as Error).message,
            });
          }
        }

        if (input.dry_run) {
          await db.query('ROLLBACK TO SAVEPOINT preview');
          created = { districts: 0, divisions: 0, mandals: 0, villages: 0 };
        } else {
          await writeAudit(db, {
            orgId: u.orgId, actorId: u.id, action: 'survey.villages.import',
            entityType: 'survey_project', entityId: projectId,
            afterState: {
              rows: input.rows.length,
              imported: results.filter(r => r.status === 'IMPORTED').length,
            },
            requestId: (req as { requestId?: string }).requestId,
          });
        }

        return {
          dry_run: input.dry_run,
          rows: input.rows.length,
          imported: results.filter(r => r.status === 'IMPORTED').length,
          validated: results.filter(r => r.status === 'VALIDATED').length,
          already_listed: results.filter(r => r.status === 'ALREADY_LISTED').length,
          rejected: results.filter(r => r.status === 'REJECTED').length,
          // What the geography would gain, so somebody can see before they
          // commit that a typo is about to create a district.
          geography_created: created,
          results,
        };
      });
    });
}
