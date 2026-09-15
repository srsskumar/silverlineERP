import { ApiError } from '@silverline/shared';

/**
 * The record version for optimistic concurrency.
 *
 * Read from `X-Record-Version`, falling back to `If-Match`.
 *
 * `If-Match` was the obvious choice and turned out to be unusable in front of
 * a CDN. Vercel's edge implements RFC 7232 conditional requests, so it acts on
 * the header itself: a bare `3` is refused outright with 412, and — far worse
 * — a *quoted* tag lets the request through, the write commits, and the edge
 * then replaces the 200 with a 412 on the way back. The caller sees a failure,
 * the change has happened, and their next attempt reports a version conflict
 * they cannot explain. Both of those were reported from production while every
 * test passed, because tests inject into the framework and never cross the
 * proxy.
 *
 * The lesson is that HTTP preconditions belong to the transport: a proxy is
 * entitled to answer them, and an application that overloads them for its own
 * concurrency control is arguing with infrastructure it does not own. A header
 * with no standard meaning is inert to every proxy in the path.
 *
 * `If-Match` is still accepted so that direct callers, scripts and older
 * clients keep working.
 */
export const VERSION_HEADER = 'x-record-version';

export function parseIfMatch(req: { headers: Record<string, unknown> }): number {
  const raw = req.headers[VERSION_HEADER] ?? req.headers['if-match'];
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
