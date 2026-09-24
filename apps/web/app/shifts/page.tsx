import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { PERMISSIONS } from '@/lib/permissions';
import { PageHeader, PageBody } from '@/components/ui/Page';
import { ShiftsManager } from '@/components/allocation/ShiftsManager';

export const dynamic = 'force-static';

export default function ShiftsPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.ROSTER_READ}>
        <PageHeader
          title="Shifts"
          description="The windows a roster entry books an employee into — start/end time, break, and the days off that go with it."
        />
        <PageBody>
          <ShiftsManager />
        </PageBody>
      </RequirePermission>
    </AppShell>
  );
}
