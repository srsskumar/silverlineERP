'use client';

import * as React from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ImportUpload, type UploadTarget } from '@/components/ImportUpload';
import {
  IMPORT_TEMPLATES, downloadTemplate, downloadTemplateWorkbook, templateSheet,
  type ImportTemplate,
} from '@/lib/import-templates';
import { optionsNote } from '@/lib/xlsx';
import { useQuery } from '@tanstack/react-query';
import { apiRequestRaw } from '@/lib/apiClient';

/**
 * The download-the-format panel.
 *
 * Shown beside every importer, because the first thing anybody does without
 * one is guess at the column names, collect a page of validation errors, and
 * guess again.
 */
export function ImportTemplateCard({ templateKey }: { templateKey: string }) {
  const template = IMPORT_TEMPLATES.find((t) => t.key === templateKey);
  if (!template) return null;
  return <TemplatePanel template={template} />;
}

export function TemplatePanel({ template }: { template: ImportTemplate }) {
  /*
   * Designations are a list the organisation keeps, not a fixed set this file
   * can hold. Fetched at the moment of download so the dropdown in the
   * workbook is the list as it stands, rather than the list as it stood when
   * this template was written.
   */
  const wantsDesignations = template.headers.includes('designation');
  const designations = useQuery({
    queryKey: ['designations'],
    enabled: wantsDesignations,
    staleTime: 300_000,
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/designations')).body as { data: Array<{ label: string }> })
        .data.map((d) => d.label),
  });
  const live = wantsDesignations && designations.data?.length
    ? { designation: designations.data }
    : undefined;

  return (
    <section className="rounded-lg border border-border bg-surface-sunken p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text">{template.label} template</h3>
          <p className="mt-0.5 text-xs text-text-muted">{template.description}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          {/* Excel first: its dropdowns stop the mis-typed enum that causes
              most of the rejections on a bulk upload. */}
          <Button type="button" variant="secondary" onClick={() => downloadTemplateWorkbook(template, live)}>
            <Download className="size-4" />
            Excel
          </Button>
          <Button type="button" variant="ghost" onClick={() => downloadTemplate(template)}>
            <Download className="size-4" />
            CSV
          </Button>
        </div>
      </div>

      <div className="mt-3 space-y-2 text-xs">
        <p className="text-text-muted">
          <span className="font-medium text-text">Required:</span>{' '}
          {template.required.map((h) => (
            <code key={h} className="mr-1 rounded bg-surface px-1 py-0.5 font-mono text-2xs">{h}</code>
          ))}
        </p>
        <details>
          <summary className="cursor-pointer text-text-muted hover:text-text">
            All {template.headers.length} columns
          </summary>
          <p className="mt-1.5 flex flex-wrap gap-1">
            {template.headers.map((h) => (
              <code key={h} className="rounded bg-surface px-1 py-0.5 font-mono text-2xs text-text-muted">{h}</code>
            ))}
          </p>
        </details>
        <ul className="ml-4 list-disc space-y-0.5 text-text-subtle">
          {optionsNote(templateSheet(template, live)).map((n) => <li key={n}>{n}</li>)}
          {template.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      </div>

      {/* The format and the place to submit it, together. This page used to
          say "upload it from the matching screen" and for most of these no
          such screen existed. */}
      {UPLOAD_TARGETS[template.key] ? (
        <ImportUpload target={UPLOAD_TARGETS[template.key]!} />
      ) : (
        <p className="mt-3 text-2xs text-text-subtle">
          {ELSEWHERE[template.key] ?? 'Upload this from its own screen.'}
        </p>
      )}
    </section>
  );
}

/**
 * Where each filled-in template is submitted.
 *
 * Employees and villages keep their own importers -- they have preview
 * screens of their own with more to say about a row than a table of
 * rejections can carry -- so those point at the screen instead.
 */
const UPLOAD_TARGETS: Record<string, UploadTarget | undefined> = {
  assets: { path: '/api/v1/assets/import', verb: 'Add to the register' },
  'asset-allocation': { path: '/api/v1/assets/allocations/import', verb: 'Record allocations' },
  inventory: { path: '/api/v1/inventory/items/import', verb: 'Add to stock' },
  // Employees upload from here too. The dedicated importer under Employees
  // is still there and says more about each row; this is for somebody who
  // came looking for the format and has the filled-in file in hand.
  employees: { path: '/api/v1/employees/bulk-import', verb: 'Add to the register' },
};

const ELSEWHERE: Record<string, string> = {
  'survey-villages': 'Villages upload under Land survey \u2192 Setup, where they are loaded against the programme they belong to \u2014 a village list means nothing without one.',
};

/** Every template in one place, for an admin or settings screen. */
export function AllImportTemplates() {
  return (
    <div className="space-y-3">
      {IMPORT_TEMPLATES.map((t) => <TemplatePanel key={t.key} template={t} />)}
    </div>
  );
}
