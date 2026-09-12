/**
 * Cross-platform fence map.
 *
 * expo-maps ships two distinct native views — `GoogleMaps.View` on Android and
 * `AppleMaps.View` on iOS — with separate (though similar) prop types. This
 * wrapper takes one Silverline-shaped description of what to draw and renders
 * whichever view the platform provides, so screens never branch on Platform.OS.
 *
 * Both views need a native build: they are unavailable in Expo Go and on web.
 * Rather than crashing the screen, an unsupported platform renders an explicit
 * "map unavailable" panel — a field user seeing a blank rectangle would not
 * know whether the map failed or there was nothing to show.
 */

import { useMemo } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { AppleMaps, GoogleMaps } from "expo-maps";
import { Ionicons } from "@expo/vector-icons";
import type { CircleGeometry, PolygonGeometry } from "@silverline/shared";
import { font, radius, space, useIsDark, useTheme } from "../theme";
import { Muted } from "./primitives";
import type { GeoFence } from "../api/endpoints";

export interface MapPoint {
  id: string;
  latitude: number;
  longitude: number;
  title?: string;
  tint?: string;
}

export interface MapCanvasProps {
  fences?: readonly GeoFence[];
  points?: readonly MapPoint[];
  /** Centre. Falls back to the first fence, then to a wide default view. */
  center?: { latitude: number; longitude: number } | null;
  zoom?: number;
  height?: number;
  /** Highlights one fence — the one the user is currently standing in. */
  activeFenceId?: string | null;
}

const DEFAULT_ZOOM = 15;

/** Hex + alpha byte, since both native layers take a colour string. */
function alpha(hex: string, a: string): string {
  return `${hex}${a}`;
}

export function MapCanvas({
  fences = [],
  points = [],
  center,
  zoom = DEFAULT_ZOOM,
  height = 240,
  activeFenceId = null,
}: MapCanvasProps) {
  const t = useTheme();
  const isDark = useIsDark();

  const circles = useMemo(
    () =>
      fences
        .filter((f) => f.geometry_type === "circle")
        .map((f) => {
          const g = f.geometry as CircleGeometry;
          const active = f.id === activeFenceId;
          return {
            id: f.id,
            center: { latitude: g.lat, longitude: g.lng },
            // Tolerance is part of the accepted area, so draw what the server
            // will actually accept rather than the nominal radius.
            radius: g.radius_m + (f.tolerance_meters ?? 0),
            color: alpha(active ? t.success : t.primary, active ? "40" : "22"),
            lineColor: active ? t.success : t.primary,
            lineWidth: active ? 3 : 2,
          };
        }),
    [fences, activeFenceId, t],
  );

  const polygons = useMemo(
    () =>
      fences
        .filter((f) => f.geometry_type === "polygon")
        .map((f) => {
          const g = f.geometry as PolygonGeometry;
          const active = f.id === activeFenceId;
          return {
            id: f.id,
            // Contract stores [lat, lng] tuples; the map wants objects.
            coordinates: g.points.map(([latitude, longitude]) => ({ latitude, longitude })),
            color: alpha(active ? t.success : t.primary, active ? "40" : "22"),
            lineColor: active ? t.success : t.primary,
            lineWidth: active ? 3 : 2,
          };
        }),
    [fences, activeFenceId, t],
  );

  const markers = useMemo(
    () =>
      points.map((p) => ({
        id: p.id,
        coordinates: { latitude: p.latitude, longitude: p.longitude },
        title: p.title,
        tintColor: p.tint ?? t.primary,
      })),
    [points, t],
  );

  const resolvedCenter = useMemo(() => {
    if (center) return center;
    if (points[0]) return { latitude: points[0].latitude, longitude: points[0].longitude };
    const circle = circles[0];
    if (circle) return circle.center;
    const poly = polygons[0]?.coordinates[0];
    if (poly) return { latitude: poly.latitude, longitude: poly.longitude };
    return null;
  }, [center, points, circles, polygons]);

  const frame = {
    height,
    borderRadius: radius.lg,
    overflow: "hidden" as const,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.border,
    backgroundColor: t.surfaceSunken,
  };

  // Nothing to centre on: an empty map at 0,0 shows the Atlantic, which reads
  // as a bug. Say there is nothing to draw instead.
  if (!resolvedCenter) {
    return (
      <View style={[frame, { alignItems: "center", justifyContent: "center", gap: space.sm }]}>
        <Ionicons name="map-outline" size={22} color={t.textSubtle} />
        <Muted>No sites to show yet</Muted>
      </View>
    );
  }

  const cameraPosition = { coordinates: resolvedCenter, zoom };
  const uiSettings = { myLocationButtonEnabled: false } as const;

  if (Platform.OS === "android") {
    return (
      <View style={frame}>
        <GoogleMaps.View
          style={{ flex: 1 }}
          cameraPosition={cameraPosition}
          circles={circles}
          polygons={polygons}
          markers={markers}
          uiSettings={uiSettings}
          colorScheme={isDark ? GoogleMaps.MapColorScheme.DARK : GoogleMaps.MapColorScheme.LIGHT}
          properties={{ isMyLocationEnabled: true }}
        />
      </View>
    );
  }

  if (Platform.OS === "ios") {
    return (
      <View style={frame}>
        <AppleMaps.View
          style={{ flex: 1 }}
          cameraPosition={cameraPosition}
          circles={circles}
          polygons={polygons}
          markers={markers}
          uiSettings={uiSettings}
          colorScheme={isDark ? AppleMaps.MapColorScheme.DARK : AppleMaps.MapColorScheme.LIGHT}
          properties={{ isMyLocationEnabled: true }}
        />
      </View>
    );
  }

  return (
    <View style={[frame, { alignItems: "center", justifyContent: "center", gap: space.sm, padding: space.lg }]}>
      <Ionicons name="map-outline" size={22} color={t.textSubtle} />
      <Muted style={{ textAlign: "center", fontSize: font.sm }}>
        Maps need the Android or iOS build of the app.
      </Muted>
    </View>
  );
}
