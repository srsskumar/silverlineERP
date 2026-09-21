'use client';

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiClientError } from '@/lib/apiClient';
import { isTerminalTaskStatus, parseDependencyBlocked, parseInvalidTransition, transitionTask } from '@/lib/tasks';
import { requestIdOf } from '@/lib/form-errors';
import { hasPermission } from '@/lib/permissions';
import { useAuth } from './AuthProvider';
import { Button } from './ui/Button';
import { ErrorCard } from './ui/ErrorCard';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/Dialog';

/**
 * Who may push a task past unfinished predecessors.
 *
 * The permission the status endpoint checks before it accepts `override`
 * (work/routes.ts). Offering the button to anybody else would only offer a
 * 403.
 */
export const DEPENDENCY_OVERRIDE_PERMISSION = 'project.update';

/**
 * Status transition control. Options come from the detail's `allowed_next`
 * (server is the source of truth — the contract fixes no client-side matrix).
 * Server rule failures map to targeted messages:
 *   INVALID_TRANSITION → allowed list (from the error, else the detail prop)
 *   DEPENDENCY_BLOCKED → blocking predecessor ids
 *   SUBTASKS_OPEN      → close/cancel subtasks first
 *
 * A move blocked by unfinished predecessors can be overridden, with a
 * reason, by somebody holding project.update -- the same rule the server
 * applies. The reason goes on the audit trail beside the move.
 */
