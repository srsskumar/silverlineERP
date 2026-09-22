'use client';

import * as React from 'react';
import Link from '@/components/AppLink';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import {
  listRecords,
  regularize,
  type AttendanceException,
  type AttendanceRecord,
} from '@/lib/attendance';
import { queryKeys } from '@/lib/query-keys';
import { DATE_RE, regularizeSchema, type RegularizeFormInput } from '@/lib/validation';
import { applyFieldErrors } from '@/lib/form-errors';
import { AttendanceStatusBadge } from '@/components/AttendanceStatusBadge';
import { DecisionDialog } from '@/components/DecisionDialog';
import { ExceptionDialog } from '@/components/ExceptionDialog';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';

export const dynamic = 'force-static';

const inputClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1';

interface KnownException {
  id: string;
  version: string;
  label?: string;
}

function RegularizeCard({ onCreated }: { onCreated: (ex: AttendanceException) => void }) {
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const [created, setCreated] = React.useState<AttendanceException | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegularizeFormInput>({
    resolver: zodResolver(regularizeSchema),
    defaultValues: { employee_id: '', work_date: '', claimed_check_in: '', claimed_check_out: '', reason: '' },
  });

  const mutation = useMutation({
    mutationFn: (v: RegularizeFormInput) =>
      regularize({
        employee_id: v.employee_id,
        work_date: v.work_date,
        claimed_check_in: v.claimed_check_in || undefined,
        claimed_check_out: v.claimed_check_out || undefined,
        reason: v.reason,
      }),
    onSuccess: (ex) => {
      setCreated(ex);
      setSubmitError(null);
      onCreated(ex);
      reset();
    },
    onError: (err) => {
      const mapped = applyFieldErrors(err, (f, e) => setError(f as keyof RegularizeFormInput, e));
      if (!mapped) setSubmitError(err);
    },
  });

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold text-text">Request regularization</h2>
      <p className="mt-1 text-xs text-text-muted">Creates an exception carrying the claimed times; it appears in the known-ids queue below.</p>
      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="mt-3 grid gap-3 sm:grid-cols-2" noValidate>
        <FormField label="Employee ID *" htmlFor="reg-employee" error={errors.employee_id?.message}>
          <Input id="reg-employee" {...register('employee_id')} />
        </FormField>
        <FormField label="Work date (YYYY-MM-DD) *" htmlFor="reg-date" error={errors.work_date?.message}>
          <Input id="reg-date" placeholder="2026-09-01" {...register('work_date')} />
        </FormField>
        <FormField label="Claimed check-in" htmlFor="reg-in" error={errors.claimed_check_in?.message}>
          <Input id="reg-in" placeholder="2026-09-01T09:00:00Z" {...register('claimed_check_in')} />
        </FormField>
        <FormField label="Claimed check-out" htmlFor="reg-out" error={errors.claimed_check_out?.message}>
          <Input id="reg-out" placeholder="2026-09-01T18:00:00Z" {...register('claimed_check_out')} />
        </FormField>
        <div className="sm:col-span-2">
          <FormField label="Reason *" htmlFor="reg-reason" error={errors.reason?.message}>
            <textarea id="reg-reason" rows={2} className={inputClass} {...register('reason')} />
          </FormField>
        </div>
        {submitError ? (
          <div className="sm:col-span-2"><ErrorCard title="Could not request regularization" error={submitError} /></div>
        ) : null}
        {created ? (
          <p role="status" className="text-sm text-success sm:col-span-2">
            Regularization filed as <span className="font-mono text-xs">{created.id}</span> (v{created.version}).
          </p>
        ) : null}
        <div className="sm:col-span-2">
          <Button type="submit" loading={isSubmitting || mutation.isPending}>Submit regularization</Button>
        </div>
      </form>
    </div>
  );
}

