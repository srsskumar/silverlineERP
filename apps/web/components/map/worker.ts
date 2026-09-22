import { setWorkerUrl } from 'maplibre-gl';

/**
 * Where the map finds its worker.
 *
 * MapLibre works out this address from its own module URL, which a bundled
 * build does not have, and the fallback is an empty string: the browser then
 * loads the page itself as the worker script, the request never finishes,
 * and no GeoJSON layer -- fences, punch clusters -- is ever drawn.
 * scripts/vendor-maplibre-worker.mjs puts the real script here before every
 * build, and this module tells the map so before any map is constructed.
 * Import it from every component that creates a map.
 */
export const MAPLIBRE_WORKER_URL = '/vendor/maplibre/maplibre-gl-worker.js';

setWorkerUrl(MAPLIBRE_WORKER_URL);
