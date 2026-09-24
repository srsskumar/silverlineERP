/**
 * Rupees to the paisa, half up (D-010).
 *
 * Math.round(q * r * 100) / 100 rounded 0.5 x 4.35 = 2.175 down to 2.17,
 * because the float product is 2.17499999... NUMERIC, the invoice side and
 * every calculator say 2.18. Trimming to twelve significant digits first
 * throws away the float noise without touching any real paise.
 */
export function paise(n: number): number {
  return Math.round(Number((n * 100).toPrecision(12))) / 100;
}
