'use client';

import * as React from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { getMyEmployee } from '@/lib/employees';
import { listBalances, listTypes, openYearBalances, upsertBalance, type OpenYearResult } from '@/lib/leave';
import { businessToday } from '@/lib/finance';
import { queryKeys } from '@/lib/query-keys';
import { leaveBalanceSchema, type LeaveBalanceFormInput } from '@/lib/validation';
import { applyFieldErrors } from '@/lib/form-errors';
import { BalanceCards } from '@/components/BalanceCards';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { EmployeePicker } from '@/components/EmployeePicker';
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
    control,
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
            <FormField label="Employee *" htmlFor="bal-employee" error={errors.employee_id?.message}>
              <Controller
                control={control}
                name="employee_id"
                render={({ field }) => (
                  <EmployeePicker id="bal-employee" value={field.value ?? ''} onChange={field.onChange} />
                )}
              />
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

/**
 * Bulk-open next year's balances (R5-008, leave.admin). Dry-runs first so
 * the confirm shows real preview counts, then writes for real on confirm.
 * No carry-forward: opened rows start at the leave type's plain annual
 * entitlement (owner decision, 2026-09-24).
 */
function OpenYearDialog({
  open,
  onClose,
  year,
  onOpened,
}: {
  open: boolean;
  onClose: () => void;
  year: number;
  onOpened: () => void;
}) {
  const [result, setResult] = React.useState<OpenYearResult | null>(null);

  const previewQuery = useQuery({
    queryKey: queryKeys.leave.openYearPreview(year),
    queryFn: () => openYearBalances({ year, dry_run: true }),
    enabled: open,
    staleTime: 0,
  });

  React.useEffect(() => {
    if (open) setResult(null);
  }, [open, year]);

  const confirmMutation = useMutation({
    mutationFn: () => openYearBalances({ year }),
    onSuccess: (r) => {
      setResult(r);
      onOpened();
    },
  });

  if (!open) return null;
  const preview = previewQuery.data;
  const toCreate = preview ? preview.total - preview.skipped : null;
  return (
    <div role="dialog" aria-modal="true" aria-label={`Open ${year} balances`} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg bg-surface p-6 shadow-lg">
        <h2 className="text-base font-semibold text-text">Open {year} balances</h2>
        <p className="mt-1 text-sm text-text-muted">
          Creates a {year} balance row, at the standard annual entitlement, for every active employee
          and balance-tracked leave type that does not already have one. No carry-forward — unused{' '}
          {year - 1} balance is not brought over.
        </p>
        {result ? (
          <div className="mt-4 flex flex-col gap-3">
            <div role="status" className="rounded-md border border-success/30 bg-success-subtle px-3 py-2 text-sm text-success">
              Opened {year}: {result.created} created, {result.skipped} already existed (of {result.total}).
            </div>
            <div className="flex justify-end">
              <Button variant="secondary" onClick={onClose}>Close</Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-4">
            {previewQuery.isLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : previewQuery.isError ? (
              <ErrorCard title="Could not preview" error={previewQuery.error} onRetry={() => previewQuery.refetch()} />
            ) : preview ? (
              <div role="status" className="rounded-md border border-border bg-surface-muted px-3 py-2 text-sm text-text">
                Would create <strong>{toCreate}</strong> of {preview.total} employee x type rows
                ({preview.skipped} already open).
              </div>
            ) : null}
            {confirmMutation.isError ? (
              <ErrorCard title="Could not open balances" error={confirmMutation.error} />
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
              <Button
                onClick={() => confirmMutation.mutate()}
                loading={confirmMutation.isPending}
                disabled={!preview || toCreate === 0}
              >
                {preview && toCreate === 0 ? 'Already fully open' : `Open ${year} balances`}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function BalancesPanel() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const canAdmin = hasPermission({ permissions: session?.permissions }, PERMISSIONS.LEAVE_ADMIN);

  const currentYear = new Date().getFullYear();
  const nextYear = currentYear + 1;
  const [year, setYear] = React.useState(String(currentYear));
  const [employeeInput, setEmployeeInput] = React.useState('');
  const [employeeId, setEmployeeId] = React.useState<string | null>(null);
  const [adjustOpen, setAdjustOpen] = React.useState(false);
  const [openYearOpen, setOpenYearOpen] = React.useState(false);
  const [meLoading, setMeLoading] = React.useState(false);
  const [meError, setMeError] = React.useState<unknown>(null);

  const yearNum = Number(year);
  const yearValid = Number.isInteger(yearNum) && yearNum >= 2000 && yearNum <= 2100;

  // From 1 December (org/IST time), nudge admins if next year's balances
  // are not yet open (R5-008) -- otherwise a request crossing into January
  // 422s for lack of a row, not for lack of entitlement.
  const isDecemberOrLater = businessToday().slice(5, 7) === '12';
  const rolloverBannerQuery = useQuery({
    queryKey: queryKeys.leave.openYearPreview(nextYear),
    queryFn: () => openYearBalances({ year: nextYear, dry_run: true }),
    enabled: canAdmin && isDecemberOrLater,
    staleTime: 5 * 60_000,
  });
  const rolloverOutstanding = rolloverBannerQuery.data
    ? rolloverBannerQuery.data.total - rolloverBannerQuery.data.skipped
    : 0;

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
          <FormField label="Employee" htmlFor="bal-lookup">
            <EmployeePicker
              id="bal-lookup"
              status={null}
              value={employeeInput}
              onChange={setEmployeeInput}
              placeholder="Type a name or employee number…"
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
        {canAdmin && (
          <Button variant="secondary" onClick={() => setOpenYearOpen(true)}>
            Open {nextYear} balances
          </Button>
        )}
      </div>

      {canAdmin && isDecemberOrLater && rolloverOutstanding > 0 && (
        <div role="status" className="rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-sm text-warning">
          {rolloverOutstanding} employee x type balance{rolloverOutstanding === 1 ? '' : 's'} for {nextYear}{' '}
          {rolloverOutstanding === 1 ? 'is' : 'are'} not open yet — a request crossing into January will be
          refused for lack of a balance row, not for lack of entitlement.{' '}
          <button type="button" className="font-medium underline" onClick={() => setOpenYearOpen(true)}>
            Open {nextYear} balances
          </button>
        </div>
      )}

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

      <OpenYearDialog
        open={openYearOpen}
        onClose={() => setOpenYearOpen(false)}
        year={nextYear}
        onOpened={() => {
          queryClient.invalidateQueries({ queryKey: queryKeys.leave.balances() });
          queryClient.invalidateQueries({ queryKey: queryKeys.leave.openYearPreview(nextYear) });
        }}
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
