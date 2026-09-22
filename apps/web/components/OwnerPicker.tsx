'use client';

import * as React from 'react';
import { useRows } from '@/components/v2/Workbench';
import { Combobox } from '@/components/ui/Combobox';
import { EmployeePicker } from '@/components/EmployeePicker';

/**
 * Where a record can be attached: the list to pick from, per owner type.
 *
 * The register keys an attachment by owner type and owner id, and the form
 * asked for the id in a text box. Nobody has a project's UUID to hand, but
 * everybody knows its name.
 */
export const OWNER_SOURCES: Record<string, { path: string; label: (r: Record<string, unknown>) => string; hint?: (r: Record<string, unknown>) => string | undefined }> = {
  project: { path: 'projects?limit=100', label: (r) => String(r.name ?? r.code ?? r.id), hint: (r) => (r.code ? String(r.code) : undefined) },
  client: { path: 'clients?limit=100', label: (r) => String(r.name ?? r.id), hint: (r) => (r.code ? String(r.code) : undefined) },
  vendor: { path: 'vendors?limit=100', label: (r) => String(r.name ?? r.id), hint: (r) => (r.code ? String(r.code) : undefined) },
  asset: { path: 'assets?limit=100', label: (r) => String(r.name ?? r.asset_code ?? r.id), hint: (r) => (r.asset_code ? String(r.asset_code) : undefined) },
  tender: { path: 'tenders?limit=100', label: (r) => String(r.tender_no ?? r.reference_number ?? r.id), hint: (r) => (r.department ? String(r.department) : undefined) },
};

/**
 * The record a document belongs to, chosen by name.
 *
 * An employee comes from the searchable register; everything else is a
 * short enough list to load and filter as you type. An owner type nothing
 * here knows falls back to the id box rather than refusing the form.
 */
export function OwnerPicker({ ownerType, value, onChange, id }: {
  ownerType: string;
  value: string;
  onChange: (id: string) => void;
  id?: string;
}) {
  if (ownerType === 'employee') {
    return <EmployeePicker id={id} value={value} onChange={onChange} />;
  }
  const source = OWNER_SOURCES[ownerType];
  if (!source) {
    return (
      <input
        id={id}
        className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text"
        value={value}
        placeholder={`${ownerType} id`}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return <ListPicker id={id} source={source} value={value} onChange={onChange} />;
}

function ListPicker({ id, source, value, onChange }: {
  id?: string;
  source: (typeof OWNER_SOURCES)[string];
  value: string;
  onChange: (id: string) => void;
}) {
  const rows = useRows(source.path);
  const options = React.useMemo(
    () => (rows.data?.rows ?? []).map((r) => ({ id: String(r.id), label: source.label(r), hint: source.hint?.(r) })),
    [rows.data, source],
  );
  return (
    <Combobox
      id={id}
      value={value}
      onChange={onChange}
      options={options}
      isLoading={rows.isLoading}
      placeholder="Type to search…"
    />
  );
}
