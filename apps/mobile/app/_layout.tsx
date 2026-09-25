import {clearPayslipFiles} from "../src/ui/Payslip";
import {AppErrorBoundary, RouteErrorBoundary} from "../src/ui/ErrorBoundary";
import {registerBackgroundSync} from "../src/sync/background";
import { onStaleQueries } from "../src/sync/afterSync";
import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { AuthProvider, useAuth } from "../src/auth/AuthContext";

void SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000, gcTime: 5 * 60_000 },
  },
});

function Gate({ children }: { children: React.ReactNode }) {
  const { ready,signedIn } = useAuth();
  useEffect(()=>{clearPayslipFiles();},[signedIn]);
  useEffect(()=>{if(signedIn)void registerBackgroundSync();},[signedIn]);
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);
  if (!ready) return null;
  return <>{children}</>;
}

// Queued work that synced marks what it changed as stale (final review, item 3).
onStaleQueries(keys => {
  for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
});

export default function RootLayout() {
  return (
    // Two boundaries, deliberately nested.
    //
    // The outer one is a last resort for AuthProvider/QueryClient themselves.
    // The inner one sits INSIDE AuthProvider, and that placement is the whole
    // point: when the only boundary wrapped AuthProvider, any render error
    // unmounted the provider, React state holding the session went with it,
    // and the remount ran loadSession() — which returns null by design so a
    // fresh launch demands credentials. The result was that a single component
    // error signed the user out and reset navigation to the first tab.
    <AppErrorBoundary fatal>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Gate>
            <StatusBar style="auto" />
            <RouteErrorBoundary>
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="(auth)" />
                <Stack.Screen name="(tabs)" />
              </Stack>
            </RouteErrorBoundary>
          </Gate>
        </AuthProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}
