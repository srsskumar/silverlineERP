'use client';

import { inr, type PayrollTotals } from '@/lib/payroll';

function MoneyCard({ label, value, accent }: { label: string; value: unknown; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</p>
      <p className={`mt-1 font-mono text-lg font-semibold ${accent ? 'text-text' : 'text-text'}`}>
        {inr(value)}
      </p>
    </div>
  );
}

/** Run totals: gross / deductions / net + headcount ("—" when totals are absent). */
export function TotalsCards({ totals }: { totals: PayrollTotals | null | undefined }) {
  const headcount =
    totals && typeof totals.headcount === 'number' && Number.isFinite(totals.headcount)
      ? String(totals.headcount)
      : '—';
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <MoneyCard label="Gross" value={totals?.gross} />
      <MoneyCard label="Deductions" value={totals?.total_deductions} />
      <MoneyCard label="Net pay" value={totals?.net_pay} accent />
      <div className="rounded-lg border border-border bg-surface p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-text-muted">Headcount</p>
        <p className="mt-1 font-mono text-lg font-semibold text-text">{headcount}</p>
      </div>
    </div>
  );
}
