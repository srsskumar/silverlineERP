'use client';

import { AlertTriangle } from 'lucide-react';
import { ApiClientError } from '@/lib/apiClient';
import { Button } from './Button';
import { cn } from '@/lib/cn';
import { fieldLabel } from '@silverline/shared';

/**
 * What went wrong, and what to do about it.
 *
 * This used to print error.message and stop. When the server said
 * "Validation failed" that was the whole of what the reader got — the list
 * of which fields were wrong arrived in the same response and was thrown
 * away here. Three things are worth saying and this says all three: what
 * happened, which values caused it, and the next thing to try.
 *
 * The corrective step is derived from the error code rather than written at
 * each call site, because the useful advice depends on the kind of failure
 * and not on the screen it happened on: a 403 always means ask an
 * administrator, a network failure always means check the connection.
 */
function requestIdOf(error: unknown): string | undefined {
  return error instanceof ApiClientError ? error.requestId : undefined;
}

/** The next thing to try, for the kinds of failure that have an obvious one. */
function nextStep(error: unknown): string | null {
  if (!(error instanceof ApiClientError)) {
    // Not an answer from the server at all: the request never arrived.
    return 'The server could not be reached. Check your connection and try again — '
      + 'nothing has been saved, so nothing has been half-done.';
  }
  switch (error.code) {
    case 'VALIDATION_ERROR':
      return 'Correct the values listed above and submit again.';
    case 'FORBIDDEN':
      return null; // The message already names the permission and who grants it.
    case 'UNAUTHORIZED':
      return 'Your session has expired. Sign in again — your work is not lost if you '
        + 'sign in on another tab first.';
    case 'NOT_FOUND':
      return null; // Likewise: the message says where to go instead.
    case 'CONFLICT':
      return 'Something else already uses that value. Change it, or open the existing '
        + 'record instead of creating a second one.';
    case 'VERSION_CONFLICT':
      return 'Somebody else changed this while you had it open. Reload to see their '
        + 'version, then make your change again on top of it.';
    case 'RATE_LIMITED':
      return 'Too many requests in a short time. Wait a moment and try again.';
    default:
      if (error.status >= 500) {
        return 'This is a fault on our side, not something you did wrong. Try again in a '
          + 'moment; if it keeps happening, send an administrator the request ID below.';
      }
      return null;
  }
}

export function ErrorCard({
  title = 'That did not work',
  error,
  onRetry,
  className,
}: {
  title?: string;
  error?: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const message = error instanceof Error ? error.message : 'Something unexpected happened.';
  const requestId = requestIdOf(error);
  const fields = error instanceof ApiClientError ? error.fieldErrors : [];
  const advice = nextStep(error);
  const retryable = !(error instanceof ApiClientError) || error.retryable
    || error.code === 'VALIDATION_ERROR';

  return (
    <div
      role="alert"
      className={cn('flex gap-2.5 rounded-lg border border-danger/30 bg-danger-subtle px-3 py-2.5', className)}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text">{title}</p>
        <p className="mt-0.5 text-xs text-text-muted">{message}</p>

        {fields.length > 0 && (
          <ul className="mt-1.5 space-y-0.5">
            {fields.slice(0, 8).map((f, i) => (
              <li key={`${f.field}:${i}`} className="text-xs text-text-muted">
                <span className="font-medium text-text">{fieldLabel(f.field)}</span>
                {' — '}
                {f.message}
              </li>
            ))}
            {fields.length > 8 && (
              <li className="text-2xs text-text-subtle">
                and {fields.length - 8} more
              </li>
            )}
          </ul>
        )}

        {advice && <p className="mt-1.5 text-xs text-text">{advice}</p>}

        {requestId && (
          <p className="mt-1 font-mono text-2xs text-text-subtle">Request ID: {requestId}</p>
        )}
        {onRetry && retryable && (
          <Button variant="secondary" size="sm" className="mt-2.5" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}
