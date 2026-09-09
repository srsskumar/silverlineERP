import {clearPayslipFiles} from "../src/ui/Payslip";
import {AppErrorBoundary} from "../src/ui/ErrorBoundary";
import {registerBackgroundSync} from "../src/sync/background";
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

export default function RootLayout() {
  return (
    <AppErrorBoundary><QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Gate>
          <StatusBar style="auto" />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(auth)" />
            <Stack.Screen name="(tabs)" />
          </Stack>
        </Gate>
      </AuthProvider>
    </QueryClientProvider></AppErrorBoundary>
  );
}
