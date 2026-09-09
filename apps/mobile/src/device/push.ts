/**
 * Push registration + deep-link parsing via expo-notifications.
 *
 * PRIVACY ASSUMPTION: notification payloads carry NO PII — only
 * { type, entityType, entityId, title, body } (backend S5 emits usernames
 * only, never emails/phones). Deep links therefore never leak PII into OS
 * notification trays or link URLs.
 *
 * EXPO GO COMPAT: remote push was removed from Expo Go on Android in SDK 53+
 * — importing expo-notifications at module load THROWS there. Everything
 * below lazy-loads it inside try/catch: in Expo Go all functions degrade to
 * null/no-op (the in-app inbox still works), while dev builds and store
 * builds get full push. See https://docs.expo.dev/versions/v57.0.0/sdk/notifications/
 */

import { Platform } from "react-native";

type NotificationsModule = typeof import("expo-notifications");

let cached: NotificationsModule | null | undefined;
let handlerSet = false;

async function loadNotifications(): Promise<NotificationsModule | null> {
  if (cached !== undefined) return cached;
  try {
    // Dynamic import on purpose — static import crashes Expo Go (SDK 53+).
    cached = await import("expo-notifications");
    return cached;
  } catch {
    cached = null;
    return null;
  }
}

async function ensureHandler(
  Notifications: NotificationsModule,
): Promise<void> {
  if (handlerSet) return;
  handlerSet = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

/** True when remote push is available (dev/store build, not Expo Go). */
export async function isPushAvailable(): Promise<boolean> {
  return (await loadNotifications()) !== null;
}

export async function registerForPushNotifications(): Promise<string | null> {
  const Notifications = await loadNotifications();
  if (!Notifications) return null; // Expo Go: remote push unavailable.
  await ensureHandler(Notifications);
  const { status: existing } =
    await Notifications.getPermissionsAsync();
  const status =
    existing === "granted"
      ? existing
      : (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") return null;
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
  try {
    const token = await Notifications.getExpoPushTokenAsync();
    return token.data;
  } catch {
    return null;
  }
}

export interface DeepLink {
  /** expo-router path, e.g. "/(tabs)/tasks?taskId=…" */
  path: string;
  entityType: string;
  entityId: string;
}

/**
 * Map backend notification entity refs to in-app routes.
 * Known entityTypes: task | comment → tasks tab; leave → leave tab;
 * attendance/exception → attendance tab; anything else → home.
 */
export function parseDeepLink(
  entityType: string | undefined,
  entityId: string | undefined,
): DeepLink {
  const id = entityId ?? "";
  switch ((entityType ?? "").toLowerCase()) {
    case "task":
    case "comment":
      return {
        path: `/(tabs)/tasks${id ? `?taskId=${encodeURIComponent(id)}` : ""}`,
        entityType: entityType ?? "",
        entityId: id,
      };
    case "leave":
    case "leave_request":
      return { path: "/(tabs)/leave", entityType: entityType ?? "", entityId: id };
    case "attendance":
    case "attendance_exception":
    case "exception":
      return {
        path: "/(tabs)/attendance",
        entityType: entityType ?? "",
        entityId: id,
      };
    default:
      return { path: "/(tabs)", entityType: entityType ?? "", entityId: id };
  }
}
