/**
 * Fix round 1: one pull-to-refresh for every list screen. Hand it the
 * queries the screen shows and pass the result to <Screen refresh={...}>.
 * react-query's refetch() ignores `enabled`, so a caller passes `false`
 * for a query that must not fire (no project picked, a hidden tab, no
 * permission): `usePullRefresh(canRead && list, projectId !== null && rules)`.
 */
import { useState } from "react";

export interface PullRefresh {
  refreshing: boolean;
  onRefresh: () => void;
}

export function usePullRefresh(
  ...queries: Array<{ refetch: () => Promise<unknown> } | null | undefined | false>
): PullRefresh {
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = () => {
    setRefreshing(true);
    const live = queries.filter((q): q is { refetch: () => Promise<unknown> } => Boolean(q));
    void Promise.allSettled(live.map((q) => q.refetch())).finally(() => setRefreshing(false));
  };
  return { refreshing, onRefresh };
}
