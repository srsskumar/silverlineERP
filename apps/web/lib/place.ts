/**
 * Where a punch stands on its place name (see the API's placeStatus):
 * no position at all, positioned but not yet named by the worker, named,
 * or asked and nothing came back.
 *
 * In its own module, apart from the attendance client, so a component that
 * only prints a place does not pull the whole API client in -- and so a
 * test that mocks the client does not have to know about it.
 */
export type PlaceStatus = 'none' | 'resolving' | 'named' | 'unnamed';

/**
 * What to print for a punch's place.
 *
 * The name once the worker has been; "resolving…" while it has not, so the
 * reader knows a name is coming rather than that there is none; a dash for
 * a punch made without a position; and "unnamed" when the geocoder was
 * asked and had nothing, which is true of open country and of a bad fix.
 */
export function placeLabel(name: string | null | undefined, status: PlaceStatus | undefined): string {
  if (name) return name;
  switch (status) {
    case 'resolving': return 'resolving…';
    case 'unnamed': return 'unnamed place';
    default: return '—';
  }
}
