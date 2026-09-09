'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import {
  firstDayOfMonth,
  getMyPayslip,
  isNoEmployeeLink,
  isNoPayslip,
  lastDayOfMonth,
} from '@/lib/payroll';
import { queryKeys } from '@/lib/query-keys';
import { PERMISSIONS } from '@/lib/permissions';
import { PeriodPicker } from '@/components/PeriodPicker';
import { PayslipPrint } from '@/components/PayslipPrint';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';

export const dynamic = 'force-static';

/**
 * Own full-slip view (GET /payroll/payslips/me?period_start=&period_end=).
 * Period inputs default to the current month. NO_PAYSLIP renders a
 * period-empty state; NO_EMPLOYEE_LINK renders a no-link state (the caller's
 * account is not tied to an employee record) — both without a request-ID
 * error card, since they are expected outcomes, not failures.
 */
function MyPayslipPanel() {
  const [start, setStart] = React.useState(() => firstDayOfMonth());
  const [end, setEnd] = React.useState(() => lastDayOfMonth());
  const [loaded, setLoaded] = React.useState<{ period_start: string; period_end: string } | null>(null);

  const slipQuery = useQuery({
    queryKey: queryKeys.payroll.myPayslip(loaded ?? {}),
    queryFn: () => getMyPayslip(loaded as { period_start: string; period_end: string }),
    enabled: loaded !== null,
    retry: false,
  });

  const noPayslip = slipQuery.isError && isNoPayslip(slipQuery.error);
  const noLink = slipQuery.isError && isNoEmployeeLink(slipQuery.error);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4 sm:p-6 print:hidden">
        <PeriodPicker
          start={start}
          end={end}
          onStartChange={setStart}
          onEndChange={setEnd}
          idPrefix="my-payslip"
        />
        <div className="mt-3">
          <Button disabled={!start || !end} onClick={() => setLoaded({ period_start: start, period_end: end })}>
            Load payslip
          </Button>
        </div>
      </div>

      {!loaded ? (
        <EmptyState
          title="Pick a period"
          description="Defaults to the current month. Your full slip loads here and can be printed (no PDF export in P1 — use the browser print dialog)."
        />
      ) : slipQuery.isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : noPayslip ? (
        <EmptyState
          title="No payslip for this period"
          description={`Nothing was calculated for ${loaded.period_start} → ${loaded.period_end}. The run may still be open, or you were not on its payroll.`}
        />
      ) : noLink ? (
        <EmptyState
          title="No employee record linked"
          description="Your account is not linked to an employee record (NO_EMPLOYEE_LINK), so there is no slip to show. Ask HR to link your user to your employee profile."
        />
      ) : slipQuery.isError ? (
        <ErrorCard title="Could not load payslip" error={slipQuery.error} onRetry={() => slipQuery.refetch()} />
      ) : slipQuery.data ? (
        <PayslipPrint slip={slipQuery.data} />
      ) : null}
    </div>
  );
}

export default function MyPayslipPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.PAYSLIP_READ}>
        <h1 className="text-xl font-bold text-slate-900 print:hidden">My payslip</h1>
        <p className="mt-1 text-sm text-slate-500 print:hidden">
          Your full slip for a pay period — printable via the browser.
        </p>
        <div className="mt-6">
          <MyPayslipPanel />
        </div>
      </RequirePermission>
    </AppShell>
  );
}
