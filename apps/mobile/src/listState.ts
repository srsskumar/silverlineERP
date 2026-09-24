/**
 * MA-003: what a list card should show. A failed load with nothing cached
 * used to fall through to the empty state ("No tenders found", "Nothing due
 * for renewal"), so a 403 or a dropped connection read as "there is nothing
 * here", which is a claim about the data the screen had no basis for.
 * Rows already on hand (cachedRead's offline copy) still win over an error.
 */
export type ListState = "loading" | "error" | "empty" | "rows";

export function listState(
  query: { isLoading: boolean; isError: boolean },
  count: number,
): ListState {
  if (count > 0) return "rows";
  if (query.isLoading) return "loading";
  if (query.isError) return "error";
  return "empty";
}

/**
 * Fix round 1: whether retrying a failed load can help. A dropped connection
 * (status 0, or a non-API error), a timeout, a rate limit or a 5xx may work
 * next time; a 401/403/404/422 will not, so the screen offers no Retry.
 */
export function canRetryLoad(error: unknown): boolean {
  const status =
    typeof error === "object" && error !== null && typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : 0;
  if (status === 0 || status >= 500) return true;
  return status === 408 || status === 429;
}

/** The Retry action for a failed query, or undefined when a retry would not help. */
export function retryAction(query: { error: unknown; refetch: () => unknown }): (() => void) | undefined {
  return canRetryLoad(query.error) ? () => void query.refetch() : undefined;
}
