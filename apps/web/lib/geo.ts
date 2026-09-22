import { apiRequest } from './apiClient';

/**
 * Place lookup.
 *
 * This file used to be the geo-fences client (list, create, patch). Silverline
 * has no geo-fencing since 2026-09-22; what stays is the geocoder call, kept
 * for the place names attendance is about to attach to punches.
 */

export interface PlaceSearchResult {
  id: string;
  display_name: string;
  lat: number;
  lng: number;
  type: string | null;
}

/** Explicit, user-triggered place search (the public geocoder forbids autocomplete). */
export async function searchPlaces(query: string): Promise<PlaceSearchResult[]> {
  const { data } = await apiRequest<{ data?: PlaceSearchResult[] } | PlaceSearchResult[]>(
    `/api/v1/geo/search?q=${encodeURIComponent(query.trim())}`,
    { method: 'GET' },
  );
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.data) ? data.data : [];
}
