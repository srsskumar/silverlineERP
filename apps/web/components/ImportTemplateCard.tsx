'use client';

import * as React from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IMPORT_TEMPLATES, downloadTemplate, type ImportTemplate } from '@/lib/import-templates';

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
  return (
    <section className="rounded-lg border border-border bg-surface-sunken p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text">{template.label} template</h3>
          <p className="mt-0.5 text-xs text-text-muted">{template.description}</p>
        </div>
        <Button type="button" variant="secondary" onClick={() => downloadTemplate(template)}>
          <Download className="size-4" />
          Download CSV
        </Button>
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
          {template.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      </div>
    </section>
  );
}

/** Every template in one place, for an admin or settings screen. */
export function AllImportTemplates() {
  return (
    <div className="space-y-3">
      {IMPORT_TEMPLATES.map((t) => <TemplatePanel key={t.key} template={t} />)}
    </div>
  );
}
