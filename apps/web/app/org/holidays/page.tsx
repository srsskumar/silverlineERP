'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { useAuth } from '@/components/AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { createHoliday, listHolidays } from '@/lib/holidays';
import { queryKeys } from '@/lib/query-keys';
import { holidaySchema, ORG_UNIT_TYPES, type HolidayInput } from '@/lib/validation';
import { applyFieldErrors } from '@/lib/form-errors';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';

export const dynamic = 'force-static';

function CreateHolidayDialog({ open, year, onClose }: { open: boolean; year: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<HolidayInput>({
    resolver: zodResolver(holidaySchema),
    defaultValues: { date: `${year}-01-01`, name: '', type: 'PUBLIC' },
  });

  React.useEffect(() => {
    if (open) {
      reset({ date: `${year}-01-01`, name: '', type: 'PUBLIC' });
      setSubmitError(null);
    }
  }, [open, year, reset]);

  const mutation = useMutation({
    mutationFn: (v: HolidayInput) =>
      createHoliday({ date: v.date, name: v.name, type: v.type, scope_type: v.scope_type, scope_id: v.scope_id || null }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.holidays.all });
      onClose();
    },
    onError: (err) => {
      const mapped = applyFieldErrors(err, (f, e) => setError(f as keyof HolidayInput, e));
      if (!mapped) setSubmitError(err);
    },
  });

  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="Create holiday" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
        <h2 className="text-base font-semibold text-slate-900">New holiday</h2>
        <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="mt-4 flex flex-col gap-4" noValidate>
          <FormField label="Date *" htmlFor="hol-date" error={errors.date?.message}>
            <Input id="hol-date" type="date" invalid={!!errors.date} {...register('date')} />
          </FormField>
          <FormField label="Name *" htmlFor="hol-name" error={errors.name?.message}>
            <Input id="hol-name" invalid={!!errors.name} {...register('name')} />
          </FormField>
          <FormField label="Type *" htmlFor="hol-type" error={errors.type?.message}>
            <Input id="hol-type" placeholder="PUBLIC / FESTIVAL / REGIONAL…" {...register('type')} />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Scope type" htmlFor="hol-scope-type" error={errors.scope_type?.message}>
              <select id="hol-scope-type" className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" {...register('scope_type')}>
                <option value="">Org-wide</option>
                {ORG_UNIT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Scope ID" htmlFor="hol-scope-id" error={errors.scope_id?.message}>
              <Input id="hol-scope-id" placeholder="optional" {...register('scope_id')} />
            </FormField>
          </div>
          {submitError ? <ErrorCard title="Could not create holiday" error={submitError} /> : null}
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

function HolidaysManager() {
  const { session } = useAuth();
  const canManage = hasPermission({ permissions: session?.permissions }, PERMISSIONS.HOLIDAY_MANAGE);
  const [year, setYear] = React.useState(new Date().getFullYear());
  const [createOpen, setCreateOpen] = React.useState(false);

  const holidaysQuery = useQuery({
    queryKey: queryKeys.holidays.list({ year }),
    queryFn: () => listHolidays({ year }),
    staleTime: 60_000,
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4">
        <div>
          <FormField label="Year" htmlFor="hol-year">
            <Input
              id="hol-year"
              type="number"
              value={year}
              min={2000}
              max={2100}
              onChange={(e) => setYear(Number(e.target.value) || new Date().getFullYear())}
              className="w-32"
            />
          </FormField>
        </div>
        <div className="ml-auto">{canManage && <Button onClick={() => setCreateOpen(true)}>New holiday</Button>}</div>
      </div>
      {holidaysQuery.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : holidaysQuery.isError ? (
        <ErrorCard title="Could not load holidays" error={holidaysQuery.error} onRetry={() => holidaysQuery.refetch()} />
      ) : (holidaysQuery.data ?? []).length === 0 ? (
        <EmptyState title={`No holidays in ${year}`} description="Add the year's public and festival holidays." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 bg-white text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Date</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Name</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Type</th>
                <th className="px-3 py-2 text-left font-medium text-slate-600">Scope</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(holidaysQuery.data ?? []).map((h) => (
                <tr key={h.id}>
                  <td className="px-3 py-2 font-mono text-xs">{h.date}</td>
                  <td className="px-3 py-2">{h.name}</td>
                  <td className="px-3 py-2">{h.type}</td>
                  <td className="px-3 py-2 text-slate-600">
                    {h.scope_type ? `${h.scope_type}:${String(h.scope_id).slice(0, 8)}…` : 'Org-wide'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <CreateHolidayDialog open={createOpen} year={year} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

export default function HolidaysPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.HOLIDAY_READ}>
        <h1 className="text-xl font-bold text-slate-900">Holidays</h1>
        <p className="mt-1 text-sm text-slate-500">Yearly holiday calendar, optionally scoped to a location.</p>
        <div className="mt-6">
          <HolidaysManager />
        </div>
      </RequirePermission>
    </AppShell>
  );
}
