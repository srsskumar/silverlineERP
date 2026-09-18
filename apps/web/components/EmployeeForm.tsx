'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import {
  employeeCreateSchema,
  employeeUpdateSchema,
  EMPLOYEE_STATUSES,
  GENDERS,
  type EmployeeCreateInput,
} from '@/lib/validation';
import { listEmployees } from '@/lib/employees';
import { applyFieldErrors, isConflictError, requestIdOf } from '@/lib/form-errors';
import { ApiClientError } from '@/lib/apiClient';
import { Button } from './ui/Button';
import { ErrorCard } from './ui/ErrorCard';
import { FormField } from './ui/FormField';
import { Input } from './ui/Input';
import { CascadingLocationSelect } from './CascadingLocationSelect';
import { DesignationSelect } from './DesignationSelect';
import { ConflictDialog } from './ConflictDialog';

export type EmployeeFormValues = EmployeeCreateInput;

const inputClass =
  'w-full rounded-md border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 border-border';

function toDefaults(src?: Partial<Record<string, unknown>>): Partial<EmployeeFormValues> {
  if (!src) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === null) continue;
    if (k === 'skills' && Array.isArray(v)) {
      out[k] = v.join(', ');
      continue;
    }
    out[k] = v as unknown;
  }
  return out as Partial<EmployeeFormValues>;
}

