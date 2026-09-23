/**
 * Placeholder destination for a catalog module the More launcher lists but
 * mobile has not built a screen for yet (see src/modulesLauncher.ts).
 *
 * Exists so the launcher can already reflect the full module catalog today —
 * everything an admin has switched on for this role appears in the list —
 * without a dead link: tapping an unbuilt module explains itself instead of
 * doing nothing or crashing on a missing route.
 */
import { router, useLocalSearchParams } from "expo-router";
import { withScreenBoundary } from "../src/ui/ErrorBoundary";
import { BackHeader, EmptyState, Screen } from "../src/ui/primitives";

function ComingSoonScreen() {
  const { label } = useLocalSearchParams<{ code?: string; label?: string }>();
  const title = typeof label === "string" && label.length > 0 ? label : "Module";

  return (
    <Screen>
      <BackHeader title={title} onBack={() => router.back()} />
      <EmptyState
        icon="construct-outline"
        title="Coming soon on mobile"
        message={`${title} is available on the web app. This module has not been built for the phone yet — check back in a future update.`}
      />
    </Screen>
  );
}

export default withScreenBoundary(ComingSoonScreen);