export function StatusTransitionSelect({
  taskId,
  current,
  allowedNext,
  version,
  onTransitioned,
}: {
  taskId: string;
  current: string;
  allowedNext: string[];
  version?: number | string;
  onTransitioned: () => void;
}) {
  const [next, setNext] = React.useState('');
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const [done, setDone] = React.useState<string | null>(null);
  const { session } = useAuth();
  const canOverride = hasPermission(
    { permissions: session?.permissions }, DEPENDENCY_OVERRIDE_PERMISSION);
  // The status the override dialog is for, and what has been typed as why.
  const [overriding, setOverriding] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState('');

  const mutation = useMutation({
    mutationFn: (input: { status: string; overrideReason?: string }) =>
      transitionTask(taskId, input.status, version,
        input.overrideReason ? { override: true, override_reason: input.overrideReason } : undefined),
    onSuccess: (task) => {
      setSubmitError(null);
      setDone(String(task.status));
      setNext('');
      setOverriding(null);
      setReason('');
      onTransitioned();
    },
    onError: (err) => setSubmitError(err),
  });

  React.useEffect(() => {
    setNext('');
    setDone(null);
    setSubmitError(null);
  }, [taskId, current]);

  const terminal = isTerminalTaskStatus(current);

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`task-status-${taskId}`} className="text-sm font-medium text-text-muted">
        Move to
      </label>
      {terminal ? (
        <p className="text-sm text-text-muted">
          <span className="font-mono">{current}</span> is terminal — no further transitions.
        </p>
      ) : allowedNext.length === 0 ? (
        <p className="text-sm text-text-muted">No transitions are available from {current}.</p>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row">
          <select
            id={`task-status-${taskId}`}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 sm:max-w-xs"
            value={next}
            onChange={(e) => {
              setNext(e.target.value);
              setSubmitError(null);
              setDone(null);
            }}
          >
            <option value="">Pick next status…</option>
            {allowedNext.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <Button disabled={!next} loading={mutation.isPending} onClick={() => next && mutation.mutate({ status: next })}>
            Move
          </Button>
        </div>
      )}
      {done ? (
        <p role="status" className="text-sm text-success">
          Moved to {done}.
        </p>
      ) : null}
      {submitError && !overriding ? (
        <TransitionError
          error={submitError}
          fallbackAllowed={allowedNext}
          onOverride={canOverride && next ? () => { setSubmitError(null); setOverriding(next); } : undefined}
        />
      ) : null}
      <Dialog open={overriding !== null} onOpenChange={(open) => { if (!open) { setOverriding(null); setReason(''); } }}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Move past unfinished predecessors</DialogTitle>
            <DialogDescription>
              The work this task waits on is not done. Say why it should move to{' '}
              <span className="font-mono">{overriding}</span> anyway; the reason is kept with the move.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-4 py-3">
            <label htmlFor={`override-reason-${taskId}`} className="text-sm font-medium text-text-muted">
              Reason
            </label>
            <textarea
              id={`override-reason-${taskId}`}
              className="min-h-20 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-ring"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            {submitError && overriding ? (
              <TransitionError error={submitError} fallbackAllowed={allowedNext} />
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => { setOverriding(null); setReason(''); setSubmitError(null); }}>
                Cancel
              </Button>
              <Button
                disabled={!reason.trim()}
                loading={mutation.isPending}
                onClick={() => overriding && mutation.mutate({ status: overriding, overrideReason: reason.trim() })}
              >
                Override and move
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TransitionError({
  error, fallbackAllowed, onOverride,
}: { error: unknown; fallbackAllowed: string[]; onOverride?: () => void }) {
  const code = error instanceof ApiClientError ? error.code : undefined;
  const requestId = requestIdOf(error);

  if (code === 'INVALID_TRANSITION') {
    const allowed = parseInvalidTransition(error);
    const list = allowed.length > 0 ? allowed : fallbackAllowed;
    return (
      <div role="alert" className="rounded-lg border border-warning/30 bg-warning-subtle px-4 py-3 text-sm text-warning">
        <p className="font-medium">That transition is not allowed from the current status.</p>
        {list.length > 0 ? (
          <p className="mt-1">
            Allowed next:{' '}
            <span className="font-mono text-xs">{list.join(', ')}</span>
          </p>
        ) : (
          <p className="mt-1">No transitions are available — refresh to get the latest state.</p>
        )}
        {requestId && <p className="mt-1 text-xs opacity-75">Request ID: {requestId}</p>}
      </div>
    );
  }
  if (code === 'DEPENDENCY_BLOCKED') {
    const blocking = parseDependencyBlocked(error);
    return (
      <div role="alert" className="rounded-lg border border-warning/30 bg-warning-subtle px-4 py-3 text-sm text-warning">
        <p className="font-medium">Blocked by unfinished predecessors — complete them first.</p>
        {blocking.length > 0 ? (
          <ul className="mt-1 list-disc pl-5 font-mono text-xs">
            {blocking.map((id) => (
              <li key={id}>{id}</li>
            ))}
          </ul>
        ) : null}
        {onOverride ? (
          <div className="mt-2">
            <Button size="sm" variant="secondary" onClick={onOverride}>
              Override with a reason…
            </Button>
          </div>
        ) : null}
        {requestId && <p className="mt-1 text-xs opacity-75">Request ID: {requestId}</p>}
      </div>
    );
  }
  if (code === 'SUBTASKS_OPEN') {
    return (
      <div role="alert" className="rounded-lg border border-warning/30 bg-warning-subtle px-4 py-3 text-sm text-warning">
        <p className="font-medium">Open subtasks remain.</p>
        <p className="mt-1">Close or cancel all open subtasks before moving this task.</p>
        {requestId && <p className="mt-1 text-xs opacity-75">Request ID: {requestId}</p>}
      </div>
    );
  }
  if (code === 'OVERRIDE_REASON_REQUIRED') {
    return (
      <div role="alert" className="rounded-lg border border-warning/30 bg-warning-subtle px-4 py-3 text-sm text-warning">
        <p className="font-medium">Say why the task should move anyway.</p>
        {requestId && <p className="mt-1 text-xs opacity-75">Request ID: {requestId}</p>}
      </div>
    );
  }
  return <ErrorCard title={code ? `Could not move task (${code})` : 'Could not move task'} error={error} />;
}
