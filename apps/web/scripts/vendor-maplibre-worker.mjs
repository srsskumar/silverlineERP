// Put MapLibre's worker where the browser can fetch it.
//
// MapLibre GL draws GeoJSON sources -- every fence on the geo-fence screen,
// every punch cluster on the attendance map -- in a web worker. Since v6 it
// finds that worker's script next to its own module through import.meta.url,
// which a webpack bundle does not carry as an http(s) address, so the lookup
// came back empty and the map started `new Worker('')`: the page's own HTML,
// loaded as a script. The request never completed, nothing that needed the
// worker was ever drawn, and the tiles underneath made it look like a map
// with no fences on it.
//
// This copies the worker and the shared chunk it imports into public/, where
// the static export serves them, and the map is told that address (see
// components/map/worker.ts). They are copied as .js rather than .mjs because
// not every static host maps .mjs to a JavaScript MIME type, and a module
// worker with the wrong MIME type is refused outright. Run before build and
// dev; the output is generated, not committed.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKER_FILE = 'maplibre-gl-worker.js';
export const SHARED_FILE = 'maplibre-gl-shared.js';

/**
 * Copies the two files from `distDir` into `outDir`, rewriting the worker's
 * import of its shared chunk to the .js name. Returns the paths written.
 */
export function vendorMaplibreWorker(distDir, outDir) {
  mkdirSync(outDir, { recursive: true });
  const worker = readFileSync(join(distDir, 'maplibre-gl-worker.mjs'), 'utf8')
    .replaceAll('./maplibre-gl-shared.mjs', `./${SHARED_FILE}`);
  writeFileSync(join(outDir, WORKER_FILE), worker);
  copyFileSync(join(distDir, 'maplibre-gl-shared.mjs'), join(outDir, SHARED_FILE));
  return [join(outDir, WORKER_FILE), join(outDir, SHARED_FILE)];
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const require = createRequire(import.meta.url);
  const distDir = dirname(require.resolve('maplibre-gl/package.json')) + '/dist';
  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'vendor', 'maplibre');
  for (const file of vendorMaplibreWorker(distDir, outDir)) console.log(`vendored ${file}`);
}
