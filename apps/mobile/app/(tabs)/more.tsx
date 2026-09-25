/**
 * More: read-only profile, security settings, notification preferences,
 * the sync queue, notifications and sign-out.
 */
import { withScreenBoundary } from "../../src/ui/ErrorBoundary";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Switch, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Payslip } from "../../src/ui/Payslip";
import { apiFetch } from "../../src/api/client";
import { registerDevice } from "../../src/device/registration";
import { useAuth } from "../../src/auth/AuthContext";
import { getEmployeesMe, getNotifications } from "../../src/api/endpoints";
import { buildModuleLauncher } from "../../src/modulesLauncher";
import {
  getBiometricState,
  setBiometricEnabled,
  type BiometricState,
} from "../../src/device/auth";
import { registerForPushNotifications } from "../../src/device/push";
import { discardOp, listOps, retryOp } from "../../src/sync/queue";
import { reviewLink } from "../../src/survey/reviewLink";
import { useSyncEngine } from "../../src/sync/engine";
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  ListRow,
  Muted,
  Row,
  Screen,
  SectionLabel,
  Subtle,
  Title,
} from "../../src/ui/primitives";
import { radius, space, useTheme } from "../../src/theme";
import { dayTime, MODULE_CATALOG } from "@silverline/shared";

const CHANNELS = [
  { key: "push", label: "Push" },
  { key: "sms", label: "SMS" },
  { key: "whatsapp", label: "WhatsApp" },
] as const;

