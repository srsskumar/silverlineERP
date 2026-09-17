import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { buildAuthenticate, requirePermission } from '../../common/auth.js';
import { actor, parse, mutate, fail } from '../../common/domain.js';
import { writeAudit } from '../../common/audit.js';
import { canMatchOnSerial } from '@silverline/shared';

/**
 * Loading assets and inventory from a file (enhancement note 3).
 *
 * Both had a download template and nowhere to upload it -- the template page
 * said "upload it from the matching screen" and no such screen existed. A
 * format nobody can submit is a format nobody uses.
 *
 * Previewed by default, like the village importer. An import that silently
 * writes two hundred rows on a mis-typed column is one nobody runs twice, so
 * `dry_run` defaults to true and the caller has to ask for the write.
 */

const assetRow = z.object({
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(255),
  category: z.string().trim().min(1).max(64),
  asset_type: z.string().trim().max(64).optional().or(z.literal('')),
  serial_number: z.string().trim().max(120).optional().or(z.literal('')),
  make: z.string().trim().max(160).optional().or(z.literal('')),
  model: z.string().trim().max(160).optional().or(z.literal('')),
  condition: z.string().trim().max(24).optional().or(z.literal('')),
  condition_note: z.string().trim().max(2000).optional().or(z.literal('')),
});

const allocationRow = z.object({
  asset_code: z.string().trim().min(1).max(64),
  emp_no: z.string().trim().min(1).max(64),
  project_code: z.string().trim().max(64).optional().or(z.literal('')),
  issued_on: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
  due_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
  condition: z.string().trim().max(24).optional().or(z.literal('')),
  reason: z.string().trim().min(1).max(500),
});

const inventoryRow = z.object({
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(255),
  unit: z.string().trim().min(1).max(24),
  reorder_level: z.coerce.number().finite().min(0).optional(),
});

type Result = {
  row: number; key?: string; status: string; message?: string;
};

