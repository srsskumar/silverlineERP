import {useAuth} from "../../src/auth/AuthContext";
/**
 * Home: today-attendance chip + My Work (≤20) + sync pill.
 */
import { useQuery } from "@tanstack/react-query";
import { Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import {
  getAttendanceRecords,
  getTasks,
} from "../../src/api/endpoints";
import { useSyncEngine } from "../../src/sync/engine";
import { Card, Pill, useStyles } from "../../src/ui";

export default function HomeScreen() {
  const S=useStyles();
  const sync = useSyncEngine();
  const {user}=useAuth();
  const today = new Intl.DateTimeFormat('en-CA',{timeZone:user?.timezone??'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());

  const attendance = useQuery({
    queryKey: ["attendance", "today"],
    queryFn: () => getAttendanceRecords({ from: today, to: today, limit: 5 }),
  });
  const work = useQuery({
    queryKey: ["tasks", "mine"],
    queryFn: () => getTasks({ assignee_me: true, limit: 20 }),
  });

  const todayStatus =
    attendance.data?.[0]?.status ?? (attendance.isLoading ? "…" : "not punched");

  return (
    <ScrollView style={S.screen}>
      <Pressable onPress={() => void sync.syncNow()}>
        <Card title="Sync">
          <View style={S.row}>
            <Pill
              text={
                sync.status === "syncing"
                  ? "syncing…"
                  : sync.status === "offline"
                    ? "offline"
                    : sync.pending > 0
                      ? `${sync.pending} pending`
                      : "up to date"
              }
              tone={
                sync.status === "offline"
                  ? "bad"
                  : sync.pending > 0
                    ? "warn"
                    : "ok"
              }
            />
            <Text style={S.muted}>tap to Sync now</Text>
          </View>
        </Card>
      </Pressable>

      <Card title="Today">
        <Pill text={String(todayStatus)} tone="info" />
      </Card>

      <Card title={`My Work (${work.data?.items.length ?? 0})`}>
        {(work.data?.items ?? []).slice(0, 20).map((t) => (
          <Pressable
            key={t.id}
            onPress={() => router.push(`/(tabs)/tasks?taskId=${t.id}`)}
          >
            <View style={[S.row, { paddingVertical: 6 }]}>
              <Text style={[S.body, { flex: 1 }]} numberOfLines={1}>
                {t.title}
              </Text>
              <Text style={S.muted}>{t.status}</Text>
            </View>
          </Pressable>
        ))}
        {work.isLoading ? <Text style={S.muted}>Loading…</Text> : null}
        {work.isError ? (
          <Text style={S.error}>Couldn&apos;t load tasks (offline?)</Text>
        ) : null}
      </Card>
    </ScrollView>
  );
}
