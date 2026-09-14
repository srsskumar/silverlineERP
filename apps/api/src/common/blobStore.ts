/**
 * Storage for uploaded file content.
 *
 * Content lives in the database, encrypted, rather than on local disk: the API
 * runs on a serverless host whose filesystem is ephemeral and per-invocation,
 * so a document written during one request is not there for the next. The
 * content was already encrypted before it was written to disk, so this changes
 * where a blob lives, not how it is protected.
 *
 * Rows written by an earlier, disk-backed deployment are still readable:
 * {@link readBlob} falls back to `file_path` when a row has no stored content.
 * That fallback is the only reason the filesystem is touched at all here, and
 * it disappears once no legacy rows remain.
 */

import { readFile } from "node:fs/promises";
import { decryptPii, encryptPii } from "./crypto.js";

/** The encrypted form written to `content_encrypted`. */
export function encodeBlob(binary: Buffer): string {
  return encryptPii(binary.toString("base64"));
}

/** A row that may carry inline content, a legacy path, or both. */
export interface StoredBlob {
  content_encrypted?: string | null;
  file_path?: string | null;
}

/**
 * Returns a stored file's bytes, or null when neither the column nor the
 * legacy path yields anything.
 *
 * Disk rows are tolerated in both shapes they were ever written in: encrypted
 * (the `gcm1.` prefix) and, from the very earliest builds, raw.
 */
export async function readBlob(row: StoredBlob): Promise<Buffer | null> {
  if (row.content_encrypted) {
    return Buffer.from(decryptPii(row.content_encrypted), "base64");
  }
  if (!row.file_path) return null;
  try {
    const stored = await readFile(row.file_path);
    return stored.subarray(0, 5).toString() === "gcm1."
      ? Buffer.from(decryptPii(stored.toString()), "base64")
      : stored;
  } catch {
    // The host that held the file is gone, or never had it. The caller turns
    // this into a 404 rather than a 500 — the row exists, the bytes do not.
    return null;
  }
}
