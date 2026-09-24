'use client';

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiRequest } from '@/lib/apiClient';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';

/**
 * Delete a document from the register (§46.6.1), if retention allows it.
 *
 * The API's own refusal already names what is blocking it — a retention
 * date still running, a legal hold, or a later revision pointing back at
 * this one (RETENTION_BLOCKED / HAS_SUCCESSOR) — so this surfaces that
 * message as-is rather than inventing a second one.
 */
export function DeleteDocumentButton({
  id, title, version, retention, onDeleted,
}: {
  id: string;
  title: string;
  version: number;
  /** The register list already runs the same retention check the DELETE
   *  route enforces (packages/shared/src/documents.ts's canDelete), so a
   *  blocked document says why up front instead of only after a failed
   *  attempt. Optional so a caller without it still gets the try-then-fail
   *  path. */
  retention?: { deletable: boolean; reason?: string };
  onDeleted: () => void;
}) {
  const [error, setError] = React.useState<unknown>(null);

  const remove = useMutation({
    mutationFn: () =>
      apiRequest(`/api/v1/documents/${id}`, { method: 'DELETE', headers: { 'If-Match': String(version) } }),
    onSuccess: () => { setError(null); onDeleted(); },
    onError: setError,
  });

  if (retention && !retention.deletable) {
    return <p className="max-w-[14rem] text-right text-2xs text-text-subtle">{retention.reason}</p>;
  }

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <Button
        variant="ghost"
        size="sm"
        loading={remove.isPending}
        onClick={() => {
          if (window.confirm(`Delete "${title}"? This cannot be undone.`)) {
            remove.mutate();
          }
        }}
      >
        Delete
      </Button>
      {error ? <ErrorCard title="Could not delete this document" error={error} className="max-w-xs" /> : null}
    </div>
  );
}
