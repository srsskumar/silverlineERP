import { Component, type ComponentType, type ReactNode } from "react";
import { View } from "react-native";
import { usePathname } from "expo-router";
import { reportClientError } from "../device/diagnostics";
import { Button, EmptyState, Screen } from "./primitives";

function Recovery({ retry }: { retry: () => void }) {
  return (
    <Screen scroll={false}>
      <View style={{ flex: 1, justifyContent: "center" }}>
        <EmptyState
          icon="warning-outline"
          title="This screen could not open"
          message="Your saved changes are still on this device. Try opening the screen again."
          action={<Button title="Try again" icon="refresh-outline" onPress={retry} />}
        />
      </View>
    </Screen>
  );
}

interface Props {
  children: ReactNode;
  /**
   * Changing this clears the error. Route-scoped boundaries pass the pathname
   * so navigating away from a broken screen recovers on its own — without it a
   * boundary latches failed forever and every later screen renders the error.
   */
  resetKey?: string;
  fatal?: boolean;
}

export class AppErrorBoundary extends Component<Props, { failed: boolean; key?: string }> {
  state: { failed: boolean; key?: string } = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: { failed: boolean; key?: string }) {
    if (state.key !== props.resetKey) return { failed: false, key: props.resetKey };
    return null;
  }

  componentDidCatch(error: Error) {
    void reportClientError(error, this.props.fatal ?? false);
  }

  render() {
    return this.state.failed ? (
      <Recovery retry={() => this.setState({ failed: false })} />
    ) : (
      this.props.children
    );
  }
}

/**
 * Error boundary scoped to the current route.
 *
 * Placed inside the navigator so a screen that throws does not unmount the
 * navigator (which would reset navigation to the first tab) nor AuthProvider
 * (which would drop the session and bounce the user to the login screen).
 */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return <AppErrorBoundary resetKey={pathname}>{children}</AppErrorBoundary>;
}

/**
 * Wrap a screen component so its own render errors stay contained to the
 * content area — the tab bar keeps working and the user can navigate away
 * instead of being thrown back to Home.
 */
export function withScreenBoundary<P extends object>(Wrapped: ComponentType<P>): ComponentType<P> {
  function Guarded(props: P) {
    return (
      <RouteErrorBoundary>
        <Wrapped {...props} />
      </RouteErrorBoundary>
    );
  }
  Guarded.displayName = `withScreenBoundary(${Wrapped.displayName ?? Wrapped.name ?? "Screen"})`;
  return Guarded;
}
