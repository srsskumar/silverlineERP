'use client';

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiClientError } from '@/lib/apiClient';
import { isTerminalTaskStatus, parseDependencyBlocked, parseInvalidTransition, transitionTask } from '@/lib/tasks';
import { requestIdOf } from '@/lib/form-errors';
import { Button } from './ui/Button';
import { ErrorCard } from './ui/ErrorCard';

/**
 * Status transition control. Options come from the detail's `allowed_next`
 * (server is the source of truth — the contract fixes no client-side matrix).
 * Server rule failures map to targeted messages:
 *   INVALID_TRANSITION → allowed list (from the error, else the detail prop)
 *   DEPENDENCY_BLOCKED → blocking predecessor ids
 *   SUBTASKS_OPEN      → close/cancel subtasks first
 *   USE_STATUS_ENDPOINT → override flow is NOT in web S4 — ask the PM
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

  const mutation = useMutation({
    mutationFn: (status: string) => transitionTask(taskId, status, version),
    onSuccess: (task) => {
      setSubmitError(null);
      setDone(String(task.status));
      setNext('');
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
          <Button disabled={!next} loading={mutation.isPending} onClick={() => next && mutation.mutate(next)}>
            Move
          </Button>
        </div>
      )}
      {done ? (
        <p role="status" className="text-sm text-success">
          Moved to {done}.
        </p>
      ) : null}
      {submitError ? (
        <TransitionError error={submitError} fallbackAllowed={allowedNext} />
      ) : null}
    </div>
  );
}

function TransitionError({ error, fallbackAllowed }: { error: unknown; fallbackAllowed: string[] }) {
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
  if (code === 'USE_STATUS_ENDPOINT') {
    return (
      <div role="alert" className="rounded-lg border border-warning/30 bg-warning-subtle px-4 py-3 text-sm text-warning">
        <p className="font-medium">This transition needs a privileged override.</p>
        <p className="mt-1">The override flow is not in web S4 — ask your PM to apply the override via the API.</p>
        {requestId && <p className="mt-1 text-xs opacity-75">Request ID: {requestId}</p>}
      </div>
    );
  }
  return <ErrorCard title={code ? `Could not move task (${code})` : 'Could not move task'} error={error} />;
}
