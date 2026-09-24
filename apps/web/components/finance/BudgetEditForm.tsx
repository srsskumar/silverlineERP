'use client';

import * as React from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { listCostHeads } from '@/lib/cost-heads';
import { setProjectBudget } from '@/lib/cost-heads';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FieldError, RecordSheet, Section } from '@/components/finance/Primitives';
import { applyFieldErrors } from '@/lib/form-errors';
import { budgetFormSchema, type BudgetFormInput } from '@/lib/validation';

/**
 * Revise a project's budget (§15.6) — PUT replaces the whole thing in one
 * call, which is also how "edit" works here: there is no per-line PATCH.
 *
 * A standalone component (not inlined in app/billing/page.tsx, which already
 * renders CostPosition) so it can be exercised directly against a stubbed
 * fetch.
 */
export function BudgetEditForm({
  projectId, existing, isRevision, onClose, onSaved,
}: {
  projectId: string;
  /** Current live lines, if any — pre-fills the form for a revision. */
  existing?: Array<{ cost_head_id: string; budgeted_amount: number; notes?: string | null }>;
  /** True once a budget already exists: the API requires a reason to change it. */
  isRevision: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const costHeads = useQuery({
    queryKey: ['cost-heads', 'active', 'for-budget'],
    queryFn: () => listCostHeads({ active: true }),
    staleTime: 60_000,
  });

  const {
    register, control, handleSubmit, setError, formState: { errors },
  } = useForm<BudgetFormInput>({
    resolver: zodResolver(budgetFormSchema),
    defaultValues: {
      revision_reason: '',
      lines: existing?.length
        ? existing.map((l) => ({ cost_head_id: l.cost_head_id, budgeted_amount: String(l.budgeted_amount) as unknown as number, notes: l.notes ?? '' }))
        : [{ cost_head_id: '', budgeted_amount: '' as unknown as number, notes: '' }],
    } as unknown as BudgetFormInput,
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });

  const save = useMutation({
    mutationFn: (v: BudgetFormInput) => setProjectBudget(projectId, v),
    onSuccess: onSaved,
    onError: (err) => {
      applyFieldErrors(err, (f, e) => setError(f as keyof BudgetFormInput, e));
      setSubmitError(err);
    },
  });

  return (
    <RecordSheet open onClose={onClose} wide title={isRevision ? 'Revise budget' : 'Set budget'} subtitle="Replaces the whole budget for this project in one call.">
      <form onSubmit={handleSubmit((v) => save.mutate(v))} noValidate>
        {isRevision ? (
          <label className="block text-xs text-text-muted">
            Reason for the revision
            <input className="mt-1 w-full" maxLength={500} {...register('revision_reason')} />
            <FieldError message={errors.revision_reason?.message} />
          </label>
        ) : null}

        <Section
          title="Cost heads"
          action={
            <Button type="button" variant="secondary" size="sm" onClick={() => append({ cost_head_id: '', budgeted_amount: '' as unknown as number, notes: '' })}>
              Add line
            </Button>
          }
        >
          <div className="space-y-3">
            {fields.map((f, i) => (
              <div key={f.id} className="rounded-lg border border-border bg-surface-sunken p-3">
                <div className="grid gap-2 sm:grid-cols-4">
                  <select {...register(`lines.${i}.cost_head_id`)}>
                    <option value="">Pick a cost head</option>
                    {(costHeads.data ?? []).map((h) => (
                      <option key={h.id} value={h.id}>{h.code} — {h.name}</option>
                    ))}
                  </select>
                  <input type="number" min="0" step="0.01" placeholder="Budgeted amount" {...register(`lines.${i}.budgeted_amount`)} />
                  <input className="sm:col-span-2" placeholder="Notes (optional)" maxLength={500} {...register(`lines.${i}.notes`)} />
                </div>
                {fields.length > 1 ? (
                  <div className="mt-2 flex justify-end">
                    <Button type="button" variant="ghost" size="sm" onClick={() => remove(i)}>Remove</Button>
                  </div>
                ) : null}
                {errors.lines?.[i] ? (
                  <p className="mt-1 text-2xs text-danger">
                    {Object.values(errors.lines[i] as Record<string, { message?: string } | undefined>)
                      .map((e) => e?.message).filter(Boolean).join(' · ')}
                  </p>
                ) : null}
              </div>
            ))}
            {typeof errors.lines?.message === 'string' ? <FieldError message={errors.lines.message} /> : null}
          </div>
        </Section>

        {submitError ? <ErrorCard title="Could not save the budget" error={submitError} className="mt-4" /> : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending}>Save budget</Button>
        </div>
      </form>
    </RecordSheet>
  );
}
