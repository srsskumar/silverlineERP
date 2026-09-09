'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { createFence, listFences, updateFence, type GeoFence } from '@/lib/geo';
import { queryKeys } from '@/lib/query-keys';
import { ORG_UNIT_TYPES } from '@/lib/validation';
import { isConflictError, requestIdOf } from '@/lib/form-errors';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { ConflictDialog, useConflict } from '@/components/ConflictDialog';
import { FenceForm, type FencePayload } from '@/components/FenceForm';

export const dynamic = 'force-static';

const inputClass =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1';

function describeGeometry(fence: GeoFence): string {
  const g = fence.geometry as Record<string, unknown> | null;
  if (!g || typeof g !== 'object') return '—';
  if (fence.geometry_type === 'circle') {
    const lat = typeof g.lat === 'number' ? g.lat : (g.latitude as number | undefined);
    const lng = typeof g.lng === 'number' ? g.lng : (g.longitude as number | undefined);
    const r = typeof g.radius_m === 'number' ? g.radius_m : (g.radius as number | undefined);
    if (typeof lat === 'number' && typeof lng === 'number') return `(${lat}, ${lng})${typeof r === 'number' ? ` r=${r}m` : ''}`;
    return JSON.stringify(g);
  }
  const pts = (g.points ?? g.coordinates ?? g.vertices) as Array<{ lat?: number; lng?: number } | number[]> | undefined;
  if (Array.isArray(pts)) return `${pts.length} points`;
  return JSON.stringify(g);
}

function CreateFenceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const conflict = useConflict();

  React.useEffect(() => {
    if (open) {
      setSubmitError(null);
      conflict.hide();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  const mutation = useMutation({
    mutationFn: (payload: FencePayload) => createFence(payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.geoFences.all });
      onClose();
    },
    onError: (err) => {
      if (isConflictError(err)) {
        conflict.show(err instanceof Error ? err.message : undefined, requestIdOf(err));
        return;
      }
      setSubmitError(err);
    },
  });

  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="Create geo-fence" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-6 shadow-lg">
        <h2 className="text-base font-semibold text-slate-900">New geo-fence</h2>
        <div className="mt-4">
          <FenceForm key={open ? 'open' : 'closed'} onSubmit={async (p) => { await mutation.mutateAsync(p); }} />
          {submitError ? (
            <div className="mt-3"><ErrorCard title="Could not create fence" error={submitError} /></div>
          ) : null}
          <div className="mt-3 flex justify-end">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
          </div>
        </div>
        <ConflictDialog open={conflict.open} message={conflict.conflict?.message} requestId={conflict.conflict?.requestId} onReload={() => queryClient.invalidateQueries({ queryKey: queryKeys.geoFences.all })} onClose={conflict.hide} />
      </div>
    </div>
  );
}

function FencesManager() {
  const { session } = useAuth();
  const canManage = hasPermission({ permissions: session?.permissions }, PERMISSIONS.GEO_MANAGE);
  const queryClient = useQueryClient();
  const [scopeType, setScopeType] = React.useState('');
  const [scopeId, setScopeId] = React.useState('');
  const [createOpen, setCreateOpen] = React.useState(false);
  const [rowError, setRowError] = React.useState<{ id: string; error: unknown } | null>(null);
  const conflict = useConflict();

  const filters = React.useMemo(
    () => ({ scope_type: scopeType || undefined, scope_id: scopeId.trim() || undefined }),
    [scopeType, scopeId],
  );

  const listQuery = useQuery({
    queryKey: queryKeys.geoFences.list(filters),
    queryFn: () => listFences(filters),
    staleTime: 30_000,
  });

  const deactivate = useMutation({
    mutationFn: (fence: GeoFence) => updateFence(fence.id, { status: 'INACTIVE' }, fence.version),
    onSuccess: async () => {
      setRowError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.geoFences.all });
    },
    onError: (err, fence) => {
      if (isConflictError(err)) {
        conflict.show(err instanceof Error ? err.message : undefined, requestIdOf(err));
        return;
      }
      setRowError({ id: (fence as GeoFence).id, error: err });
    },
  });

  const rows = listQuery.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:flex-row sm:items-end">
        <div>
          <label htmlFor="fence-filter-type" className="text-sm font-medium text-slate-700">Scope type</label>
          <select id="fence-filter-type" className={`${inputClass} sm:w-44`} value={scopeType} onChange={(e) => setScopeType(e.target.value)}>
            <option value="">All</option>
            {ORG_UNIT_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="flex-1">
          <label htmlFor="fence-filter-id" className="text-sm font-medium text-slate-700">Scope ID</label>
          <Input id="fence-filter-id" placeholder="Filter by scope…" value={scopeId} onChange={(e) => setScopeId(e.target.value)} />
        </div>
        {canManage && <Button onClick={() => setCreateOpen(true)}>New fence</Button>}
      </div>

      {listQuery.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : listQuery.isError ? (
        <ErrorCard title="Could not load geo-fences" error={listQuery.error} onRetry={() => listQuery.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No geo-fences" description="Create the first fence for this scope." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 bg-white text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Name</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Scope</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Geometry</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Tol / Acc (m)</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Status</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Version</th>
                {canManage && <th className="px-3 py-2 text-left font-medium text-slate-600">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((f) => (
                <tr key={f.id}>
                  <td className="px-3 py-2 font-medium text-slate-800">{f.name}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-600">{f.scope_type} · {f.scope_id}</td>
                  <td className="px-3 py-2 text-xs text-slate-700">
                    <Badge tone={f.geometry_type === 'circle' ? 'info' : 'neutral'}>{String(f.geometry_type)}</Badge>{' '}
                    {describeGeometry(f)}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">
                    {(f.tolerance_meters as number | null) ?? '—'} / {(f.accuracy_threshold_meters as number | null) ?? '—'}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={(f.status ?? 'ACTIVE') === 'ACTIVE' ? 'success' : 'neutral'}>{String(f.status ?? 'ACTIVE')}</Badge>
                  </td>
                  <td className="px-3 py-2 text-slate-500">v{f.version}</td>
                  {canManage && (
                    <td className="px-3 py-2">
                      {(f.status ?? 'ACTIVE') === 'ACTIVE' ? (
                        <button
                          className="text-red-600 hover:underline disabled:opacity-50"
                          disabled={deactivate.isPending}
                          onClick={() => deactivate.mutate(f)}
                        >
                          Deactivate
                        </button>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                      {rowError?.id === f.id && (
                        <div className="mt-2 max-w-sm">
                          <ErrorCard title="Deactivate failed" error={rowError.error} />
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateFenceDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <ConflictDialog
        open={conflict.open}
        message={conflict.conflict?.message}
        requestId={conflict.conflict?.requestId}
        onReload={() => queryClient.invalidateQueries({ queryKey: queryKeys.geoFences.all })}
        onClose={conflict.hide}
      />
    </div>
  );
}

export default function GeoFencesPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.GEO_READ}>
        <h1 className="text-xl font-bold text-slate-900">Geo-fences</h1>
        <p className="mt-1 text-sm text-slate-500">Circle and polygon perimeters scoped to org units.</p>
        <div className="mt-6">
          <FencesManager />
        </div>
      </RequirePermission>
    </AppShell>
  );
}
