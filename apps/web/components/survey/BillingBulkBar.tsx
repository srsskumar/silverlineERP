'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/apiClient';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/finance/Primitives';
import { useToast } from '@/components/ui/Toast';
import { messageOf } from '@/lib/form-errors';
import { businessToday } from '@/lib/finance';
import {
  MILESTONE_LABELS, MILESTONE_PERCENT, BILLING_SKIP_LABELS, BILLING_STATUS_LABELS,
} from '@silverline/shared';

type Row = Record<string, any>;

const field = 'rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text';

/**
 * Claim, or record a decision on, the villages that are selected (§066).
 *
 * A programme claims villages in batches — a mandal's worth goes out under
 * one covering letter on one date with one file number. Recording that a
 * village at a time is how thirty-eight go in and two are found months
 * later, unclaimed, on a programme everybody believes is fully billed.
 *
 * It always shows the work before it does it. The selection here usually
 * comes from a filter, and a filter is exactly the thing somebody gets wrong
 * without noticing — so the first press asks what would happen and nothing
 * is written until they have read the answer.
 */
export function BillingBulkBar({
  selected, canManage, onDone, onClear,
}: {
  selected: string[];
  canManage: boolean;
  onDone: () => void;
  onClear: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [action, setAction] = React.useState<'SUBMIT' | 'DECIDE'>('SUBMIT');
  const [milestone, setMilestone] = React.useState('1');
  const [on, setOn] = React.useState(businessToday());
  const [reference, setReference] = React.useState('');
  const [useExtent, setUseExtent] = React.useState(false);
  const [status, setStatus] = React.useState('APPROVED');
  const [remarks, setRemarks] = React.useState('');
  const [preview, setPreview] = React.useState<Row | null>(null);

  // Anything changed after a preview describes a different batch.
  React.useEffect(() => { setPreview(null); },
    [action, milestone, on, reference, useExtent, status, selected]);

  const body = (dryRun: boolean) => ({
    survey_village_ids: selected,
    action,
    milestone: Number(milestone),
    ...(action === 'SUBMIT'
      ? {
        submitted_on: on || undefined,
        reference_no: reference.trim() || undefined,
        use_village_extent: useExtent || undefined,
      }
      : { status, decided_on: on || undefined }),
    ...(remarks.trim() ? { remarks: remarks.trim() } : {}),
    dry_run: dryRun,
  });

  const run = useMutation({
    mutationFn: async (dryRun: boolean) =>
      apiRequest('/api/v1/survey/billing/bulk', { method: 'POST', body: body(dryRun) }),
    onError: (e) => {
      setPreview(null);
      toast.error('Nothing was recorded', messageOf(e));
    },
    onSuccess: (res: unknown) => {
      const d = ((res as { data?: Row }).data ?? {}) as Row;
      if (d.dry_run) { setPreview(d); return; }
      toast.success(
        action === 'SUBMIT'
          ? `${Number(d.updated)} village(s) submitted for billing`
          : `${Number(d.updated)} claim(s) recorded as ${
            (BILLING_STATUS_LABELS as Row)[status]?.toLowerCase() ?? status.toLowerCase()}`,
        (d.skipped as Row[] ?? []).length > 0
          ? `${(d.skipped as Row[]).length} left alone — see the list before applying next time.`
          : undefined,
      );
      setPreview(null);
      setReference(''); setRemarks('');
      qc.invalidateQueries({ queryKey: ['survey-villages'] });
      qc.invalidateQueries({ queryKey: ['survey-billing'] });
      onDone();
    },
  });

  if (!canManage || selected.length === 0) return null;

  const skipped = (preview?.skipped as Row[]) ?? [];
  /* Grouped by reason: a list of two hundred village names is not something
     anybody reads, while "180 already submitted at this milestone" is. */
  const byReason = skipped.reduce<Record<string, string[]>>((acc, s) => {
    const key = String(s.reason);
    (acc[key] ??= []).push(String(s.village_name));
    return acc;
  }, {});

  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface-sunken p-3">
      <div className="flex flex-wrap items-end gap-2">
        <span className="text-sm font-medium text-text">
          {selected.length} village{selected.length === 1 ? '' : 's'} selected
        </span>

        <label className="flex flex-col gap-1 text-2xs text-text-muted">
          Record
          <select className={field} value={action}
            onChange={(e) => setAction(e.target.value as 'SUBMIT' | 'DECIDE')}>
            <option value="SUBMIT">A submission for billing</option>
            <option value="DECIDE">The department’s decision</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-2xs text-text-muted">
          Milestone
          <select className={field} value={milestone}
            onChange={(e) => setMilestone(e.target.value)}>
            {[1, 2, 3].map((m) => (
              <option key={m} value={m}>
                {MILESTONE_LABELS[m]} — {MILESTONE_PERCENT[m]}%
              </option>
            ))}
          </select>
        </label>

        {action === 'DECIDE' ? (
          <label className="flex flex-col gap-1 text-2xs text-text-muted">
            Decided
            <select className={field} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Returned</option>
              <option value="PAID">Paid</option>
            </select>
          </label>
        ) : null}

        <label className="flex flex-col gap-1 text-2xs text-text-muted">
          {action === 'SUBMIT' ? 'Submitted on' : 'Decided on'}
          <input type="date" className={field} value={on} max={businessToday()}
            onChange={(e) => setOn(e.target.value)} />
        </label>

        {action === 'SUBMIT' ? (
          <>
            <label className="flex flex-col gap-1 text-2xs text-text-muted">
              Department reference
              <input className={field} value={reference} placeholder="RC/2026/114"
                onChange={(e) => setReference(e.target.value)} />
            </label>
            <label className="flex items-center gap-1.5 pb-2 text-2xs text-text-muted"
              title="The extent claimed is normally the village’s own. Typing it forty times is forty chances to transpose a digit.">
              <input type="checkbox" checked={useExtent}
                onChange={(e) => setUseExtent(e.target.checked)} />
              Claim each village’s recorded extent
            </label>
          </>
        ) : null}

        <label className="flex flex-col gap-1 text-2xs text-text-muted">
          Remarks
          <input className={field} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </label>

        <Button type="button" variant="secondary" disabled={run.isPending}
          onClick={() => run.mutate(true)}>
          {preview ? 'Check again' : 'Show what would happen'}
        </Button>
        <Button type="button" variant="ghost" onClick={onClear}>Clear selection</Button>
      </div>

      {preview ? (
        <div className="space-y-2">
          <Notice
            tone={Number(preview.would_change) > 0 ? 'info' : 'warning'}
            title={Number(preview.would_change) > 0
              ? action === 'SUBMIT'
                ? `${Number(preview.would_change)} village(s) would be submitted at ${
                  MILESTONE_LABELS[Number(milestone)]?.toLowerCase()}`
                : `${Number(preview.would_change)} claim(s) would be recorded as ${
                  (BILLING_STATUS_LABELS as Row)[status]?.toLowerCase() ?? status.toLowerCase()}`
              : 'Nothing would change'}
          >
            <div className="space-y-1">
              {(preview.villages as string[] ?? []).length > 0 ? (
                <p>
                  {(preview.villages as string[]).join(', ')}
                  {Number(preview.would_change) > (preview.villages as string[]).length
                    ? ` and ${Number(preview.would_change) - (preview.villages as string[]).length} more`
                    : ''}
                </p>
              ) : null}
              {Object.entries(byReason).map(([reason, names]) => (
                <p key={reason} className="text-text-muted">
                  {names.length} left alone —{' '}
                  {(BILLING_SKIP_LABELS as Row)[reason] ?? reason.toLowerCase().replaceAll('_', ' ')}
                  {names.length <= 5 ? `: ${names.join(', ')}` : ''}
                </p>
              ))}
              {(preview.not_found as string[] ?? []).length > 0 ? (
                <p className="text-text-muted">
                  {(preview.not_found as string[]).length} could not be found. Reload the list.
                </p>
              ) : null}
            </div>
          </Notice>

          {Number(preview.out_of_order) > 0 ? (
            <Notice tone="warning"
              title={`${Number(preview.out_of_order)} of these have no earlier claim recorded`}>
              {/* Not refused — a variation can release milestones in any
                  order. But the usual cause is the wrong milestone picked,
                  and this is the last moment to notice. */}
              They would go in at {MILESTONE_LABELS[Number(milestone)]?.toLowerCase()} without{' '}
              {Number(milestone) === 2 ? 'the first' : 'the earlier ones'} having been submitted.
              Check the milestone before applying.
            </Notice>
          ) : null}

          {Number(preview.without_extent) > 0 ? (
            <Notice tone="warning"
              title={`${Number(preview.without_extent)} of these have no extent recorded`}>
              They would be claimed with no extent against them. Add the extent from the master
              list first, or leave the extent box unticked.
            </Notice>
          ) : null}

          {Number(preview.would_change) > 0 ? (
            <Button type="button" disabled={run.isPending} onClick={() => run.mutate(false)}>
              {run.isPending ? 'Recording…' : `Apply to ${Number(preview.would_change)} village(s)`}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
