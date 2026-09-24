'use client';

import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { PERMISSIONS } from '@/lib/permissions';
import { LeaveBalancesPanel } from '@/components/LeaveBalancesPanel';

export const dynamic = 'force-static';

export default function LeaveBalancesPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.LEAVE_REQUEST}>
        <h1 className="text-xl font-bold text-text">Leave balances</h1>
        <p className="mt-1 text-sm text-text-muted">Per-type balances for one employee and year. Adjustments need leave.admin.</p>
        <div className="mt-6">
          <LeaveBalancesPanel />
        </div>
      </RequirePermission>
    </AppShell>
  );
}
