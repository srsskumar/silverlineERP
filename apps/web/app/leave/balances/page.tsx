'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { getMyEmployee } from '@/lib/employees';
import { listBalances, listTypes, upsertBalance } from '@/lib/leave';
import { queryKeys } from '@/lib/query-keys';
import { leaveBalanceSchema, type LeaveBalanceFormInput } from '@/lib/validation';
import { applyFieldErrors } from '@/lib/form-errors';
import { BalanceCards } from '@/components/BalanceCards';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';

export const dynamic = 'force-static';

const inputClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1';

/**
 * Admin balance adjust dialog (leave.admin). Upserts the opening balance for
 * an employee + type + year; the server returns the refreshed balance row.
 */
function AdjustDialog({
  open,
  onClose,
  defaultEmployeeId,
  defaultYear,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  defaultEmployeeId?: string;
  defaultYear: number;
  onSaved: () => void;
}) {
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const [saved, setSaved] = React.useState(false);

  const typesQuery = useQuery({
    queryKey: queryKeys.leave.types(),
    queryFn: listTypes,
    enabled: open,
    staleTime: 10 * 60_000,
  });

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LeaveBalanceFormInput>({
    resolver: zodResolver(leaveBalanceSchema),
    defaultValues: { employee_id: defaultEmployeeId ?? '', leave_type_id: '', period_year: defaultYear, opening_balance: 0 },
  });

  React.useEffect(() => {
    if (open) {
      reset({ employee_id: defaultEmployeeId ?? '', leave_type_id: '', period_year: defaultYear, opening_balance: 0 });
      setSubmitError(null);
      setSaved(false);
    }
  }, [open, defaultEmployeeId, defaultYear, reset]);

  const mutation = useMutation({
    mutationFn: (v: LeaveBalanceFormInput) =>
      upsertBalance({
        employee_id: v.employee_id,
        leave_type_id: v.leave_type_id,
        period_year: v.period_year,
        opening_balance: v.opening_balance,
      }),
    onSuccess: () => {
      setSaved(true);
      setSubmitError(null);
      onSaved();
    },
    onError: (err) => {
      const mapped = applyFieldErrors(err, (f, e) => setError(f as keyof LeaveBalanceFormInput, e));
      if (!mapped) setSubmitError(err);
    },
  });

  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="Adjust balance" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg bg-surface p-6 shadow-lg">
        <h2 className="text-base font-semibold text-text">Adjust opening balance</h2>
        {saved ? (
          <div className="mt-4 flex flex-col gap-3">
            <div role="status" className="rounded-md border border-success/30 bg-success-subtle px-3 py-2 text-sm text-success">
              Balance upserted. Close and review the updated cards.
            </div>
            <div className="flex justify-end">
              <Button variant="secondary" onClick={onClose}>Close</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="mt-4 flex flex-col gap-4" noValidate>
            <FormField label="Employee ID *" htmlFor="bal-employee" error={errors.employee_id?.message}>
              <Input id="bal-employee" invalid={!!errors.employee_id} {...register('employee_id')} />
            </FormField>
            <FormField label="Leave type *" htmlFor="bal-type" error={errors.leave_type_id?.message}>
              <select id="bal-type" className={inputClass} {...register('leave_type_id')}>
                <option value="">Pick a leave type…</option>
                {(typesQuery.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.code} — {t.name}
                  </option>
                ))}
              </select>
            </FormField>
            <div className="grid grid-cols-2 gap-4">
              <FormField label="Year *" htmlFor="bal-year" error={errors.period_year?.message}>
                <Input id="bal-year" inputMode="numeric" {...register('period_year')} />
              </FormField>
              <FormField label="Opening balance *" htmlFor="bal-opening" error={errors.opening_balance?.message}>
                <Input id="bal-opening" inputMode="decimal" {...register('opening_balance')} />
              </FormField>
            </div>
            {submitError ? <ErrorCard title="Could not upsert balance" error={submitError} /> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
              <Button type="submit" loading={isSubmitting || mutation.isPending}>Save balance</Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function BalancesPanel() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const canAdmin = hasPermission({ permissions: session?.permissions }, PERMISSIONS.LEAVE_ADMIN);

  const currentYear = new Date().getFullYear();
  const [year, setYear] = React.useState(String(currentYear));
  const [employeeInput, setEmployeeInput] = React.useState('');
  const [employeeId, setEmployeeId] = React.useState<string | null>(null);
  const [adjustOpen, setAdjustOpen] = React.useState(false);
  const [meLoading, setMeLoading] = React.useState(false);
  const [meError, setMeError] = React.useState<unknown>(null);

  const yearNum = Number(year);
  const yearValid = Number.isInteger(yearNum) && yearNum >= 2000 && yearNum <= 2100;

  const balancesQuery = useQuery({
    queryKey: queryKeys.leave.balances({ employee_id: employeeId ?? 'none', period_year: year }),
    queryFn: () => listBalances({ employee_id: employeeId as string, period_year: yearNum }),
    enabled: !!employeeId && yearValid,
    staleTime: 30_000,
  });

  const typesQuery = useQuery({
    queryKey: queryKeys.leave.types(),
    queryFn: listTypes,
    staleTime: 10 * 60_000,
  });

  const loadMine = async () => {
    setMeLoading(true);
    setMeError(null);
    try {
      const me = await getMyEmployee();
      setEmployeeId(me.id);
      setEmployeeInput(me.id);
    } catch (err) {
      setMeError(err);
    } finally {
      setMeLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 sm:flex-row sm:items-end">
        <div className="flex-1">
          <FormField label="Employee ID (or emp_no)" htmlFor="bal-lookup">
            <Input
              id="bal-lookup"
              placeholder="Paste an employee ID…"
              value={employeeInput}
              onChange={(e) => setEmployeeInput(e.target.value)}
            />
          </FormField>
        </div>
        <div>
          <FormField label="Year" htmlFor="bal-year-filter">
            <Input id="bal-year-filter" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} />
          </FormField>
        </div>
        <Button variant="secondary" disabled={!employeeInput.trim()} onClick={() => setEmployeeId(employeeInput.trim())}>
          Load balances
        </Button>
        <Button variant="secondary" loading={meLoading} onClick={loadMine}>
          My balances
        </Button>
        {canAdmin && (
          <Button onClick={() => setAdjustOpen(true)}>
            Adjust…
          </Button>
        )}
      </div>

      {meError ? <ErrorCard title="Could not load your employee record" error={meError} /> : null}
      {!yearValid && <ErrorCard title="Invalid year" error={new Error('Enter a 4-digit year (2000–2100).')} />}

      {!employeeId ? (
        <EmptyState
          title="No employee selected"
          description="Enter an employee ID manually (there is no employee search endpoint for balances) or use “My balances” to load your own row via /employees/me."
        />
      ) : balancesQuery.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : balancesQuery.isError ? (
        <ErrorCard title="Could not load balances" error={balancesQuery.error} onRetry={() => balancesQuery.refetch()} />
      ) : (balancesQuery.data ?? []).length === 0 ? (
        <EmptyState title="No balances for this employee + year" description="Balances appear after the yearly credit run or an admin adjustment." />
      ) : (
        <BalanceCards balances={balancesQuery.data ?? []} types={typesQuery.data ?? []} />
      )}

      <AdjustDialog
        open={adjustOpen}
        onClose={() => setAdjustOpen(false)}
        defaultEmployeeId={employeeId ?? employeeInput.trim() ?? undefined}
        defaultYear={yearValid ? yearNum : currentYear}
        onSaved={() => queryClient.invalidateQueries({ queryKey: queryKeys.leave.balances() })}
      />
    </div>
  );
}

export default function LeaveBalancesPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.LEAVE_REQUEST}>
        <h1 className="text-xl font-bold text-text">Leave balances</h1>
        <p className="mt-1 text-sm text-text-muted">Per-type balances for one employee and year. Adjustments need leave.admin.</p>
        <div className="mt-6">
          <BalancesPanel />
        </div>
      </RequirePermission>
    </AppShell>
  );
}
