'use client';
import {DownloadButton} from './DownloadButton';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { ApiClientError } from '@/lib/apiClient';
import { useAuth } from './AuthProvider';
import { hasPermission } from '@/lib/permissions';
import {
  REPORT_FORMAT,
  REPORT_ROW_LIMIT,
  REPORT_TYPE_META,
  downloadReportUrl,
  generateReport,
  type ReportJob,
  type ReportType,
} from '@/lib/reports';
import { reportSchema, type ReportFormInput } from '@/lib/validation';
import { requestIdOf } from '@/lib/form-errors';
import { Button } from './ui/Button';
import { ErrorCard } from './ui/ErrorCard';
import { FormField } from './ui/FormField';
import { Input } from './ui/Input';

/**
 * S6 report form: type-only UI (format fixed csv, no filters — deferred, see
 * README S6 notes). The type select is gated per-type: options the session
 * cannot generate are disabled with the required permission in the label.
 * Generate → result card with row count + absolute Download href.
 * 403s surface inline (never a shell gate).
 */
export function ReportForm() {
  const { session } = useAuth();
  const permissions = session?.permissions ?? [];
  const [format,setFormat]=React.useState<'csv'|'xlsx'|'pdf'>('csv');
  const [from,setFrom]=React.useState(''),[to,setTo]=React.useState(''),[projectId,setProjectId]=React.useState('');
  const [result, setResult] = React.useState<ReportJob | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<ReportFormInput>({
    resolver: zodResolver(reportSchema),
    defaultValues: { type: undefined as unknown as ReportType },
  });
  const selected = watch('type');

  const mutation = useMutation({
    mutationFn: (type: ReportType) => generateReport({ type,format,filters:{...(from?{from}:{}),...(to?{to}:{}),...(projectId?{project_id:projectId}:{})} }),
    onSuccess: (job) => setResult(job),
  });

  const onSubmit = (values: ReportFormInput) => {
    setResult(null);
    mutation.mutate(values.type);
  };

  const selectedMeta = REPORT_TYPE_META.find((m) => m.type === selected);
  const selectedAllowed =
    !!selectedMeta && hasPermission({ permissions }, selectedMeta.permission);

  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={handleSubmit(onSubmit)}
        className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4"
      >
        <FormField label="Report type" error={errors.type?.message} htmlFor="report-type">
          <select
            id="report-type"
            className="w-full rounded-md border border-border px-3 py-2 text-sm"
            {...register('type')}
          >
            <option value="">Pick a report type</option>
            {REPORT_TYPE_META.map((m) => {
              const allowed = hasPermission({ permissions }, m.permission);
              return (
                <option key={m.type} value={m.type} disabled={!allowed}>
                  {m.label}
                  {allowed ? '' : ` (needs ${m.permission})`}
                </option>
              );
            })}
          </select>
        </FormField>
        <FormField label="Format" htmlFor="report-format">
          <select id="report-format" className="rounded border p-2" value={format} onChange={e=>setFormat(e.target.value as typeof format)}><option value="csv">CSV</option><option value="xlsx">Excel (.xlsx)</option><option value="pdf">PDF</option></select>
        </FormField>
        {selected==='attendance'||selected==='leave'?<div className="grid grid-cols-2 gap-3"><label className="text-sm">From<input type="date" className="block w-full rounded border p-2" value={from} onChange={e=>setFrom(e.target.value)}/></label><label className="text-sm">To<input type="date" className="block w-full rounded border p-2" value={to} onChange={e=>setTo(e.target.value)}/></label></div>:null}
        {selected==='tasks'?<label className="text-sm">Project ID (optional)<input className="block w-full rounded border p-2" value={projectId} onChange={e=>setProjectId(e.target.value)}/></label>:null}
        <p className="text-xs text-text-muted">
          Reports larger than{' '}
          {REPORT_ROW_LIMIT} rows run in the background. Your inbox will notify you when they are ready.
        </p>
        <div>
          <Button
            type="submit"
            loading={mutation.isPending}
            disabled={!!selected && !selectedAllowed}
          >
            Generate
          </Button>
        </div>
        {selected && !selectedAllowed && selectedMeta ? (
          <p role="alert" className="text-sm text-warning">
            Your session lacks <span className="font-mono text-xs">{selectedMeta.permission}</span> — this
            report type is unavailable.
          </p>
        ) : null}
      </form>

      {mutation.isError ? (
        mutation.error instanceof ApiClientError && mutation.error.status === 403 ? (
          <div role="alert" className="rounded-lg border border-warning/30 bg-warning-subtle px-4 py-3 text-sm text-warning">
            <p className="font-medium">Not allowed to generate this report (403).</p>
            <p className="mt-1">{mutation.error.message}</p>
            {requestIdOf(mutation.error) ? (
              <p className="mt-1 text-xs opacity-75">Request ID: {requestIdOf(mutation.error)}</p>
            ) : null}
          </div>
        ) : (
          <ErrorCard
            title="Could not generate report"
            error={mutation.error}
            onRetry={() => selected && mutation.mutate(selected)}
          />
        )
      ) : null}

      {result ? (
        <div className="rounded-lg border border-success/30 bg-success-subtle px-4 py-3" role="status">
          <p className="text-sm font-medium text-success">{result.status==='READY'?`Report ready — ${result.rows} row(s).`:'Report queued. You can keep working while it is generated.'}</p>
          <p className="mt-1 font-mono text-xs text-success">
            {result.id} · {result.status}
          </p>
          <div className="mt-3">
            {result.status==='READY'?<DownloadButton path={result.download_url} name={`report-${result.id}.${String(result.format??format)}`} label="Download report" />:null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
