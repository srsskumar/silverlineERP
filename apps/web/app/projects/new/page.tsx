'use client';

import { staticHref } from '@/lib/routes';
import * as React from 'react';
import Link from '@/components/AppLink';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { createProject, listProjectTypes, listWorkspaces } from '@/lib/projects';
import { apiRequestRaw } from '@/lib/apiClient';
import { queryKeys } from '@/lib/query-keys';
import { projectSchema, type ProjectFormInput } from '@/lib/validation';
import { applyFieldErrors } from '@/lib/form-errors';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';

export const dynamic = 'force-static';

const inputClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1';

/**
 * Create a project (always starts DRAFT server-side).
 *
 * The commercial fields (§8, §8.8, §37) matter as much as the scheduling ones:
 * a project with no track, client or contract value cannot appear in a margin
 * report, and until now only a tender conversion ever set them — so a project
 * keyed in directly was commercially invisible.
 *
 * Government and private work diverge here. A government job carries a work
 * order; a private one does not, and the field is hidden rather than left to
 * be filled in wrongly.
 */
function NewProjectPanel() {
  const router = useRouter();
  const { session } = useAuth();
  const canReadWorkspaces = hasPermission({ permissions: session?.permissions }, PERMISSIONS.WORKSPACE_READ);
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const workspacesQuery = useQuery({
    queryKey: queryKeys.workspaces.list({}),
    queryFn: listWorkspaces,
    staleTime: 10 * 60_000,
    enabled: canReadWorkspaces,
    retry: false,
  });

  const typesQuery = useQuery({
    queryKey: queryKeys.projectTypes.list(),
    queryFn: listProjectTypes,
    staleTime: 10 * 60_000,
  });

  const clientsQuery = useQuery({
    queryKey: ['clients', 'for-project'],
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/clients?limit=100')).body as { data: Record<string, any>[] }).data,
    staleTime: 10 * 60_000,
    retry: false,
  });

  // There is a users endpoint now, so the project manager is a real choice
  // rather than a UUID somebody has to look up and paste.
  const usersQuery = useQuery({
    queryKey: ['users', 'for-project'],
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/users?limit=100')).body as { data: Record<string, any>[] }).data,
    staleTime: 10 * 60_000,
    retry: false,
  });

  const {
    register,
    handleSubmit,
    setError,
    watch,
    formState: { errors },
  } = useForm<ProjectFormInput>({
    resolver: zodResolver(projectSchema),
    defaultValues: {
      workspace_id: '',
      code: '',
      name: '',
      project_type_id: '',
      description: '',
      project_manager_id: '',
      planned_start_date: '',
      planned_end_date: '',
      priority: '',
      project_kind: '',
      client_id: '',
      contract_value: '',
      work_order_number: '',
    },
  });

  const projectKind = watch('project_kind');

  const mutation = useMutation({
    mutationFn: (v: ProjectFormInput) =>
      createProject({
        workspace_id: v.workspace_id,
        code: v.code.trim(),
        name: v.name.trim(),
        ...(v.project_type_id?.trim() ? { project_type_id: v.project_type_id.trim() } : {}),
        ...(v.description?.trim() ? { description: v.description.trim() } : {}),
        ...(v.project_manager_id?.trim() ? { project_manager_id: v.project_manager_id.trim() } : {}),
        ...(v.planned_start_date?.trim() ? { planned_start_date: v.planned_start_date.trim() } : {}),
        ...(v.planned_end_date?.trim() ? { planned_end_date: v.planned_end_date.trim() } : {}),
        ...(v.priority?.trim() ? { priority: v.priority.trim() } : {}),
        ...(v.project_kind ? { project_kind: v.project_kind } : {}),
        ...(v.client_id?.trim() ? { client_id: v.client_id.trim() } : {}),
        ...(v.contract_value?.trim() ? { contract_value: Number(v.contract_value) } : {}),
        ...(v.project_kind === 'GOVERNMENT' && v.work_order_number?.trim()
          ? { work_order_number: v.work_order_number.trim() }
          : {}),
      }),
    onSuccess: (project) => {
      setSubmitError(null);
      router.push(staticHref(`/projects/${project.id}`));
    },
    onError: (err) => {
      const mapped = applyFieldErrors(err, (f, e) => setError(f as keyof ProjectFormInput, e));
      if (!mapped) setSubmitError(err);
      else setSubmitError(err);
    },
  });

  if (typesQuery.isLoading || (canReadWorkspaces && workspacesQuery.isLoading)) {
    return <Skeleton className="h-96 w-full" />;
  }
  if (typesQuery.isError) {
    return <ErrorCard title="Could not load project types" error={typesQuery.error} onRetry={() => typesQuery.refetch()} />;
  }

  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="flex max-w-2xl flex-col gap-4 rounded-lg border border-border bg-surface p-4 sm:p-6" noValidate>
      {canReadWorkspaces ? (
        <FormField label="Workspace *" htmlFor="project-workspace" error={errors.workspace_id?.message}>
          <select id="project-workspace" className={inputClass} {...register('workspace_id')}>
            <option value="">Pick a workspace…</option>
            {(workspacesQuery.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </FormField>
      ) : (
        <FormField label="Workspace ID *" htmlFor="project-workspace-id" error={errors.workspace_id?.message}>
          <Input id="project-workspace-id" className="font-mono" placeholder="Paste workspace ID…" {...register('workspace_id')} invalid={!!errors.workspace_id} />
        </FormField>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Code *" htmlFor="project-code" error={errors.code?.message}>
          <Input id="project-code" placeholder="e.g. HYD-ROAD-01" invalid={!!errors.code} {...register('code')} />
        </FormField>
        <FormField label="Name *" htmlFor="project-name" error={errors.name?.message}>
          <Input id="project-name" placeholder="Project name" invalid={!!errors.name} {...register('name')} />
        </FormField>
      </div>

      <FormField label="Project type" htmlFor="project-type" error={errors.project_type_id?.message}>
        <select id="project-type" className={inputClass} {...register('project_type_id')}>
          <option value="">Default type…</option>
          {(typesQuery.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.code} — {t.name}
            </option>
          ))}
        </select>
      </FormField>

      <FormField label="Description" htmlFor="project-description" error={errors.description?.message}>
        <textarea id="project-description" rows={3} className={inputClass} placeholder="What is this project about?…" {...register('description')} />
      </FormField>

      <FormField label="Project manager" htmlFor="project-pm" error={errors.project_manager_id?.message}>
        {usersQuery.isSuccess ? (
          <select id="project-pm" className={inputClass} {...register('project_manager_id')}>
            <option value="">Unassigned…</option>
            {(usersQuery.data ?? []).map((u) => (
              <option key={String(u.id)} value={String(u.id)}>{u.username}</option>
            ))}
          </select>
        ) : (
          // Falls back to the raw id when the directory is not readable by
          // this role, rather than hiding the field entirely.
          <Input
            id="project-pm"
            className="font-mono"
            placeholder="Paste user ID (UUID)"
            invalid={!!errors.project_manager_id}
            {...register('project_manager_id')}
          />
        )}
      </FormField>

      <div className="rounded-lg border border-border bg-surface-sunken p-3">
        <p className="mb-3 text-2xs font-semibold uppercase tracking-wide text-text-subtle">
          Commercial
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Track" htmlFor="project-kind" error={errors.project_kind?.message}>
            <select id="project-kind" className={inputClass} {...register('project_kind')}>
              <option value="">Not set…</option>
              <option value="GOVERNMENT">Government</option>
              <option value="PRIVATE">Private</option>
            </select>
          </FormField>

          <FormField label="Client" htmlFor="project-client" error={errors.client_id?.message}>
            {clientsQuery.isSuccess ? (
              <select id="project-client" className={inputClass} {...register('client_id')}>
                <option value="">No client…</option>
                {(clientsQuery.data ?? []).map((c) => (
                  <option key={String(c.id)} value={String(c.id)}>{c.name}</option>
                ))}
              </select>
            ) : (
              <Input
                id="project-client"
                className="font-mono"
                placeholder="Paste client ID (UUID)"
                invalid={!!errors.client_id}
                {...register('client_id')}
              />
            )}
          </FormField>

          <FormField
            label="Contract value (₹)"
            htmlFor="project-contract-value"
            error={errors.contract_value?.message}
          >
            <Input
              id="project-contract-value"
              type="number"
              min="0"
              step="0.01"
              placeholder="Awarded value"
              invalid={!!errors.contract_value}
              {...register('contract_value')}
            />
          </FormField>

          {projectKind === 'GOVERNMENT' ? (
            <FormField
              label="Work order number"
              htmlFor="project-work-order"
              error={errors.work_order_number?.message}
            >
              <Input
                id="project-work-order"
                placeholder="As issued by the department"
                invalid={!!errors.work_order_number}
                {...register('work_order_number')}
              />
            </FormField>
          ) : null}
        </div>

        <p className="mt-2 text-2xs text-text-subtle">
          A project won on a tender carries these across automatically. Set them here when the work
          was not tendered, or the margin report has nothing to measure against.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Planned start" htmlFor="project-start" error={errors.planned_start_date?.message}>
          <Input id="project-start" type="date" invalid={!!errors.planned_start_date} {...register('planned_start_date')} />
        </FormField>
        <FormField label="Planned end" htmlFor="project-end" error={errors.planned_end_date?.message}>
          <Input id="project-end" type="date" invalid={!!errors.planned_end_date} {...register('planned_end_date')} />
        </FormField>
      </div>

      <FormField label="Priority" htmlFor="project-priority" error={errors.priority?.message}>
        <Input id="project-priority" placeholder="e.g. HIGH" {...register('priority')} />
      </FormField>

      {submitError ? <ErrorCard title="Could not create project" error={submitError} /> : null}

      <div className="flex items-center gap-3">
        <Button type="submit" loading={mutation.isPending}>
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
