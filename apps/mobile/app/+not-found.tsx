import { Link, Stack } from "expo-router";
import { View } from "react-native";
import { EmptyState, Screen } from "../src/ui/primitives";

/**
 * Unmatched-route screen.
 *
 * Without this file expo-router silently falls back to the first route, which
 * looks exactly like "the app threw me back to Home" — so a typo'd link or a
 * stale deep link was indistinguishable from a crash.
 */
export default function NotFound() {
  return (
    <>
      <Stack.Screen options={{ title: "Not found" }} />
      <Screen scroll={false}>
        <View style={{ flex: 1, justifyContent: "center" }}>
          <EmptyState
            icon="help-circle-outline"
            title="Page not available"
            message="This link points somewhere this version of the app does not have."
            action={<Link href="/(tabs)">Go to Home</Link>}
          />
        </View>
      </Screen>
    </>
  );
}
