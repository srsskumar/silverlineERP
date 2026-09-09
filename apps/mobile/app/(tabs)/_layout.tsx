import {useColors} from "../../src/ui";
import { Ionicons } from "@expo/vector-icons";
import { Redirect, Tabs } from "expo-router";
import { useAuth } from "../../src/auth/AuthContext";

export default function TabsLayout() {
  const colors=useColors();
  const { ready, signedIn,user } = useAuth();
  if (!ready) return null;
  if (!signedIn) return <Redirect href="/(auth)/login" />;
  if(user?.mfa_enrollment_required)return <Redirect href="/(auth)/enroll"/>;
  const icons = {
    index: ["home-outline", "home"] as const,
    attendance: ["time-outline", "time"] as const,
    tasks: ["checkbox-outline", "checkbox"] as const,
    leave: ["calendar-outline", "calendar"] as const,
    assets: ["cube-outline", "cube"] as const,
    more: ["person-outline", "person"] as const,
  };
  return (
    <Tabs screenOptions={({ route }) => ({ headerShown: true,headerStyle:{backgroundColor:colors.card},headerTintColor:colors.ink,tabBarStyle:{backgroundColor:colors.card},tabBarActiveTintColor:colors.primary,tabBarInactiveTintColor:colors.muted,tabBarIcon:({ focused, color, size }) => { const pair = icons[route.name as keyof typeof icons]; return <Ionicons name={focused ? pair[1] : pair[0]} size={size} color={color} />; } })}>
      <Tabs.Screen name="index" options={{ title: "Home" }} />
      <Tabs.Screen name="attendance" options={{ title: "Attendance" }} />
      <Tabs.Screen name="tasks" options={{ title: "Tasks" }} />
      <Tabs.Screen name="leave" options={{ title: "Leave" }} />
      <Tabs.Screen name="assets" options={{ title: "Assets" }} />
      <Tabs.Screen name="more" options={{ title: "More" }} />
    </Tabs>
  );
}
