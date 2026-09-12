'use client';

import { balanceTotal, isUnpaidType, type LeaveBalance, type LeaveType } from '@/lib/leave';
import { Badge } from './ui/Badge';

/**
 * Per-type balance cards: code, current/total, used-progress bar.
 * Unpaid types (LOP / is_paid=false / requires_balance=false) show an
 * "unpaid" note instead of a balance — there is nothing to accrue.
 */
export function BalanceCards({
  balances,
  types = [],
}: {
  balances: LeaveBalance[];
  types?: LeaveType[];
}) {
  const typeById = new Map(types.map((t) => [t.id, t]));
  const typeByCode = new Map(types.map((t) => [t.code, t]));

  if (balances.length === 0) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {balances.map((b) => {
        const type = typeById.get(b.leave_type_id) ?? typeByCode.get(b.leave_code);
        const unpaid = isUnpaidType(
          type ?? { code: b.leave_code, is_paid: b.leave_code !== 'LOP', requires_balance: b.leave_code !== 'LOP' },
        );
        if (unpaid) {
          return (
            <div key={b.id} className="rounded-lg border border-border bg-surface p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="font-mono text-sm font-semibold text-text">{b.leave_code}</p>
                <Badge tone="neutral">unpaid</Badge>
              </div>
              <p className="mt-2 text-xs text-text-muted">
                Unpaid leave — no balance is tracked or checked.
              </p>
            </div>
          );
        }
        const total = balanceTotal(b);
        const current = Number(b.current_balance) || 0;
        const used = Math.max(0, total - current);
        const pct = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
        return (
          <div key={b.id} className="rounded-lg border border-border bg-surface p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="font-mono text-sm font-semibold text-text">{b.leave_code}</p>
              <Badge tone={current <= 0 ? 'danger' : current <= 2 ? 'warning' : 'success'}>
                {current} / {total} days
              </Badge>
            </div>
            <div
              className="mt-3 h-2 w-full overflow-hidden rounded-full bg-surface-sunken"
              role="progressbar"
              aria-valuenow={Math.round(pct)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${b.leave_code} used ${used} of ${total} days`}
            >
              <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-2 text-xs text-text-muted">
              Used {used} of {total} · opening {Number(b.opening_balance) || 0}, credits{' '}
              {Number(b.credits) || 0}, consumed {Number(b.consumed) || 0}, adjustments{' '}
              {Number(b.adjustments) || 0}
            </p>
          </div>
        );
      })}
    </div>
  );
}
