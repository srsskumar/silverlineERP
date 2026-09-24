/**
 * Exact rupee arithmetic for line amounts (D-010, fix round 1).
 *
 * Math.round(q * r * 100) / 100 rounds 0.5 x 4.35 = 2.175 down to 2.17,
 * because the float product is 2.17499999... Trimming the float to twelve
 * significant digits fixed that but loses paise once an amount passes about
 * Rs 1e10. These work in integers instead: each input is read at a fixed
 * number of decimals (a quantity or rate typed with more is already beyond
 * what the database stores), multiplied as a BigInt, and rounded half away
 * from zero to the paisa, the way NUMERIC rounds.
 */

function scaled(n: number, dp: number): bigint {
  if (!Number.isFinite(n)) throw new RangeError(`Not a finite amount: ${n}`);
  const s = Math.abs(n).toFixed(dp);
  const [whole, frac = ""] = s.split(".");
  const v = BigInt(whole + frac.padEnd(dp, "0"));
  return n < 0 ? -v : v;
}

function divRound(num: bigint, den: bigint): bigint {
  const neg = (num < 0n) !== (den < 0n);
  const a = num < 0n ? -num : num, b = den < 0n ? -den : den;
  const q = (a * 2n + b) / (b * 2n);
  return neg ? -q : q;
}

const fromPaise = (p: bigint): number => Number(p) / 100;

/** quantity x rate, to the paisa. Quantity is read to 6 decimals, rate to 4. */
export function lineAmount(quantity: number, rate: number): number {
  return fromPaise(divRound(scaled(quantity, 6) * scaled(rate, 4), 10n ** 8n));
}

/** pct % of an amount, to the paisa. The amount is read to 2 decimals, pct to 4. */
export function percentOf(amount: number, pct: number): number {
  return fromPaise(divRound(scaled(amount, 2) * scaled(pct, 4), 100n * 10n ** 4n));
}

/** Sum of rupee amounts, each read to the paisa, without float drift. */
export function addMoney(...amounts: number[]): number {
  return fromPaise(amounts.reduce((t, a) => t + scaled(a, 2), 0n));
}
