'use client';

import * as React from 'react';
// maplibre-gl v6 exposes named exports only (no default export).
import {
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  ScaleControl,
  type GeoJSONSource,
  type MapMouseEvent,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { baseMapStyle, tokenColor } from './mapStyle';
import { circleToRing, pointsToRing } from './geometry';
import { hasWebGL2 } from './webgl';
import { MapFallback } from './MapFallback';
import { cn } from '@/lib/cn';

export interface FenceCircle {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radius_m: number;
}

export interface FencePolygon {
  id: string;
  name: string;
  /** [lat, lng] tuples, matching the API contract. */
  points: Array<[number, number]>;
}

export interface FenceMapProps {
  circles?: readonly FenceCircle[];
  polygons?: readonly FencePolygon[];
  /** Marker pins, e.g. attendance punches. */
  points?: ReadonlyArray<{ id: string; lat: number; lng: number; title?: string }>;
  center?: { lat: number; lng: number } | null;
  zoom?: number;
  className?: string;
  height?: number;
  /** Called with the clicked position — used by the create form to set a centre. */
  onMapClick?: (position: { lat: number; lng: number }) => void;
  /** Highlights one fence. */
  activeId?: string | null;
  interactive?: boolean;
}

function isDarkNow(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.classList.contains('dark');
}

export function FenceMap({
  circles = [],
  polygons = [],
  points = [],
  center,
  zoom = 13,
  className,
  height = 380,
  onMapClick,
  activeId = null,
  interactive = true,
}: FenceMapProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const mapRef = React.useRef<MapLibreMap | null>(null);
  const markersRef = React.useRef<Marker[]>([]);
  const [ready, setReady] = React.useState(false);

  // Resolve the initial centre once: the first fence, the first point, or a
  // wide default. Recentring on every render would fight the user's panning.
  const initialCenter = React.useMemo<[number, number]>(() => {
    if (center) return [center.lng, center.lat];
    if (circles[0]) return [circles[0].lng, circles[0].lat];
    const poly = polygons[0]?.points[0];
    if (poly) return [poly[1], poly[0]];
    if (points[0]) return [points[0].lng, points[0].lat];
    return [78.4772, 17.4065]; // Hyderabad — the deployment's home region.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [supported] = React.useState(() => hasWebGL2());

  React.useEffect(() => {
    if (!containerRef.current || mapRef.current || !supported) return;
    const map = new MapLibreMap({
      container: containerRef.current,
      style: baseMapStyle(isDarkNow()),
      center: initialCenter,
      zoom,
      attributionControl: { compact: true },
      interactive,
    });
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
    map.on('load', () => setReady(true));
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, [initialCenter, zoom, interactive, supported]);

  // Re-style on theme change rather than rebuilding the map, so the viewport
  // and any drawn geometry survive a light/dark toggle.
  React.useEffect(() => {
    const observer = new MutationObserver(() => {
      const map = mapRef.current;
      if (!map) return;
      map.setStyle(baseMapStyle(isDarkNow()));
      map.once('styledata', () => setReady(true));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !onMapClick) return;
    const handler = (e: MapMouseEvent) => {
      onMapClick({ lat: Number(e.lngLat.lat.toFixed(6)), lng: Number(e.lngLat.lng.toFixed(6)) });
    };
    map.on('click', handler);
    return () => {
      map.off('click', handler);
    };
  }, [onMapClick]);

  // Draw fences as one GeoJSON source, refreshed whenever the inputs change.
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const features = [
      ...circles.map((c) => ({
        type: 'Feature' as const,
        id: c.id,
        properties: { id: c.id, name: c.name, active: c.id === activeId },
        geometry: {
          type: 'Polygon' as const,
          coordinates: [circleToRing(c.lat, c.lng, c.radius_m)],
        },
      })),
      ...polygons
        .filter((p) => p.points.length >= 3)
        .map((p) => ({
          type: 'Feature' as const,
          id: p.id,
          properties: { id: p.id, name: p.name, active: p.id === activeId },
          geometry: {
            type: 'Polygon' as const,
            // GeoJSON is [lng, lat] and the contract stores [lat, lng].
            coordinates: [pointsToRing(p.points)],
          },
        })),
    ];
    const data = { type: 'FeatureCollection' as const, features };

    const primary = tokenColor('--primary', '#2f5bff');
    const success = tokenColor('--success', '#1f8757');
    const existing = map.getSource('fences') as GeoJSONSource | undefined;
    if (existing) {
      existing.setData(data);
      return;
    }
    map.addSource('fences', { type: 'geojson', data });
    map.addLayer({
      id: 'fences-fill',
      type: 'fill',
      source: 'fences',
      paint: {
        'fill-color': ['case', ['get', 'active'], success, primary],
        'fill-opacity': 0.15,
      },
    });
    map.addLayer({
      id: 'fences-line',
      type: 'line',
      source: 'fences',
      paint: {
        'line-color': ['case', ['get', 'active'], success, primary],
        'line-width': ['case', ['get', 'active'], 3, 2],
      },
    });
    map.addLayer({
      id: 'fences-label',
      type: 'symbol',
      source: 'fences',
      layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-anchor': 'center' },
      paint: {
        'text-color': tokenColor('--text', '#171b24'),
        'text-halo-color': tokenColor('--surface', '#ffffff'),
        'text-halo-width': 1.5,
      },
    });
  }, [ready, circles, polygons, activeId]);

  // Markers are real DOM, so they are rebuilt rather than diffed.
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const m of markersRef.current) m.remove();
    markersRef.current = points.map((p) => {
      const el = document.createElement('div');
      el.className = 'size-3 rounded-full border-2 border-white bg-primary shadow';
      el.title = p.title ?? '';
      return new Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map);
    });
    return () => {
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];
    };
  }, [ready, points]);

  if (!supported) {
    return (
      <MapFallback
        height={height}
        className={className}
        items={[
          ...circles.map((c) => ({
            id: c.id,
            label: c.name,
            detail: `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)} · r${Math.round(c.radius_m)}m`,
          })),
          ...polygons.map((p) => ({
            id: p.id,
            label: p.name,
            detail: `${p.points.length} points`,
          })),
        ]}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ height }}
      className={cn('w-full overflow-hidden rounded-lg border border-border bg-surface-sunken', className)}
      role="application"
      aria-label="Geo-fence map"
    />
  );
}
