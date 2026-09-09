'use client';

import * as React from 'react';
import Link from '@/components/AppLink';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import {
  approveRun,
  calculateRun,
  formatPeriod,
  getRun,
  isNoAttendanceData,
  isRunSealed,
  listPayslips,
  lockRun,
  nextAction,
  parseRunSealedExpected,
  reopenRun,
  submitReviewRun,
  type RunAction,
  type RunDetail,
} from '@/lib/payroll';
import { queryKeys } from '@/lib/query-keys';
import { applyFieldErrors, requestIdOf } from '@/lib/form-errors';
import { RunStatusBadge } from '@/components/RunStatusBadge';
import { RunTimeline } from '@/components/RunTimeline';
import { TotalsCards } from '@/components/TotalsCards';
import { WarningsList } from '@/components/WarningsList';
import { PayslipTable } from '@/components/PayslipTable';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
      <dt className="w-40 shrink-0 text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-800">{value}</dd>
    </div>
  );
}

/**
 * State-machine action buttons for a run. The next action comes from
 * `nextAction(run)` ({label, endpoint, perm}); the button is disabled with a
 * "needs …" label when the session lacks the perm (reports pattern). Approve
 * carries an optional note; reopen carries a required reason. Wrong-state
 * rejections (422 RUN_SEALED) name the expected state inline; a calculate
 * with no attendance data (422 NO_ATTENDANCE_DATA) gets its own banner.
 * No If-Match is sent on transitions in P1 — the state machine is the guard.
 */
