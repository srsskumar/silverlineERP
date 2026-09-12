'use client';

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { cancelRequest, type LeaveRequest } from '@/lib/leave';
import { Button } from './ui/Button';
import { ErrorCard } from './ui/ErrorCard';
import { FormField } from './ui/FormField';
import { Input } from './ui/Input';

const inputClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1';

/** Cancel your own PENDING request (confirm + optional reason). */
export function CancelButton({
  requestId,
  onCancelled,
}: {
  requestId: string;
  onCancelled?: (req: LeaveRequest) => void;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const mutation = useMutation({
    mutationFn: () => cancelRequest(requestId, reason.trim() ? { reason: reason.trim() } : {}),
    onSuccess: (req) => {
      setSubmitError(null);
      setConfirming(false);
      onCancelled?.(req);
    },
    onError: (err) => setSubmitError(err),
  });

  if (!confirming) {
    return (
      <Button variant="danger" onClick={() => setConfirming(true)}>
        Cancel request
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-danger/30 bg-danger-subtle p-4">
      <p className="text-sm font-medium text-danger">Cancel this pending request?</p>
      <FormField label="Reason (optional)" htmlFor="leave-cancel-reason">
        <Input
          id="leave-cancel-reason"
          className={inputClass}
          placeholder="Why are you cancelling…"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </FormField>
      {submitError ? <ErrorCard title="Could not cancel request" error={submitError} /> : null}
      <div className="flex gap-2">
        <Button variant="secondary" onClick={() => { setConfirming(false); setSubmitError(null); }}>
          Keep request
        </Button>
        <Button variant="danger" loading={mutation.isPending} onClick={() => mutation.mutate()}>
          Confirm cancel
        </Button>
      </div>
    </div>
  );
}
