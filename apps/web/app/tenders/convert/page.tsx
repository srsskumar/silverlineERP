'use client';

import * as React from 'react';
import { Suspense } from 'react';
import Link from '@/components/AppLink';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/apiClient';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { staticHref } from '@/lib/routes';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Notice } from '@/components/finance/Primitives';
import { money, day } from '@/lib/finance';
import {
  ProjectForm, emptyProjectForm, toCreatePayload, type ProjectFormState,
} from '@/components/projects/ProjectForm';

type Row = Record<string, any>;

export const dynamic = 'force-static';

/**
 * §8.7 — the single hand-off from the tender domain into the project domain.
 *
 * This used to be a short bespoke form with a different set of fields from the
 * real project screen, so a project born from a tender could not be given a
 * category, a GST treatment or a work order at creation — the very things the
 * award decides. It is now the same form, prefilled from the tender, so the
 * result is a proper project rather than a stub somebody has to go and finish.
 *
 * What the tender carries is shown above the form rather than silently copied,
 * because a value that appears in a field with no explanation looks like
 * something the user typed and forgot.
 */
function ConvertForm() {
  const id = useSearchParams().get('id');
  const router = useRouter();
  const { session } = useAuth();
  const holder = { permissions: session?.permissions };
  const [state, setState] = React.useState<ProjectFormState | null>(null);
  const [error, setError] = React.useState<unknown>(null);

  const tender = useQuery({
    queryKey: ['tender', id],
    queryFn: async () => (await apiRequest<Row>(`/api/v1/tenders/${id}`)).data,
    enabled: Boolean(id),
  });

  React.useEffect(() => {
    if (!tender.data || state) return;
    const t = tender.data as Row;
    setState({
      ...emptyProjectForm(),
      // Carried across rather than re-keyed. A tender is always government
      // work, and the bid value is the contract value unless somebody says
      // otherwise on award.
      name: String(t.tender_no ? `${t.tender_no}` : ''),
      project_kind: 'GOVERNMENT',
      client_id: t.client_id ? String(t.client_id) : '',
      project_type_id: t.project_type_id ? String(t.project_type_id) : '',
      project_category_id: t.project_category_id ? String(t.project_category_id) : '',
      contract_value: t.bid_value ?? t.estimated_value ? String(t.bid_value ?? t.estimated_value) : '',
    });
  }, [tender.data, state]);

  const mutation = useMutation({
    mutationFn: () =>
      apiRequest<Row>(`/api/v1/tenders/${id}/convert`, {
        method: 'POST',
        body: toCreatePayload(state!),
      }),
    onSuccess: (res) => router.push(staticHref(`/projects/${res.data.id}`)),
    onError: setError,
  });

  if (!id) {
    return (
      <EmptyState
        title="No tender chosen"
        description="Open an awarded tender and choose “Convert to project”."
      />
    );
  }
  if (tender.isLoading || !state) return <Skeleton className="h-96 w-full" />;
  if (tender.isError) {
    return <ErrorCard title="Could not load tender" error={tender.error} onRetry={() => tender.refetch()} />;
  }

  const t = tender.data as Row;
  const notAwarded = String(t.status) !== 'AWARDED';
  const ready = state.workspace_id && state.code.trim() && state.name.trim();

  return (
    <div className="max-w-3xl space-y-4">
      <div className="rounded-lg border border-border bg-surface-sunken p-4">
        <p className="text-2xs font-semibold uppercase tracking-wide text-text-subtle">
          Carried from tender {t.tender_no}
        </p>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-2xs text-text-subtle">Client</dt>
            <dd className="text-text">{t.client_name ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-2xs text-text-subtle">Bid value</dt>
            <dd className="tabular-nums text-text">{money(t.bid_value ?? t.estimated_value)}</dd>
          </div>
          <div>
            <dt className="text-2xs text-text-subtle">Awarded</dt>
            <dd className="text-text">{day(t.submission_date ?? t.closing_date)}</dd>
          </div>
          <div>
            <dt className="text-2xs text-text-subtle">Track</dt>
            <dd className="text-text">Government</dd>
          </div>
        </dl>
        <p className="mt-2 text-2xs text-text-subtle">
          The tender stays permanently linked to the project for traceability. Anything below can be
          changed before the project is created.
        </p>
      </div>

      {notAwarded ? (
        <Notice tone="warning" title={`This tender is ${String(t.status).toLowerCase()}`}>
          Only an awarded tender converts to a project. The server will refuse this until the tender
          reaches Awarded.
        </Notice>
      ) : null}

      <form
        onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }}
        className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 sm:p-6"
        noValidate
      >
        <ProjectForm
          state={state}
          onChange={setState}
          canManageMasters={hasPermission(holder, PERMISSIONS.PROJECT_CREATE)}
          canManageClients={hasPermission(holder, 'client.manage')}
        />

        {error ? <ErrorCard title="Could not create the project" error={error} /> : null}

        <div className="flex items-center gap-3">
          <Button type="submit" loading={mutation.isPending} disabled={!ready || notAwarded}>
            Create project
          </Button>
          <Link href="/tenders" className="text-sm text-primary hover:underline">Cancel</Link>
        </div>
      </form>
    </div>
  );
}

export default function ConvertPage() {
  return (
    <AppShell>
      <RequirePermission code="tender.convert">
        <h1 className="text-xl font-bold text-text">Convert to project</h1>
        <p className="mt-1 text-sm text-text-muted">
          Creates the project and keeps it linked to the tender it was won on.
        </p>
        <div className="mt-6">
          <Suspense fallback={<Skeleton className="h-96 w-full" />}>
            <ConvertForm />
          </Suspense>
        </div>
      </RequirePermission>
    </AppShell>
  );
}