export async function registerInventoryImport(
  app: FastifyInstance, opts: { pool: Pool; jwtSecret: string },
) {
  const auth = buildAuthenticate(opts);
  const guard = (p: string) => requirePermission(auth, p);

  /**
   * Import the asset register.
   *
   * Duplicates are recognised by serial number, and only where a serial
   * means something. The note asks for exactly that exception: an accessory
   * -- a box of tripod screws -- has no serial worth trusting, so two rows
   * for it are two boxes, not one box twice, and merging them would silently
   * destroy real stock. Those match on the asset code instead, which is
   * unique by constraint.
   *
   * A recognised duplicate updates rather than fails. Re-uploading a
   * corrected sheet is the normal way this gets used, and refusing the whole
   * file because forty rows already exist helps nobody.
   */
  app.post('/api/v1/assets/import', { preHandler: guard('asset.manage') }, async req => {
    const u = actor(req);
    const input = parse(z.object({
      rows: z.array(z.unknown()).min(1).max(2000),
      dry_run: z.boolean().default(true),
    }), req.body);

    return mutate(opts.pool, req, 'asset.import', 'asset_import', async db => {
      await db.query('SAVEPOINT preview');
      const results: Result[] = [];
      let created = 0, updated = 0;

      // The organisation's own vocabulary, read once rather than per row.
      const categories = new Map((await db.query(
        'SELECT code FROM asset_categories WHERE org_id = $1 AND active', [u.orgId])
      ).rows.map(r => [String(r.code).toUpperCase(), String(r.code)]));
      const types = new Map((await db.query(
        'SELECT id, code FROM asset_types WHERE org_id = $1 AND active', [u.orgId])
      ).rows.map(r => [String(r.code).toUpperCase(), String(r.id)]));

      for (const [index, raw] of input.rows.entries()) {
        const rowNo = index + 1;
        const parsed = assetRow.safeParse(raw);
        if (!parsed.success) {
          results.push({
            row: rowNo, status: 'REJECTED',
            message: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
          });
          continue;
        }
        const v = parsed.data;
        await db.query('SAVEPOINT import_row');
        try {
          const category = categories.get(v.category.toUpperCase());
          if (!category) {
            throw new RowError(
              `There is no active asset category "${v.category}". Add it first, or correct the sheet.`);
          }
          const typeId = v.asset_type ? types.get(v.asset_type.toUpperCase()) : null;
          if (v.asset_type && !typeId) {
            throw new RowError(`There is no active asset type "${v.asset_type}"`);
          }
          const condition = (v.condition || 'GOOD').toUpperCase();
          if (condition === 'OTHER' && !v.condition_note) {
            throw new RowError('A condition of "other" must say what condition it is in');
          }

          const serial = v.serial_number || null;
          const matchable = canMatchOnSerial(category, serial);
          const existing = (await db.query(
            matchable
              ? 'SELECT id FROM assets WHERE org_id = $1 AND serial_number = $2'
              : 'SELECT id FROM assets WHERE org_id = $1 AND asset_code = $2',
            [u.orgId, matchable ? serial : v.code])).rows[0];

          if (existing) {
            await db.query(
              `UPDATE assets SET name=$2, category=$3, asset_type_id=$4, make=$5, model=$6,
                 condition=$7, condition_note=$8, serial_number=COALESCE($9, serial_number),
                 version=version+1, updated_at=now()
               WHERE id=$1`,
              [existing.id, v.name, category, typeId, v.make || null, v.model || null,
                condition, v.condition_note || null, serial]);
            updated += 1;
            results.push({
              row: rowNo, key: v.code,
              status: input.dry_run ? 'WOULD_UPDATE' : 'UPDATED',
              message: matchable ? `Matched on serial ${serial}` : 'Matched on asset code',
            });
          } else {
            await db.query(
              `INSERT INTO assets(org_id, asset_code, name, category, asset_type_id,
                 serial_number, make, model, condition, condition_note, created_by)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
              [u.orgId, v.code, v.name, category, typeId, serial,
                v.make || null, v.model || null, condition, v.condition_note || null, u.id]);
            created += 1;
            results.push({
              row: rowNo, key: v.code,
              status: input.dry_run ? 'WOULD_CREATE' : 'CREATED',
            });
          }
          await db.query('RELEASE SAVEPOINT import_row');
        } catch (error) {
          await db.query('ROLLBACK TO SAVEPOINT import_row');
          const code = (error as { code?: string }).code;
          // A constraint the row genuinely violates is a rejected row; a
          // fault anywhere else is a fault and must not be swallowed as one.
          if (code && !['23505', '23503', '23514'].includes(code)) throw error;
          if (!code && !(error instanceof RowError)) throw error;
          results.push({
            row: rowNo, key: v.code, status: 'REJECTED',
            message: code === '23505'
              ? 'That asset code or serial number is already used by a different asset'
              : code ? 'The row violates a data constraint' : (error as Error).message,
          });
        }
      }

      if (input.dry_run) await db.query('ROLLBACK TO SAVEPOINT preview');
      else {
        await writeAudit(db, {
          orgId: u.orgId, actorId: u.id, action: 'asset.import',
          entityType: 'asset_import', afterState: { rows: input.rows.length, created, updated },
          requestId: (req as { requestId?: string }).requestId,
        });
      }

      return {
        dry_run: input.dry_run, rows: input.rows.length,
        created, updated,
        rejected: results.filter(r => r.status === 'REJECTED').length,
        results,
      };
    });
  });

  /**
   * Import who currently holds what (enhancement note 3).
   *
   * Allocations arrive as a spreadsheet when a register is first brought
   * into the system -- fifty rovers already out with fifty people, and
   * nobody is going to open fifty forms.
   *
   * An asset already out with somebody else is reported, never silently
   * moved. Quietly reassigning equipment is how a register starts
   * contradicting the people holding the equipment, and the person who
   * actually has it is the one who finds out last.
   */
  app.post('/api/v1/assets/allocations/import',
    { preHandler: guard('asset.manage') }, async req => {
      const u = actor(req);
      const input = parse(z.object({
        rows: z.array(z.unknown()).min(1).max(2000),
        dry_run: z.boolean().default(true),
      }), req.body);

      return mutate(opts.pool, req, 'asset.allocation.import', 'asset_allocation_import', async db => {
        await db.query('SAVEPOINT preview');
        const results: Result[] = [];
        let created = 0;

        for (const [index, raw] of input.rows.entries()) {
          const rowNo = index + 1;
          const parsed = allocationRow.safeParse(raw);
          if (!parsed.success) {
            results.push({
              row: rowNo, status: 'REJECTED',
              message: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
            });
            continue;
          }
          const v = parsed.data;
          await db.query('SAVEPOINT import_row');
          try {
            const asset = (await db.query(
              'SELECT id, status FROM assets WHERE org_id = $1 AND asset_code = $2',
              [u.orgId, v.asset_code])).rows[0];
            if (!asset) throw new RowError(`No asset with code ${v.asset_code}`);

            const employee = (await db.query(
              "SELECT id, status FROM employees WHERE org_id = $1 AND emp_no = $2",
              [u.orgId, v.emp_no])).rows[0];
            if (!employee) throw new RowError(`No employee with number ${v.emp_no}`);
            if (employee.status !== 'ACTIVE') {
              throw new RowError(`${v.emp_no} is not an active employee`);
            }

            let projectId: string | null = null;
            if (v.project_code) {
              const project = (await db.query(
                'SELECT id FROM projects WHERE org_id = $1 AND code = $2',
                [u.orgId, v.project_code])).rows[0];
              if (!project) throw new RowError(`No project with code ${v.project_code}`);
              projectId = String(project.id);
            }

            // Already out with somebody: say so, do not move it.
            const open = (await db.query(
              `SELECT COALESCE(NULLIF(trim(concat_ws(' ', e.first_name, e.last_name)),''),e.emp_no) AS who
                 FROM asset_assignments a JOIN employees e ON e.id = a.employee_id
                WHERE a.asset_id = $1 AND a.returned_at IS NULL`, [asset.id])).rows[0];
            if (open) {
              results.push({
                row: rowNo, key: v.asset_code, status: 'ALREADY_ALLOCATED',
                message: `${v.asset_code} is already out with ${open.who}. Record its return first.`,
              });
              await db.query('RELEASE SAVEPOINT import_row');
              continue;
            }

            await db.query(
              `INSERT INTO asset_assignments(org_id, asset_id, employee_id, project_id,
                 issued_at, due_date, condition, reason, created_by)
               VALUES($1,$2,$3,$4,COALESCE($5::timestamptz, now()),$6,$7,$8,$9)`,
              [u.orgId, asset.id, employee.id, projectId,
                v.issued_on ? `${v.issued_on}T00:00:00Z` : null,
                v.due_date || null, (v.condition || 'GOOD').toUpperCase(), v.reason, u.id]);
            await db.query(
              "UPDATE assets SET status='ASSIGNED', version=version+1, updated_at=now() WHERE id=$1",
              [asset.id]);
            created += 1;
            results.push({
              row: rowNo, key: v.asset_code,
              status: input.dry_run ? 'WOULD_ALLOCATE' : 'ALLOCATED',
            });
            await db.query('RELEASE SAVEPOINT import_row');
          } catch (error) {
            await db.query('ROLLBACK TO SAVEPOINT import_row');
            const code = (error as { code?: string }).code;
            if (code && !['23505', '23503', '23514'].includes(code)) throw error;
            if (!code && !(error instanceof RowError)) throw error;
            results.push({
              row: rowNo, key: v.asset_code, status: 'REJECTED',
              message: code ? 'The row violates a data constraint' : (error as Error).message,
            });
          }
        }

        if (input.dry_run) await db.query('ROLLBACK TO SAVEPOINT preview');
        else {
          await writeAudit(db, {
            orgId: u.orgId, actorId: u.id, action: 'asset.allocation.import',
            entityType: 'asset_allocation_import',
            afterState: { rows: input.rows.length, allocated: created },
            requestId: (req as { requestId?: string }).requestId,
          });
        }

        return {
          dry_run: input.dry_run, rows: input.rows.length, allocated: created,
          already_allocated: results.filter(r => r.status === 'ALREADY_ALLOCATED').length,
          rejected: results.filter(r => r.status === 'REJECTED').length,
          results,
        };
      });
    });

  /** Import stock items. Matched on the item code, which is its identity. */
  app.post('/api/v1/inventory/items/import',
    { preHandler: guard('inventory.manage') }, async req => {
      const u = actor(req);
      const input = parse(z.object({
        rows: z.array(z.unknown()).min(1).max(2000),
        dry_run: z.boolean().default(true),
      }), req.body);

      return mutate(opts.pool, req, 'inventory.import', 'inventory_import', async db => {
        await db.query('SAVEPOINT preview');
        const results: Result[] = [];
        let created = 0, updated = 0;

        for (const [index, raw] of input.rows.entries()) {
          const rowNo = index + 1;
          const parsed = inventoryRow.safeParse(raw);
          if (!parsed.success) {
            results.push({
              row: rowNo, status: 'REJECTED',
              message: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
            });
            continue;
          }
          const v = parsed.data;
          await db.query('SAVEPOINT import_row');
          try {
            const existing = (await db.query(
              'SELECT id FROM inventory_items WHERE org_id = $1 AND code = $2',
              [u.orgId, v.code])).rows[0];
            if (existing) {
              await db.query(
                `UPDATE inventory_items SET name=$2, unit=$3, version=version+1, updated_at=now()
                 WHERE id=$1`, [existing.id, v.name, v.unit]);
              updated += 1;
              results.push({
                row: rowNo, key: v.code,
                status: input.dry_run ? 'WOULD_UPDATE' : 'UPDATED',
              });
            } else {
              await db.query(
                'INSERT INTO inventory_items(org_id, code, name, unit, created_by) VALUES($1,$2,$3,$4,$5)',
                [u.orgId, v.code, v.name, v.unit, u.id]);
              created += 1;
              results.push({
                row: rowNo, key: v.code,
                status: input.dry_run ? 'WOULD_CREATE' : 'CREATED',
              });
            }
            await db.query('RELEASE SAVEPOINT import_row');
          } catch (error) {
            await db.query('ROLLBACK TO SAVEPOINT import_row');
            const code = (error as { code?: string }).code;
            if (code && !['23505', '23503', '23514'].includes(code)) throw error;
            if (!code && !(error instanceof RowError)) throw error;
            results.push({
              row: rowNo, key: v.code, status: 'REJECTED',
              message: code ? 'The row violates a data constraint' : (error as Error).message,
            });
          }
        }

        if (input.dry_run) await db.query('ROLLBACK TO SAVEPOINT preview');
        else {
          await writeAudit(db, {
            orgId: u.orgId, actorId: u.id, action: 'inventory.import',
            entityType: 'inventory_import',
            afterState: { rows: input.rows.length, created, updated },
            requestId: (req as { requestId?: string }).requestId,
          });
        }

        return {
          dry_run: input.dry_run, rows: input.rows.length, created, updated,
          rejected: results.filter(r => r.status === 'REJECTED').length,
          results,
        };
      });
    });
}

class RowError extends Error {}
