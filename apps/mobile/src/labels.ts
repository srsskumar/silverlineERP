/**
 * MA-010: one wording for a status/type code across the phone, identical to
 * web's statusLabel() (apps/web/lib/board-visuals.ts): IN_PROGRESS reads
 * "In progress" on both, instead of the raw code on one and a sentence on
 * the other. Dependency-free so node:test can import it.
 */
export function codeLabel(code: string | null | undefined): string {
  const words = String(code ?? "").replaceAll("_", " ").toLowerCase().trim();
  if (!words) return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}
