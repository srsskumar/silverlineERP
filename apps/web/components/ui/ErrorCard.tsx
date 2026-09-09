'use client';

import { ApiClientError } from '@/lib/apiClient';
import { Button } from './Button';

function requestIdOf(error: unknown): string | undefined {
  return error instanceof ApiClientError ? error.requestId : undefined;
}

export function ErrorCard({
  title = 'Something went wrong',
  error,
  onRetry,
}: {
  title?: string;
  error?: unknown;
  onRetry?: () => void;
}) {
  const message = error instanceof Error ? error.message : 'An unexpected error occurred.';
  const requestId = requestIdOf(error);
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
      <p className="text-sm font-medium text-red-800">{title}</p>
      <p className="mt-1 text-sm text-red-700">{message}</p>
      {requestId && <p className="mt-1 text-xs text-red-600">Request ID: {requestId}</p>}
      {onRetry && (
        <div className="mt-3">
          <Button variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
