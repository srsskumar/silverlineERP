import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { S2_PERMISSIONS, toFieldErrors } from "@silverline/shared";
import { buildAuthenticate, requirePermission } from "../../common/auth.js";
import { sendError } from "../../common/httpErrors.js";

/*
 * Geocoding only.
 *
 * This module used to own the geo-fences: their CRUD, the per-employee
 * assignments and the "effective fences" read the phone made before a punch.
 * Silverline has no geo-fencing since 2026-09-22 (owner decision); the fence
 * tables stay in the database so history is readable, but nothing serves or
 * evaluates them any more. The place search below is kept because attendance
 * is about to name the place a punch was made from, and that needs a
 * geocoder with a cache and a rate slot -- which this already is.
 */

export interface GeoRoutesOptions {
  pool: Pool;
  jwtSecret: string;
}

const placeSearchQuerySchema = z.object({
  q: z.string().trim().min(2, "Search needs at least 2 characters").max(200),
});

interface PlaceSearchResult {
  id: string;
  display_name: string;
  lat: number;
  lng: number;
  type: string | null;
}

const placeSearchCache = new Map<string, { expiresAt: number; data: PlaceSearchResult[] }>();
let lastPlaceSearchAt = 0;
let placeSearchQueue: Promise<void> = Promise.resolve();

async function waitForPlaceSearchSlot(): Promise<void> {
  const previous = placeSearchQueue;
  let release!: () => void;
  placeSearchQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  const delay = Math.max(0, lastPlaceSearchAt + 1_000 - Date.now());
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  lastPlaceSearchAt = Date.now();
  release();
}

/**
 * A finite coordinate from a provider field, or null.
 *
 * The provider sends coordinates as strings and is not required to send them at
 * all. Only a non-empty value that parses to a finite number counts; null,
 * undefined, "" and "NaN" all mean "this row has no position".
 */
