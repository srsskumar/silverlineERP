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
  MILESTONE_REQUIRES, milestoneEarned, milestoneBlockedNote, STAGE_PIPELINE,
} from '@silverline/shared';

type Row = Record<string, any>;

const field = 'rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text';

/** A stage's name, for the sentence that says what is in the way. */
const labelOfStage = (code: string): string =>
  STAGE_PIPELINE.find((s) => s.code === code)?.label
  ?? code.replace(/_/g, ' ').toLowerCase();

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
  selected, villages, canManage, onDone, onClear, onKeepEligible,
}: {
  selected: string[];
  /** The selected villages themselves, so eligibility can be read off them. */
  villages: Row[];
  canManage: boolean;
  onDone: () => void;
  onClear: () => void;
  /** Narrow the selection to the villages that have earned the milestone. */
  onKeepEligible: (ids: string[]) => void;
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

  /*
   * Which of the selected villages have actually earned this milestone
   * (§077).
   *
   * Worked out here, from the stages already on screen, using the same
   * function the server refuses with. The server has always refused an
   * unearned claim and listed it as skipped — but only after a dry run, and
   * after somebody had swept a thousand villages into a selection. Saying so
   * before the press is the difference between a filter and a rejection.
   *
   * Only for SUBMIT. Recording the department's decision on a claim that
   * already exists says nothing about whether the stage is finished.
   */
  const gate = React.useMemo(() => {
    if (action !== 'SUBMIT') return null;
    const n = Number(milestone);
    const picked = villages.filter((v) => selected.includes(String(v.id)));
    const eligible = picked.filter((v) => milestoneEarned(n, v.stages ?? {}));
    const blocked = picked.filter((v) => !milestoneEarned(n, v.stages ?? {}));
    /* Grouped by what is in the way: two hundred names is not a sentence. */
    const why = blocked.reduce<Record<string, number>>((acc, v) => {
      const note = milestoneBlockedNote(n, v.stages ?? {}, labelOfStage)
        ?? 'Not earned yet';
      acc[note] = (acc[note] ?? 0) + 1;
      return acc;
    }, {});
    return {
      required: MILESTONE_REQUIRES[n],
      eligible: eligible.map((v) => String(v.id)),
      blocked: blocked.length,
      why,
      /* Unknown rather than false when the row carries no stages at all. */
      unknown: picked.length !== selected.length,
    };
  }, [action, milestone, selected, villages]);

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

      {/*
        * What has been earned, before anything is sent.
        *
        * The contract does not release money for work in progress, so a claim
        * on a village whose QC has not signed off comes back — and a returned
        * claim costs a month. The server has always refused these; saying so
        * here, against the selection on screen, is the difference between a
        * filter and a rejection.
        */}
      {gate && gate.blocked > 0 ? (
        <Notice
          tone="warning"
          title={`${gate.blocked} of ${selected.length} selected cannot be claimed at ${
            (MILESTONE_LABELS as Row)[Number(milestone)] ?? `milestone ${milestone}`}`}
        >
          <ul className="mt-1 space-y-0.5 text-xs text-text-muted">
            {Object.entries(gate.why).map(([note, n]) => (
              <li key={note}>{n} — {note}</li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary"
              disabled={gate.eligible.length === 0}
              onClick={() => onKeepEligible(gate.eligible)}>
              {gate.eligible.length === 0
                ? 'None of these are eligible'
                : `Keep the ${gate.eligible.length} that ${
                  gate.eligible.length === 1 ? 'is' : 'are'} eligible`}
            </Button>
            <span className="text-2xs text-text-subtle">
              Submitting anyway records nothing for these — they are listed as
              skipped and left exactly as they were.
            </span>
          </div>
        </Notice>
      ) : null}

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
              title={`${Number(preview.out_of_order)} of these have an earlier milestone outstanding`}>
              {/* Not refused — a variation can release milestones in any
                  order. But the usual cause is the wrong milestone picked,
                  and this is the last moment to notice. */}
              They would go in at {MILESTONE_LABELS[Number(milestone)]?.toLowerCase()} without{' '}
              {Number(milestone) === 2 ? 'the first' : 'every earlier one'} standing. A claim the
              department returned leaves its milestone owed again, which counts here too.
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
