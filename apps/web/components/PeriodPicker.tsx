'use client';

import { periodSpanDays } from '@/lib/payroll';
import { FormField } from './ui/FormField';
import { Input } from './ui/Input';

/** Server-side period cap, mirrored from `MAX_PAYROLL_PERIOD_DAYS` (lib/validation.ts). */
const MAX_SPAN_DAYS = 62;

/**
 * Two YYYY-MM-DD date inputs with a live inclusive span day-count.
 * Validation itself lives in `payrollPeriodSchema` (lib/validation.ts);
 * this picker only previews the span (incl. the 62-day cap hint).
 */
export function PeriodPicker({
  start,
  end,
  onStartChange,
  onEndChange,
  startError,
  endError,
  idPrefix = 'pay-period',
}: {
  start: string;
  end: string;
  onStartChange: (v: string) => void;
  onEndChange: (v: string) => void;
  startError?: string;
  endError?: string;
  idPrefix?: string;
}) {
  const span = periodSpanDays(start, end);
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Period start *" htmlFor={`${idPrefix}-start`} error={startError}>
          <Input
            id={`${idPrefix}-start`}
            type="date"
            value={start}
            invalid={!!startError}
            onChange={(e) => onStartChange(e.target.value)}
          />
        </FormField>
        <FormField label="Period end *" htmlFor={`${idPrefix}-end`} error={endError}>
          <Input
            id={`${idPrefix}-end`}
            type="date"
            value={end}
            invalid={!!endError}
            onChange={(e) => onEndChange(e.target.value)}
          />
        </FormField>
      </div>
      <p role="status" className="text-xs text-slate-500">
        {span === null
          ? 'Enter valid YYYY-MM-DD dates to preview the span.'
          : span <= 0
            ? 'Period end must be on or after period start.'
            : `${span} day${span === 1 ? '' : 's'}${span > MAX_SPAN_DAYS ? ` — exceeds the ${MAX_SPAN_DAYS}-day limit` : ''}`}
      </p>
    </div>
  );
}
