'use client';

import type { BulkImportResult } from '@/lib/employees';
import { Badge } from './ui/Badge';
import { EmptyState } from './ui/EmptyState';

export function ImportReport({ report }: { report: BulkImportResult | null }) {
  if (!report) {
    return <EmptyState title="No import yet" description="Upload a CSV and submit to see the import report here." />;
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="success">{report.dry_run?`Validated: ${report.validated??0}`:`Imported: ${report.imported}`}</Badge>
        <Badge tone={report.failed > 0 ? 'danger' : 'neutral'}>Failed: {report.failed}</Badge>
      </div>
      {report.errors.length === 0 ? (
        <p className="text-sm text-text-muted">{report.dry_run?'Validation passed. Review the preview, then import the rows.':'All rows imported successfully.'}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="min-w-full divide-y divide-border bg-surface text-sm">
            <thead className="bg-surface-sunken">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Row</th>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Emp No</th>
                <th className="px-3 py-2 text-left font-medium text-text-muted">Errors</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {report.errors.map((e, i) => (
                <tr key={`${e.index}-${i}`}>
                  <td className="px-3 py-2 text-text">{e.index}</td>
                  <td className="px-3 py-2 text-text">{e.emp_no ?? '—'}</td>
                  <td className="px-3 py-2 text-text-muted">
                    <ul className="list-disc pl-4">
                      {e.errors.map((msg, j) => (
                        <li key={j}>{msg}</li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
