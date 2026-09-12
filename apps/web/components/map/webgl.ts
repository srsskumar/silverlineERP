/**
 * WebGL2 availability.
 *
 * MapLibre requires WebGL2 and throws during construction when it is missing.
 * That error propagates to the nearest error boundary, so an unsupported
 * browser does not just lose the map — it loses the whole page. Locked-down
 * corporate desktops, VDI sessions, older Android tablets and headless
 * environments all hit this, so every map checks first and renders a static
 * fallback instead.
 */
let cached: boolean | null = null;

export function hasWebGL2(): boolean {
  if (cached !== null) return cached;
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    cached = Boolean(canvas.getContext('webgl2'));
  } catch {
    cached = false;
  }
  return cached;
}
