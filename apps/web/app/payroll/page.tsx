'use client';

import * as React from 'react';
import Link from '@/components/AppLink';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { formatPeriod, getPolicy, listRuns, updatePolicy } from '@/lib/payroll';
import { queryKeys } from '@/lib/query-keys';
import { payrollPolicySchema, type PayrollPolicyInput } from '@/lib/validation';
import { applyFieldErrors } from '@/lib/form-errors';
import { RunStatusBadge } from '@/components/RunStatusBadge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { RUN_STATUSES } from '@/lib/payroll';

export const dynamic = 'force-static';

const inputClass =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1';

/**
 * Policy read + edit card (folded into /payroll — simpler than a route).
 * Read needs `payroll.read` (page gate); the edit dialog is gated on
 * `payroll.configure` and PATCHes `{per_day_divisor, pf_pct}`.
 */
function PolicyCard() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = React.useState(false);
  const canConfigure = hasPermission({ permissions: session?.permissions }, PERMISSIONS.PAYROLL_CONFIGURE);

  const policyQuery = useQuery({
    queryKey: queryKeys.payroll.policy(),
    queryFn: getPolicy,
    retry: false,
  });

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Payroll policy</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Per-day divisor and PF % applied to gross (display semantics in README).
          </p>
        </div>
        {canConfigure && policyQuery.data && (
          <Button variant="secondary" onClick={() => setEditOpen(true)}>
            Edit policy…
          </Button>
        )}
      </div>
      {policyQuery.isLoading ? (
        <Skeleton className="mt-3 h-12 w-full" />
      ) : policyQuery.isError ? (
        <div className="mt-3">
          <ErrorCard title="Could not load payroll policy" error={policyQuery.error} onRetry={() => policyQuery.refetch()} />
        </div>
      ) : policyQuery.data ? (
        <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Per-day divisor</dt>
            <dd className="font-mono text-sm text-slate-900">{String(policyQuery.data.per_day_divisor)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">PF %</dt>
            <dd className="font-mono text-sm text-slate-900">{String(policyQuery.data.pf_pct)}%</dd>
          </div>
        </dl>
      ) : null}
      {!canConfigure && (
        <p className="mt-2 text-xs text-slate-400">Policy edits need payroll.configure.</p>
      )}
      <PolicyDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        initialDivisor={policyQuery.data ? Number(policyQuery.data.per_day_divisor) : 30}
        initialPct={policyQuery.data ? Number(policyQuery.data.pf_pct) : 0}
        onSaved={() => queryClient.invalidateQueries({ queryKey: queryKeys.payroll.policy() })}
      />
    </div>
  );
}

function PolicyDialog({
  open,
  onClose,
  initialDivisor,
  initialPct,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  initialDivisor: number;
  initialPct: number;
  onSaved: () => void;
}) {
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const [saved, setSaved] = React.useState(false);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<PayrollPolicyInput>({
    resolver: zodResolver(payrollPolicySchema),
    defaultValues: { per_day_divisor: initialDivisor, pf_pct: initialPct },
  });

  React.useEffect(() => {
    if (open) {
      reset({ per_day_divisor: initialDivisor, pf_pct: initialPct });
      setSubmitError(null);
      setSaved(false);
    }
  }, [open, initialDivisor, initialPct, reset]);

  const mutation = useMutation({
    mutationFn: (v: PayrollPolicyInput) =>
      updatePolicy({ per_day_divisor: v.per_day_divisor, pf_pct: v.pf_pct }),
    onSuccess: () => {
      setSaved(true);
      setSubmitError(null);
      onSaved();
    },
    onError: (err) => {
      const mapped = applyFieldErrors(err, (f, e) => setError(f as keyof PayrollPolicyInput, e));
      if (!mapped) setSubmitError(err);
    },
  });

  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="Edit payroll policy" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg bg-white p-6 shadow-lg">
        <h2 className="text-base font-semibold text-slate-900">Edit payroll policy</h2>
        {saved ? (
          <div className="mt-4 flex flex-col gap-3">
            <div role="status" className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
              Policy updated.
            </div>
            <div className="flex justify-end">
              <Button variant="secondary" onClick={onClose}>Close</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="mt-4 flex flex-col gap-4" noValidate>
            <FormField label="Per-day divisor * (1–31)" htmlFor="policy-divisor" error={errors.per_day_divisor?.message}>
              <Input id="policy-divisor" inputMode="numeric" invalid={!!errors.per_day_divisor} {...register('per_day_divisor')} />
            </FormField>
            <FormField label="PF % * (0–100)" htmlFor="policy-pf" error={errors.pf_pct?.message}>
              <Input id="policy-pf" inputMode="decimal" invalid={!!errors.pf_pct} {...register('pf_pct')} />
            </FormField>
            {submitError ? <ErrorCard title="Could not update policy" error={submitError} /> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
              <Button type="submit" loading={isSubmitting || mutation.isPending}>Save policy</Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function RunsPanel() {
  const { session } = useAuth();
  const [status, setStatus] = React.useState('');
  const canGenerate = hasPermission({ permissions: session?.permissions }, PERMISSIONS.PAYROLL_GENERATE);

  const runsQuery = useQuery({
    queryKey: queryKeys.payroll.runs({ status: status || undefined }),
    queryFn: () => listRuns({ status: status || undefined }),
  });

  const rows = runsQuery.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:flex-row sm:items-end">
        <div>
          <label htmlFor="payroll-status" className="text-sm font-medium text-slate-700">Status</label>
          <select id="payroll-status" className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {RUN_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="flex-1" />
        {canGenerate && (
          <Link href="/payroll/new" className="text-sm font-medium text-brand-600 hover:underline">
            + New run
          </Link>
        )}
      </div>

      {runsQuery.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : runsQuery.isError ? (
        <ErrorCard title="Could not load payroll runs" error={runsQuery.error} onRetry={() => runsQuery.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No payroll runs"
          description="Nothing matches this filter yet. Create the first run for a pay period."
          action={
            canGenerate ? (
              <Link href="/payroll/new" className="text-sm font-medium text-brand-600 hover:underline">
                + New run
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 bg-white text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Period</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Status</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Run ID</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2 font-mono text-xs text-slate-800">
                    {formatPeriod(r.period_start, r.period_end)}
                  </td>
                  <td className="px-3 py-2">
                    <RunStatusBadge status={String(r.status)} />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{r.id}</td>
                  <td className="px-3 py-2">
                    <Link href={`/payroll/${r.id}`} className="text-brand-600 hover:underline">
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function PayrollPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.PAYROLL_READ}>
        <h1 className="text-xl font-bold text-slate-900">Payroll runs</h1>
        <p className="mt-1 text-sm text-slate-500">Pay periods, calculation state, and the payroll policy.</p>
        <div className="mt-6 flex flex-col gap-6">
          <PolicyCard />
          <RunsPanel />
        </div>
      </RequirePermission>
    </AppShell>
  );
}
