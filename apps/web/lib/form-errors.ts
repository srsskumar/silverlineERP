'use client';

import { ApiClientError } from './apiClient';

export type SetFieldError = (field: string, error: { message: string }) => void;

/**
 * Map a 422 `field_errors[]` envelope onto RHF fields via setError.
 * Returns true when the error was a mappable validation error.
 */
export function applyFieldErrors(error: unknown, setError: SetFieldError): boolean {
  if (!(error instanceof ApiClientError)) return false;
  if (error.status !== 422 || error.fieldErrors.length === 0) return false;
  for (const fe of error.fieldErrors) {
    if (!fe.field) continue;
    setError(fe.field, { message: fe.message || 'Invalid value' });
  }
  return true;
}

/** True for optimistic-concurrency conflicts (stale If-Match version). */
export function isConflictError(error: unknown): boolean {
  if (error instanceof ApiClientError) {
    return error.status === 409 || error.code === 'VERSION_CONFLICT' || error.code === 'CONFLICT';
  }
  return false;
}

export function requestIdOf(error: unknown): string | undefined {
  return error instanceof ApiClientError ? error.requestId : undefined;
}

/**
 * An error as one sentence, for a toast.
 *
 * A toast has room for the headline and not the field list, so this is the
 * server's message and nothing else. Anything the reader has to act on
 * field by field belongs on the form next to the field, not here.
 */
export function messageOf(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error) return error.message;
  return 'The server could not be reached. Nothing has been saved.';
}
