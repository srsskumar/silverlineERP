/**
 * The deep link from the Sync queue's "Review" to the survey tab (final
 * review, item 4).
 *
 * It carries a per-tap nonce, and the tab keys its effect on op + nonce, so
 * tapping Review again for the same op reopens the sheet. Keyed on the op id
 * alone, a second tap was the same route and nothing happened.
 */
export function reviewLink(clientUuid: string, now: number = Date.now()) {
  return {
    pathname: "/(tabs)/survey" as const,
    params: { review: clientUuid, at: String(now) },
  };
}

export function reviewRequest(
  params: { review?: string | string[]; at?: string | string[] },
): { clientUuid: string; key: string } | null {
  const id = Array.isArray(params.review) ? params.review[0] : params.review;
  if (!id) return null;
  const at = Array.isArray(params.at) ? params.at[0] : params.at;
  return { clientUuid: id, key: `${id}:${at ?? ""}` };
}
