/**
 * Turn a caught write-request failure into text worth showing a user.
 *
 * M-xxx: every mobile write screen's catch block rendered only the thrown
 * error's top-level `message` (`e instanceof Error ? e.message : "<fallback>"`,
 * or the ApiError equivalent). Live-verified on dev-thor: the server's own
 * top-level `message` for a multi-field zod validation failure is a fixed,
 * generic string — "Validation failed" — never naming a field; the actual
 * reason lives entirely in `field_errors` (surfaced by src/api/client.ts as
 * ApiError.fieldErrors), which no screen ever read. A user who mistyped a
 * date or left a required field blank saw "Validation failed" and nothing
 * else, with no way to tell what to fix.
 *
 * Dependency-free like validators.ts/rbac.ts — takes a structural shape
 * rather than importing the ApiError class, so this stays importable from
 * plain node:test with no Expo/RN runtime.
 */

export interface ApiErrorLike {
  message: string;
  fieldErrors?: ReadonlyArray<{ field: string; message: string }>;
}

function isApiErrorLike(e: unknown): e is ApiErrorLike {
  return typeof e === "object" && e !== null && "message" in e;
}

/**
 * @param fallback shown when `e` is neither an ApiError-shaped object nor a
 *   plain Error (mirrors each call site's previous hardcoded fallback string).
 */
export function describeApiError(e: unknown, fallback: string): string {
  if (isApiErrorLike(e)) {
    if (e.fieldErrors && e.fieldErrors.length > 0) {
      return e.fieldErrors
        .map((f) => (f.field ? `${f.field}: ${f.message}` : f.message))
        .join("\n");
    }
    return e.message || fallback;
  }
  if (e instanceof Error) return e.message;
  return fallback;
}
