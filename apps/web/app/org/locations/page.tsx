'use client';

import Link from '@/components/AppLink';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { createOrgUnit, listOrgUnits, patchOrgUnit, type OrgUnit, type OrgUnitType } from '@/lib/org';
import { queryKeys } from '@/lib/query-keys';
import { orgUnitSchema, type OrgUnitInput } from '@/lib/validation';
import { applyFieldErrors } from '@/lib/form-errors';
import { ApiClientError } from '@/lib/apiClient';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';

export const dynamic = 'force-static';

const TABS: OrgUnitType[] = ['district', 'mandal', 'village', 'site'];
const PARENT_OF: Record<OrgUnitType, OrgUnitType | null> = {
  district: null,
  mandal: 'district',
  village: 'mandal',
  site: 'village',
};
const PAGE_LIMIT = 20;

function CreateUnitDialog({
  type,
  open,
  onClose,
}: {
  type: OrgUnitType;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const parentType = PARENT_OF[type];
  const parentsQuery = useQuery({
    queryKey: parentType ? queryKeys.orgUnits.list({ type: parentType, limit: 200 }) : ['orgUnits', 'none'],
    queryFn: () => listOrgUnits({ type: parentType!, limit: 200 }),
    enabled: open && !!parentType,
    staleTime: 10 * 60_000,
  });
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<OrgUnitInput>({
    resolver: zodResolver(orgUnitSchema),
    defaultValues: { type, code: '', name: '', parent_id: '' },
  });

  React.useEffect(() => {
    if (open) {
      reset({ type, code: '', name: '', parent_id: '' });
      setSubmitError(null);
    }
  }, [open, type, reset]);

  const mutation = useMutation({
    mutationFn: (v: OrgUnitInput) =>
      createOrgUnit({
        type: v.type,
        code: v.code,
        name: v.name,
        parent_id: v.parent_id || null,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.orgUnits.all });
      onClose();
    },
    onError: (err) => {
      const mapped = applyFieldErrors(err, (f, e) => setError(f as keyof OrgUnitInput, e));
      if (!mapped) setSubmitError(err);
    },
  });

  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label={`Create ${type}`} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
        <h2 className="text-base font-semibold text-slate-900">New {type}</h2>
        <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="mt-4 flex flex-col gap-4" noValidate>
          <FormField label="Code *" htmlFor="unit-code" error={errors.code?.message}>
            <Input id="unit-code" invalid={!!errors.code} {...register('code')} />
          </FormField>
          <FormField label="Name *" htmlFor="unit-name" error={errors.name?.message}>
            <Input id="unit-name" invalid={!!errors.name} {...register('name')} />
          </FormField>
          {parentType && (
            <FormField label={`Parent ${parentType}`} htmlFor="unit-parent" error={errors.parent_id?.message}>
              <select
                id="unit-parent"
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                {...register('parent_id')}
              >
                <option value="">Select {parentType}</option>
                {(parentsQuery.data?.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.code})
                  </option>
                ))}
              </select>
            </FormField>
          )}
          {submitError ? <ErrorCard title="Could not create location" error={submitError} /> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={isSubmitting || mutation.isPending}>
              Create
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function LocationsManager() {
  const { session } = useAuth();
  const canManage = hasPermission({ permissions: session?.permissions }, PERMISSIONS.ORG_UNITS_MANAGE);
  const queryClient = useQueryClient();
  const [tab, setTab] = React.useState<OrgUnitType>('district');
  const [q, setQ] = React.useState('');
  const [debouncedQ, setDebouncedQ] = React.useState('');
  const [createOpen, setCreateOpen] = React.useState(false);
  const [rowError, setRowError] = React.useState<{ id: string; error: unknown } | null>(null);

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const listQuery = useInfiniteQuery({
    queryKey: queryKeys.orgUnits.list({ type: tab, q: debouncedQ || undefined, limit: PAGE_LIMIT }),
    queryFn: ({ pageParam }) =>
      listOrgUnits({ type: tab, q: debouncedQ || undefined, limit: PAGE_LIMIT, cursor: pageParam as string | undefined }),
    initialPageParam: undefined as unknown as string | undefined,
    getNextPageParam: (last) => (last.has_more && last.next_cursor ? last.next_cursor : undefined),
    staleTime: 30_000,
  });

  const deactivate = useMutation({
    mutationFn: (unit: OrgUnit) => patchOrgUnit(unit.id, { status: 'INACTIVE' }, unit.version),
    onSuccess: async () => {
      setRowError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.orgUnits.all });
    },
    onError: (err, unit) => setRowError({ id: (unit as OrgUnit).id, error: err }),
  });

  const rows = (listQuery.data?.pages ?? []).flatMap((p) => p.data);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium ${
              tab === t ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 ring-1 ring-slate-300'
            }`}
          >
            {t}s
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <Input placeholder="Search code / name…" value={q} onChange={(e) => setQ(e.target.value)} className="sm:w-56" />
          {canManage && <Button onClick={() => setCreateOpen(true)}>New {tab}</Button>}
        </div>
      </div>

      {listQuery.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : listQuery.isError ? (
        <ErrorCard title="Could not load locations" error={listQuery.error} onRetry={() => listQuery.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={`No ${tab}s`} description="Create the first record to build the hierarchy." />
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 bg-white text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Code</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Name</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Status</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Version</th>
                  {canManage && <th className="px-3 py-2 text-left font-medium text-slate-600">Action</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((u) => (
                  <tr key={u.id}>
                    <td className="px-3 py-2 font-mono text-xs">{u.code}</td>
                    <td className="px-3 py-2">{u.name}</td>
                    <td className="px-3 py-2">
                      <Badge tone={u.status === 'ACTIVE' ? 'success' : 'neutral'}>{u.status}</Badge>
                    </td>
                    <td className="px-3 py-2 text-slate-500">v{u.version}</td>
                    {canManage && (
                      <td className="px-3 py-2">
                        {u.status === 'ACTIVE' ? (
                          <button
                            className="text-red-600 hover:underline disabled:opacity-50"
                            disabled={deactivate.isPending}
                            onClick={() => deactivate.mutate(u)}
                          >
                            Deactivate
                          </button>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                        {rowError?.id === u.id && (
                          <div className="mt-2 max-w-sm">
                            <ErrorCard
                              title={
                                rowError.error instanceof ApiClientError &&
                                /child/i.test(rowError.error.message)
                                  ? 'Cannot deactivate: child locations still active'
                                  : 'Deactivate failed'
                              }
                              error={rowError.error}
                            />
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {listQuery.hasNextPage && (
            <Button variant="secondary" loading={listQuery.isFetchingNextPage} onClick={() => listQuery.fetchNextPage()}>
              Load more
            </Button>
          )}
        </>
      )}
      <CreateUnitDialog type={tab} open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

export default function LocationsPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.ORG_UNITS_READ}>
        <h1 className="text-xl font-bold text-slate-900">Locations</h1><Link className="text-sm text-blue-700 underline" href="/org/locations/import">Import locations from CSV</Link>
        <p className="mt-1 text-sm text-slate-500">District → mandal → village → site hierarchy.</p>
        <div className="mt-6">
          <LocationsManager />
        </div>
      </RequirePermission>
    </AppShell>
  );
}
