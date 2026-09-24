import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { PERMISSIONS } from '@/lib/permissions';
import { PageHeader, PageBody } from '@/components/ui/Page';
import { CostHeadsManager } from '@/components/finance/CostHeadsManager';

export const dynamic = 'force-static';

export default function CostHeadsPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.COSTHEAD_READ}>
        <PageHeader
          title="Cost heads"
          description="The fixed set of labour/material/subcontract/equipment/overhead categories a project budget is built from."
        />
        <PageBody>
          <CostHeadsManager />
        </PageBody>
      </RequirePermission>
    </AppShell>
  );
}
