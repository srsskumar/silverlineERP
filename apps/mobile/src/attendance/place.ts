/**
 * What a day's row says about where its punches were made.
 *
 * Pure text over the API's record fields, kept apart from the screen so it
 * can be tested without React Native: the server names the place from the
 * coordinates after the punch (village or town, district, state) and says
 * where it stands on that -- named, still resolving, nothing found, or no
 * position at all.
 */

export type PlaceStatus = "none" | "resolving" | "named" | "unnamed";

export interface PlacedRecord {
  check_in_at?: string | null;
  check_out_at?: string | null;
  check_in_place_name?: string | null;
  check_in_place_status?: PlaceStatus | string;
  check_out_place_name?: string | null;
  check_out_place_status?: PlaceStatus | string;
  [k: string]: unknown;
}

/** The name, or that one is coming, or that none could be found. */
export function placeLabel(name: unknown, status: unknown): string | null {
  if (typeof name === "string" && name.trim()) return name.trim();
  if (status === "resolving") return "finding the place…";
  if (status === "unnamed") return "place not found";
  return null;
}

/**
 * "In 09:14 from Kondapur, Hyderabad · Out 18:02 from Gachibowli, Hyderabad"
 *
 * One place when both punches were made from the same one, which is the
 * usual day; the second only when it differs, so a day spent in one village
 * does not say it twice.
 */
export function punchPlaceLine(
  record: PlacedRecord,
  clock: (iso: string) => string,
): string | undefined {
  const parts: string[] = [];
  const inPlace = record.check_in_at ? placeLabel(record.check_in_place_name, record.check_in_place_status) : null;
  const outPlace = record.check_out_at ? placeLabel(record.check_out_place_name, record.check_out_place_status) : null;
  if (record.check_in_at) {
    parts.push(`In ${clock(record.check_in_at)}${inPlace ? ` from ${inPlace}` : ""}`);
  }
  if (record.check_out_at) {
    const same = outPlace !== null && outPlace === inPlace;
    parts.push(`Out ${clock(record.check_out_at)}${outPlace && !same ? ` from ${outPlace}` : ""}`);
  }
  return parts.length ? parts.join(" · ") : undefined;
}
