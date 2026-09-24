import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { PERMISSIONS } from '@/lib/permissions';
import { PageHeader, PageBody } from '@/components/ui/Page';
import { PaymentsManager } from '@/components/finance/PaymentsManager';

export const dynamic = 'force-static';

export default function PaymentsPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.PAYMENT_READ}>
        <PageHeader
          title="Payments"
          description="Money that actually moved — record it here, then allocate it against a bill, invoice, claim or advance."
        />
        <PageBody>
          <PaymentsManager />
        </PageBody>
      </RequirePermission>
    </AppShell>
  );
}