function RunActions({ detail, onChanged }: { detail: RunDetail; onChanged: () => void }) {
  const { session } = useAuth();
  const action: RunAction | null = nextAction(detail.run);
  const [note, setNote] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [recalculate, setRecalculate] = React.useState(false);
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const allowed = action
    ? hasPermission({ permissions: session?.permissions }, action.perm)
    : false;

  React.useEffect(() => {
    setNote('');
    setReason('');
    setRecalculate(false);
    setFieldError(null);
    setSubmitError(null);
  }, [detail.run.id, detail.run.status]);

  const mutation = useMutation({
    mutationFn: () => {
      if (!action) throw new Error('No action available for this state');
      switch (action.endpoint) {
        case 'calculate':
          return calculateRun(detail.run.id);
        case 'submit-review':
          return submitReviewRun(detail.run.id);
        case 'approve':
          return approveRun(detail.run.id, { note: note.trim() || undefined });
        case 'lock':
          return lockRun(detail.run.id);
        case 'reopen':
          return reopenRun(detail.run.id, { reason: reason.trim(), recalculate });
      }
    },
    onSuccess: () => {
      setSubmitError(null);
      setFieldError(null);
      onChanged();
    },
    onError: (err) => {
      const mapped = applyFieldErrors(err, (field, e) => {
        if ((action?.endpoint === 'reopen' && field === 'reason') || (action?.endpoint === 'approve' && field === 'note')) {
          setFieldError(e.message || 'Invalid value');
        }
      });
      // RUN_SEALED / NO_ATTENDANCE_DATA carry no field_errors, so they fall
      // through to submitError and render as targeted banners below.
      if (!mapped) setSubmitError(err);
    },
  });

  if (!action) {
    return (
      <p className="text-sm text-slate-500">
        {detail.run.status === 'VALIDATING'
          ? 'Calculation in progress — refresh to pick up the CALCULATED state.'
          : `No action is available in state ${String(detail.run.status)}.`}
      </p>
    );
  }

  const sealedExpected = isRunSealed(submitError) ? parseRunSealedExpected(submitError) : null;
  const noAttendance = isNoAttendanceData(submitError);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFieldError(null);
    setSubmitError(null);
    if (action.endpoint === 'reopen' && !reason.trim()) {
      setFieldError('Reason is required');
      return;
    }
    if (action.endpoint === 'approve' && note.trim().length > 1000) {
      setFieldError('Note must be at most 1000 characters');
      return;
    }
    mutation.mutate();
  };

  return (
    <form onSubmit={onSubmit} className="flex max-w-xl flex-col gap-3" noValidate>
      {action.endpoint === 'approve' && (
        <FormField label="Approval note (optional)" htmlFor="run-approve-note" error={fieldError ?? undefined}>
          <Input
            id="run-approve-note"
            placeholder="Approved — totals verified…"
            value={note}
            disabled={!allowed}
            onChange={(e) => setNote(e.target.value)}
          />
        </FormField>
      )}
      {action.endpoint === 'reopen' && (
        <>
        <FormField label="Reopen reason *" htmlFor="run-reopen-reason" error={fieldError ?? undefined}>
          <Input
            id="run-reopen-reason"
            placeholder="Why is this locked run being reopened…"
            value={reason}
            disabled={!allowed}
            onChange={(e) => setReason(e.target.value)}
          />
        </FormField>
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={recalculate} disabled={!allowed || mutation.isPending}
            onChange={(e) => setRecalculate(e.target.checked)} className="mt-1" />
          Recalculate this period from corrected records. This returns the run to OPEN and requires approval again. Previous payslip versions remain in history.
        </label>
        </>
      )}

      {sealedExpected && (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm font-medium text-amber-800">Wrong state (RUN_SEALED)</p>
          <p className="mt-1 text-sm text-amber-700">
            The run moved on — this action needs state {sealedExpected}. Reload to see the current state, then
            continue from there.
          </p>
          {requestIdOf(submitError) && (
            <p className="mt-1 text-xs text-amber-600">Request ID: {requestIdOf(submitError)}</p>
          )}
        </div>
      )}
      {isRunSealed(submitError) && !sealedExpected && (
        <ErrorCard title="Wrong state (RUN_SEALED)" error={submitError} />
      )}
      {noAttendance && (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm font-medium text-amber-800">No attendance data (NO_ATTENDANCE_DATA)</p>
          <p className="mt-1 text-sm text-amber-700">
            Nothing can be calculated — no attendance records exist for this period. Record attendance first, then
            retry calculation.
          </p>
          {requestIdOf(submitError) && (
            <p className="mt-1 text-xs text-amber-600">Request ID: {requestIdOf(submitError)}</p>
          )}
        </div>
      )}
      {submitError && !isRunSealed(submitError) && !noAttendance ? (
        <ErrorCard title={`Could not ${action.label.toLowerCase()}`} error={submitError} />
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" loading={mutation.isPending} disabled={!allowed}>
          {action.label}
        </Button>
        {!allowed && <span className="text-xs text-slate-500">needs {action.perm}</span>}
      </div>
    </form>
  );
}

export function RunDetailView({ id }: { id: string }) {
  const queryClient = useQueryClient();

  const detailQuery = useQuery({
    queryKey: queryKeys.payroll.run(id),
    queryFn: () => getRun(id),
  });

  const payslipsQuery = useQuery({
    queryKey: queryKeys.payroll.payslips(id),
    queryFn: () => listPayslips(id),
    retry: false,
  });

  const refetchAll = React.useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.payroll.run(id) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.payroll.payslips(id) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.payroll.runs() });
  }, [queryClient, id]);

  if (detailQuery.isLoading) {
    return (
      <AppShell>
        <Skeleton className="h-96 w-full" />
      </AppShell>
    );
  }
  if (detailQuery.isError) {
    return (
      <AppShell>
        <ErrorCard title="Could not load payroll run" error={detailQuery.error} onRetry={() => detailQuery.refetch()} />
      </AppShell>
    );
  }
  const detail = detailQuery.data;
  if (!detail) {
    return (
      <AppShell>
        <EmptyState title="Payroll run not found" />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.PAYROLL_READ}>
        <div className="flex flex-col gap-6">
          <div className="rounded-lg border border-slate-200 bg-white p-4 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="font-mono text-xl font-bold text-slate-900">
                  {formatPeriod(detail.run.period_start, detail.run.period_end)}
                </h1>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <RunStatusBadge status={String(detail.run.status)} />
                  {typeof detail.run.version === 'number' && (
                    <span className="text-xs text-slate-500">v{detail.run.version}</span>
                  )}
                </div>
              </div>
              <Link href="/payroll" className="text-sm text-brand-600 hover:underline">
                Back to runs
              </Link>
            </div>
            <dl className="mt-4 divide-y divide-slate-100">
              <DetailRow label="Run ID" value={<span className="font-mono text-xs">{detail.run.id}</span>} />
              <DetailRow
                label="Timeline"
                value={<RunTimeline status={String(detail.run.status)} />}
              />
            </dl>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-slate-900">Totals</h2>
            <div className="mt-3">
              <TotalsCards totals={detail.totals} />
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-slate-900">Warnings ({detail.warnings.length})</h2>
            <div className="mt-3">
              <WarningsList warnings={detail.warnings} />
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-slate-900">Next step</h2>
            <p className="mt-1 text-xs text-slate-500">
              One action at a time — the state machine guards the order (no version handshake in P1).
            </p>
            <div className="mt-3">
              <RunActions detail={detail} onChanged={refetchAll} />
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-slate-900">Payslips</h2>
            <p className="mt-1 text-xs text-slate-500">
              Summary columns only — full-slip detail is available to each employee on /my-payslip (P1 gap, see README).
            </p>
            <div className="mt-3">
              {payslipsQuery.isLoading ? (
                <Skeleton className="h-48 w-full" />
              ) : payslipsQuery.isError ? (
                <ErrorCard title="Could not load payslips" error={payslipsQuery.error} onRetry={() => payslipsQuery.refetch()} />
              ) : (
                <PayslipTable rows={payslipsQuery.data ?? []} />
              )}
            </div>
          </div>
        </div>
      </RequirePermission>
    </AppShell>
  );
}
