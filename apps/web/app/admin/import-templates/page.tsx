'use client';

import { AppShell } from '@/components/AppShell';
import { PageHeader, PageBody } from '@/components/ui/Page';
import { AllImportTemplates } from '@/components/ImportTemplateCard';
import { TaskTemplateCard } from '@/components/TaskTemplateCard';
import { ExportPanel } from '@/components/ExportPanel';

/**
 * Getting data in, and getting it out.
 *
 * The formats used to live here with nowhere to submit them — the page said
 * "upload it from the matching screen" and for assets, allocations and stock
 * no such screen existed. Each template now carries its own upload.
 *
 * Exports are listed here too. They are generated on the Reports screen and
 * always were, but nobody looking for "how do I download my assets" thinks to
 * look under Reports, so the way out is named in the same place as the way
 * in.
 */
export default function ImportTemplatesPage() {
  return (
    <AppShell>
      <PageHeader
        title="Upload and download"
        description="Fill in a template to load data, or export what is already there."
        breadcrumb={<a href="/admin" className="hover:underline">Administration</a>}
      />
      <PageBody>
        <ExportPanel />
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
