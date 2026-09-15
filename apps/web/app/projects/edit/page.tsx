'use client';

import * as React from 'react';
import { Suspense } from 'react';
import Link from '@/components/AppLink';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { getProject, patchProject } from '@/lib/projects';
import { queryKeys } from '@/lib/query-keys';
import { staticHref } from '@/lib/routes';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  ProjectForm, projectFormFrom, toPatchPayload, type ProjectFormState,
} from '@/components/projects/ProjectForm';

export const dynamic = 'force-static';

/**
 * Edit a project.
 *
 * There was no way to correct a project at all: everything had to be right at
 * creation or stay wrong forever, which for a contract value or a client is
 * not a realistic demand — the award paperwork routinely arrives after work
 * has started.
 *
 * The project arrives as `?id=`, like every other deep link in the app, because
 * the build is a static export and cannot generate a page per project.
 */
function EditProjectPanel() {
  const id = useSearchParams().get('id');
  const router = useRouter();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const holder = { permissions: session?.permissions };
  const [state, setState] = React.useState<ProjectFormState | null>(null);
  const [error, setError] = React.useState<unknown>(null);

  const detail = useQuery({
    queryKey: queryKeys.projects.detail(id ?? ''),
    queryFn: () => getProject(id!),
    enabled: Boolean(id),
  });

  React.useEffect(() => {
    if (detail.data && !state) setState(projectFormFrom(detail.data.project as Record<string, any>));
  }, [detail.data, state]);

  const mutation = useMutation({
    mutationFn: () => patchProject(id!, toPatchPayload(state!) as never, detail.data!.project.version),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(id!) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects.list() });
      router.push(staticHref(`/projects/${id}`));
    },
    onError: setError,
  });

  if (!id) {
    return <EmptyState title="No project chosen" description="Open a project and choose Edit." />;
  }
  if (detail.isLoading || !state) return <Skeleton className="h-96 w-full" />;
  if (detail.isError) {
    return <ErrorCard title="Could not load project" error={detail.error} onRetry={() => detail.refetch()} />;
  }

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }}
      className="flex max-w-3xl flex-col gap-4 rounded-lg border border-border bg-surface p-4 sm:p-6"
      noValidate
    >
      <ProjectForm
        state={state}
        onChange={setState}
        canManageMasters={hasPermission(holder, PERMISSIONS.PROJECT_CREATE)}
        canManageClients={hasPermission(holder, 'client.manage')}
        editing
      />

      {error ? <ErrorCard title="Could not save the project" error={error} /> : null}

      <div className="flex items-center gap-3">
        <Button type="submit" loading={mutation.isPending} disabled={!state.name.trim()}>
          Save changes
        </Button>
        <Link href={`/projects/${id}`} className="text-sm text-primary hover:underline">
          Cancel
        </Link>
      </div>
      <p className="text-2xs text-text-subtle">
        The status is changed from the project page, where only the moves the workflow allows are offered.
      </p>
    </form>
  );
}

export default function EditProjectPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.PROJECT_UPDATE}>
        <h1 className="text-xl font-bold text-text">Edit project</h1>
        <div className="mt-6">
          <Suspense fallback={<Skeleton className="h-96 w-full" />}>
            <EditProjectPanel />
          </Suspense>
        </div>
      </RequirePermission>
    </AppShell>
  );
}
