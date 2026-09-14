import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * AES-256-GCM field encryption for PII at rest (aadhaar / pan / bank_account).
 * Key: `ENCRYPTION_KEY` env (32-byte hex). Falls back to a documented
 * dev-only default (see apps/api README env table). The key is NEVER logged.
 */
export const DEV_DEFAULT_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const ENCRYPTED_PREFIX = "gcm1";

function keyBytes(): Buffer {
  const hex = process.env["ENCRYPTION_KEY"] ?? DEV_DEFAULT_ENCRYPTION_KEY;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("ENCRYPTION_KEY must be 32-byte hex (64 hex chars)");
  }
  return Buffer.from(hex, "hex");
}

/** Encrypts a UTF-8 string; returns `gcm1.<ivHex>.<tagHex>.<ctHex>`. */
export function encryptPii(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}.${iv.toString("hex")}.${tag.toString("hex")}.${ct.toString("hex")}`;
}

/** Decrypts a blob produced by {@link encryptPii}. Throws on tamper. */
export function decryptPii(blob: string): string {
  const parts = blob.split(".");
  if (parts.length !== 4 || parts[0] !== ENCRYPTED_PREFIX) {
    throw new Error("Unrecognized encrypted payload format");
  }
  const [, ivHex, tagHex, ctHex] = parts as [string, string, string, string];
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyBytes(),
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return (
    decipher.update(Buffer.from(ctHex, "hex")).toString("utf8") +
    decipher.final().toString("utf8")
  );
}

/**
 * Deterministic blind index over an encrypted field.
 *
 * `encryptPii` uses a random IV, so two rows holding the same Aadhaar produce
 * different ciphertext and a UNIQUE index over the column finds nothing. That
 * left Aadhaar, PAN, bank account and PhonePe with no duplicate detection at
 * all, which §7's acceptance criteria require.
 *
 * An HMAC keyed with the same secret as the encryption gives a stable value per
 * plaintext that can carry a UNIQUE index, without being reversible the way a
 * bare hash of a 12-digit Aadhaar would be (that space is small enough to
 * enumerate in seconds). The value is an index only — never returned, never
 * logged.
 */
export function blindIndex(value: string): string {
  return createHmac("sha256", keyBytes())
    .update(`silverline-blind-index:${value}`)
    .digest("hex");
}

/**
 * Canonical form for comparison, so "1234 5678 9012" and "123456789012" are
 * recognised as the same Aadhaar and "abcde1234f" as the same PAN.
 */
export function normalizeForIndex(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

/** Blind index over the canonical form; null for empty input. */
export function piiIndex(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = normalizeForIndex(value);
  return normalized === "" ? null : blindIndex(normalized);
}

/** Last-4 mask (`••••1234`) for masked PII responses; null when empty. */
export function maskLast4(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const digits = value.replace(/\D/g, "");
  const tail = (digits.length > 0 ? digits : value).slice(-4);
  return `••••${tail}`;
}

/**
 * Redacts PII values inside audit before/after payloads. Any of the listed
 * keys (at any nesting depth, including `*_encrypted` blobs) becomes the
 * literal string `"[REDACTED]"`.
 */
const REDACT_KEYS = new Set([
  "aadhaar",
  "pan",
  "bank_account",
  "phonepe_number",
  "salary_basic",
  "aadhaar_encrypted",
  "pan_encrypted",
  "bank_account_encrypted",
]);

export function redactPiiForAudit(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactPiiForAudit);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k) ? "[REDACTED]" : redactPiiForAudit(v);
    }
    return out;
  }
  return value;
}
