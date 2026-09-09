'use client';

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiClientError } from '@/lib/apiClient';
import { closeProject, parseProjectOpenTasks, type Project } from '@/lib/projects';
import { requestIdOf } from '@/lib/form-errors';
import { Button } from './ui/Button';
import { ErrorCard } from './ui/ErrorCard';

/**
 * Close-project dialog. The server refuses with 422 PROJECT_HAS_OPEN_TASKS
 * `{open_count}` while open tasks remain — the count is shown inline so the
 * user knows how many tasks to finish first.
 */
export function CloseProjectDialog({
  projectId,
  open,
  onClose,
  onClosed,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onClosed: (project: Project) => void;
}) {
  const [reason, setReason] = React.useState('');
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  React.useEffect(() => {
    if (open) {
      setReason('');
      setSubmitError(null);
    }
  }, [open ]);

  const mutation = useMutation({
    mutationFn: () => closeProject(projectId, reason.trim() ? { reason: reason.trim() } : {}),
    onSuccess: (project) => {
      setSubmitError(null);
      onClosed(project);
      onClose();
    },
    onError: (err) => setSubmitError(err),
  });

  if (!open) return null;

  return (
    <div role="dialog" aria-modal="true" aria-label="Close project" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
        <h2 className="text-base font-semibold text-slate-900">Close project</h2>
        <p className="mt-1 text-xs text-slate-500">
          Closing is final-ish: finish or cancel all open tasks first, or the server will refuse.
        </p>
        <div className="mt-4 flex flex-col gap-1">
          <label htmlFor="close-reason" className="text-sm font-medium text-slate-700">
            Reason (optional)
          </label>
          <textarea
            id="close-reason"
            rows={2}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1"
            placeholder="e.g. All deliverables accepted…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        {submitError ? <CloseError error={submitError} /> : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={mutation.isPending} onClick={() => mutation.mutate()}>
            Close project
          </Button>
        </div>
      </div>
    </div>
  );
}

function CloseError({ error }: { error: unknown }) {
  const code = error instanceof ApiClientError ? error.code : undefined;
  const requestId = requestIdOf(error);
  if (code === 'PROJECT_HAS_OPEN_TASKS') {
    const openCount = parseProjectOpenTasks(error);
    return (
      <div role="alert" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <p className="font-medium">
          Cannot close — {openCount !== null ? `${openCount} open task${openCount === 1 ? '' : 's'} remain${openCount === 1 ? 's' : ''}` : 'open tasks remain'}.
        </p>
        <p className="mt-1">Finish or cancel the remaining tasks on the project page, then close again.</p>
        {requestId && <p className="mt-1 text-xs opacity-75">Request ID: {requestId}</p>}
      </div>
    );
  }
  return (
    <div className="mt-3">
      <ErrorCard title={code ? `Could not close project (${code})` : 'Could not close project'} error={error} />
    </div>
  );
}
