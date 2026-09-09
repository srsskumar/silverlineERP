'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { decideException, type AttendanceException } from '@/lib/attendance';
import { decisionSchema, type DecisionFormInput } from '@/lib/validation';
import { applyFieldErrors, isConflictError, requestIdOf } from '@/lib/form-errors';
import { Button } from './ui/Button';
import { ErrorCard } from './ui/ErrorCard';
import { FormField } from './ui/FormField';
import { ConflictDialog, useConflict } from './ConflictDialog';

const inputClass =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1';

/**
 * Single-transition exception decision (APPROVE/REJECT + optional note),
 * sent with If-Match. 409s open the ConflictDialog; Reload re-fetches the
 * parent so the caller can retry against the fresh version.
 */
export function DecisionDialog({
  open,
  onClose,
  exceptionId,
  version,
  onReload,
  onDecided,
}: {
  open: boolean;
  onClose: () => void;
  exceptionId: string;
  version: number | string;
  onReload: () => void;
  onDecided?: (ex: AttendanceException) => void;
}) {
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const conflict = useConflict();

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<DecisionFormInput>({
    resolver: zodResolver(decisionSchema),
    defaultValues: { decision: 'APPROVE', note: '' },
  });

  React.useEffect(() => {
    if (open) {
      reset({ decision: 'APPROVE', note: '' });
      setSubmitError(null);
      conflict.hide();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, exceptionId, reset]);

  const mutation = useMutation({
    mutationFn: (v: DecisionFormInput) =>
      decideException(exceptionId, { decision: v.decision, note: v.note || undefined }, version),
    onSuccess: (ex) => {
      onDecided?.(ex);
      onClose();
    },
    onError: (err) => {
      if (isConflictError(err)) {
        conflict.show(err instanceof Error ? err.message : undefined, requestIdOf(err));
        return;
      }
      const mapped = applyFieldErrors(err, (f, e) => setError(f as keyof DecisionFormInput, e));
      if (!mapped) setSubmitError(err);
    },
  });

  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="Decide exception" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
        <h2 className="text-base font-semibold text-slate-900">Decide exception</h2>
        <p className="mt-1 font-mono text-xs text-slate-500">
          {exceptionId} · v{String(version)}
        </p>
        <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="mt-4 flex flex-col gap-4" noValidate>
          <FormField label="Decision *" htmlFor="dec-decision" error={errors.decision?.message}>
            <select id="dec-decision" className={inputClass} {...register('decision')}>
              <option value="APPROVE">APPROVE</option>
              <option value="REJECT">REJECT</option>
            </select>
          </FormField>
          <FormField label="Note (optional)" htmlFor="dec-note" error={errors.note?.message}>
            <textarea id="dec-note" rows={3} className={inputClass} placeholder="Decision rationale…" {...register('note')} />
          </FormField>
          {submitError ? <ErrorCard title="Could not record decision" error={submitError} /> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={isSubmitting || mutation.isPending}>
              Submit decision
            </Button>
          </div>
        </form>
        <ConflictDialog open={conflict.open} message={conflict.conflict?.message} requestId={conflict.conflict?.requestId} onReload={onReload} onClose={conflict.hide} />
      </div>
    </div>
  );
}
