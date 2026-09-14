/**
 * Cross-platform fence map.
 *
 * expo-maps ships two distinct native views — `GoogleMaps.View` on Android and
 * `AppleMaps.View` on iOS — with separate (though similar) prop types. This
 * wrapper takes one Silverline-shaped description of what to draw and renders
 * whichever view the platform provides, so screens never branch on Platform.OS.
 *
 * expo-maps needs a development/store build. Expo Go instead ships
 * react-native-maps, so this wrapper uses that compatible renderer as a
 * fallback. Web still receives an explicit unsupported panel.
 */

import { useMemo } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { requireOptionalNativeModule } from "expo";
import { Ionicons } from "@expo/vector-icons";
import type { CircleGeometry, PolygonGeometry } from "@silverline/shared";
import { font, radius, space, useIsDark, useTheme } from "../theme";
import { Muted } from "./primitives";
import type { GeoFence } from "../api/endpoints";

type ExpoMapsModule = typeof import("expo-maps");
type ReactNativeMapsModule = typeof import("react-native-maps");

/**
 * Importing `expo-maps` eagerly calls `requireNativeModule('ExpoMaps')` inside
 * the package. Expo Go and development clients built before expo-maps was
 * added do not contain that native module, so the import throws while Expo
 * Router is evaluating the attendance route. Router then reports the
 * misleading secondary warning that the route has no default export.
 *
 * Probe first and only evaluate the package in a binary that actually contains
 * ExpoMaps. This keeps attendance and punching usable in an old client while a
 * purpose-built Silverline development client still renders the native map.
 */
function loadExpoMaps(): ExpoMapsModule | null {
  if (Platform.OS !== "android" && Platform.OS !== "ios") return null;
  if (!requireOptionalNativeModule("ExpoMaps")) return null;
  try {
    // Metro needs a statically discoverable literal; the call remains runtime
    // conditional, after the optional native-module probe above.
    return require("expo-maps") as ExpoMapsModule;
  } catch {
    return null;
  }
}

const expoMaps = loadExpoMaps();

function loadReactNativeMaps(): ReactNativeMapsModule | null {
  if (Platform.OS !== "android" && Platform.OS !== "ios") return null;
  try {
    return require("react-native-maps") as ReactNativeMapsModule;
  } catch {
    return null;
  }
}

// Prefer expo-maps in a Silverline native build. Expo Go does not contain
// ExpoMaps, but SDK 57 includes react-native-maps and can render it immediately.
const reactNativeMaps = expoMaps ? null : loadReactNativeMaps();
const fallbackTileUrl =
  process.env.EXPO_PUBLIC_MAP_TILE_URL ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

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
        .filter((f) => f.geometry_type === "circle" && (!f.status || f.status === "ACTIVE"))
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
        .filter((f) => f.geometry_type === "polygon" && (!f.status || f.status === "ACTIVE"))
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

  if (Platform.OS === "android" && expoMaps) {
    const { GoogleMaps } = expoMaps;
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

  if (Platform.OS === "ios" && expoMaps) {
    const { AppleMaps } = expoMaps;
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

  if (reactNativeMaps) {
    const NativeMapView = reactNativeMaps.default;
    const NativeCircle = reactNativeMaps.Circle;
    const NativePolygon = reactNativeMaps.Polygon;
    const NativeMarker = reactNativeMaps.Marker;
    const NativeUrlTile = reactNativeMaps.UrlTile;
    // Region deltas are a portable approximation of the native zoom level.
    // The longitude delta is wider to match the landscape map card.
    const latitudeDelta = 360 / 2 ** zoom;
    const initialRegion = {
      ...resolvedCenter,
      latitudeDelta,
      longitudeDelta: latitudeDelta * 1.6,
    };
    return (
      <View style={frame}>
        <NativeMapView
          key={`${resolvedCenter.latitude.toFixed(5)}:${resolvedCenter.longitude.toFixed(5)}:${zoom}`}
          style={{ flex: 1 }}
          initialRegion={initialRegion}
          mapType={Platform.OS === "android" ? "none" : "standard"}
          userInterfaceStyle="light"
          loadingEnabled
          loadingBackgroundColor="#eef1f5"
          showsUserLocation
          showsMyLocationButton={false}
          toolbarEnabled={false}
        >
          <NativeUrlTile
            urlTemplate={fallbackTileUrl}
            maximumNativeZ={19}
            maximumZ={19}
            tileSize={256}
            tileCacheMaxAge={7 * 24 * 60 * 60}
            shouldReplaceMapContent={Platform.OS === "ios"}
            zIndex={0}
          />
          {circles.map((circle) => (
            <NativeCircle
              key={circle.id}
              center={circle.center}
              radius={circle.radius}
              fillColor={circle.color}
              strokeColor={circle.lineColor}
              strokeWidth={circle.lineWidth}
            />
          ))}
          {polygons.map((polygon) => (
            <NativePolygon
              key={polygon.id}
              coordinates={polygon.coordinates}
              fillColor={polygon.color}
              strokeColor={polygon.lineColor}
              strokeWidth={polygon.lineWidth}
            />
          ))}
          {markers.map((marker) => (
            <NativeMarker
              key={marker.id}
              coordinate={marker.coordinates}
              title={marker.title}
              pinColor={marker.tintColor}
            />
          ))}
        </NativeMapView>
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            right: 4,
            bottom: 3,
            borderRadius: 3,
            backgroundColor: "rgba(255,255,255,0.88)",
            paddingHorizontal: 4,
            paddingVertical: 2,
          }}
        >
          <Muted style={{ color: "#334155", fontSize: 9 }}>© OpenStreetMap contributors</Muted>
        </View>
      </View>
    );
  }

  return (
    <View style={[frame, { alignItems: "center", justifyContent: "center", gap: space.sm, padding: space.lg }]}>
      <Ionicons name="map-outline" size={22} color={t.textSubtle} />
      <Muted style={{ textAlign: "center", fontSize: font.sm }}>
        Map preview is unavailable on this platform. Attendance and punching still work.
      </Muted>
    </View>
  );
}
