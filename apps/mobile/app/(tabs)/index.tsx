/**
 * Home: sync state, today's attendance, and the user's open work.
 *
 * Ordered by what a field user opens the app to find out, in order: is my work
 * saved, am I punched in, what am I doing today.
 */
import { withScreenBoundary } from "../../src/ui/ErrorBoundary";
import { useQuery } from "@tanstack/react-query";
import { View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/auth/AuthContext";
import { getAttendanceRecords, getTasks } from "../../src/api/endpoints";
import { useSyncEngine } from "../../src/sync/engine";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ListRow,
  Loading,
  Muted,
  Row,
  Screen,
  SectionLabel,
  StatTile,
  StatusDot,
  Subtle,
  Title,
} from "../../src/ui/primitives";
import { space, useTheme } from "../../src/theme";

function HomeScreen() {
  const t = useTheme();
  const sync = useSyncEngine();
  const { user } = useAuth();
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: user?.timezone ?? "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const attendance = useQuery({
    queryKey: ["attendance", "today"],
    queryFn: () => getAttendanceRecords({ from: today, to: today, limit: 5 }),
  });
  const work = useQuery({
    queryKey: ["tasks", "mine"],
    queryFn: () => getTasks({ assignee_me: true, limit: 20 }),
  });

  const todayStatus = attendance.data?.[0]?.status ?? null;
  const tasks = work.data?.items ?? [];
  const overdue = tasks.filter(
    (x) =>
      typeof x.due_date === "string" &&
      x.due_date < today &&
      !["DONE", "CANCELLED"].includes(String(x.status)),
  ).length;

  const syncTone =
    sync.status === "offline" ? "danger" : sync.pending > 0 ? "warning" : "success";
  const syncText =
    sync.status === "syncing"
      ? "Syncing…"
      : sync.status === "offline"
        ? "Offline"
        : sync.pending > 0
          ? `${sync.pending} waiting to send`
          : "All work saved";

  return (
    <Screen>
      <Title>{greeting()}</Title>
      <Muted style={{ marginTop: 2, marginBottom: space.lg }}>
        {user?.username ? `Signed in as ${user.username}` : "Your day at a glance"}
      </Muted>

      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Row gap={space.sm}>
            <Ionicons
              name={
                sync.status === "offline"
                  ? "cloud-offline-outline"
                  : sync.pending > 0
                    ? "cloud-upload-outline"
                    : "cloud-done-outline"
              }
              size={18}
              color={
                syncTone === "danger" ? t.danger : syncTone === "warning" ? t.warning : t.success
              }
            />
            <StatusDot text={syncText} tone={syncTone} />
          </Row>
          <Button
            title="Sync now"
            variant="ghost"
            onPress={() => void sync.syncNow()}
            loading={sync.status === "syncing"}
          />
        </Row>
        {sync.status === "offline" ? (
          <Subtle style={{ marginTop: space.sm }}>
            Punches and updates are saved on this device and sent when you are back online.
          </Subtle>
        ) : null}
      </Card>

      <Row gap={space.md} style={{ marginBottom: space.md }}>
        <StatTile
          label="Today"
          value={todayStatus ? String(todayStatus) : attendance.isLoading ? "…" : "Not in"}
          tone={todayStatus ? "success" : "neutral"}
          icon="time-outline"
        />
        <StatTile
          label="Open tasks"
          value={work.isLoading ? "…" : tasks.length}
          icon="checkbox-outline"
        />
      </Row>

      {overdue > 0 ? (
        <Row gap={space.md} style={{ marginBottom: space.md }}>
          <StatTile label="Overdue" value={overdue} tone="danger" icon="alert-circle-outline" />
          <View style={{ flex: 1 }} />
        </Row>
      ) : null}

      {!todayStatus && !attendance.isLoading ? (
        <Card>
          <Row style={{ justifyContent: "space-between" }}>
            <View style={{ flex: 1 }}>
              <Muted>You have not checked in today.</Muted>
            </View>
            <Button
              title="Check in"
              icon="log-in-outline"
              onPress={() => router.push("/(tabs)/attendance")}
            />
          </Row>
        </Card>
      ) : null}

      <SectionLabel>My work</SectionLabel>
      <Card>
        {work.isLoading ? (
          <Loading />
        ) : work.isError ? (
          <EmptyState
            icon="cloud-offline-outline"
            title="Could not load tasks"
            message="You may be offline. Cached work still shows on the Tasks tab."
          />
        ) : tasks.length === 0 ? (
          <EmptyState
            icon="checkmark-done-outline"
            title="Nothing assigned"
            message="Tasks assigned to you will show up here."
          />
        ) : (
          tasks.slice(0, 20).map((task, i, arr) => (
            <ListRow
              key={task.id}
              title={task.title}
              subtitle={typeof task.due_date === "string" ? `Due ${task.due_date}` : undefined}
              right={<Badge text={String(task.status)} tone={taskTone(String(task.status))} />}
              onPress={() => router.push(`/(tabs)/tasks?taskId=${task.id}`)}
              last={i === arr.length - 1}
            />
          ))
        )}
      </Card>
    </Screen>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function taskTone(status: string): "success" | "warning" | "info" | "neutral" {
  if (status === "DONE") return "success";
  if (status === "BLOCKED") return "warning";
  if (status === "IN_PROGRESS" || status === "IN_REVIEW") return "info";
  return "neutral";
}

// Contained per screen: a render error here shows the recovery card in the
// content area while the tab bar and navigation stay usable, instead of
// unmounting the navigator and dropping the user back on Home.
export default withScreenBoundary(HomeScreen);