function MoreScreen() {
  const t = useTheme();
  const { user, roles, logout, modules } = useAuth();
  const sync = useSyncEngine();

  // Every other catalog module this user's roles show as visible — the four
  // built this round route to their real screens, everything else opens a
  // plain "coming soon" placeholder. See src/modulesLauncher.ts.
  const launcherGroups = buildModuleLauncher(MODULE_CATALOG, modules);

  const preferences = useQuery({
    queryKey: ["notification-preferences"],
    queryFn: async () =>
      (
        await apiFetch<{ notification_preferences: Record<string, boolean> }>(
          "/api/v1/auth/preferences",
        )
      ).data,
  });
  const [preferenceError, setPreferenceError] = useState("");
  const [bio, setBio] = useState<BiometricState | null>(null);
  const [pushToken, setPushToken] = useState<string | null>(null);

  const employee = useQuery({ queryKey: ["employee", "me"], queryFn: getEmployeesMe });
  const notifs = useQuery({ queryKey: ["notifications"], queryFn: () => getNotifications() });
  const [queue, setQueue] = useState<Awaited<ReturnType<typeof listOps>>>([]);

  useEffect(() => {
    void getBiometricState().then(setBio).catch(() => undefined);
    void listOps().then(setQueue).catch(() => setQueue([]));
  }, [sync.pending]);

  async function setPreference(key: string, value: boolean) {
    try {
      setPreferenceError("");
      await apiFetch("/api/v1/auth/preferences", { method: "PATCH", body: { [key]: value } });
      await preferences.refetch();
    } catch {
      setPreferenceError("Connect to the internet to update notification preferences.");
    }
  }

  // A refused operation cannot be retried as it stands, so the only way out is
  // to drop it. The server's reason is on the row; discarding is final, so ask.
  const confirmDiscard = (op: (typeof queue)[number]) => {
    Alert.alert(
      "Discard this change?",
      `The server did not accept this ${op.entity.replaceAll("_", " ")}` +
        `${op.error ? ` (${op.error})` : ""}. Discarding removes it from this ` +
        "device; it will not be sent. Make the change again if it is still needed.",
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            void discardOp(op.client_uuid)
              .then(() => listOps())
              .then(setQueue)
              .catch(() => undefined);
          },
        },
      ],
    );
  };

  const toggleBio = async (v: boolean) => {
    try {
      await setBiometricEnabled(v);
      setBio(await getBiometricState());
    } catch {
      // Enrolment cancelled — leave the toggle as it was.
    }
  };

  const displayName = String(employee.data?.full_name ?? employee.data?.name ?? "");
  const initials = (displayName || user?.username || "?").slice(0, 2).toUpperCase();
  const biometricsAvailable = Boolean(bio?.hardware && bio?.enrolled);

  return (
    <Screen>
      <Title>More</Title>
      <Muted style={{ marginTop: 2, marginBottom: space.lg }}>
        Every module your roles can see, plus your profile and device settings.
      </Muted>

      {launcherGroups.map((group) => (
        <View key={group.title}>
          <SectionLabel>{group.title}</SectionLabel>
          <Card>
            {group.items.map((item, i, arr) => (
              <ListRow
                key={item.code}
                title={item.label}
                right={item.comingSoon ? <Badge text="SOON" tone="neutral" /> : undefined}
                onPress={() => router.push(item.route)}
                last={i === arr.length - 1}
              />
            ))}
          </Card>
        </View>
      ))}

      <SectionLabel>Account</SectionLabel>
      <Card>
        <Row gap={space.md}>
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: radius.pill,
              backgroundColor: t.primarySubtle,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Muted style={{ color: t.primary, fontWeight: "700" }}>{initials}</Muted>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Muted style={{ color: t.text, fontWeight: "600" }}>
              {displayName || `@${user?.username ?? "?"}`}
            </Muted>
            <Subtle>@{user?.username ?? "?"}</Subtle>
          </View>
        </Row>
        <Row gap={space.xs} style={{ marginTop: space.md, flexWrap: "wrap" }}>
          {roles.length > 0 ? (
            roles.map((r) => <Badge key={r} text={r} tone="info" />)
          ) : (
            <Subtle>No roles assigned</Subtle>
          )}
        </Row>
        <Subtle style={{ marginTop: space.sm }}>
          Profile details are managed by HR and are read-only here.
        </Subtle>
      </Card>

      <Payslip />

      <SectionLabel>Security</SectionLabel>
      <Card>
        <Row style={{ justifyContent: "space-between", minHeight: 32 }}>
          <View style={{ flex: 1 }}>
            <Muted style={{ color: t.text }}>Biometric unlock</Muted>
            {!biometricsAvailable ? (
              <Subtle>No enrolled biometrics on this device</Subtle>
            ) : null}
          </View>
          <Switch
            value={bio?.enabled ?? false}
            disabled={!biometricsAvailable}
            trackColor={{ true: t.primary, false: t.border }}
            onValueChange={(v) => void toggleBio(v)}
          />
        </Row>
      </Card>

      <SectionLabel>Notifications</SectionLabel>
      <Card>
        {CHANNELS.map(({ key, label }) => (
          <Row key={key} style={{ justifyContent: "space-between", minHeight: 40 }}>
            <Muted style={{ color: t.text, flex: 1 }}>{label}</Muted>
            <Switch
              value={preferences.data?.notification_preferences[key] ?? false}
              disabled={!preferences.data}
              trackColor={{ true: t.primary, false: t.border }}
              onValueChange={(v) => void setPreference(key, v)}
            />
          </Row>
        ))}
        <Subtle style={{ marginTop: space.sm }}>
          SMS and WhatsApp work once your organisation configures the service.
        </Subtle>
        {preferenceError ? (
          <View style={{ marginTop: space.md }}>
            <Banner tone="warning" icon="cloud-offline-outline" title={preferenceError} />
          </View>
        ) : null}
        <Button
          title={pushToken ? "Push registered" : "Enable push on this device"}
          variant="secondary"
          icon={pushToken ? "checkmark-circle-outline" : "notifications-outline"}
          disabled={Boolean(pushToken)}
          style={{ marginTop: space.md }}
          onPress={() => {
            void registerForPushNotifications()
              .then(async (token) => {
                if (token) {
                  await registerDevice(token);
                  setPushToken(token);
                }
              })
              .catch(() => setPushToken(null));
          }}
        />
      </Card>

      <SectionLabel>Sync queue ({queue.length})</SectionLabel>
      <Card>
        {queue.length === 0 ? (
          <EmptyState
            icon="cloud-done-outline"
            title="Everything is sent"
            message="Work you do offline appears here until it reaches the server."
          />
        ) : (
          queue.map((op, i, arr) => (
            <ListRow
              key={op.client_uuid}
              title={op.entity.replaceAll("_", " ")}
              // A delivered row with text on it is one the server holds for
              // review, and the text is its reason -- shown, so a punch the
              // queue replayed after the signal came back still tells the
              // person why a supervisor will be asking about it.
              subtitle={(op.state === "FAILED" || op.state === "SUCCEEDED") && op.error ? `${op.op} · ${op.error}` : op.op}
              right={
                <Row gap={space.sm}>
                  {op.state === "FAILED" &&
                  !["CONFLICT", "REJECTED"].includes(op.decision ?? "") ? (
                    <Button
                      title="Retry"
                      variant="ghost"
                      onPress={() => void retryOp(op.client_uuid).then(() => sync.syncNow())}
                    />
                  ) : null}
                  {op.state === "FAILED" && op.decision === "CONFLICT"
                  && op.entity === "survey_entry" ? (
                    // Fix round 2: reopen the queued return on its village,
                    // against the day as it stands now, and re-submit.
                    <Button
                      title="Review"
                      variant="ghost"
                      onPress={() => router.push(reviewLink(op.client_uuid))}
                    />
                  ) : null}
                  {op.state === "FAILED" &&
                  ["CONFLICT", "REJECTED"].includes(op.decision ?? "") ? (
                    <Button
                      title="Discard"
                      variant="ghost"
                      tone="danger"
                      onPress={() => confirmDiscard(op)}
                    />
                  ) : null}
                  <Badge
                    text={op.state === "SUCCEEDED" && op.decision === "REVIEW" ? "REVIEW" : op.state}
                    tone={
                      op.state === "SUCCEEDED"
                        ? op.decision === "REVIEW" ? "warning" : "success"
                        : op.state === "FAILED"
                          ? "danger"
                          : "warning"
                    }
                  />
                </Row>
              }
              last={i === arr.length - 1}
            />
          ))
        )}
        <Button
          title="Sync now"
          icon="sync-outline"
          variant="secondary"
          loading={sync.status === "syncing"}
          style={{ marginTop: space.md }}
          onPress={() => void sync.syncNow()}
        />
      </Card>

      <SectionLabel>Recent notifications</SectionLabel>
      <Card>
        {(notifs.data?.items ?? []).length === 0 ? (
          <EmptyState icon="notifications-off-outline" title="Nothing yet" />
        ) : (
          (notifs.data?.items ?? []).slice(0, 10).map((n, i, arr) => (
            <ListRow
              key={n.id}
              title={String(n.title ?? n.type ?? n.id.slice(0, 8))}
              subtitle={dayTime(n.created_at)}
              right={
                n.read_at ? null : (
                  <View
                    style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: t.primary }}
                  />
                )
              }
              last={i === arr.length - 1}
            />
          ))
        )}
      </Card>

      <Button
        title="Sign out"
        variant="secondary"
        tone="danger"
        icon="log-out-outline"
        onPress={() => void logout()}
        style={{ marginTop: space.lg }}
      />
      <View style={{ height: space.xl }} />
    </Screen>
  );
}

// Contained per screen: a render error here shows the recovery card in the
// content area while the tab bar and navigation stay usable, instead of
// unmounting the navigator and dropping the user back on Home.
export default withScreenBoundary(MoreScreen);
