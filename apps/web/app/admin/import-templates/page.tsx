'use client';

import { AppShell } from '@/components/AppShell';
import { PageHeader, PageBody } from '@/components/ui/Page';
import { AllImportTemplates } from '@/components/ImportTemplateCard';
import { TaskTemplateCard } from '@/components/TaskTemplateCard';

/**
 * Every bulk-upload format in one place.
 *
 * Employees have their own importer and the template sits beside it there.
 * Inventory, assets and tasks are loaded by an administrator from a file, so
 * the formats live here rather than nowhere — which is where they were.
 */
export default function ImportTemplatesPage() {
  return (
    <AppShell>
      <PageHeader
        title="Upload formats"
        description="Download the template, fill it in, and upload it from the matching screen."
        breadcrumb={<a href="/admin" className="hover:underline">Administration</a>}
      />
      <PageBody>
        <AllImportTemplates />
        <TaskTemplateCard />
        <p className="text-2xs text-text-subtle">
          Each file carries one filled example row. It is there so the expected formats are
          unambiguous — a date is 1990-07-24, never 24/07/90 — and can be deleted before uploading.
        </p>
      </PageBody>
    </AppShell>
  );
}
