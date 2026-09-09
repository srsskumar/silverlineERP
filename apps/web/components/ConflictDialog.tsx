'use client';

import * as React from 'react';
import { Button } from './ui/Button';

export function ConflictDialog({
  open,
  message,
  requestId,
  onReload,
  onClose,
}: {
  open: boolean;
  message?: string;
  requestId?: string;
  onReload: () => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div role="alertdialog" aria-modal="true" aria-label="Version conflict" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
        <h2 className="text-base font-semibold text-slate-900">Someone else changed this record</h2>
        <p className="mt-2 text-sm text-slate-600">
          {message || 'The record changed since you opened it (version conflict). Reload to get the latest version, then re-apply your changes.'}
        </p>
        {requestId && <p className="mt-2 text-xs text-slate-500">Request ID: {requestId}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Dismiss
          </Button>
          <Button
            onClick={() => {
              onReload();
              onClose();
            }}
          >
            Reload
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Small hook to own conflict-dialog state for 409 flows. */
export function useConflict() {
  const [state, setState] = React.useState<{ message?: string; requestId?: string } | null>(null);
  return {
    conflict: state,
    open: state !== null,
    show: (message?: string, requestId?: string) => setState({ message, requestId }),
    hide: () => setState(null),
  };
}
