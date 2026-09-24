import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { PERMISSIONS } from '@/lib/permissions';
import { PageHeader, PageBody } from '@/components/ui/Page';
import { FinancialPeriodsManager } from '@/components/finance/FinancialPeriodsManager';

export const dynamic = 'force-static';

export default function FinancialPeriodsPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.PERIOD_READ}>
        <PageHeader
          title="Financial periods"
          description="Close a period once its books are settled; reopen it, with a reason, if something still needs posting."
        />
        <PageBody>
          <FinancialPeriodsManager />
        </PageBody>
      </RequirePermission>
    </AppShell>
  );
}
