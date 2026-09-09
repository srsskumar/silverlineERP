'use client';

import {DownloadButton} from './DownloadButton';
import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listDocuments, uploadDocument, MAX_DOCUMENT_BYTES, fileToBase64 } from '@/lib/documents';
import { queryKeys } from '@/lib/query-keys';
import { documentUploadSchema } from '@/lib/validation';
import { Button } from './ui/Button';
import { EmptyState } from './ui/EmptyState';
import { ErrorCard } from './ui/ErrorCard';
import { FormField } from './ui/FormField';
import { Input } from './ui/Input';
import { Spinner } from './ui/Spinner';

export function DocumentList({
  employeeId,
  canUpload = false,
}: {
  employeeId: string;
  canUpload?: boolean;
}) {
  const queryClient = useQueryClient();
  const docsQuery = useQuery({
    queryKey: queryKeys.documents.list(employeeId),
    queryFn: () => listDocuments(employeeId),
  });
  const [docType, setDocType] = React.useState('AADHAAR');
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [uploadError, setUploadError] = React.useState<unknown>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const mutation = useMutation({
    mutationFn: (input: { doc_type: string; file_name: string; content_base64: string }) =>
      uploadDocument(employeeId, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.documents.list(employeeId) });
      setUploadError(null);
      setFileError(null);
      if (fileRef.current) fileRef.current.value = '';
    },
    onError: (err) => setUploadError(err),
  });

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setFileError(null);
    setUploadError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_DOCUMENT_BYTES) {
      setFileError(`File is ${(file.size / 1024 / 1024).toFixed(1)}MB; maximum is 5MB.`);
      return;
    }
    try {
      const content_base64 = await fileToBase64(file);
      const parsed = documentUploadSchema.safeParse({
        doc_type: docType.trim() || 'OTHER',
        file_name: file.name,
        content_base64,
      });
      if (!parsed.success) {
        setFileError(parsed.error.errors[0]?.message ?? 'Invalid file');
        return;
      }
      mutation.mutate(parsed.data);
    } catch {
      setFileError('Could not read file. Please try again.');
    }
  };

  return (
    <section aria-label="Documents" className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">Documents</h2>
      {docsQuery.isLoading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
          <Spinner size="sm" /> Loading documents…
        </div>
      ) : docsQuery.isError ? (
        <div className="mt-3">
          <ErrorCard title="Could not load documents" error={docsQuery.error} onRetry={() => docsQuery.refetch()} />
        </div>
      ) : (docsQuery.data ?? []).length === 0 ? (
        <div className="mt-3">
          <EmptyState title="No documents" description="Upload identity or joining documents for this employee." />
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {(docsQuery.data ?? []).map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-800">{d.file_name}</p>
                <p className="text-xs text-slate-500">
                  {d.doc_type} · sha {String(d.checksum).slice(0, 12)}…
                </p>
              </div><DownloadButton path={`/api/v1/employees/${employeeId}/documents/${d.id}/download`} name={d.file_name} label="Download"/>
            </li>
          ))}
        </ul>
      )}
      {canUpload && (
        <div className="mt-4 flex flex-col gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:items-end">
          <div className="w-full sm:w-48">
            <FormField label="Document type" htmlFor="doc-type">
              <Input id="doc-type" value={docType} onChange={(e) => setDocType(e.target.value)} />
            </FormField>
          </div>
          <div className="flex-1">
            <FormField label="File (max 5MB)" htmlFor="doc-file" error={fileError ?? undefined}>
              <Input id="doc-file" ref={fileRef} type="file" onChange={onFileChange} disabled={mutation.isPending} />
            </FormField>
          </div>
          {mutation.isPending && <Spinner />}
        </div>
      )}
      {uploadError ? (
        <div className="mt-3">
          <ErrorCard title="Upload failed" error={uploadError} />
        </div>
      ) : null}
      <div className="mt-2 flex gap-2">
        <Button variant="secondary" onClick={() => docsQuery.refetch()}>
          Refresh
        </Button>
      </div>
    </section>
  );
}
