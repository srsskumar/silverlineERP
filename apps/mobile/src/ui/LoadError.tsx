/**
 * MA-003: the state a list shows when its load failed and nothing is cached.
 * Before this, the same screens fell through to their empty state, so a 403
 * or a dropped connection read as "there is nothing here".
 */
import { describeApiError } from "../errorFormat";
import { EmptyState } from "./primitives";

export function LoadError({ error, what }: { error: unknown; what: string }) {
  return (
    <EmptyState
      icon="cloud-offline-outline"
      title={`Could not load ${what}`}
      message={describeApiError(error, "Check your connection and try again.")}
    />
  );
}
