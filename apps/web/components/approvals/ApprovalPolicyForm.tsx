'use client';

import * as React from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiRequestRaw } from '@/lib/apiClient';
import { createApprovalPolicy } from '@/lib/approval-policies';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FieldError, RecordSheet, Section } from '@/components/finance/Primitives';
import { useToast } from '@/components/ui/Toast';
import { applyFieldErrors } from '@/lib/form-errors';
import {
  approvalPolicySchema, APPROVAL_DOCUMENT_TYPES, type ApprovalPolicyFormInput,
} from '@/lib/validation';
import { DOCUMENT_TYPE_LABELS } from '@/lib/finance';

type Row = Record<string, any>;

const emptyLevel = { sequence: 1, min_amount: '0', max_amount: '', approver_role: '', approver_user_id: '', sla_hours: '' };

/**
 * Create (or, by pre-filling from an existing row, "edit") an approval
 * policy — the DoA ladder that gates a document type (§41).
 *
 * There is no PATCH route: POST /api/v1/approval-policies supersedes
 * whichever policy is active for the same (document_type, project_id) pair,
 * so "edit" here means "submit a replacement," which is what the API's own
 * uniqueness index enforces anyway (see the route's own comment). A
 * standalone component, not inlined in app/approvals/policies/page.tsx —
 * app-router page files may only export the page itself; an extra named
 * export fails `next build`.
 */
export function ApprovalPolicyForm({
  initial, onClose, onSaved,
}: {
  /** Prefill for "edit as a new version"; absent for a fresh policy. */
  initial?: Row | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const toast = useToast();
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const projects = useQuery({
    queryKey: ['projects', 'for-approval-policy'],
    queryFn: async () => ((await apiRequestRaw('/api/v1/projects?limit=100')).body as { data: Row[] }).data,
    staleTime: 300_000,
  });

  const defaultLevels = initial?.levels?.length
    ? initial.levels.map((l: Row) => ({
        sequence: l.sequence, min_amount: String(l.min_amount),
        max_amount: l.max_amount === null || l.max_amount === undefined ? '' : String(l.max_amount),
        approver_role: l.approver_role ?? '', approver_user_id: l.approver_user_id ?? '',
        sla_hours: l.sla_hours === null || l.sla_hours === undefined ? '' : String(l.sla_hours),
      }))
    : [emptyLevel];

  const {
    register, control, handleSubmit, setError, formState: { errors },
  } = useForm<ApprovalPolicyFormInput>({
    resolver: zodResolver(approvalPolicySchema),
    defaultValues: {
      document_type: initial?.document_type ?? APPROVAL_DOCUMENT_TYPES[0],
      name: initial?.name ?? '',
      mode: initial?.mode ?? 'CUMULATIVE',
      project_id: initial?.project_id ?? '',
      tolerance_pct: initial?.tolerance_pct !== undefined ? String(initial.tolerance_pct) : '0',
      active: initial?.active ?? true,
      levels: defaultLevels,
    } as unknown as ApprovalPolicyFormInput,
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'levels' });

  const save = useMutation({
    mutationFn: (v: ApprovalPolicyFormInput) => createApprovalPolicy(v),
    onSuccess: (row) => {
      toast.success('Approval policy saved', `${row.name} now governs ${DOCUMENT_TYPE_LABELS[row.document_type] ?? row.document_type}.`);
      onSaved(String(row.id));
    },
    onError: (err) => {
      applyFieldErrors(err, (f, e) => setError(f as keyof ApprovalPolicyFormInput, e));
      setSubmitError(err);
    },
  });

  return (
    <RecordSheet
      open onClose={onClose} wide
      title={initial ? 'Replace approval policy' : 'New approval policy'}
      subtitle="The ladder a document of this type must climb before it is approved."
    >
      <form onSubmit={handleSubmit((v) => save.mutate(v))} noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-text-muted">
            Document type
            <select className="mt-1 w-full" {...register('document_type')}>
              {APPROVAL_DOCUMENT_TYPES.map((t) => (
                <option key={t} value={t}>{DOCUMENT_TYPE_LABELS[t] ?? t}</option>
              ))}
            </select>
            <FieldError message={errors.document_type?.message} />
          </label>
          <label className="text-xs text-text-muted">
            Name
            <input className="mt-1 w-full" maxLength={150} {...register('name')} />
            <FieldError message={errors.name?.message} />
          </label>
          <label className="text-xs text-text-muted">
            Mode
            <select className="mt-1 w-full" {...register('mode')}>
              <option value="CUMULATIVE">Cumulative — every level up to the amount</option>
              <option value="SINGLE">Single — only the one level the amount falls in</option>
            </select>
          </label>
          <label className="text-xs text-text-muted">
            Project (optional — leave blank for the org-wide default)
            <select className="mt-1 w-full" {...register('project_id')}>
              <option value="">Org-wide</option>
              {(projects.data ?? []).map((p) => (
                <option key={String(p.id)} value={String(p.id)}>{p.code} — {p.name}</option>
              ))}
            </select>
            <FieldError message={errors.project_id?.message} />
          </label>
          <label className="text-xs text-text-muted">
            Tolerance %
            <input type="number" min="0" max="25" step="0.01" className="mt-1 w-full" {...register('tolerance_pct')} />
            <FieldError message={errors.tolerance_pct?.message} />
          </label>
          <label className="mt-1 flex items-center gap-2 text-xs text-text-muted">
            <input type="checkbox" {...register('active')} />
            Active
          </label>
        </div>

        <Section
          title="Levels"
          action={
            <Button
              type="button" variant="secondary" size="sm"
              onClick={() => append({ ...emptyLevel, sequence: fields.length + 1 } as unknown as ApprovalPolicyFormInput['levels'][number])}
            >
              Add level
            </Button>
          }
        >
          <div className="space-y-3">
            {fields.map((f, i) => (
              <div key={f.id} className="rounded-lg border border-border bg-surface-sunken p-3">
                <div className="grid gap-2 sm:grid-cols-6">
                  <input type="number" min="1" max="20" placeholder="Sequence" {...register(`levels.${i}.sequence`)} />
                  <input type="number" min="0" step="any" placeholder="Min amount" {...register(`levels.${i}.min_amount`)} />
                  <input type="number" min="0" step="any" placeholder="Max amount (blank = and above)" {...register(`levels.${i}.max_amount`)} />
                  <input placeholder="Approver role" maxLength={50} {...register(`levels.${i}.approver_role`)} />
                  <input placeholder="Approver user ID (optional)" {...register(`levels.${i}.approver_user_id`)} />
                  <input type="number" min="1" max="8760" placeholder="SLA hours (optional)" {...register(`levels.${i}.sla_hours`)} />
                </div>
                {fields.length > 1 ? (
                  <div className="mt-2 flex justify-end">
                    <Button type="button" variant="ghost" size="sm" onClick={() => remove(i)}>Remove</Button>
                  </div>
                ) : null}
                {errors.levels?.[i] ? (
                  <p className="mt-1 text-2xs text-danger">
                    {Object.values(errors.levels[i] as Record<string, { message?: string } | undefined>)
                      .map((e) => e?.message).filter(Boolean).join(' · ')}
                  </p>
                ) : null}
              </div>
            ))}
            {typeof errors.levels?.message === 'string' ? <FieldError message={errors.levels.message} /> : null}
          </div>
        </Section>

        {submitError ? <ErrorCard title="Could not save the policy" error={submitError} className="mt-4" /> : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending}>Save policy</Button>
        </div>
      </form>
    </RecordSheet>
  );
}
