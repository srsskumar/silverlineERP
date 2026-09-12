'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { getEmployee, patchEmployee } from '@/lib/employees';
import { queryKeys } from '@/lib/query-keys';
import { displayMasked, displayEmployeeName } from '@/lib/masking';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmployeeForm } from '@/components/EmployeeForm';
import { DocumentList } from '@/components/DocumentList';
import { ExitDialog } from '@/components/ExitDialog';
import { ReactivateDialog } from '@/components/ReactivateDialog';

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
      <dt className="w-40 shrink-0 text-xs font-medium uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="text-sm text-text">{value}</dd>
    </div>
  );
}

export function EmployeeDetailView({ id }: { id: string }) {
  const { session } = useAuth();
  const holder = { permissions: session?.permissions };
  const canUpdate = hasPermission(holder, PERMISSIONS.EMPLOYEE_UPDATE);
  const canExit = hasPermission(holder, PERMISSIONS.EMPLOYEE_EXIT);
  const canReactivate = hasPermission(holder, PERMISSIONS.EMPLOYEE_REACTIVATE);
  const canUpload = hasPermission(holder, PERMISSIONS.DOCUMENT_UPLOAD);
  const queryClient = useQueryClient();
  const [exitOpen, setExitOpen] = React.useState(false);
  const [reactivateOpen, setReactivateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [savedTick, setSavedTick] = React.useState(0);

  const detailQuery = useQuery({
    queryKey: queryKeys.employees.detail(id),
    queryFn: () => getEmployee(id),
  });

  const refetchAll = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.employees.detail(id) });
  };

  if (detailQuery.isLoading) return <Skeleton className="h-96 w-full" />;
  if (detailQuery.isError) {
    return <ErrorCard title="Could not load employee" error={detailQuery.error} onRetry={() => detailQuery.refetch()} />;
  }
  const emp = detailQuery.data;
  if (!emp) return <EmptyState title="Employee not found" />;
  const exited = emp.status === 'EXITED' || emp.status === 'TERMINATED';

  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.EMPLOYEE_READ}>
        <div className="flex flex-col gap-6">
          <div className="rounded-lg border border-border bg-surface p-4 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-xl font-bold text-text">
                  {displayEmployeeName(emp)} <span className="font-mono text-sm font-normal text-text-muted">{emp.emp_no}</span>
                </h1>
                <div className="mt-2 flex items-center gap-2">
                  <Badge>{emp.status}</Badge>
                  <span className="text-xs text-text-muted">v{emp.version}</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {canUpdate && (
                  <Button variant="secondary" onClick={() => setEditing((v) => !v)}>
                    {editing ? 'Cancel edit' : 'Edit'}
                  </Button>
                )}
                {!exited && canExit && (
                  <Button variant="danger" onClick={() => setExitOpen(true)}>
                    Exit
                  </Button>
                )}
                {exited && canReactivate && (
                  <Button variant="secondary" onClick={() => setReactivateOpen(true)}>
                    Reactivate
                  </Button>
                )}
              </div>
            </div>
            <dl className="mt-4 divide-y divide-border">
              <DetailRow label="Phone" value={displayMasked(emp.phone ?? null, emp.phone_last4 ?? null)} />
              <DetailRow label="Email" value={(emp.email as string) ?? '—'} />
              <DetailRow label="Designation" value={(emp.designation as string) ?? '—'} />
              <DetailRow label="Department" value={(emp.department as string) ?? '—'} />
              <DetailRow label="Joined" value={(emp.date_of_joining as string) ?? '—'} />
              <DetailRow label="Aadhaar" value={displayMasked(emp.aadhaar ?? null, emp.aadhaar_last4 ?? null)} />
              <DetailRow label="PAN" value={displayMasked(emp.pan ?? null, emp.pan_last4 ?? null)} />
              <DetailRow label="Bank account" value={displayMasked(emp.bank_account ?? null, emp.bank_account_last4 ?? null)} />
              <DetailRow label="PhonePe" value={displayMasked(emp.phonepe_number ?? null, null)} />
              <DetailRow
                label="Salary basic"
                value={displayMasked(
                  emp.salary_basic !== null && emp.salary_basic !== undefined ? String(emp.salary_basic) : null,
                  null,
                )}
              />
              {emp.date_of_exit && <DetailRow label="Exit date" value={String(emp.date_of_exit)} />}
              {emp.exit_reason && <DetailRow label="Exit reason" value={String(emp.exit_reason)} />}
            </dl>
          </div>

          {editing && canUpdate && (
            <div className="rounded-lg border border-border bg-surface p-4 sm:p-6">
              <h2 className="mb-4 text-sm font-semibold text-text">Edit employee (v{emp.version})</h2>
              <EmployeeForm
                key={`${emp.version}-${savedTick}`}
                mode="edit"
                defaultValues={emp as unknown as Record<string, unknown>}
                submitLabel="Save changes"
                onConflictReload={refetchAll}
                onSubmit={async (values) => {
                  const { emp_no: _omit, ...patch } = values;
                  await patchEmployee(id, patch, emp.version);
                  setSavedTick((t) => t + 1);
                  setEditing(false);
                  await refetchAll();
                }}
              />
            </div>
          )}

          <DocumentList employeeId={id} canUpload={canUpload} />

          <ExitDialog
            employeeId={id}
            employeeName={displayEmployeeName(emp)}
            dateOfJoining={(emp.date_of_joining as string) ?? undefined}
            open={exitOpen}
            onClose={() => setExitOpen(false)}
            onSuccess={refetchAll}
          />
          <ReactivateDialog
            employeeId={id}
            employeeName={displayEmployeeName(emp)}
            open={reactivateOpen}
            onClose={() => setReactivateOpen(false)}
            onSuccess={refetchAll}
          />
        </div>
      </RequirePermission>
    </AppShell>
  );
}
