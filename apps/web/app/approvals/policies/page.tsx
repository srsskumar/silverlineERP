import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { PERMISSIONS } from '@/lib/permissions';
import { PageHeader, PageBody } from '@/components/ui/Page';
import { ApprovalPoliciesManager } from '@/components/approvals/ApprovalPoliciesManager';

export const dynamic = 'force-static';

export default function ApprovalPoliciesPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.APPROVAL_CONFIGURE}>
        <PageHeader
          title="Approval policies"
          description="The authority ladder each document type must climb before it is approved."
          breadcrumb={<Link href="/approvals" className="hover:underline">Approvals</Link>}
        />
        <PageBody>
          <ApprovalPoliciesManager />
        </PageBody>
      </RequirePermission>
    </AppShell>
  );
}
