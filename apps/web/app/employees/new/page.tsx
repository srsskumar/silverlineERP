'use client';

import { staticHref } from '@/lib/routes';
import { useRouter } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { EmployeeForm } from '@/components/EmployeeForm';
import { PERMISSIONS } from '@/lib/permissions';
import { createEmployee } from '@/lib/employees';

export const dynamic = 'force-static';

export default function NewEmployeePage() {
  const router = useRouter();
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.EMPLOYEE_CREATE}>
        <h1 className="text-xl font-bold text-text">New employee</h1>
        <p className="mt-1 text-sm text-text-muted">Creates an employee record, then opens its detail page.</p>
        <div className="mt-6 max-w-3xl rounded-lg border border-border bg-surface p-4 sm:p-6">
          <EmployeeForm
            mode="create"
            submitLabel="Create employee"
            onSubmit={async (values) => {
              const created = await createEmployee(values);
              router.push(staticHref(`/employees/${created.id}`));
            }}
          />
        </div>
      </RequirePermission>
    </AppShell>
  );
}
