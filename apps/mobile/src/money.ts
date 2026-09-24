/**
 * One rupee formatter for every screen (D-014).
 *
 * Eight screens printed money with maximumFractionDigits: 0, so the phone
 * showed Rs 1,500 where the web showed Rs 1,499.60 for the same claim, and
 * three more dropped a trailing zero. This matches the web's money():
 * two decimals always, Indian grouping, and a dash for a value that is not
 * there rather than a zero nobody recorded.
 *
 * Grouped by hand from integer paise rather than through toLocaleString, so
 * the output does not depend on how much Intl the device's engine ships.
 */
export function formatMoney(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  const paise = Math.round(Math.abs(n) * 100 + 1e-7);
  const rupees = Math.floor(paise / 100).toString();
  const frac = String(paise % 100).padStart(2, "0");
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  const grouped = rest ? `${rest},${last3}` : last3;
  return `${n < 0 && paise > 0 ? "-" : ""}₹${grouped}.${frac}`;
}

/** The same, or null for an absent or zero figure a card would rather omit. */
export function formatMoneyOrNull(value: number | string | null | undefined): string | null {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n === 0) return null;
  return formatMoney(n);
}
