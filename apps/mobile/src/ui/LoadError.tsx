/**
 * MA-003: the state a list shows when its load failed and nothing is cached.
 * Before this, the same screens fell through to their empty state, so a 403
 * or a dropped connection read as "there is nothing here".
 *
 * Fix round 1: offers Retry when one can help (retryAction in listState.ts
 * decides: network/5xx yes, 401/403/404/422 no), so the user is not stuck
 * after react-query's single silent retry.
 */
import { describeApiError } from "../errorFormat";
import { retryAction } from "../listState";
import { Button, EmptyState } from "./primitives";

export function LoadError({
  query,
  what,
}: {
  query: { error: unknown; refetch: () => unknown };
  what: string;
}) {
  const onRetry = retryAction(query);
  return (
    <EmptyState
      icon="cloud-offline-outline"
      title={`Could not load ${what}`}
      message={describeApiError(query.error, "Check your connection and try again.")}
      action={
        onRetry ? (
          <Button title="Retry" icon="refresh-outline" variant="secondary" onPress={onRetry} />
        ) : undefined
      }
    />
  );
}
