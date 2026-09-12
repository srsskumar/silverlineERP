'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { formatHours, getRecord } from '@/lib/attendance';
import { queryKeys } from '@/lib/query-keys';
import { AttendanceStatusBadge } from '@/components/AttendanceStatusBadge';
import { DecisionDialog } from '@/components/DecisionDialog';
import { ExceptionDialog } from '@/components/ExceptionDialog';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
      <dt className="w-40 shrink-0 text-xs font-medium uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="text-sm text-text">{value}</dd>
    </div>
  );
}

export function RecordDetailView({ id }: { id: string }) {
  const { session } = useAuth();
  const holder = { permissions: session?.permissions };
  const canDecide = hasPermission(holder, PERMISSIONS.ATTENDANCE_DECIDE);
  const [fileOpen, setFileOpen] = React.useState(false);
  const [decideOpen, setDecideOpen] = React.useState(false);
  const [decideId, setDecideId] = React.useState('');
  const [decideVersion, setDecideVersion] = React.useState('1');

  const detailQuery = useQuery({
    queryKey: queryKeys.attendance.record(id),
    queryFn: () => getRecord(id),
  });

  if (detailQuery.isLoading) {
    return (
      <AppShell>
        <Skeleton className="h-96 w-full" />
      </AppShell>
    );
  }
  if (detailQuery.isError) {
    return (
      <AppShell>
        <ErrorCard title="Could not load attendance record" error={detailQuery.error} onRetry={() => detailQuery.refetch()} />
      </AppShell>
    );
  }
  const detail = detailQuery.data;
  if (!detail) {
    return (
      <AppShell>
        <EmptyState title="Record not found" />
      </AppShell>
    );
  }
  const { record, events } = detail;

  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.ATTENDANCE_READ}>
        <div className="flex flex-col gap-6">
          <div className="rounded-lg border border-border bg-surface p-4 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-xl font-bold text-text">
                  {record.work_date} <span className="font-mono text-sm font-normal text-text-muted">{record.employee_id}</span>
                </h1>
                <div className="mt-2 flex items-center gap-2">
                  <AttendanceStatusBadge status={String(record.status)} violation={!!record.geofence_violation} />
                  <span className="text-xs text-text-muted">v{record.version}</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => setFileOpen(true)}>
                  File exception
                </Button>
              </div>
            </div>
            <dl className="mt-4 divide-y divide-border">
              <DetailRow label="Check in" value={record.check_in_at ? String(record.check_in_at) : '—'} />
              <DetailRow label="Check out" value={record.check_out_at ? String(record.check_out_at) : '—'} />
              <DetailRow label="Total hours" value={formatHours(record.total_hours)} />
              <DetailRow label="Geofence violation" value={record.geofence_violation ? 'Yes ⚠' : 'No'} />
            </dl>
          </div>

          <div className="rounded-lg border border-border bg-surface p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-text">Events timeline ({events.length})</h2>
            {events.length === 0 ? (
              <p className="mt-2 text-sm text-text-muted">No punch events on this record yet.</p>
            ) : (
              <ol className="mt-3 flex flex-col gap-0">
                {events.map((e) => {
                  const rec = e as unknown as Record<string, unknown>;
                  const decision = typeof rec.decision === 'string' ? rec.decision : null;
                  const review = typeof rec.review === 'string' ? rec.review : null;
                  return (
                    <li key={e.id} className="flex gap-3 border-l-2 border-border pb-4 pl-4 last:pb-0">
                      <div className="flex flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={e.event_type === 'CHECK_IN' ? 'success' : 'info'}>{e.event_type}</Badge>
                          <span className="font-mono text-xs text-text-muted">{e.client_timestamp}</span>
                          {decision && <Badge tone="success">{decision}</Badge>}
                          {review && <Badge tone="warning">{review}</Badge>}
                        </div>
                        <p className="font-mono text-xs text-text-muted">
                          {e.id}
                          {typeof e.latitude === 'number' && typeof e.longitude === 'number'
                            ? ` · ${e.latitude},${e.longitude}${typeof e.gps_accuracy === 'number' ? ` ±${e.gps_accuracy}m` : ''}`
                            : ' · no GPS'}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>

          {canDecide && (
            <div className="rounded-lg border border-border bg-surface p-4 sm:p-6">
              <h2 className="text-sm font-semibold text-text">Decide an exception</h2>
              <p className="mt-1 text-xs text-text-muted">
                Enter a known exception id + version (from a file action or a 202 punch response), then submit a decision.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3 sm:items-end">
                <FormField label="Exception ID" htmlFor="rec-decide-id">
                  <Input id="rec-decide-id" placeholder="exc_…" value={decideId} onChange={(e) => setDecideId(e.target.value)} />
                </FormField>
                <FormField label="Version (If-Match)" htmlFor="rec-decide-ver">
                  <Input id="rec-decide-ver" inputMode="numeric" value={decideVersion} onChange={(e) => setDecideVersion(e.target.value)} />
                </FormField>
                <Button disabled={!decideId.trim()} onClick={() => setDecideOpen(true)}>
                  Decide…
                </Button>
              </div>
            </div>
          )}

          <ExceptionDialog
            open={fileOpen}
            onClose={() => setFileOpen(false)}
            defaultEmployeeId={record.employee_id}
            defaultRecordId={record.id}
          />
          {canDecide && decideId.trim() && (
            <DecisionDialog
              open={decideOpen}
              onClose={() => setDecideOpen(false)}
              exceptionId={decideId.trim()}
              version={decideVersion.trim() || '1'}
              onReload={() => detailQuery.refetch()}
            />
          )}
        </div>
      </RequirePermission>
    </AppShell>
  );
}
