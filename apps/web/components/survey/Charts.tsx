'use client';

import * as React from 'react';
import {
  DEFAULT_PLOT, areaPath, bars, linePath, niceMax, stack, ticks, xOf, yOf,
  type Segment,
} from '@/lib/chart';

/**
 * Charts for the survey module (§39).
 *
 * Inline SVG with no charting library. This app is a static export served to
 * field users over mobile connections, and a line, some bars and a stack are
 * arithmetic rather than a framework — the arithmetic lives in lib/chart.ts
 * where it is tested, because a chart that is wrong is worse than no chart:
 * it is read at a glance and believed.
 *
 * Colours come from the theme tokens rather than literals so these follow
 * the rest of the application, including in dark mode.
 */

function Empty({ label }: { label: string }) {
  return (
    <div className="flex h-32 items-center justify-center rounded-md border border-dashed
      border-border text-xs text-text-subtle">
      {label}
    </div>
  );
}

/** Axis labels and gridlines, shared by the line and bar charts. */
function Grid({ max, unit }: { max: number; unit?: string }) {
  const p = DEFAULT_PLOT;
  return (
    <g>
      {ticks(max).map((t) => {
        const y = yOf(t, max);
        return (
          <g key={t}>
            <line x1={p.padLeft} x2={p.width - p.padRight} y1={y} y2={y}
              className="stroke-border" strokeWidth={1}
              strokeDasharray={t === 0 ? undefined : '2 3'} />
            <text x={p.padLeft - 6} y={y + 3} textAnchor="end"
              className="fill-text-subtle text-[9px]">
              {t}{unit && t === niceMax(max) ? ` ${unit}` : ''}
            </text>
          </g>
        );
      })}
    </g>
  );
}

export interface SeriesPoint { label: string; value: number }

/**
 * A line through a series, over time.
 *
 * Every point is labelled on hover rather than only at intervals: a supervisor
 * asking "which week was that" should not have to count gridlines.
 */
export function LineChart({
  points, unit, title,
}: { points: SeriesPoint[]; unit?: string; title?: string }) {
  const p = DEFAULT_PLOT;
  const values = points.map((x) => x.value);
  const max = Math.max(0, ...values);

  if (points.length === 0) return <Empty label="Nothing recorded in this range" />;

  return (
    <figure className="space-y-1">
      {title ? <figcaption className="text-xs text-text-muted">{title}</figcaption> : null}
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${p.width} ${p.height}`} role="img"
          aria-label={title ?? 'Progress over time'}
          className="h-48 w-full min-w-[420px]">
          <Grid max={max} unit={unit} />
          <path d={areaPath(values, max)} className="fill-primary/10" />
          <path d={linePath(values, max)} fill="none" strokeWidth={2}
            className="stroke-primary" strokeLinejoin="round" strokeLinecap="round" />
          {points.map((pt, i) => (
            <circle key={`${pt.label}:${i}`} cx={xOf(i, points.length)}
              cy={yOf(pt.value, max)} r={2.5} className="fill-primary">
              <title>{`${pt.label}: ${pt.value}${unit ? ` ${unit}` : ''}`}</title>
            </circle>
          ))}
          {/* Only the ends are labelled: at a year of weeks, every label
              would overlap into an unreadable band. */}
          <text x={p.padLeft} y={p.height - 6} className="fill-text-subtle text-[9px]">
            {points[0].label}
          </text>
          {points.length > 1 ? (
            <text x={p.width - p.padRight} y={p.height - 6} textAnchor="end"
              className="fill-text-subtle text-[9px]">
              {points[points.length - 1].label}
            </text>
          ) : null}
        </svg>
      </div>
    </figure>
  );
}

/** A bar per period, for comparing sizes rather than following a trend. */
export function BarChart({
  points, unit, title,
}: { points: SeriesPoint[]; unit?: string; title?: string }) {
  const p = DEFAULT_PLOT;
  const values = points.map((x) => x.value);
  const max = Math.max(0, ...values);

  if (points.length === 0) return <Empty label="Nothing recorded in this range" />;

  return (
    <figure className="space-y-1">
      {title ? <figcaption className="text-xs text-text-muted">{title}</figcaption> : null}
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${p.width} ${p.height}`} role="img"
          aria-label={title ?? 'Progress by period'}
          className="h-48 w-full min-w-[420px]">
          <Grid max={max} unit={unit} />
          {bars(values, max).map((b, i) => (
            <rect key={`${points[i].label}:${i}`} x={b.x} y={b.y}
              width={b.width} height={b.height} rx={1.5}
              className="fill-primary/70 hover:fill-primary">
              <title>{`${points[i].label}: ${points[i].value}${unit ? ` ${unit}` : ''}`}</title>
            </rect>
          ))}
        </svg>
      </div>
    </figure>
  );
}

const STACK_TONES = [
  'bg-text-subtle', 'bg-warning', 'bg-primary', 'bg-success', 'bg-danger',
];

/**
 * One bar divided into shares — villages by stage, at a glance.
 *
 * Drawn with elements rather than SVG so the pieces carry their own labels
 * and stay readable when one of them is a sliver.
 */
export function StackBar({
  segments, title,
}: { segments: Segment[]; title?: string }) {
  const pieces = stack(segments);
  const total = segments.reduce((t, s) => t + Math.max(0, s.value), 0);

  if (pieces.length === 0) return <Empty label="No villages to divide up yet" />;

  return (
    <figure className="space-y-2">
      {title ? (
        <figcaption className="flex items-baseline justify-between gap-2 text-xs">
          <span className="text-text-muted">{title}</span>
          <span className="text-text-subtle">{total} villages</span>
        </figcaption>
      ) : null}
      <div className="flex h-5 w-full overflow-hidden rounded-md border border-border"
        role="img" aria-label={pieces.map((s) => `${s.label}: ${s.value}`).join(', ')}>
        {pieces.map((s, i) => (
          <div key={s.key} style={{ width: `${s.widthPct}%` }}
            className={STACK_TONES[i % STACK_TONES.length]}
            title={`${s.label}: ${s.value} (${Math.round(s.widthPct)}%)`} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {pieces.map((s, i) => (
          <li key={s.key} className="flex items-center gap-1.5 text-2xs text-text-muted">
            <span className={`inline-block h-2 w-2 rounded-sm
              ${STACK_TONES[i % STACK_TONES.length]}`} />
            {s.label} <span className="text-text">{s.value}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
