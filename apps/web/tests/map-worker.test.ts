import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SHARED_FILE, WORKER_FILE, vendorMaplibreWorker } from '../scripts/vendor-maplibre-worker.mjs';

const setWorkerUrl = vi.fn();
vi.mock('maplibre-gl', () => ({ setWorkerUrl: (url: string) => setWorkerUrl(url) }));

/*
 * The punch map drew tiles but never a marker: MapLibre 6 could not work
 * out its worker's address inside the bundle, started a worker from '' (the
 * page itself), and every GeoJSON layer waited on it for ever. These pin the
 * two halves of the fix -- the worker is served, and the map is told where.
 */
describe('maplibre worker', () => {
  it('is told where the vendored worker is before any map is built', async () => {
    const { MAPLIBRE_WORKER_URL } = await import('../components/map/worker');
    expect(MAPLIBRE_WORKER_URL).toBe('/vendor/maplibre/maplibre-gl-worker.js');
    expect(setWorkerUrl).toHaveBeenCalledWith(MAPLIBRE_WORKER_URL);
  });

  it('vendors the worker and the chunk it imports, under names every host serves as JavaScript', () => {
    const root = mkdtempSync(join(tmpdir(), 'maplibre-'));
    const dist = join(root, 'dist');
    mkdirSync(dist);
    writeFileSync(join(dist, 'maplibre-gl-worker.mjs'), 'import{a}from"./maplibre-gl-shared.mjs";a();');
    writeFileSync(join(dist, 'maplibre-gl-shared.mjs'), 'export const a=()=>1;');
    const out = join(root, 'public', 'vendor', 'maplibre');

    const written = vendorMaplibreWorker(dist, out);

    expect(written).toEqual([join(out, WORKER_FILE), join(out, SHARED_FILE)]);
    expect(readFileSync(join(out, WORKER_FILE), 'utf8')).toBe('import{a}from"./maplibre-gl-shared.js";a();');
    expect(readFileSync(join(out, SHARED_FILE), 'utf8')).toBe('export const a=()=>1;');
  });
});
