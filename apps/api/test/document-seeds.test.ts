import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_ROLE_GRANTS, DOCUMENT_TYPE_SEEDS } from '@silverline/shared';

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

/**
 * The role grants exist twice too: in TypeScript, where the seed script reads
 * them, and in migration 048, which is what actually runs on a deployment.
 *
 * They were separated the hard way. Migration 047 shipped the register, the
 * application enforced `document.manage`, and production had never heard of
 * the permission — every write came back "insufficient permissions" with
 * nothing in the deployment explaining why, because new permissions had only
 * ever arrived through a seed script that does not run against a live
 * database.
 */
const grantSql = readFileSync(
  fileURLToPath(new URL('../src/database/migrations/048_document_permissions.sql', import.meta.url)),
  'utf8',
);

/**
 * Migration 082 split releasing a hold off placing one, and grants the release
 * to whichever roles hold document.legalhold when it runs, rather than from a
 * list. So for these checks it is granted exactly where 048 grants the hold.
 */
const releaseSql = readFileSync(
  fileURLToPath(new URL('../src/database/migrations/082_document_hold_release.sql', import.meta.url)),
  'utf8',
);

/**
 * Migration 112 (owner decision 2026-09-24 #4) narrows AUDITOR specifically:
 * it may place a hold but not release one. 082's blanket "release wherever
 * hold is granted" rule no longer holds for that one pairing, so it is
 * checked here and subtracted back out of `pairs` below.
 */
const revokeSql = readFileSync(
  fileURLToPath(new URL('../src/database/migrations/112_auditor_legalhold_release.sql', import.meta.url)),
  'utf8',
);

describe('document permission grants', () => {
  const placed = [...grantSql.matchAll(/\('([A-Z_]+)','(document\.[a-z]+)'\)/g)]
    .map(m => [m[1], m[2]] as const);
  const revokesAuditorRelease = /'document\.legalhold\.release'/.test(revokeSql)
    && /code = 'AUDITOR'/.test(revokeSql) && /^DELETE FROM role_permissions/m.test(revokeSql);
  const pairs = [
    ...placed,
    ...placed.filter(([, p]) => p === 'document.legalhold')
      .map(([r]) => [r, 'document.legalhold.release'] as const)
      .filter(([r, p]) => !(revokesAuditorRelease && r === 'AUDITOR' && p === 'document.legalhold.release')),
  ];

  it('112 actually revokes what it claims to (or the filter above is vacuous)', () => {
    expect(revokesAuditorRelease).toBe(true);
  });

  it('grants the release of a hold to exactly the roles that hold document.legalhold', () => {
    expect(releaseSql).toMatch(/permission_code = 'document\.legalhold'/);
    expect(releaseSql).toContain("'document.legalhold.release'");
    expect(releaseSql).toContain('ON CONFLICT (role_id, permission_code) DO NOTHING');
  });

  it('parses the grants out of the migration', () => {
    expect(pairs.length).toBeGreaterThan(10);
  });

  it('grants exactly what the application believes each role has', () => {
    for (const [role, grants] of Object.entries(DOCUMENT_ROLE_GRANTS)) {
      for (const permission of grants) {
        // document.read is granted by a separate statement, since the
        // permission predates this module.
        if (permission === 'document.read') continue;
        expect(
          pairs.some(([r, p]) => r === role && p === permission),
          `${role} should be granted ${permission} by the migration`,
        ).toBe(true);
      }
    }
  });

  it('grants nothing the application does not believe in', () => {
    for (const [role, permission] of pairs) {
      expect(
        DOCUMENT_ROLE_GRANTS[role as keyof typeof DOCUMENT_ROLE_GRANTS] ?? [],
        `${role} is granted ${permission} by the migration but not by the application`,
      ).toContain(permission);
    }
  });

  it('never grants deletion to anyone but an administrator', () => {
    // An auditor who can destroy evidence is not a control.
    for (const [role, permission] of pairs) {
      if (permission === 'document.delete') {
        expect(['SUPER_ADMIN', 'ADMIN']).toContain(role);
      }
    }
  });

  it('creates every permission it then grants', () => {
    // A grant referencing a permission that does not exist violates the
    // foreign key and fails the whole migration.
    const created = [...[grantSql, releaseSql].join('\n').matchAll(/\('(document\.[a-z.]+)',\s*'[^']*',\s*'documents'\)/g)]
      .map(m => m[1]);
    for (const [, permission] of pairs) {
      if (permission === 'document.read') continue;
      expect(created, `${permission} is granted but never created`).toContain(permission);
    }
  });

  it('can be applied twice without failing', () => {
    expect(grantSql).toContain('ON CONFLICT (code) DO NOTHING');
    expect(grantSql).toContain('ON CONFLICT (role_id, permission_code) DO NOTHING');
  });
});
