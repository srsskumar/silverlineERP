/**
 * Fence data for the attendance screen: fetch (cached offline), work out which
 * fence the user is standing in, and keep OS geofence monitoring pointed at the
 * nearest sites.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getGeoFences, toFenceShapes, toMonitoredFences } from "../api/endpoints";
import {
  fenceContaining,
  hasBackgroundPermission,
  startFenceMonitoring,
  type MonitoredFence,
} from "./geofencing";
import type { PunchFix } from "./location";

export function useFences(fix: PunchFix | null, enabled = true) {
  const [monitored, setMonitored] = useState<MonitoredFence[]>([]);
  const [backgroundGranted, setBackgroundGranted] = useState<boolean | null>(null);

  const query = useQuery({
    queryKey: ["geo-fences"],
    queryFn: () => getGeoFences(),
    enabled,
    // Fences change rarely; refetching on every focus wastes a field user's data.
    staleTime: 15 * 60 * 1000,
    retry: false,
  });

  const fences = useMemo(() => query.data ?? [], [query.data]);
  const shapes = useMemo(() => toFenceShapes(fences), [fences]);

  /** The fence the user is inside right now, or null. Advisory only. */
  const currentFence = useMemo(
    () => (fix ? fenceContaining(shapes, fix) : null),
    [shapes, fix],
  );

  useEffect(() => {
    let cancelled = false;
    void hasBackgroundPermission().then((granted) => {
      if (!cancelled) setBackgroundGranted(granted);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-register whenever the user's position or the fence set changes, so the
  // monitored subset follows them as they move between districts.
  useEffect(() => {
    if (!fix || fences.length === 0 || backgroundGranted !== true) return;
    let cancelled = false;
    void startFenceMonitoring(toMonitoredFences(fences), fix).then((selected) => {
      if (!cancelled) setMonitored(selected);
    });
    return () => {
      cancelled = true;
    };
  }, [fix, fences, backgroundGranted]);

  const refreshBackgroundPermission = useCallback(async () => {
    const granted = await hasBackgroundPermission();
    setBackgroundGranted(granted);
    return granted;
  }, []);

  return {
    fences,
    shapes,
    currentFence,
    monitored,
    backgroundGranted,
    refreshBackgroundPermission,
    isLoading: query.isLoading,
    error: query.error,
  };
}
