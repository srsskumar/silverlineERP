import { apiRequest } from './apiClient';

/**
 * S2 geo-fences client (frozen contract).
 *
 * POST /api/v1/geo-fences {name, scope_type, scope_id, geometry_type,
 *   geometry, tolerance_meters?, accuracy_threshold_meters?} → 201 bare
 * GET  /geo-fences?scope_type=&scope_id= → {data,...} (bare arrays tolerated)
 * PATCH /:id + If-Match → 200 with version++.
 *
 * Geometry payload shape is a client-side assumption (the contract fixes
 * field names but not the geometry object layout):
 *   circle  → {lat, lng, radius_m}
 *   polygon → {points: [[lat, lng], ...]} (≥3 points, tuple form per server)
 * See apps/web/README.md.
 */

export type GeometryType = 'circle' | 'polygon';

export interface CircleGeometry {
  lat: number;
  lng: number;
  radius_m: number;
}

export interface PolygonGeometry {
  /** Backend contract: [lat, lng] tuples (shared s2.ts polygonGeometrySchema). */
  points: Array<[number, number]>;
}

export type FenceGeometry = CircleGeometry | PolygonGeometry;

export interface GeoFence {
  id: string;
  name: string;
  scope_type: string;
  scope_id: string;
  geometry_type: GeometryType | string;
  geometry: FenceGeometry | Record<string, unknown>;
  tolerance_meters?: number | null;
  accuracy_threshold_meters?: number | null;
  status?: string;
  version: number;
  employee_ids?: string[];
  [key: string]: unknown;
}

export interface PlaceSearchResult {
  id: string;
  display_name: string;
  lat: number;
  lng: number;
  type: string | null;
}

export interface ListFencesParams {
  scope_type?: string;
  scope_id?: string;
}

export function buildFencesQuery(params: ListFencesParams = {}): string {
  const search = new URLSearchParams();
  if (params.scope_type) search.set('scope_type', params.scope_type);
  if (params.scope_id) search.set('scope_id', params.scope_id);
  const qs = search.toString();
  return `/api/v1/geo-fences${qs ? `?${qs}` : ''}`;
}

/** Tolerate `{data:[...]}` envelopes and bare arrays (S1 documents pattern). */
export function normalizeFences(body: unknown): GeoFence[] {
  if (Array.isArray(body)) return body as GeoFence[];
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const nested = (body as { data?: unknown }).data;
    if (Array.isArray(nested)) return nested as GeoFence[];
    // Single-object 201 responses may flow through here; wrap defensively.
    if (typeof (body as { id?: unknown }).id === 'string') return [body as GeoFence];
  }
  return [];
}

export async function listFences(params: ListFencesParams = {}): Promise<GeoFence[]> {
  const { data } = await apiRequest<unknown>(buildFencesQuery(params), { method: 'GET' });
  return normalizeFences(data);
}

export async function createFence(input: {
  name: string;
  scope_type: string;
  scope_id: string;
  geometry_type: GeometryType;
  geometry: FenceGeometry;
  employee_ids?: string[];
  tolerance_meters?: number;
  accuracy_threshold_meters?: number;
}): Promise<GeoFence> {
  const { data } = await apiRequest<GeoFence>('/api/v1/geo-fences', {
    method: 'POST',
    body: input as unknown as Record<string, unknown>,
  });
  return data;
}

/** Explicit, user-triggered place search used by the fence editor. */
export async function searchPlaces(query: string): Promise<PlaceSearchResult[]> {
  const { data } = await apiRequest<{ data?: PlaceSearchResult[] } | PlaceSearchResult[]>(
    `/api/v1/geo/search?q=${encodeURIComponent(query.trim())}`,
    { method: 'GET' },
  );
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.data) ? data.data : [];
}

export async function updateFence(
  id: string,
  patch: Partial<Pick<GeoFence, 'name' | 'status' | 'tolerance_meters' | 'accuracy_threshold_meters'>> & {
    geometry_type?: GeometryType;
    geometry?: FenceGeometry;
  },
  version: number | string,
): Promise<GeoFence> {
  const { data } = await apiRequest<GeoFence>(`/api/v1/geo-fences/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'If-Match': String(version) },
    body: patch as unknown as Record<string, unknown>,
  });
  return data;
}
