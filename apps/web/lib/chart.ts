/**
 * Chart geometry (§39).
 *
 * Plain arithmetic producing SVG coordinates, with no charting library
 * behind it. That is a deliberate choice: this app is a static export served
 * from a VM, every dependency is bytes a field user downloads over a mobile
 * connection, and what these charts need — a line, some bars, a stack — is
 * a few dozen lines of arithmetic rather than a framework.
 *
 * Kept apart from the components so the arithmetic can be tested directly.
 * A chart that is wrong is worse than no chart: it is read at a glance and
 * believed, and nobody checks the numbers behind it.
 */

export interface Point { x: number; y: number }

/**
 * A round upper bound for an axis.
 *
 * Axes that end on 4,637 make every value on them hard to read. This walks
 * up 1, 2, 2.5, 5, 10 within the decade — the steps people already expect
 * on a printed scale.
 */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

/**
 * Evenly spaced axis labels, ending exactly on the maximum.
 *
 * The top gridline has to carry the maximum or the tallest bar runs past the
 * last label and the chart reads as though it goes off the top.
 */
export function ticks(max: number, count = 4): number[] {
  const top = niceMax(max);
  const out: number[] = [];
  for (let i = 0; i <= count; i += 1) {
    out.push(Math.round((top * i / count) * 100) / 100);
  }
  return out;
}

export interface Plot {
  width: number; height: number;
  padLeft: number; padBottom: number; padTop: number; padRight: number;
}

const DEFAULT_PLOT: Plot = {
  width: 640, height: 200, padLeft: 44, padBottom: 22, padTop: 8, padRight: 8,
};

/** Where a value sits vertically, with zero at the bottom of the plot. */
export function yOf(value: number, max: number, plot: Plot = DEFAULT_PLOT): number {
  const top = niceMax(max);
  const usable = plot.height - plot.padTop - plot.padBottom;
  if (top <= 0) return plot.height - plot.padBottom;
  const clamped = Math.max(0, Math.min(value, top));
  return plot.padTop + usable * (1 - clamped / top);
}

/** Where the nth of `count` points sits horizontally. */
export function xOf(index: number, count: number, plot: Plot = DEFAULT_PLOT): number {
  const usable = plot.width - plot.padLeft - plot.padRight;
  // A single point sits in the middle rather than hard against the axis,
  // where it would read as a value of zero on the y-axis line.
  if (count <= 1) return plot.padLeft + usable / 2;
  return plot.padLeft + (usable * index) / (count - 1);
}

/**
 * An SVG path through a series.
 *
 * Returns an empty string for an empty series rather than a stub path, so a
 * chart with no data draws nothing at all instead of a line along the floor
 * that reads as "zero throughout".
 */
export function linePath(values: number[], max: number, plot: Plot = DEFAULT_PLOT): string {
  if (values.length === 0) return '';
  return values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${round(xOf(i, values.length, plot))} `
      + `${round(yOf(v, max, plot))}`)
    .join(' ');
}

/** The same series as a filled area, closed along the baseline. */
export function areaPath(values: number[], max: number, plot: Plot = DEFAULT_PLOT): string {
  if (values.length === 0) return '';
  const floor = round(yOf(0, max, plot));
  const first = round(xOf(0, values.length, plot));
  const last = round(xOf(values.length - 1, values.length, plot));
  return `${linePath(values, max, plot)} L${last} ${floor} L${first} ${floor} Z`;
}

export interface Bar { x: number; y: number; width: number; height: number }

/** Evenly spaced bars, with a gap between them. */
export function bars(
  values: number[], max: number, plot: Plot = DEFAULT_PLOT, gap = 0.3,
): Bar[] {
  if (values.length === 0) return [];
  const usable = plot.width - plot.padLeft - plot.padRight;
  const slot = usable / values.length;
  const width = Math.max(1, slot * (1 - gap));
  const floor = yOf(0, max, plot);
  return values.map((v, i) => {
    const y = yOf(v, max, plot);
    return {
      x: round(plot.padLeft + slot * i + (slot - width) / 2),
      y: round(y),
      width: round(width),
      // A value of zero gets no bar rather than a sliver, which would read
      // as a small amount of something.
      height: round(Math.max(0, floor - y)),
    };
  });
}

export interface Segment { value: number; label: string; key: string }
export interface StackPiece extends Segment { offsetPct: number; widthPct: number }

/**
 * One bar divided into proportional pieces.
 *
 * Returns an empty list when nothing has a value: a stack of zeros drawn as
 * equal shares would say every stage holds the same number of villages,
 * which is the opposite of what it means.
 */
export function stack(segments: Segment[]): StackPiece[] {
  const total = segments.reduce((t, s) => t + Math.max(0, s.value), 0);
  if (total <= 0) return [];
  let offset = 0;
  return segments
    .filter(s => s.value > 0)
    .map(s => {
      const widthPct = (s.value / total) * 100;
      const piece = { ...s, offsetPct: round(offset), widthPct: round(widthPct) };
      offset += widthPct;
      return piece;
    });
}

/** Two decimals is well under one device pixel at these sizes. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export { DEFAULT_PLOT };
