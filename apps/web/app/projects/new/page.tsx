'use client';

import { staticHref } from '@/lib/routes';
import * as React from 'react';
import Link from '@/components/AppLink';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { createProject } from '@/lib/projects';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { ProjectForm, emptyProjectForm, toCreatePayload, type ProjectFormState } from '@/components/projects/ProjectForm';

export const dynamic = 'force-static';

/**
 * Create a project.
 *
 * The form is shared with the edit screen so the two cannot drift: a field
 * that can be set at creation and then never corrected is the worst of both.
 */
function NewProjectPanel() {
  const router = useRouter();
  const { session } = useAuth();
  const holder = { permissions: session?.permissions };
  const [state, setState] = React.useState<ProjectFormState>(emptyProjectForm());
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const mutation = useMutation({
    mutationFn: () => createProject(toCreatePayload(state) as never),
    onSuccess: (project) => {
      setSubmitError(null);
      router.push(staticHref(`/projects/${project.id}`));
    },
    onError: setSubmitError,
  });

  const ready = state.workspace_id && state.code.trim() && state.name.trim();

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
      />

      {submitError ? <ErrorCard title="Could not create project" error={submitError} /> : null}

      <div className="flex items-center gap-3">
        <Button type="submit" loading={mutation.isPending} disabled={!ready}>
          Create project (starts DRAFT)
        </Button>
        <Link href="/projects" className="text-sm text-primary hover:underline">
          Cancel
        </Link>
      </div>
    </form>
  );
}

export default function NewProjectPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.PROJECT_CREATE}>
        <h1 className="text-xl font-bold text-text">New project</h1>
        <p className="mt-1 text-sm text-text-muted">Projects start as DRAFT — activate them from the detail page.</p>
        <div className="mt-6">
          <NewProjectPanel />
        </div>
      </RequirePermission>
    </AppShell>
  );
}
