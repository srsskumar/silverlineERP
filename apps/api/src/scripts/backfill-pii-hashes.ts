/**
 * Backfills the employee blind-index columns added in migration 024.
 *
 * The migration cannot do this itself: the index is an HMAC keyed with the
 * application's ENCRYPTION_KEY, which SQL has no access to. Until this runs,
 * rows written before the migration carry NULL hashes and are excluded by the
 * partial unique indexes — so nothing breaks, but a duplicate Aadhaar shared
 * with a pre-existing row is not detected.
 *
 * Safe to re-run: rows that already carry a hash are skipped, and a row whose
 * value would collide with another employee's is reported rather than written,
 * so the operator can resolve the real duplicate by hand.
 *
 *   npm run backfill:pii-hashes --workspace=apps/api
 */

import "../common/env.js";
import { Pool } from "pg";
import { decryptPii, piiIndex } from "../common/crypto.js";

interface Row {
  id: string;
  org_id: string;
  emp_no: string;
  aadhaar_encrypted: string | null;
  pan_encrypted: string | null;
  bank_account_encrypted: string | null;
}

export interface BackfillReport {
  scanned: number;
  updated: number;
  /** Rows whose hash collided with an existing employee, needing manual review. */
  conflicts: Array<{ id: string; emp_no: string; field: string }>;
  /** Rows whose ciphertext could not be decrypted with the current key. */
  undecryptable: Array<{ id: string; emp_no: string; field: string }>;
}

export async function backfillPiiHashes(pool: Pool): Promise<BackfillReport> {
  const report: BackfillReport = {
    scanned: 0,
    updated: 0,
    conflicts: [],
    undecryptable: [],
  };

  const rows = await pool.query<Row>(
    `SELECT id, org_id, emp_no, aadhaar_encrypted, pan_encrypted, bank_account_encrypted
       FROM employees
      WHERE (aadhaar_encrypted IS NOT NULL AND aadhaar_hash IS NULL)
         OR (pan_encrypted IS NOT NULL AND pan_hash IS NULL)
         OR (bank_account_encrypted IS NOT NULL AND bank_account_hash IS NULL)
      ORDER BY created_at`,
  );

  for (const row of rows.rows) {
    report.scanned += 1;
    const columns: Array<[column: string, blob: string | null, field: string]> = [
      ["aadhaar_hash", row.aadhaar_encrypted, "aadhaar"],
      ["pan_hash", row.pan_encrypted, "pan"],
      ["bank_account_hash", row.bank_account_encrypted, "bank_account"],
    ];
    for (const [column, blob, field] of columns) {
      if (!blob) continue;
      let hash: string | null;
      try {
        hash = piiIndex(decryptPii(blob));
      } catch {
        // A key rotation, or a value encrypted by a different deployment.
        report.undecryptable.push({ id: row.id, emp_no: row.emp_no, field });
        continue;
      }
      if (!hash) continue;
      try {
        const updated = await pool.query(
          `UPDATE employees SET ${column} = $2 WHERE id = $1 AND ${column} IS NULL`,
          [row.id, hash],
        );
        if ((updated.rowCount ?? 0) > 0) report.updated += 1;
      } catch (error) {
        if (String((error as { code?: string }).code) !== "23505") throw error;
        // A genuine pre-existing duplicate. Leaving the hash NULL keeps both
        // rows readable; a human decides which one is real.
        report.conflicts.push({ id: row.id, emp_no: row.emp_no, field });
      }
    }
  }

  return report;
}

const invokedAsScript =
  process.argv[1]?.endsWith("backfill-pii-hashes.ts") === true ||
  process.argv[1]?.endsWith("backfill-pii-hashes.js") === true;

if (invokedAsScript) {
  const databaseUrl =
    process.env["DATABASE_URL"] ?? "postgresql://localhost:5432/silverline_dev";
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const report = await backfillPiiHashes(pool);
    console.log(
      `backfill-pii-hashes: scanned ${report.scanned} employee(s), wrote ${report.updated} hash(es)`,
    );
    for (const conflict of report.conflicts) {
      console.warn(
        `  duplicate ${conflict.field} — employee ${conflict.emp_no} (${conflict.id}) left unindexed; resolve by hand`,
      );
    }
    for (const bad of report.undecryptable) {
      console.warn(
        `  could not decrypt ${bad.field} for employee ${bad.emp_no} (${bad.id}); check ENCRYPTION_KEY`,
      );
    }
    if (report.conflicts.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
