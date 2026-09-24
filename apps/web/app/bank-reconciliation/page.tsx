import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { PERMISSIONS } from '@/lib/permissions';
import { PageHeader, PageBody } from '@/components/ui/Page';
import { BankReconciliationManager } from '@/components/finance/BankReconciliationManager';

export const dynamic = 'force-static';

export default function BankReconciliationPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.BANK_READ}>
        <PageHeader
          title="Bank reconciliation"
          description="Import a statement, then match each line against a payment already recorded."
        />
        <PageBody>
          <BankReconciliationManager />
        </PageBody>
      </RequirePermission>
    </AppShell>
  );
}
