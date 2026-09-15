import { ApiError } from '@silverline/shared';

/**
 * The record version carried in `If-Match`, for optimistic concurrency.
 *
 * An entity-tag is a quoted string (RFC 7232 §2.3), and the quotes are not
 * cosmetic: an edge proxy that implements conditional requests treats a bare
 * `3` as a malformed precondition and answers 412 itself, so the request never
 * reaches this process. That is exactly what happened in production while
 * every local test passed, because tests inject straight into the framework
 * and skip the proxy entirely.
 *
 * So both forms are accepted here — the quoted one the clients now send, and
 * the bare one older clients and scripts still use.
 */
export function parseIfMatch(req: { headers: Record<string, unknown> }): number {
  const raw = req.headers['if-match'];
  const header = (Array.isArray(raw) ? raw[0] : raw);
  const text = typeof header === 'string' ? header.trim() : undefined;
  // W/"3" is a weak validator; the version it names is the same number.
  const unquoted = text?.replace(/^W\//, '').replace(/^"(.*)"$/, '$1').trim();
  const n = unquoted === undefined || unquoted === '' ? Number.NaN : Number(unquoted);
  if (!Number.isInteger(n) || n < 1) {
    throw new ApiError({
      status: 422,
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
      fieldErrors: [
        {
          field: 'If-Match',
          message: 'If-Match header with the current version is required',
          code: 'missing_version',
        },
      ],
    });
  }
  return n;
}
