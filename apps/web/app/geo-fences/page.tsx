'use client';

import * as React from 'react';
import Link from 'next/link';
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
import { Skeleton } from '@/components/ui/Skeleton';
import { ConflictDialog, useConflict } from '@/components/ConflictDialog';
import { FenceForm, type FencePayload } from '@/components/FenceForm';
import { FenceMap } from '@/components/map/FenceMap';
import { fetchAllOrgUnits } from '@/lib/org';
import { fetchAllEmployees } from '@/lib/employees';

export const dynamic = 'force-static';

const inputClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1';

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
    <div role="dialog" aria-modal="true" aria-label="Create geo-fence" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-surface p-6 shadow-lg">
        <h2 className="text-base font-semibold text-text">New geo-fence</h2>
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
  const unitsQuery = useQuery({
    queryKey: [...queryKeys.orgUnits.all, 'fence-picker'],
    queryFn: () => fetchAllOrgUnits({ limit: 100 }),
    staleTime: 10 * 60_000,
  });
  const units = unitsQuery.data ?? [];
  const unitById = React.useMemo(() => new Map(units.map((unit) => [unit.id, unit])), [units]);
  const employeesQuery = useQuery({
    queryKey: ['employees', 'fence-assignment-labels'],
    queryFn: () => fetchAllEmployees({ limit: 100, status: 'ACTIVE' }),
    staleTime: 10 * 60_000,
  });
  const employeeById = React.useMemo(
    () => new Map((employeesQuery.data ?? []).map((employee) => [employee.id, employee])),
    [employeesQuery.data],
  );

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
  const [activeFenceId, setActiveFenceId] = React.useState<string | null>(null);

  // Split the stored geometry into the two shapes the map draws. Rows with
  // geometry the API did not return in the expected form are skipped rather
  // than crashing the map.
  const mapCircles = React.useMemo(
    () =>
      rows.flatMap((f) => {
        if (f.geometry_type !== 'circle') return [];
        const g = f.geometry as { lat?: number; lng?: number; radius_m?: number } | null;
        if (!g || typeof g.lat !== 'number' || typeof g.lng !== 'number') return [];
        return [{
          id: f.id,
          name: f.name,
          lat: g.lat,
          lng: g.lng,
          radius_m: (typeof g.radius_m === 'number' ? g.radius_m : 100) + (f.tolerance_meters ?? 0),
        }];
      }),
    [rows],
  );
  const mapPolygons = React.useMemo(
    () =>
      rows.flatMap((f) => {
        if (f.geometry_type !== 'polygon') return [];
        const g = f.geometry as { points?: Array<[number, number]> } | null;
        if (!g || !Array.isArray(g.points) || g.points.length < 3) return [];
        return [{ id: f.id, name: f.name, points: g.points }];
      }),
    [rows],
  );


  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 sm:flex-row sm:items-end">
        <div>
          <label htmlFor="fence-filter-type" className="text-sm font-medium text-text-muted">Scope type</label>
          <select id="fence-filter-type" className={`${inputClass} sm:w-44`} value={scopeType} onChange={(e) => { setScopeType(e.target.value); setScopeId(''); }}>
            <option value="">All</option>
            {ORG_UNIT_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="flex-1">
          <label htmlFor="fence-filter-id" className="text-sm font-medium text-text-muted">Location / site</label>
          <select id="fence-filter-id" className={inputClass} value={scopeId} disabled={!scopeType || unitsQuery.isLoading} onChange={(e) => setScopeId(e.target.value)}>
            <option value="">{scopeType ? `All ${scopeType}s` : 'Choose a scope type first'}</option>
            {units.filter((unit) => unit.type === scopeType && unit.status === 'ACTIVE').map((unit) => (
              <option key={unit.id} value={unit.id}>{unit.name} ({unit.code})</option>
            ))}
          </select>
        </div>
        {canManage && <Button onClick={() => setCreateOpen(true)}>New fence</Button>}
      </div>

      {/* Overview map: a table of coordinate tuples cannot answer "do these
          sites overlap" or "is one of them in the wrong district", which is the
          question an admin actually has when reviewing fences. */}
      {rows.length > 0 ? (
        <FenceMap
          height={340}
          className="mb-4"
          circles={mapCircles}
          polygons={mapPolygons}
          activeId={activeFenceId}
        />
      ) : null}

      {listQuery.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : listQuery.isError ? (
        <ErrorCard title="Could not load geo-fences" error={listQuery.error} onRetry={() => listQuery.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No geo-fences" description="Create the first fence for this scope." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="min-w-full divide-y divide-border bg-surface text-sm">
            <thead className="bg-surface-sunken">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Name</th>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Scope</th>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Direct employees</th>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Geometry</th>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Tol / Acc (m)</th>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Status</th>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Version</th>
                {canManage && <th className="px-3 py-2 text-left font-medium text-text-muted">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((f) => (
                // Hovering a row highlights that fence on the map above, which
                // is how an admin connects a coordinate tuple to a place.
                <tr
                  key={f.id}
                  onMouseEnter={() => setActiveFenceId(f.id)}
                  onMouseLeave={() => setActiveFenceId(null)}
                  onFocus={() => setActiveFenceId(f.id)}
                  onBlur={() => setActiveFenceId(null)}
                  className="row-hover"
                >
                  <td className="px-3 py-2 font-medium text-text">{f.name}</td>
                  <td className="px-3 py-2 text-xs text-text-muted">
                    {f.scope_type} · {unitById.get(f.scope_id)?.name ?? f.scope_id}
                  </td>
                  <td className="px-3 py-2 text-xs text-text-muted">
                    {(f.employee_ids ?? []).length > 0
                      ? (f.employee_ids ?? []).map((id) => {
                          const employee = employeeById.get(id);
                          return employee ? `${employee.emp_no} · ${employee.first_name}` : id;
                        }).join(', ')
                      : 'Site/location fallback'}
                  </td>
                  <td className="px-3 py-2 text-xs text-text-muted">
                    <Badge tone={f.geometry_type === 'circle' ? 'info' : 'neutral'}>{String(f.geometry_type)}</Badge>{' '}
                    {describeGeometry(f)}
                  </td>
                  <td className="px-3 py-2 text-xs text-text-muted">
                    {(f.tolerance_meters as number | null) ?? '—'} / {(f.accuracy_threshold_meters as number | null) ?? '—'}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={(f.status ?? 'ACTIVE') === 'ACTIVE' ? 'success' : 'neutral'}>{String(f.status ?? 'ACTIVE')}</Badge>
                  </td>
                  <td className="px-3 py-2 text-text-muted">v{f.version}</td>
                  {canManage && (
                    <td className="px-3 py-2">
                      {(f.status ?? 'ACTIVE') === 'ACTIVE' ? (
                        <button
                          className="text-danger hover:underline disabled:opacity-50"
                          disabled={deactivate.isPending}
                          onClick={() => deactivate.mutate(f)}
                        >
                          Deactivate
                        </button>
                      ) : (
                        <span className="text-text-subtle">—</span>
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
        <h1 className="text-xl font-bold text-text">Geo-fences</h1>
        <p className="mt-1 text-sm text-text-muted">Circle and polygon perimeters scoped to employee work locations.</p>
        <div className="mt-4 rounded-lg border border-info/30 bg-info/5 p-4 text-sm text-text-muted">
          Assign the employee to a site under <Link href="/employees" className="font-medium text-info underline">Employees</Link>,
          then create an active fence for that same site here. Site fences take priority over village, mandal and district fences;
          punches outside the effective boundary are sent for review.
        </div>
        <div className="mt-6">
          <FencesManager />
        </div>
      </RequirePermission>
    </AppShell>
  );
}