function ExceptionsManager() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const canDecide = hasPermission({ permissions: session?.permissions }, PERMISSIONS.ATTENDANCE_DECIDE);

  const [lookupEmployee, setLookupEmployee] = React.useState('');
  const [lookupDate, setLookupDate] = React.useState('');
  const [lookup, setLookup] = React.useState<{ loading: boolean; error: unknown; record: AttendanceRecord | null; searched: boolean }>({
    loading: false, error: null, record: null, searched: false,
  });
  const [fileOpen, setFileOpen] = React.useState(false);
  const [known, setKnown] = React.useState<KnownException[]>([]);
  const [manualId, setManualId] = React.useState('');
  const [manualVersion, setManualVersion] = React.useState('1');
  const [decideTarget, setDecideTarget] = React.useState<KnownException | null>(null);

  const addKnown = React.useCallback((entry: KnownException) => {
    setKnown((prev) => (prev.some((k) => k.id === entry.id) ? prev : [...prev, entry]));
  }, []);

  const runLookup = async () => {
    if (!lookupEmployee.trim() || !DATE_RE.test(lookupDate.trim())) {
      setLookup({ loading: false, error: new Error('Enter an employee ID and a work date (YYYY-MM-DD).'), record: null, searched: true });
      return;
    }
    setLookup({ loading: true, error: null, record: null, searched: true });
    try {
      const page = await listRecords({ employee_id: lookupEmployee.trim(), from: lookupDate.trim(), to: lookupDate.trim(), limit: 5 });
      const exact = page.data.find((r) => r.work_date === lookupDate.trim()) ?? page.data[0] ?? null;
      setLookup({ loading: false, error: null, record: exact, searched: true });
    } catch (err) {
      setLookup({ loading: false, error: err, record: null, searched: true });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border border-warning/30 bg-warning-subtle px-4 py-3 text-xs text-warning">
        The S2 contract has no <span className="font-mono">GET /attendance/exceptions</span> list endpoint, so there is no
        server-side queue to render. This page works from <em>known</em> exception ids: ids returned by file/regularize
        actions, <span className="font-mono">exception_id</span> values from 202 punch responses, or ids you paste manually.
        A list endpoint is tracked as an S3 backend gap.
      </div>

      <div className="rounded-lg border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold text-text">1 · Load record by employee + date</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3 sm:items-end">
          <FormField label="Employee ID" htmlFor="exc-lookup-emp">
            <Input id="exc-lookup-emp" value={lookupEmployee} onChange={(e) => setLookupEmployee(e.target.value)} />
          </FormField>
          <FormField label="Work date (YYYY-MM-DD)" htmlFor="exc-lookup-date">
            <Input id="exc-lookup-date" placeholder="2026-09-01" value={lookupDate} onChange={(e) => setLookupDate(e.target.value)} />
          </FormField>
          <Button loading={lookup.loading} onClick={runLookup}>Load record</Button>
        </div>
        {lookup.searched && !lookup.loading && lookup.error ? (
          <div className="mt-3"><ErrorCard title="Lookup failed" error={lookup.error} /></div>
        ) : null}
        {lookup.searched && !lookup.loading && !lookup.error && !lookup.record ? (
          <div className="mt-3"><EmptyState title="No record for that employee + date" description="File an unlinked exception below, or check the lookup values." /></div>
        ) : null}
        {lookup.record ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2 text-sm">
            <AttendanceStatusBadge status={String(lookup.record.status)} />
            <span className="font-mono text-xs text-text-muted">{lookup.record.id} · {lookup.record.work_date}</span>
            <Link href={`/attendance/records/${lookup.record.id}`} className="text-primary hover:underline">
              Open record
            </Link>
            <Button variant="secondary" onClick={() => setFileOpen(true)}>File exception…</Button>
          </div>
        ) : null}
      </div>

      <RegularizeCard onCreated={(ex) => addKnown({ id: ex.id, version: String(ex.version), label: 'regularization' })} />

      <div className="rounded-lg border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold text-text">2 · Decide queue ({known.length} known)</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3 sm:items-end">
          <FormField label="Exception ID" htmlFor="exc-manual-id">
            <Input id="exc-manual-id" placeholder="Paste from a 202 punch…" value={manualId} onChange={(e) => setManualId(e.target.value)} />
          </FormField>
          <FormField label="Version (If-Match)" htmlFor="exc-manual-ver">
            <Input id="exc-manual-ver" inputMode="numeric" value={manualVersion} onChange={(e) => setManualVersion(e.target.value)} />
          </FormField>
          <Button
            variant="secondary"
            disabled={!manualId.trim()}
            onClick={() => {
              addKnown({ id: manualId.trim(), version: manualVersion.trim() || '1', label: 'manual' });
              setManualId('');
            }}
          >
            Track ID
          </Button>
        </div>
        {known.length === 0 ? (
          <div className="mt-3"><EmptyState title="Queue is empty" description="File an exception or regularization above, or track an ID from a 202 punch response." /></div>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-md border border-border">
            {known.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="font-mono text-xs text-text">{k.id}</span>
                <Badge tone="info">v{k.version}</Badge>
                {k.label && <Badge>{k.label}</Badge>}
                <span className="ml-auto flex items-center gap-2">
                  <Input
                    aria-label={`Version for ${k.id}`}
                    className="!w-20"
                    inputMode="numeric"
                    value={k.version}
                    onChange={(e) => setKnown((prev) => prev.map((p) => (p.id === k.id ? { ...p, version: e.target.value } : p)))}
                  />
                  {canDecide ? (
                    <Button variant="secondary" onClick={() => setDecideTarget(k)}>Decide…</Button>
                  ) : (
                    <span className="text-xs text-text-subtle">needs attendance.decide</span>
                  )}
                  <button
                    className="text-xs text-text-muted hover:underline"
                    onClick={() => setKnown((prev) => prev.filter((p) => p.id !== k.id))}
                  >
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ExceptionDialog
        open={fileOpen}
        onClose={() => setFileOpen(false)}
        defaultEmployeeId={lookup.record?.employee_id}
        defaultRecordId={lookup.record?.id}
        onFiled={(ex) => addKnown({ id: ex.id, version: String(ex.version), label: 'filed' })}
      />
      {decideTarget && (
        <DecisionDialog
          open={!!decideTarget}
          onClose={() => setDecideTarget(null)}
          exceptionId={decideTarget.id}
          version={decideTarget.version || '1'}
          onReload={() => queryClient.invalidateQueries({ queryKey: queryKeys.attendance.all })}
          onDecided={(ex) => {
            setKnown((prev) => prev.filter((p) => p.id !== ex.id));
            setDecideTarget(null);
          }}
        />
      )}
    </div>
  );
}

export default function ExceptionsPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.ATTENDANCE_READ}>
        <h1 className="text-xl font-bold text-text">Attendance exceptions</h1>
        <p className="mt-1 text-sm text-text-muted">File, regularize and decide attendance exceptions by known ID.</p>
        <div className="mt-6">
          <ExceptionsManager />
        </div>
      </RequirePermission>
    </AppShell>
  );
}
