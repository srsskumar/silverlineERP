/**
 * M-004: shared offset-paging logic for the mobile list screens whose API
 * endpoints return `has_more`/`next_offset` but were never given a way to
 * see past the first page (`getClients`/`getTenders`/`getLeads`/
 * `getRequisitions`/`getPurchaseOrders` in src/api/endpoints.ts) — with
 * enough seed data, the 51st+ row was simply invisible, with no indication
 * more existed.
 *
 * Mirrors the "Newer/Older" pattern app/asset-movements.tsx already ships
 * (the one existing precedent in the app for this shape of list), pulled out
 * here so five screens share one tested implementation instead of five
 * copies of the same off-by-one risk.
 */

export const PAGE_SIZE = 50;

/** The offset to move to going one page further from the start ("Older"). */
export function olderOffset(offset: number, pageSize: number = PAGE_SIZE): number {
  return offset + pageSize;
}

/** The offset to move to going one page back toward the start ("Newer"). Never negative. */
export function newerOffset(offset: number, pageSize: number = PAGE_SIZE): number {
  return Math.max(0, offset - pageSize);
}

/** Whether "Newer" has anywhere to go — false only at the first page. */
export function canGoNewer(offset: number): boolean {
  return offset > 0;
}

/** Whether "Older" has anywhere to go — exactly what the server told us. */
export function canGoOlder(hasMore: boolean | undefined): boolean {
  return hasMore === true;
}
