'use client';

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { AppShell } from '@/components/AppShell';
import { RequirePermission } from '@/components/RequirePermission';
import { ImportReport } from '@/components/ImportReport';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { FormField } from '@/components/ui/FormField';
import { PERMISSIONS } from '@/lib/permissions';
import { bulkImportEmployees, type BulkImportResult } from '@/lib/employees';
import { parseEmployeeCsv } from '@/lib/csv';
import { importRowSchema } from '@/lib/validation';

export const dynamic = 'force-static';

const SAMPLE_CSV = `emp_no,first_name,last_name,phone,date_of_joining,designation
EMP001,Asha,Kumari,+919876543210,2024-01-15,Field Officer
EMP002,Ravi,Teja,+919876543211,2024-02-01,Supervisor`;

function ImportForm() {
  const [text, setText] = React.useState('');
  const [fileName, setFileName] = React.useState('');
  const [report, setReport] = React.useState<BulkImportResult | null>(null);

  const parsed = React.useMemo(() => parseEmployeeCsv(text), [text]);
  const validationIssues = React.useMemo(() => {
    const issues: Array<{ index: number; message: string }> = [];
    parsed.rows.slice(0, 20).forEach((row, i) => {
      const res = importRowSchema.safeParse(row);
      if (!res.success) {
        issues.push({ index: i + 1, message: res.error.errors[0]?.message ?? 'Invalid row' });
      }
    });
    return issues;
  }, [parsed.rows]);

  const mutation = useMutation({
    mutationFn: (dryRun:boolean) => bulkImportEmployees(parsed.rows,dryRun),
    onSuccess: (res) => setReport(res),
  });

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setText(await file.text());
    setReport(null);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <FormField label="CSV file" htmlFor="import-file">
            <input
              id="import-file"
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={onFile}
              className="w-full text-sm text-slate-700"
            />
          </FormField>
          {fileName && <p className="mt-1 text-xs text-slate-500">Loaded: {fileName}</p>}
          <div className="mt-3">
            <FormField label="Or paste CSV text" htmlFor="import-text">
              <textarea
                id="import-text"
                rows={10}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setReport(null);
                }}
                placeholder={SAMPLE_CSV}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </FormField>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button variant="secondary" onClick={() => { setText(SAMPLE_CSV); setReport(null); }}>
              Load sample
            </Button>
            <Button
              loading={mutation.isPending}
              disabled={parsed.rows.length === 0}
              onClick={() => mutation.mutate(true)}
            >
              Validate {parsed.rows.length > 0 ? `(${parsed.rows.length} rows)` : ''}
            </Button>
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-900">Preview</h2>
          <p className="mt-1 text-sm text-slate-600">
            {parsed.rows.length} valid row(s)
            {parsed.parseErrors.length > 0 && `, ${parsed.parseErrors.length} malformed row(s) skipped`}.
          </p>
          {parsed.parseErrors.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-xs text-red-700">
              {parsed.parseErrors.slice(0, 10).map((e) => (
                <li key={e.index}>
                  Row {e.index}: {e.errors.join('; ')}
                </li>
              ))}
            </ul>
          )}
          {validationIssues.length > 0 && (
            <div className="mt-2">
              <p className="text-xs font-medium text-amber-800">Client-side validation warnings (first 20 rows):</p>
              <ul className="mt-1 list-disc pl-5 text-xs text-amber-800">
                {validationIssues.slice(0, 10).map((v) => (
                  <li key={v.index}>
                    Row {v.index}: {v.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="mt-3 text-xs text-slate-500">
            Columns map to employee fields (emp_no, first_name, phone, date_of_joining/doj, designation, district…).
            Server validates again and returns per-row errors below.
          </p>
        </div>
      </div>
      {report?.dry_run?<Button disabled={mutation.isPending||!report.validated} onClick={()=>mutation.mutate(false)}>Import {report.validated??0} validated rows</Button>:null}
      {mutation.isError && <ErrorCard title="Import failed" error={mutation.error} onRetry={() => mutation.mutate(true)} />}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-900">Report</h2>
        <ImportReport report={report} />
      </div>
    </div>
  );
}

export default function ImportPage() {
  return (
    <AppShell>
      <RequirePermission code={PERMISSIONS.EMPLOYEE_IMPORT}>
        <h1 className="text-xl font-bold text-slate-900">Bulk import employees</h1>
        <p className="mt-1 text-sm text-slate-500">CSV → preview → submit → per-row report.</p>
        <div className="mt-6">
          <ImportForm />
        </div>
      </RequirePermission>
    </AppShell>
  );
}
