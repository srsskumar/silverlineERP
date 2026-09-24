'use client';

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiRequest } from '@/lib/apiClient';
import { Button } from '@/components/ui/Button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter,
} from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/Toast';
import { messageOf } from '@/lib/form-errors';
import { MILESTONE_LABELS } from '@silverline/shared';

type Row = Record<string, any>;

/** The same gate the API applies to a reversal (SV-019): administrators only. */
export function mayReversePayments(roles: readonly string[] | undefined | null): boolean {
  return (roles ?? []).some((r) => r === 'ADMIN' || r === 'SUPER_ADMIN');
}

/** The shortest reason the API accepts. */
export const REVERSAL_REASON_MIN = 5;

/**
 * Reversing a payment recorded by mistake (SV-019).
 *
 * A paid claim is closed to every ordinary edit, so this is the only way back
 * from a wrong "Paid". It asks for the reason before anything is sent and
 * sends the claim's version, so a claim somebody else has just changed is not
 * reversed on the strength of a stale screen. The claim returns to approved
 * and can be corrected from there.
 */
export function ReversePaymentDialog({ claim, onDone }: { claim: Row; onDone: () => void }) {
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const ready = reason.trim().length >= REVERSAL_REASON_MIN;

  const reverse = useMutation({
    mutationFn: async () => apiRequest(`/api/v1/survey/billing/${claim.id}/reverse`, {
      method: 'POST',
      headers: { 'If-Match': String(claim.version) },
      body: { reason: reason.trim() },
    }),
    onError: (e) => toast.error('The payment was not reversed', messageOf(e)),
    onSuccess: () => {
      toast.success('Payment reversed', 'The claim is back to approved and can be corrected.');
      setOpen(false);
      setReason('');
      onDone();
    },
  });

  const milestone = MILESTONE_LABELS[Number(claim.milestone)] ?? `Milestone ${claim.milestone}`;
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setReason(''); }}>
      <Button type="button" variant="ghost" onClick={() => setOpen(true)}
        title="Withdraw a payment recorded by mistake (administrators only)">
        Reverse payment
      </Button>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Reverse this payment?</DialogTitle>
          <DialogDescription>
            {milestone} ({Number(claim.percent)}%) goes back to approved. Its share and
            extent do not change, and the reversal is recorded with your reason.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <label className="block text-2xs text-text-subtle" htmlFor={`reverse-reason-${claim.id}`}>
            Reason
          </label>
          <textarea id={`reverse-reason-${claim.id}`}
            className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text"
            rows={3} maxLength={1000} value={reason}
            onChange={(e) => setReason(e.target.value)} />
          {!ready ? (
            <p className="mt-1 text-2xs text-text-subtle">
              Say why, in at least {REVERSAL_REASON_MIN} characters.
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="button" variant="primary" disabled={!ready || reverse.isPending}
            onClick={() => reverse.mutate()}>
            {reverse.isPending ? 'Reversing…' : 'Reverse payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
