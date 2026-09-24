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
