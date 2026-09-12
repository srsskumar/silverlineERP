'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { decideRequest, type LeaveDecision, type LeaveRequest } from '@/lib/leave';
import { leaveDecisionSchema, type LeaveDecisionFormInput } from '@/lib/validation';
import { applyFieldErrors, isConflictError, requestIdOf } from '@/lib/form-errors';
import { Button } from './ui/Button';
import { ErrorCard } from './ui/ErrorCard';
import { FormField } from './ui/FormField';
import { ConflictDialog, useConflict } from './ConflictDialog';

const inputClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1';

/**
 * Approve / reject a pending leave request with If-Match versioning.
 * Reject requires a note (client-side; the server enforces NOTE_REQUIRED).
 * 409s open the ConflictDialog; Reload re-fetches the parent.
 */
export function DecisionButtons({
  requestId,
  version,
  onReload,
  onDecided,
}: {
  requestId: string;
  version: number | string;
  onReload: () => void;
  onDecided?: (req: LeaveRequest) => void;
}) {
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const [done, setDone] = React.useState<LeaveDecision | null>(null);
  const conflict = useConflict();

  const {
    register,
    handleSubmit,
    reset,
    setError,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<LeaveDecisionFormInput>({
    resolver: zodResolver(leaveDecisionSchema),
    defaultValues: { decision: 'APPROVE', note: '' },
  });
  const decision = watch('decision');

  const mutation = useMutation({
    mutationFn: (v: LeaveDecisionFormInput) =>
      decideRequest(requestId, { decision: v.decision, note: v.note?.trim() || undefined }, version),
    onSuccess: (req) => {
      setDone(req.status === 'APPROVED' || req.status === 'REJECTED' ? (req.status === 'APPROVED' ? 'APPROVE' : 'REJECT') : null);
      setSubmitError(null);
      onDecided?.(req);
    },
    onError: (err) => {
      if (isConflictError(err)) {
        conflict.show(err instanceof Error ? err.message : undefined, requestIdOf(err));
        return;
      }
      const mapped = applyFieldErrors(err, (f, e) => setError(f as keyof LeaveDecisionFormInput, e));
      if (!mapped) setSubmitError(err);
    },
  });

  React.useEffect(() => {
    setDone(null);
    setSubmitError(null);
    conflict.hide();
    reset({ decision: 'APPROVE', note: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId, version]);

  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="flex flex-col gap-3" noValidate>
        <div className="flex gap-2" role="radiogroup" aria-label="Decision">
          {(['APPROVE', 'REJECT'] as const).map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={decision === d}
              onClick={() => setValue('decision', d, { shouldValidate: true })}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ring-1 ${
                decision === d ? 'bg-primary text-primary-fg ring-primary' : 'bg-surface text-text-muted ring-border'
              }`}
            >
              {d}
            </button>
          ))}
        </div>
        <FormField
          label={decision === 'REJECT' ? 'Note * (required to reject)' : 'Note (optional)'}
          htmlFor="leave-decision-note"
          error={errors.note?.message}
        >
          <textarea
            id="leave-decision-note"
            rows={2}
            className={inputClass}
            placeholder="Decision rationale…"
            {...register('note')}
          />
        </FormField>
        {errors.decision?.message ? (
          <p role="alert" className="text-xs text-danger">
            {errors.decision.message}
          </p>
        ) : null}
        {submitError ? <ErrorCard title="Could not record decision" error={submitError} /> : null}
        {done ? (
          <p role="status" className="text-sm text-success">
            Decision recorded ({done}).
          </p>
        ) : null}
        <div>
          <Button type="submit" loading={isSubmitting || mutation.isPending}>
            Submit decision (v{String(version)})
          </Button>
        </div>
      </form>
      <ConflictDialog
        open={conflict.open}
        message={conflict.conflict?.message}
        requestId={conflict.conflict?.requestId}
        onReload={onReload}
        onClose={conflict.hide}
      />
    </div>
  );
}
