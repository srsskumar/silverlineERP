import { Ionicons } from "@expo/vector-icons";
import { Redirect, Tabs } from "expo-router";
import { StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../src/auth/AuthContext";
import { getMyVillages } from "../../src/api/endpoints";
import { font, useTheme } from "../../src/theme";

/** Outline when idle, filled when active — the platform convention. */
const ICONS = {
  index: ["home-outline", "home"],
  attendance: ["time-outline", "time"],
  tasks: ["checkbox-outline", "checkbox"],
  leave: ["calendar-outline", "calendar"],
  assets: ["cube-outline", "cube"],
  survey: ["map-outline", "map"],
  more: ["ellipsis-horizontal", "ellipsis-horizontal"],
} as const;

export default function TabsLayout() {
  const t = useTheme();
  const { ready, signedIn, user, canDo } = useAuth();
  // A fixed tab bar height is used as given, with no room added for the
  // system bar; edge to edge on Android 15 then draws the gesture bar over
  // the labels. The inset is added back here.
  const insets = useSafeAreaInsets();

  /*
   * The survey tab appears for the people who do survey work, not for
   * everyone who could.
   *
   * survey.enter is granted to the EMPLOYEE role, so gating on the permission
   * alone would put a Survey tab in front of every clerk in the company. Being
   * on the crew of a village is the fact that makes the tab worth its place,
   * and it is the same cached query the screen itself reads — no second
   * request. Offline before the list has ever loaded, the tab stays hidden;
   * anything already filed is in the outbox regardless.
   */
  const maySeeSurvey = canDo("survey.read");
  const mine = useQuery({
    queryKey: ["survey", "my-villages"],
    queryFn: getMyVillages,
    // Not asked at all without the right to the answer: a 403 on every cold
    // start is noise in the logs and a wasted round trip on a field handset.
    enabled: signedIn && maySeeSurvey,
    retry: false,
  });
  const showSurvey = maySeeSurvey && (mine.data?.villages.length ?? 0) > 0;

  if (!ready) return null;
  if (!signedIn) return <Redirect href="/(auth)/login" />;
  if (user?.mfa_enrollment_required) return <Redirect href="/(auth)/enroll" />;

  return (
    <Tabs
      screenOptions={({ route }) => ({
        // Each screen renders its own Title, so a native header would repeat it.
        headerShown: false,
        tabBarStyle: {
          backgroundColor: t.surface,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: t.border,
          height: 60 + insets.bottom,
          paddingTop: 6,
          paddingBottom: 8 + insets.bottom,
        },
        tabBarLabelStyle: { fontSize: font.xs, fontWeight: "600" },
        tabBarActiveTintColor: t.primary,
        tabBarInactiveTintColor: t.textSubtle,
        tabBarIcon: ({ focused, color, size }) => {
          const pair = ICONS[route.name as keyof typeof ICONS];
          return <Ionicons name={focused ? pair[1] : pair[0]} size={size - 2} color={color} />;
        },
      })}
    >
      <Tabs.Screen name="index" options={{ title: "Home" }} />
      <Tabs.Screen name="attendance" options={{ title: "Attendance" }} />
      <Tabs.Screen name="tasks" options={{ title: "Tasks" }} />
      <Tabs.Screen name="leave" options={{ title: "Leave" }} />
      <Tabs.Screen name="assets" options={{ title: "Assets" }} />
      <Tabs.Screen
        name="survey"
        options={{ title: "Survey", href: showSurvey ? undefined : null }}
      />
      <Tabs.Screen name="more" options={{ title: "More" }} />
    </Tabs>
  );
}
