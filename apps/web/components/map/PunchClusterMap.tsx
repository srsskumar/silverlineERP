'use client';

import * as React from 'react';
import {
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  type GeoJSONSource,
  type MapMouseEvent,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { baseMapStyle, tokenColor } from './mapStyle';
import { hasWebGL2 } from './webgl';
import { MapFallback } from './MapFallback';
import { cn } from '@/lib/cn';

export interface PunchPoint {
  id: string;
  lat: number;
  lng: number;
  /**
   * Drives the dot colour. Named to match the API's field and REQUIRED on
   * purpose: as an optional `status?` this silently accepted the server's
   * `outcome` objects and coloured every punch as clean.
   */
  outcome: 'ok' | 'review' | 'outside';
}

export interface PunchClusterMapProps {
  points: readonly PunchPoint[];
  height?: number;
  className?: string;
  onSelect?: (id: string) => void;
}

function isDarkNow(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.classList.contains('dark');
}

/**
 * Attendance punches aggregated on a map.
 *
 * Clustering is done by MapLibre's own `cluster: true` on the GeoJSON source
 * rather than by running supercluster in our code: MapLibre embeds supercluster
 * internally, so doing it here would mean shipping the same algorithm twice and
 * re-clustering on every pan. Above roughly 100k points this should move to a
 * server-side tile endpoint — at that scale the GeoJSON payload, not the
 * clustering, is the bottleneck.
 */
export function PunchClusterMap({ points, height = 420, className, onSelect }: PunchClusterMapProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const mapRef = React.useRef<MapLibreMap | null>(null);
  const [ready, setReady] = React.useState(false);

  const data = React.useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: points.map((p) => ({
        type: 'Feature' as const,
        properties: { id: p.id, outcome: p.outcome },
        geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
      })),
    }),
    [points],
  );

  const initialCenter = React.useMemo<[number, number]>(() => {
    if (points[0]) return [points[0].lng, points[0].lat];
    return [78.4772, 17.4065];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [supported] = React.useState(() => hasWebGL2());

  React.useEffect(() => {
    if (!containerRef.current || mapRef.current || !supported) return;
    const map = new MapLibreMap({
      container: containerRef.current,
      style: baseMapStyle(isDarkNow()),
      center: initialCenter,
      zoom: 9,
      attributionControl: { compact: true },
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
  }, [initialCenter, supported]);

  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const existing = map.getSource('punches') as GeoJSONSource | undefined;
    if (existing) {
      existing.setData(data);
      return;
    }

    const primary = tokenColor('--primary', '#2f5bff');
    const success = tokenColor('--success', '#1f8757');
    const warning = tokenColor('--warning', '#b06a08');
    const danger = tokenColor('--danger', '#d32836');

    map.addSource('punches', {
      type: 'geojson',
      data,
      cluster: true,
      clusterMaxZoom: 15,
      clusterRadius: 45,
    });

    map.addLayer({
      id: 'clusters',
      type: 'circle',
      source: 'punches',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': primary,
        'circle-opacity': 0.85,
        // Area, not radius, should track count — otherwise a cluster of 500
        // looks five times a cluster of 100 rather than about twice.
        'circle-radius': ['step', ['get', 'point_count'], 14, 10, 18, 50, 24, 250, 32],
        'circle-stroke-width': 2,
        'circle-stroke-color': tokenColor('--surface', '#ffffff'),
      },
    });
    map.addLayer({
      id: 'cluster-count',
      type: 'symbol',
      source: 'punches',
      filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12 },
      paint: { 'text-color': '#ffffff' },
    });
    map.addLayer({
      id: 'punch-point',
      type: 'circle',
      source: 'punches',
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': [
          'match',
          ['get', 'outcome'],
          'review', warning,
          'outside', danger,
          success,
        ],
        'circle-radius': 6,
        'circle-stroke-width': 2,
        'circle-stroke-color': tokenColor('--surface', '#ffffff'),
      },
    });

    // Clicking a cluster zooms to the extent it covers.
    map.on('click', 'clusters', (e: MapMouseEvent) => {
      const feature = map.queryRenderedFeatures(e.point, { layers: ['clusters'] })[0];
      const clusterId = feature?.properties?.cluster_id;
      if (clusterId == null) return;
      const source = map.getSource('punches') as GeoJSONSource;
      void source.getClusterExpansionZoom(Number(clusterId)).then((zoom) => {
        const geometry = feature.geometry as { coordinates: [number, number] };
        map.easeTo({ center: geometry.coordinates, zoom });
      });
    });
    map.on('click', 'punch-point', (e: MapMouseEvent) => {
      // Layer-scoped handlers get `features`, but the base MapMouseEvent type
      // does not declare it; query at the click point instead of casting.
      const id = map.queryRenderedFeatures(e.point, { layers: ['punch-point'] })[0]?.properties?.id;
      if (typeof id === 'string') onSelect?.(id);
    });
    for (const layer of ['clusters', 'punch-point']) {
      map.on('mouseenter', layer, () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', layer, () => {
        map.getCanvas().style.cursor = '';
      });
    }
  }, [ready, data, onSelect]);

  React.useEffect(() => {
    const observer = new MutationObserver(() => {
      const map = mapRef.current;
      if (!map) return;
      map.setStyle(baseMapStyle(isDarkNow()));
      map.once('styledata', () => setReady(false));
      map.once('idle', () => setReady(true));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  if (!supported) {
    return (
      <MapFallback
        height={height}
        className={className}
        items={points.map((p) => ({
          id: p.id,
          label:
            p.outcome === 'ok'
              ? 'Inside fence'
              : p.outcome === 'outside'
                ? 'Outside fence'
                : 'Flagged for review',
          detail: `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`,
        }))}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ height }}
      className={cn('w-full overflow-hidden rounded-lg border border-border bg-surface-sunken', className)}
      role="application"
      aria-label="Attendance punch map"
    />
  );
}
