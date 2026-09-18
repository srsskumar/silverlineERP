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
import { apiRequest, apiRequestRaw } from '@/lib/apiClient';
import { Notice } from '@/components/finance/Primitives';
import { useToast } from '@/components/ui/Toast';
import { messageOf } from '@/lib/form-errors';

type Row = Record<string, unknown>;
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
      <dt className="w-40 shrink-0 text-xs font-medium uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="text-sm text-text">{value}</dd>
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
      <p className="text-sm text-text-muted">
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
        <label className="flex items-start gap-2 text-sm text-text-muted">
          <input type="checkbox" checked={recalculate} disabled={!allowed || mutation.isPending}
            onChange={(e) => setRecalculate(e.target.checked)} className="mt-1" />
          Recalculate this period from corrected records. This returns the run to OPEN and requires approval again. Previous payslip versions remain in history.
        </label>
        </>
      )}

      {sealedExpected && (
        <div role="alert" className="rounded-lg border border-warning/30 bg-warning-subtle px-4 py-3">
          <p className="text-sm font-medium text-warning">Wrong state (RUN_SEALED)</p>
          <p className="mt-1 text-sm text-warning">
            The run moved on — this action needs state {sealedExpected}. Reload to see the current state, then
            continue from there.
          </p>
          {requestIdOf(submitError) && (
            <p className="mt-1 text-xs text-warning">Request ID: {requestIdOf(submitError)}</p>
          )}
        </div>
      )}
      {isRunSealed(submitError) && !sealedExpected && (
        <ErrorCard title="Wrong state (RUN_SEALED)" error={submitError} />
      )}
      {noAttendance && (
        <div role="alert" className="rounded-lg border border-warning/30 bg-warning-subtle px-4 py-3">
          <p className="text-sm font-medium text-warning">No attendance data (NO_ATTENDANCE_DATA)</p>
          <p className="mt-1 text-sm text-warning">
            Nothing can be calculated — no attendance records exist for this period. Record attendance first, then
            retry calculation.
          </p>
          {requestIdOf(submitError) && (
            <p className="mt-1 text-xs text-warning">Request ID: {requestIdOf(submitError)}</p>
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
        {!allowed && <span className="text-xs text-text-muted">needs {action.perm}</span>}
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
          <div className="rounded-lg border border-border bg-surface p-4 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="font-mono text-xl font-bold text-text">
                  {formatPeriod(detail.run.period_start, detail.run.period_end)}
                </h1>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <RunStatusBadge status={String(detail.run.status)} />
                  {typeof detail.run.version === 'number' && (
                    <span className="text-xs text-text-muted">v{detail.run.version}</span>
                  )}
                </div>
              </div>
              <Link href="/payroll" className="text-sm text-primary hover:underline">
                Back to runs
              </Link>
            </div>
            <dl className="mt-4 divide-y divide-border">
              <DetailRow label="Run ID" value={<span className="font-mono text-xs">{detail.run.id}</span>} />
              <DetailRow
                label="Timeline"
                value={<RunTimeline status={String(detail.run.status)} />}
              />
            </dl>
          </div>

          <div className="rounded-lg border border-border bg-surface p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-text">Totals</h2>
            <div className="mt-3">
              <TotalsCards totals={detail.totals} />
            </div>
          </div>

          <LabourCostPanel runId={id} />

          <div className="rounded-lg border border-border bg-surface p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-text">Warnings ({detail.warnings.length})</h2>
            <div className="mt-3">
              <WarningsList warnings={detail.warnings} />
            </div>
          </div>

          <div className="rounded-lg border border-border bg-surface p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-text">Next step</h2>
            <p className="mt-1 text-xs text-text-muted">
              One action at a time — the state machine guards the order (no version handshake in P1).
            </p>
            <div className="mt-3">
              <RunActions detail={detail} onChanged={refetchAll} />
            </div>
          </div>

          <div className="rounded-lg border border-border bg-surface p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-text">Payslips</h2>
            <p className="mt-1 text-xs text-text-muted">
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

/* ------------------------------------------ labour cost onto the projects */

/**
 * Where this run's wage bill was earned (§note 10).
 *
 * The cost ledger only ever heard from expense claims and manual
 * adjustments, so in a survey business — where the dominant cost is crew days
 * in the field — every project's margin was revenue against almost nothing.
 *
 * Shown here because this is where somebody stands once a run is locked, and
 * posting is the next thing that happens to it. The figures are real money
 * apportioned by real days: attendance names the village a crew checked out
 * of, the village belongs to a programme, and the programme to a project.
 */
export function LabourCostPanel({ runId }: { runId: string }) {
  const { session } = useAuth();
  const perms = { permissions: session?.permissions };
  const canRead = hasPermission(perms, 'cost.read');
  const canPost = hasPermission(perms, 'cost.adjust');
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = React.useState('');

  const cost = useQuery({
    queryKey: ['labour-cost', runId],
    enabled: canRead,
    queryFn: async () =>
      (await apiRequestRaw(`/api/v1/payroll-runs/${runId}/labour-cost`)).body as Row,
  });

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['labour-cost', runId] }); };

  const postIt = useMutation({
    mutationFn: async () =>
      apiRequest(`/api/v1/payroll-runs/${runId}/labour-cost`, { method: 'POST', body: {} }),
    onError: (e) => toast.error('Nothing was posted', messageOf(e)),
    onSuccess: () => {
      toast.success('Posted to the cost ledger',
        'Each project’s budget position now includes this month’s wages.');
      refresh();
    },
  });

  const reverseIt = useMutation({
    mutationFn: async () =>
      apiRequest(`/api/v1/payroll-runs/${runId}/labour-cost/reverse`,
        { method: 'POST', body: { reason } }),
    onError: (e) => toast.error('Nothing was reversed', messageOf(e)),
    onSuccess: () => {
      toast.success('Reversed',
        'Both the posting and the reversal stay on the ledger, and the run can be posted again.');
      setReason('');
      refresh();
    },
  });

  if (!canRead) return null;

  const d = cost.data?.data as Row | undefined;
  const lines: Row[] = (d?.lines as Row[]) ?? [];
  const money = (n: unknown) =>
    `₹${Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

  return (
    <div className="rounded-lg border border-border bg-surface p-4 sm:p-6">
      <h2 className="text-sm font-semibold text-text">Labour cost by project</h2>

      {cost.isLoading ? <Skeleton className="mt-3 h-32" /> : null}
      {cost.isError ? (
        <ErrorCard className="mt-3" error={cost.error} onRetry={() => cost.refetch()} />
      ) : null}

      {d ? (
        <>
          <p className="mt-2 text-xs text-text-muted">
            Apportioned across projects by the days each person actually worked on them.
            Attendance names the village a crew checked out of, and the village is what ties
            a day to a project.
          </p>

          {lines.length > 0 ? (
            <ul className="mt-3 divide-y divide-border">
              {lines.map((l) => (
                <li key={String(l.projectId)} className="flex items-baseline gap-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-text">
                    {(l.project as Row)?.name
                      ? `${String((l.project as Row).code)} — ${String((l.project as Row).name)}`
                      : String(l.projectId)}
                  </span>
                  <span className="text-2xs text-text-subtle">
                    {String(l.days)} day(s) · {String(l.employees)} person(s)
                  </span>
                  <span className="tabular-nums text-text">{money(l.amount)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-text-muted">
              No day in this period was recorded against a project.
            </p>
          )}

          {Number(d.unattributed_amount) > 0 ? (
            <div className="mt-3">
              <Notice tone="warning" title="Some of this month landed nowhere">
              {money(d.unattributed_amount)} across {String(d.unattributed_days)} day(s) is not
              charged to any project — office days, training, or a check-out that never named a
              village. It is left unattributed rather than spread across whichever projects
              happen to be listed, because charging a project for a day nobody worked on it is
              worse than admitting the day is unaccounted for.
              </Notice>
            </div>
          ) : null}

          {d.already_posted ? (
            <div className="mt-4 space-y-2">
              <Notice tone="info" title="Already on the cost ledger">
                {money(d.posted_total)} was posted from this run. Reverse it if the run has been
                reopened and the numbers have changed — both entries stay on the ledger.
              </Notice>
              {canPost ? (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex flex-1 flex-col gap-1 text-2xs text-text-muted">
                    Why it is being reversed
                    <input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Attendance corrected, run reopened…"
                      className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text"
                    />
                  </label>
                  <Button type="button" variant="secondary"
                    disabled={!reason.trim() || reverseIt.isPending}
                    onClick={() => reverseIt.mutate()}>
                    Reverse
                  </Button>
                </div>
              ) : null}
            </div>
          ) : !d.postable ? (
            <div className="mt-3">
              <Notice tone="info" title="Not ready to post">
              Only a locked run can be posted. Anything earlier can still be recalculated, and
              the cost would have to be chased with reversals when it moved.
              </Notice>
            </div>
          ) : canPost && lines.length > 0 ? (
            <Button type="button" className="mt-4"
              disabled={postIt.isPending}
              onClick={() => postIt.mutate()}>
              Post {money(lines.reduce((t, l) => t + Number(l.amount), 0))} to the cost ledger
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
