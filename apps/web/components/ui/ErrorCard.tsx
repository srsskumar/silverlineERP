'use client';

import { AlertTriangle } from 'lucide-react';
import { ApiClientError } from '@/lib/apiClient';
import { Button } from './Button';
import { cn } from '@/lib/cn';

function requestIdOf(error: unknown): string | undefined {
  return error instanceof ApiClientError ? error.requestId : undefined;
}

export function ErrorCard({
  title = 'Something went wrong',
  error,
  onRetry,
  className,
}: {
  title?: string;
  error?: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const message = error instanceof Error ? error.message : 'An unexpected error occurred.';
  const requestId = requestIdOf(error);
  return (
    <div
      role="alert"
      className={cn('flex gap-2.5 rounded-lg border border-danger/30 bg-danger-subtle px-3 py-2.5', className)}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text">{title}</p>
        <p className="mt-0.5 text-xs text-text-muted">{message}</p>
        {requestId && (
          <p className="mt-1 font-mono text-2xs text-text-subtle">Request ID: {requestId}</p>
        )}
        {onRetry && (
          <Button variant="secondary" size="sm" className="mt-2.5" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}
