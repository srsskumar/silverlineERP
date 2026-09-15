import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_TYPE_SEEDS } from '@silverline/shared';

/**
 * The seeded document types exist twice: once in TypeScript, where the API
 * validates against them, and once in the migration, where they are written
 * into each organisation. Two copies of the same list drift, and the drift is
 * invisible — the application would validate a type the database has never
 * heard of, and the failure would surface as a foreign-key error in front of
 * a user.
 *
 * Parsing the SQL is unlovely, but it is the only thing that actually compares
 * the two.
 */
const sql = readFileSync(
  fileURLToPath(new URL('../src/database/migrations/047_document_register.sql', import.meta.url)),
  'utf8',
);

/** The VALUES rows of the seed INSERT, as (code, notice, blocks, retention). */
function seedRows(): Array<{
  code: string; noticeDays: number; expiryRequired: boolean;
  blocksOperations: boolean; retentionYears: number; confidential: boolean;
}> {
  const block = sql.slice(sql.indexOf('CROSS JOIN (VALUES'), sql.indexOf('AS t(code,label'));
  const rows: ReturnType<typeof seedRows> = [];
  // Each row opens with ('CODE','Label','CATEGORY',ARRAY[...],notice,...)
  const re = /\('([A-Z_]+)',(?:'(?:[^']|'')*',){2}ARRAY\[[^\]]*\],(\d+),(true|false),(true|false),(\d+),(true|false)/g;
  for (const m of block.matchAll(re)) {
    rows.push({
      code: m[1],
      noticeDays: Number(m[2]),
      expiryRequired: m[3] === 'true',
      blocksOperations: m[4] === 'true',
      retentionYears: Number(m[5]),
      confidential: m[6] === 'true',
    });
  }
  return rows;
}

describe('document type seeds', () => {
  const rows = seedRows();

  it('parses every row out of the migration', () => {
    // If this fails the parser is broken, not the seeds — and a broken parser
    // would make every check below pass vacuously.
    expect(rows.length).toBe(DOCUMENT_TYPE_SEEDS.length);
    expect(rows.length).toBeGreaterThan(20);
  });

  it('seeds exactly the codes the application knows', () => {
    expect(rows.map(r => r.code).sort()).toEqual(DOCUMENT_TYPE_SEEDS.map(s => s.code).sort());
  });

  it('agrees on every rule that governs behaviour', () => {
    // A notice window that disagrees means the database says a licence needs
    // sixty days of warning and the application says thirty.
    for (const seed of DOCUMENT_TYPE_SEEDS) {
      const row = rows.find(r => r.code === seed.code)!;
      expect(row.noticeDays, `${seed.code} notice_days`).toBe(seed.noticeDays);
      expect(row.expiryRequired, `${seed.code} expiry_required`).toBe(seed.expiryRequired);
      expect(row.blocksOperations, `${seed.code} blocks_operations`).toBe(seed.blocksOperations);
      expect(row.retentionYears, `${seed.code} retention_years`).toBe(seed.retentionYears);
      expect(row.confidential, `${seed.code} confidential`).toBe(seed.confidential);
    }
  });

  it('inserts without duplicating on a re-run', () => {
    // Migrations are applied more than once in practice — a redeploy, a
    // restore, a second environment sharing the file.
    expect(sql).toContain('ON CONFLICT (org_id, code) DO NOTHING');
  });

  it('gives every organisation the list, not just the first', () => {
    expect(sql).toContain('FROM organizations o');
    expect(sql).toContain('CROSS JOIN');
  });
});
