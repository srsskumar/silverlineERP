import { Component, type ReactNode } from "react";
import { View } from "react-native";
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

export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    void reportClientError(error);
  }
  render() {
    return this.state.failed ? (
      <Recovery retry={() => this.setState({ failed: false })} />
    ) : (
      this.props.children
    );
  }
}