export function EmployeeForm({
  mode = 'create',
  defaultValues,
  submitLabel,
  onSubmit,
  onConflictReload,
}: {
  mode?: 'create' | 'edit';
  defaultValues?: Partial<Record<string, unknown>>;
  submitLabel?: string;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
  onConflictReload?: () => void;
}) {
  const schema = mode === 'create' ? employeeCreateSchema : employeeUpdateSchema;
  const {
    register,
    handleSubmit,
    setValue,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<EmployeeFormValues>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(schema as any),
    defaultValues: toDefaults(defaultValues) as EmployeeFormValues,
  });
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const [conflict, setConflict] = React.useState<{ message?: string; requestId?: string } | null>(null);
  const [reportsQuery, setReportsQuery] = React.useState('');
  const [reportsOpen, setReportsOpen] = React.useState(false);
  const districtId = watch('district_id' as keyof EmployeeFormValues) as unknown as string | undefined;
  const mandalId = watch('mandal_id' as keyof EmployeeFormValues) as unknown as string | undefined;
  const villageId = watch('village_id' as keyof EmployeeFormValues) as unknown as string | undefined;
  const siteId = watch('site_id' as keyof EmployeeFormValues) as unknown as string | undefined;
  const designationId =
    watch('designation_id' as keyof EmployeeFormValues) as unknown as string | undefined;
  const designationLabel =
    watch('designation' as keyof EmployeeFormValues) as unknown as string | undefined;

  const debouncedQ = React.useMemo(() => reportsQuery.trim(), [reportsQuery]);
  const reportsSearch = useQuery({
    queryKey: ['employees', 'reports-search', debouncedQ],
    queryFn: () => listEmployees({ q: debouncedQ, limit: 8, status: 'ACTIVE' }),
    enabled: reportsOpen && debouncedQ.length >= 2,
    staleTime: 30_000,
  });

  const clean = (v: EmployeeFormValues): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...v };
    // Normalize empty strings / helper shapes to API payload.
    for (const k of Object.keys(out)) {
      if (out[k] === '' || out[k] === undefined) delete out[k];
    }
    if (typeof out.skills === 'string') {
      const parts = (out.skills as string)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length > 0) out.skills = parts;
      else delete out.skills;
    }
    if (out.salary_basic === '' || out.salary_basic === undefined) delete out.salary_basic;
    if (out.experience_years === '' || out.experience_years === undefined) delete out.experience_years;
    return out;
  };

  const internalSubmit = async (values: EmployeeFormValues) => {
    setSubmitError(null);
    try {
      await onSubmit(clean(values));
    } catch (err) {
      if (isConflictError(err)) {
        setConflict({
          message: err instanceof Error ? err.message : undefined,
          requestId: requestIdOf(err),
        });
        return;
      }
      const mapped = applyFieldErrors(err, (field, e) =>
        setError(field as keyof EmployeeFormValues, e),
      );
      if (!mapped) setSubmitError(err);
    }
  };

  const err = (name: keyof EmployeeFormValues): string | undefined =>
    (errors[name]?.message as string | undefined) ??
    (typeof errors[name] === 'string' ? (errors[name] as unknown as string) : undefined);

  return (
    <form onSubmit={handleSubmit(internalSubmit)} className="flex flex-col gap-5" noValidate>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Employee No *" htmlFor="emp_no" error={err('emp_no')}>
          <Input id="emp_no" invalid={!!errors.emp_no} disabled={mode === 'edit'} {...register('emp_no')} />
        </FormField>
        <FormField label="Status" htmlFor="status" error={err('status')}>
          <select id="status" className={inputClass} {...register('status')}>
            <option value="">Select status</option>
            {EMPLOYEE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="First name *" htmlFor="first_name" error={err('first_name')}>
          <Input id="first_name" invalid={!!errors.first_name} {...register('first_name')} />
        </FormField>
        <FormField label="Last name" htmlFor="last_name" error={err('last_name')}>
          <Input id="last_name" {...register('last_name')} />
        </FormField>
        <FormField label="Father name" htmlFor="father_name" error={err('father_name')}>
          <Input id="father_name" {...register('father_name')} />
        </FormField>
        <FormField label="Gender" htmlFor="gender" error={err('gender')}>
          <select id="gender" className={inputClass} {...register('gender')}>
            <option value="">Select gender</option>
            {GENDERS.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Date of birth" htmlFor="date_of_birth" error={err('date_of_birth')}>
          <Input id="date_of_birth" type="date" {...register('date_of_birth')} />
        </FormField>
        <FormField label="Date of joining *" htmlFor="date_of_joining" error={err('date_of_joining')}>
          <Input id="date_of_joining" type="date" invalid={!!errors.date_of_joining} {...register('date_of_joining')} />
        </FormField>
        <FormField label="Phone *" htmlFor="phone" error={err('phone')}>
          <Input id="phone" placeholder="+919876543210" invalid={!!errors.phone} {...register('phone')} />
        </FormField>
        <FormField label="Secondary phone" htmlFor="phone_secondary" error={err('phone_secondary')}>
          <Input id="phone_secondary" {...register('phone_secondary')} />
        </FormField>
        <FormField label="Email" htmlFor="email" error={err('email')}>
          <Input id="email" type="email" {...register('email')} />
        </FormField>
        <FormField label="Designation" htmlFor="designation" error={err('designation') ?? err('designation_id')}>
          <DesignationSelect
            id="designation"
            value={designationId}
            label={designationLabel}
            onChange={(picked) => {
              setValue('designation_id' as keyof EmployeeFormValues,
                (picked?.id ?? null) as never, { shouldDirty: true });
              setValue('designation' as keyof EmployeeFormValues,
                (picked?.label ?? '') as never, { shouldDirty: true });
            }}
          />
        </FormField>
        <FormField label="Department" htmlFor="department" error={err('department')}>
          <Input id="department" {...register('department')} />
        </FormField>
        <div className="relative">
          <FormField label="Reports to (search emp_no / name)" htmlFor="reports-search" error={err('reports_to')}>
            <Input
              id="reports-search"
              placeholder="Type at least 2 characters…"
              value={reportsQuery}
              onChange={(e) => {
                setReportsQuery(e.target.value);
                setReportsOpen(true);
              }}
              onFocus={() => setReportsOpen(true)}
            />
          </FormField>
          <input type="hidden" {...register('reports_to')} />
          {reportsOpen && debouncedQ.length >= 2 && (
            <div className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-md border border-border bg-surface shadow-lg">
              {(reportsSearch.data?.data ?? []).map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-surface-sunken"
                  onClick={() => {
                    setValue('reports_to', e.id, { shouldDirty: true });
                    setReportsQuery(`${e.emp_no} — ${e.first_name}`);
                    setReportsOpen(false);
                  }}
                >
                  {e.emp_no} — {e.first_name} {e.last_name ?? ''}
                </button>
              ))}
              {reportsSearch.data?.data.length === 0 && (
                <p className="px-3 py-2 text-sm text-text-muted">No matches</p>
              )}
            </div>
          )}
        </div>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-text-muted">Location</p>
        <CascadingLocationSelect
          districtId={districtId || undefined}
          mandalId={mandalId || undefined}
          villageId={villageId || undefined}
          siteId={siteId || undefined}
          onChange={(v) => {
            setValue('district_id', (v.district_id ?? '') as never, { shouldDirty: true });
            setValue('mandal_id', (v.mandal_id ?? '') as never, { shouldDirty: true });
            setValue('village_id', (v.village_id ?? '') as never, { shouldDirty: true });
            setValue('site_id', (v.site_id ?? '') as never, { shouldDirty: true });
          }}
        />
        <input type="hidden" {...register('site_id')} />
        <div className="mt-3 grid grid-cols-1 gap-4">
          <FormField label="Address" htmlFor="address" error={err('address')}>
            <Input id="address" {...register('address')} />
          </FormField>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Aadhaar (12 digits)" htmlFor="aadhaar" error={err('aadhaar')}>
          <Input id="aadhaar" inputMode="numeric" {...register('aadhaar')} />
        </FormField>
        <FormField label="PAN (ABCDE1234F)" htmlFor="pan" error={err('pan')}>
          <Input id="pan" {...register('pan')} />
        </FormField>
        <FormField label="Salary basic" htmlFor="salary_basic" error={err('salary_basic')}>
          <Input id="salary_basic" type="number" min={0} step="0.01" {...register('salary_basic')} />
        </FormField>
        <FormField label="PhonePe number" htmlFor="phonepe_number" error={err('phonepe_number')}>
          <Input id="phonepe_number" {...register('phonepe_number')} />
        </FormField>
        <FormField label="Bank name" htmlFor="bank_name" error={err('bank_name')}>
          <Input id="bank_name" {...register('bank_name')} />
        </FormField>
        <FormField label="Bank account" htmlFor="bank_account" error={err('bank_account')}>
          <Input id="bank_account" {...register('bank_account')} />
        </FormField>
        <FormField label="Bank IFSC" htmlFor="bank_ifsc" error={err('bank_ifsc')}>
          <Input id="bank_ifsc" {...register('bank_ifsc')} />
        </FormField>
        <FormField label="Experience (years)" htmlFor="experience_years" error={err('experience_years')}>
          <Input id="experience_years" type="number" min={0} step="0.5" {...register('experience_years')} />
        </FormField>
        <FormField label="Education" htmlFor="education" error={err('education')}>
          <Input id="education" {...register('education')} />
        </FormField>
        <FormField label="Skills (comma separated)" htmlFor="skills" error={err('skills')}>
          <Input id="skills" placeholder="masonry, surveying" {...register('skills')} />
        </FormField>
      </div>

      {submitError ? (
        <ErrorCard
          title={submitError instanceof ApiClientError ? `Save failed (${submitError.code})` : 'Save failed'}
          error={submitError}
        />
      ) : null}

      <div>
        <Button type="submit" loading={isSubmitting}>
          {submitLabel ?? (mode === 'create' ? 'Create employee' : 'Save changes')}
        </Button>
      </div>

      <ConflictDialog
        open={conflict !== null}
        message={conflict?.message}
        requestId={conflict?.requestId}
        onClose={() => setConflict(null)}
        onReload={() => {
          setConflict(null);
          onConflictReload?.();
        }}
      />
    </form>
  );
}
