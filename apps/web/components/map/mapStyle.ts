import type { StyleSpecification } from 'maplibre-gl';

/**
 * Base map style.
 *
 * OpenStreetMap raster tiles, deliberately: they need no API key and no vendor
 * account, which matters for an on-premises ERP deployment where a per-render
 * billing relationship with a tile vendor would be an adoption blocker. Swap
 * `TILE_URL` for a hosted vector style if the organisation has one.
 *
 * OSM's tile usage policy expects a real User-Agent and modest volume. A field
 * ERP drawing a few site boundaries is well inside it, but a public-facing
 * high-traffic deployment should host its own tiles.
 */
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

const ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export function baseMapStyle(dark: boolean): StyleSpecification {
  return {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: [TILE_URL],
        tileSize: 256,
        attribution: ATTRIBUTION,
        maxzoom: 19,
      },
    },
    layers: [
      // Painted under the tiles so the gap while tiles load matches the theme
      // instead of flashing white on a dark page.
      { id: 'background', type: 'background', paint: { 'background-color': dark ? '#11151d' : '#eef1f5' } },
      {
        id: 'osm',
        type: 'raster',
        source: 'osm',
        paint: dark
          ? // No dark raster tiles exist without a vendor key, so invert and
            // re-hue the light ones. Not beautiful, but legible, and it keeps
            // the page from having one blazing white rectangle in dark mode.
            { 'raster-brightness-max': 0.85, 'raster-saturation': -0.6, 'raster-contrast': 0.1, 'raster-opacity': 0.75 }
          : { 'raster-opacity': 1 },
      },
    ],
  };
}

/** Reads a CSS token to a concrete colour, since MapLibre cannot use var(). */
export function tokenColor(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw ? `hsl(${raw})` : fallback;
}
