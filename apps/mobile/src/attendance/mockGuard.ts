/**
 * No mock locations (owner decision 2026-10-28, docs/DEV_PLAN.md).
 *
 * The OS tells us when the fix came from a mock provider. The server refuses
 * such a punch outright (422 MOCK_LOCATION) and keeps the attempt as evidence,
 * so there is no point queuing it: the phone refuses first, with the words
 * that let the person clear the cause. Pure, so it is tested without the
 * device APIs.
 */
export function mockLocationRefusal(
  fix: { mocked: boolean } | null | undefined,
): string | null {
  if (!fix || !fix.mocked) return null;
  return (
    "Mock location is on, so this punch cannot be made. " +
    "Turn off mock locations (Developer options › Select mock location app), " +
    "then refresh your location and punch again."
  );
}
