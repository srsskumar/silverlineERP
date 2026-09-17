import { describe, expect, it } from 'vitest';
import {
  niceMax, ticks, yOf, xOf, linePath, areaPath, bars, stack, DEFAULT_PLOT,
} from '../lib/chart';

describe('choosing a readable axis', () => {
  it('rounds up to a number somebody can read off a scale', () => {
    // An axis that ends on 4,637 makes every value on it hard to read.
    expect(niceMax(4637)).toBe(5000);
    expect(niceMax(0.8)).toBe(1);
    expect(niceMax(23)).toBe(25);
    expect(niceMax(120)).toBe(200);
  });

  it('never returns zero, which would divide everything by nothing', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(-5)).toBe(1);
    expect(niceMax(Number.NaN)).toBe(1);
  });

  it('ends the labels exactly on the maximum', () => {
    // Otherwise the tallest bar runs past the last gridline and the chart
    // reads as though it goes off the top.
    const t = ticks(4637);
    expect(t[0]).toBe(0);
    expect(t[t.length - 1]).toBe(5000);
    expect(t).toHaveLength(5);
  });
});

describe('placing a value in the plot', () => {
  it('puts zero on the floor and the maximum at the ceiling', () => {
    const floor = yOf(0, 100);
    const ceiling = yOf(100, 100);
    expect(floor).toBe(DEFAULT_PLOT.height - DEFAULT_PLOT.padBottom);
    expect(ceiling).toBe(DEFAULT_PLOT.padTop);
    // SVG y grows downward, so a bigger value sits higher up the page.
    expect(ceiling).toBeLessThan(floor);
  });

  it('does not let a value escape the plot', () => {
    // A figure above the axis maximum would otherwise draw outside the box.
    expect(yOf(500, 100)).toBe(yOf(100, 100));
    expect(yOf(-20, 100)).toBe(yOf(0, 100));
  });

  it('spreads points across the width, first and last on the edges', () => {
    expect(xOf(0, 5)).toBe(DEFAULT_PLOT.padLeft);
    expect(xOf(4, 5)).toBe(DEFAULT_PLOT.width - DEFAULT_PLOT.padRight);
  });

  it('centres a lone point rather than pinning it to the axis', () => {
    // On the axis line it reads as a y-value of zero.
    const only = xOf(0, 1);
    expect(only).toBeGreaterThan(DEFAULT_PLOT.padLeft);
    expect(only).toBeLessThan(DEFAULT_PLOT.width - DEFAULT_PLOT.padRight);
  });
});

describe('drawing a series', () => {
  it('draws nothing at all for an empty series', () => {
    // A stub path along the floor reads as "zero throughout", which is a
    // different claim from "nothing recorded".
    expect(linePath([], 100)).toBe('');
    expect(areaPath([], 100)).toBe('');
    expect(bars([], 100)).toEqual([]);
  });

  it('starts with a move and continues with lines', () => {
    const d = linePath([10, 20, 30], 30);
    expect(d.startsWith('M')).toBe(true);
    expect(d.match(/L/g)).toHaveLength(2);
  });

  it('closes the area along the baseline', () => {
    const d = areaPath([10, 20], 20);
    expect(d.endsWith('Z')).toBe(true);
    expect(d).toContain(String(yOf(0, 20)));
  });

  it('gives a zero value no bar rather than a sliver', () => {
    // A sliver reads as a small amount of something.
    const [zero, some] = bars([0, 50], 50);
    expect(zero.height).toBe(0);
    expect(some.height).toBeGreaterThan(0);
  });

  it('keeps bars inside the plot and apart from each other', () => {
    const drawn = bars([10, 20, 30], 30);
    expect(drawn[0].x).toBeGreaterThanOrEqual(DEFAULT_PLOT.padLeft);
    const lastEdge = drawn[2].x + drawn[2].width;
    expect(lastEdge).toBeLessThanOrEqual(DEFAULT_PLOT.width - DEFAULT_PLOT.padRight);
    expect(drawn[1].x).toBeGreaterThan(drawn[0].x + drawn[0].width);
  });
});

describe('dividing one bar into shares', () => {
  const segs = [
    { key: 'a', label: 'To do', value: 30 },
    { key: 'b', label: 'In progress', value: 50 },
    { key: 'c', label: 'Done', value: 20 },
  ];

  it('gives each piece its share and lays them end to end', () => {
    const pieces = stack(segs);
    expect(pieces.map(p => p.widthPct)).toEqual([30, 50, 20]);
    expect(pieces.map(p => p.offsetPct)).toEqual([0, 30, 80]);
  });

  it('fills the bar exactly', () => {
    const pieces = stack(segs);
    const last = pieces[pieces.length - 1];
    expect(last.offsetPct + last.widthPct).toBeCloseTo(100, 5);
  });

  it('leaves out what has no value, rather than drawing a zero-width piece', () => {
    expect(stack([...segs, { key: 'd', label: 'Rework', value: 0 }]))
      .toHaveLength(3);
  });

  it('draws nothing when nothing has a value', () => {
    // Equal shares of zero would say every stage holds the same number of
    // villages, which is the opposite of what it means.
    expect(stack([
      { key: 'a', label: 'To do', value: 0 },
      { key: 'b', label: 'Done', value: 0 },
    ])).toEqual([]);
  });

  it('handles a single segment taking the whole bar', () => {
    const pieces = stack([{ key: 'a', label: 'All of it', value: 7 }]);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toMatchObject({ offsetPct: 0, widthPct: 100 });
  });
});