function coordinate(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function searchPlaces(query: string): Promise<PlaceSearchResult[]> {
  const key = query.toLocaleLowerCase("en-IN");
  const cached = placeSearchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  await waitForPlaceSearchSlot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const base = (process.env["GEOCODING_BASE_URL"] ?? "https://nominatim.openstreetmap.org").replace(/\/$/, "");
    const url = new URL(`${base}/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "6");
    url.searchParams.set("addressdetails", "1");
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Language": "en-IN,en;q=0.8",
        "User-Agent": process.env["GEOCODING_USER_AGENT"] ?? "SilverlineERP/1.0",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Geocoder returned ${response.status}`);
    const body = await response.json() as Array<Record<string, unknown>>;
    const data = body.flatMap((item): PlaceSearchResult[] => {
      const lat = coordinate(item["lat"]);
      const lng = coordinate(item["lon"]);
      // A row missing a coordinate is dropped, not centred on the null island:
      // Number(null) is 0, so coercing a missing longitude would place the
      // result at 0°E and the map would recentre somewhere plausible-looking.
      if (lat === null || lng === null) return [];
      return [{
        id: `${String(item["osm_type"] ?? "place")}:${String(item["osm_id"] ?? `${lat},${lng}`)}`,
        display_name: String(item["display_name"] ?? query),
        lat,
        lng,
        type: typeof item["type"] === "string" ? item["type"] : null,
      }];
    });
    if (placeSearchCache.size >= 200) placeSearchCache.delete(placeSearchCache.keys().next().value ?? "");
    placeSearchCache.set(key, { expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1_000, data });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------------
 * Reverse geocoding: the place a punch was made from.
 *
 * Asked by the background worker, never by the punch route: the provider is
 * a public service with a one-request-per-second courtesy limit and a ten
 * second timeout, and nobody punching in should wait on either. Results are
 * cached by position rounded to about a hundred metres, since a crew punches
 * from the same few places all week.
 * --------------------------------------------------------------------- */

/** What the address object from the provider is reduced to. */
export interface PlaceResolution {
  /** "Kondapur, Hyderabad, Telangana" -- null when the provider knew nothing. */
  place_name: string | null;
  /** The provider's address object, kept whole for the detail screen. */
  place_detail: Record<string, unknown> | null;
}

const reverseCache = new Map<string, { expiresAt: number; data: PlaceResolution }>();

/** Cache key: three decimals is about 110 m of latitude, 105 m of longitude at Hyderabad. */
export function reverseCacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

function firstText(address: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = address[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * The most specific settled place, then the district, then the state.
 *
 * A supervisor reads "Kondapur, Hyderabad, Telangana" and knows where that
 * is; the provider's display_name runs to a dozen comma-separated parts
 * beginning with a house number. Parts that repeat (a city that is its own
 * district) are said once.
 */
export function placeNameFromAddress(address: Record<string, unknown> | null | undefined): string | null {
  if (!address) return null;
  const parts = [
    firstText(address, ["village", "hamlet", "neighbourhood", "suburb", "town", "city", "municipality"]),
    firstText(address, ["city", "town", "state_district", "county", "district"]),
    firstText(address, ["state", "region", "province"]),
  ];
  const out: string[] = [];
  for (const p of parts) {
    if (p && !out.includes(p)) out.push(p);
  }
  return out.length ? out.join(", ") : firstText(address, ["country"]);
}

/** Nominatim's zoom for "settlement": village or suburb, not street or house. */
const REVERSE_ZOOM = "14";

/**
 * Name the place at a position. Throws on a provider fault (the caller
 * counts attempts); resolves with a null name when the provider answers
 * but knows nothing there, which is final.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<PlaceResolution> {
  const key = reverseCacheKey(lat, lng);
  const cached = reverseCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  await waitForPlaceSearchSlot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const base = (process.env["GEOCODING_BASE_URL"] ?? "https://nominatim.openstreetmap.org").replace(/\/$/, "");
    const url = new URL(`${base}/reverse`);
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lng));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("zoom", REVERSE_ZOOM);
    url.searchParams.set("addressdetails", "1");
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Language": "en-IN,en;q=0.8",
        "User-Agent": process.env["GEOCODING_USER_AGENT"] ?? "SilverlineERP/1.0",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Geocoder returned ${response.status}`);
    const body = await response.json() as Record<string, unknown> | null;
    // "Unable to geocode" comes back as 200 with an error field: the
    // provider answered, and the answer is that there is nothing there.
    const address = body && typeof body["address"] === "object" && body["address"] !== null && !("error" in body)
      ? body["address"] as Record<string, unknown>
      : null;
    const data: PlaceResolution = {
      place_name: placeNameFromAddress(address),
      place_detail: address
        ? { ...address, display_name: typeof body?.["display_name"] === "string" ? body["display_name"] : undefined }
        : null,
    };
    if (reverseCache.size >= 500) reverseCache.delete(reverseCache.keys().next().value ?? "");
    reverseCache.set(key, { expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1_000, data });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** For tests: forget cached answers. */
export function clearReverseCache(): void {
  reverseCache.clear();
}

export async function registerGeoRoutes(
  app: FastifyInstance,
  opts: GeoRoutesOptions,
): Promise<void> {
  const authenticate = buildAuthenticate({
    pool: opts.pool,
    jwtSecret: opts.jwtSecret,
  });
  // The fence permissions (geo.read, geo.manage) are gone with the fences.
  // Looking a place up belongs to the people who read where punches were
  // made from, so the search takes the attendance register's read grant.
  const canSearch = requirePermission(authenticate, S2_PERMISSIONS.ATTENDANCE_READ);

  // Deliberately button-triggered by a client: the public geocoder forbids
  // client-side autocomplete. Requests are serialized to one/second and cached
  // for seven days; GEOCODING_BASE_URL keeps the provider replaceable.
  app.get("/api/v1/geo/search", { preHandler: canSearch }, async (req, reply) => {
    const parsed = placeSearchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return sendError(reply, req.requestId, {
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        fieldErrors: toFieldErrors(parsed.error),
      });
    }
    try {
      return reply.status(200).send({ data: await searchPlaces(parsed.data.q) });
    } catch (error) {
      req.log.warn({ err: error }, "place search provider failed");
      return sendError(reply, req.requestId, {
        status: 502,
        code: "GEOCODER_UNAVAILABLE",
        message: "Location search is temporarily unavailable",
      });
    }
  });
}
