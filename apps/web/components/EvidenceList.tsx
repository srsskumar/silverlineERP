'use client';

import {DownloadButton} from './DownloadButton';
import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fileToBase64,
  listEvidence,
  uploadEvidence,
} from '@/lib/tasks';
import { checkEvidenceFile, evidenceSchema } from '@/lib/validation';
import { queryKeys } from '@/lib/query-keys';
import { Button } from './ui/Button';
import { EmptyState } from './ui/EmptyState';
import { ErrorCard } from './ui/ErrorCard';
import { FormField } from './ui/FormField';
import { Input } from './ui/Input';
import { Spinner } from './ui/Spinner';

/**
 * Task evidence list + upload. Files are sent as base64
 * (`{evidence_type,file_name,content_base64}`); the client gates uploads at
 * 5MB with an extension allowlist (see checkEvidenceFile).
 */
export function EvidenceList({
  taskId,
  canUpload = false,
}: {
  taskId: string;
  canUpload?: boolean;
}) {
  const queryClient = useQueryClient();
  const evidenceQuery = useQuery({
    queryKey: queryKeys.taskEvidence.list(taskId),
    queryFn: () => listEvidence(taskId),
  });
  const [evidenceType, setEvidenceType] = React.useState('PHOTO');
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [uploadError, setUploadError] = React.useState<unknown>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const mutation = useMutation({
    mutationFn: (input: { evidence_type: string; file_name: string; content_base64: string }) =>
      uploadEvidence(taskId, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.taskEvidence.list(taskId) });
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
    const gate = checkEvidenceFile(file);
    if (gate) {
      setFileError(gate);
      return;
    }
    try {
      const content_base64 = await fileToBase64(file);
      const parsed = evidenceSchema.safeParse({
        evidence_type: evidenceType.trim() || 'OTHER',
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
    <section aria-label="Evidence" className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold text-text">Evidence</h2>
      {evidenceQuery.isLoading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-text-muted">
          <Spinner size="sm" /> Loading evidence…
        </div>
      ) : evidenceQuery.isError ? (
        <div className="mt-3">
          <ErrorCard title="Could not load evidence" error={evidenceQuery.error} onRetry={() => evidenceQuery.refetch()} />
        </div>
      ) : (evidenceQuery.data ?? []).length === 0 ? (
        <div className="mt-3">
          <EmptyState title="No evidence" description="Attach photos or files that prove this task's progress." />
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {(evidenceQuery.data ?? []).map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium text-text">{item.file_name}</p>
                <p className="font-mono text-xs text-text-muted">
                  {item.evidence_type}
                  {item.created_at ? ` · ${String(item.created_at)}` : ''}
                </p>
              </div><DownloadButton path={`/api/v1/tasks/${taskId}/evidence/${item.id}/download`} name={item.file_name} label="Download"/>
            </li>
          ))}
        </ul>
      )}
      {canUpload && (
        <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-end">
          <div className="w-full sm:w-48">
            <FormField label="Evidence type" htmlFor={`evidence-type-${taskId}`}>
              <Input
                id={`evidence-type-${taskId}`}
                value={evidenceType}
                onChange={(e) => setEvidenceType(e.target.value)}
                placeholder="e.g. PHOTO"
              />
            </FormField>
          </div>
          <div className="flex-1">
            <FormField label="File (max 5MB)" htmlFor={`evidence-file-${taskId}`} error={fileError ?? undefined}>
              <Input id={`evidence-file-${taskId}`} ref={fileRef} type="file" onChange={onFileChange} disabled={mutation.isPending} />
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
        <Button variant="secondary" onClick={() => evidenceQuery.refetch()}>
          Refresh
        </Button>
      </div>
    </section>
  );
}
