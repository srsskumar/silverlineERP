'use client';

import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiRequest, apiRequestRaw } from '@/lib/apiClient';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/finance/Primitives';
import { useToast } from '@/components/ui/Toast';
import { messageOf } from '@/lib/form-errors';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';

/**
 * Change the same thing about several people at once (§note 12).
 *
 * A crew of thirty moving to a new mandal is one decision, not thirty, and
 * doing it one record at a time is how twenty-eight get moved and two are
 * forgotten until somebody's attendance stops matching their site.
 *
 * It always shows the work before it does it. This is the one screen where
 * somebody discovers they had the wrong filter applied after it has already
 * touched two hundred records, so the first press only asks the server what
 * would change, and nothing is written until they have read the answer.
 */
type Row = Record<string, unknown>;

export function BulkEditBar({
  selected, onDone, onClear,
}: {
  selected: Set<string>;
  onDone: () => void;
  onClear: () => void;
}) {
  const { session } = useAuth();
  const canEdit = hasPermission({ permissions: session?.permissions }, PERMISSIONS.EMPLOYEE_CREATE);
  const toast = useToast();
  const [field, setField] = React.useState('');
  const [value, setValue] = React.useState('');
  const [preview, setPreview] = React.useState<Row | null>(null);

  const designations = useQuery({
    queryKey: ['designations'],
    enabled: canEdit && field === 'designation_id',
    staleTime: 300_000,
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/designations')).body as { data: Row[] }).data,
  });

  const ids = React.useMemo(() => [...selected], [selected]);
  // A field changed mid-flight makes the preview describe something else.
  React.useEffect(() => { setPreview(null); }, [field, value, selected]);

  const run = useMutation({
    mutationFn: async (dryRun: boolean) => apiRequest('/api/v1/employees/bulk', {
      method: 'PATCH',
      body: {
        employee_ids: ids,
        changes: { [field]: value === '' ? null : value },
        dry_run: dryRun,
      },
    }),
    onError: (e) => { setPreview(null); toast.error('Nothing was changed', messageOf(e)); },
    onSuccess: (res: unknown) => {
      const d = ((res as { data?: Row }).data ?? {}) as Row;
      if (d.dry_run) { setPreview(d); return; }
      toast.success(
        `${Number(d.updated)} record(s) updated`,
        Number(d.unchanged) > 0
          ? `${Number(d.unchanged)} already held that value and were left alone.`
          : undefined,
      );
      setPreview(null);
      setField(''); setValue('');
      onDone();
    },
  });

  if (!canEdit || selected.size === 0) return null;

  const FIELDS: Array<{ key: string; label: string; kind: 'text' | 'designation' }> = [
    { key: 'department', label: 'Department', kind: 'text' },
    { key: 'designation_id', label: 'Designation', kind: 'designation' },
  ];
  const input = 'rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text';

  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface-sunken p-3">
      <div className="flex flex-wrap items-end gap-2">
        <span className="text-sm font-medium text-text">
          {selected.size} selected
        </span>

        <label className="flex flex-col gap-1 text-2xs text-text-muted">
          Change
          <select className={input} value={field} onChange={(e) => setField(e.target.value)}>
            <option value="">Choose a field…</option>
            {FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </label>

        {field === 'designation_id' ? (
          <label className="flex flex-col gap-1 text-2xs text-text-muted">
            To
            <select className={input} value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="">Choose a designation…</option>
              {(designations.data ?? []).map((d) => (
                <option key={String(d.id)} value={String(d.id)}>{String(d.label)}</option>
              ))}
            </select>
          </label>
        ) : field ? (
          <label className="flex flex-col gap-1 text-2xs text-text-muted">
            To
            <input className={input} value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
        ) : null}

        <Button type="button" variant="secondary"
          disabled={!field || run.isPending}
          onClick={() => run.mutate(true)}>
          {preview ? 'Check again' : 'Show what would change'}
        </Button>
        <Button type="button" variant="ghost" onClick={onClear}>Clear selection</Button>
      </div>

      {preview ? (
        <div className="space-y-2">
          <Notice
            tone={Number(preview.would_change) > 0 ? 'info' : 'warning'}
            title={Number(preview.would_change) > 0
              ? `${Number(preview.would_change)} record(s) would change`
              : 'Nothing would change'}
          >
            {Number(preview.unchanged) > 0
              ? `${Number(preview.unchanged)} already hold that value. ` : ''}
            {(preview.refused as Row[] ?? []).length > 0
              ? `${(preview.refused as Row[]).length} cannot be changed: `
                + (preview.refused as Row[]).map((r) => `${String(r.emp_no)} (${String(r.reason)})`).join('; ')
              : ''}
            {(preview.not_found as string[] ?? []).length > 0
              ? ` ${(preview.not_found as string[]).length} could not be found.` : ''}
          </Notice>
          {Number(preview.would_change) > 0 ? (
            <Button type="button" disabled={run.isPending} onClick={() => run.mutate(false)}>
              Apply to {Number(preview.would_change)} record(s)
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
