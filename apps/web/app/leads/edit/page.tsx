'use client';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/apiClient';
import { Workbench, Panel, MutationForm } from '@/components/v2/Workbench';
import { LEAD_FIELDS } from '@/lib/lead-fields';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';

type Row = Record<string, any>;

/**
 * Edit a lead.
 *
 * There was no way to correct one at all: a mis-keyed value or a change of
 * owner meant raising a second lead, which is how the pipeline ends up with
 * duplicates of the same opportunity.
 *
 * The lead arrives as `?id=`, like every other deep link here, because the
 * build is a static export and cannot generate a page per lead.
 */
function EditLead() {
  const id = useSearchParams().get('id');
  const detail = useQuery({
    queryKey: ['lead', id],
    queryFn: async () => (await apiRequest<Row>(`/api/v1/leads/${id}`)).data,
    enabled: Boolean(id),
  });

  if (!id) return <EmptyState title="No lead chosen" description="Open a lead and choose Edit." />;
  if (detail.isLoading) return <Skeleton className="h-96 w-full" />;
  if (detail.isError) {
    return <ErrorCard title="Could not load lead" error={detail.error} onRetry={() => detail.refetch()} />;
  }

  const lead = detail.data as Row;
  return (
    <Panel title={`Lead ${lead.lead_no}`}>
      <MutationForm
        path={`leads/${id}`}
        method="PATCH"
        version={lead.version}
        initial={lead}
        // The lead number identifies the record everywhere else, so it is
        // fixed once the lead exists.
        fields={LEAD_FIELDS.filter((f) => f.key !== 'lead_no')}
        submit="Save changes"
      />
    </Panel>
  );
}

export default function Page() {
  return (
    <Workbench title="Edit lead" description="Correct the details, or hand the lead to somebody else.">
      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <EditLead />
      </Suspense>
    </Workbench>
  );
}
