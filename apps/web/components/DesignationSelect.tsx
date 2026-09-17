'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Combobox } from './ui/Combobox';
import { apiRequest, apiRequestRaw } from '@/lib/apiClient';

/**
 * A job title, picked from the list rather than typed.
 *
 * Free text made "Site Engineer", "site engineer" and "Sr. Engineer" three
 * designations as far as any report was concerned, so nobody could say how
 * many engineers there were. The list is only worth having if it can grow
 * without leaving the form, though — a picker that cannot take a title
 * somebody has genuinely been hired into sends them straight back to typing
 * it into whichever field still accepts free text.
 *
 * Adding one here also creates the role of the same name, which is where
 * this employee's permissions will come from. The role arrives with no
 * permissions on it: an administrator grants those deliberately, so that
 * filling in a hiring form never quietly confers access.
 */
export type Designation = { id: string; label: string };

type Row = { id: string; label: string; code: string; employee_count?: number };

export function DesignationSelect({
  value, label, onChange, id, disabled,
}: {
  value?: string;
  /** The stored text, which may predate the list. */
  label?: string;
  onChange: (picked: Designation | null) => void;
  id?: string;
  disabled?: boolean;
}) {
  const qc = useQueryClient();

  const list = useQuery({
    queryKey: ['designations'],
    staleTime: 300_000,
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/designations')).body as { data: Row[] }).data,
  });

  const create = useMutation({
    mutationFn: async (newLabel: string) => {
      const res = await apiRequest('/api/v1/designations', {
        method: 'POST',
        body: { label: newLabel, create_role: true },
      });
      return ((res as unknown as { data?: Row }).data ?? (res as unknown as Row));
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['designations'] }); },
  });

  const options = React.useMemo(() => {
    const rows = (list.data ?? []).map((d) => ({
      id: d.id,
      label: d.label,
      hint: d.employee_count ? `${d.employee_count} on this title` : undefined,
    }));
    // A record saved before the list existed still has its text. Showing it
    // as an option is the difference between "Site Engineer" staying put and
    // silently clearing itself the first time somebody edits the record.
    if (label && !value && !rows.some((r) => r.label.toLowerCase() === label.toLowerCase())) {
      rows.unshift({ id: `text:${label}`, label, hint: 'not on the list' });
    }
    return rows;
  }, [list.data, label, value]);

  const selected = value ?? (label ? `text:${label}` : '');

  return (
    <div className="space-y-1">
      <Combobox
        id={id}
        value={selected}
        isLoading={list.isLoading}
        disabled={disabled}
        placeholder="Search job titles…"
        createLabel="Add designation"
        options={options}
        onChange={(picked) => {
          if (!picked) return onChange(null);
          if (picked.startsWith('text:')) {
            return onChange({ id: '', label: picked.slice(5) });
          }
          const row = (list.data ?? []).find((d) => d.id === picked);
          onChange(row ? { id: row.id, label: row.label } : null);
        }}
        onCreate={async (name) => {
          const row = await create.mutateAsync(name);
          onChange({ id: String(row.id), label: String(row.label) });
          return { id: String(row.id) };
        }}
        emptyHint={
          <span>
            No title matches. Adding one creates a role of the same name, with no
            permissions on it until an administrator grants them.
          </span>
        }
      />
    </div>
  );
}
