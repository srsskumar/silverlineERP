/**
 * Attendance: punch in/out with live geo-fence context.
 *
 * The screen now answers the field user's actual question before they act —
 * "am I at the site?" — by drawing the fences around them and naming the one
 * they are standing in. Previously the only feedback was the server's verdict
 * after the punch had already been queued.
 *
 * Offline behaviour is unchanged: punches enqueue into pending_ops with a
 * client UUID and Idempotency-Key and flush on reconnect. Fences are cached, so
 * the map and the containment check still work without signal.
 */
import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Device from "expo-device";
import {
  getAttendanceRecords,
  getEmployeesMe,
} from "../../src/api/endpoints";
import {
  accuracyLabel,
  getPunchFix,
  isPoorAccuracy,
  type PunchFix,
} from "../../src/device/location";
import { loadLastFix, saveLastFix } from "../../src/device/lastFix";
import { buildPunchSignals } from "../../src/device/signals";
import { useFences } from "../../src/device/useFences";
import { requestBackgroundPermission } from "../../src/device/geofencing";
import { submitQueued } from "../../src/sync/engine";
import { validateAttendanceException } from "../../src/validators";
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Input,
  ListRow,
  Loading,
  Muted,
  Row,
  Screen,
  SectionLabel,
  StatusDot,
  Subtle,
  Title,
} from "../../src/ui/primitives";
import { MapCanvas } from "../../src/ui/MapCanvas";
import { space, useTheme } from "../../src/theme";

export default function AttendanceScreen() {
  const t = useTheme();
  const [fix, setFix] = useState<PunchFix | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgTone, setMsgTone] = useState<"success" | "warning" | "danger">("success");
  const [busy, setBusy] = useState<"in" | "out" | "locating" | null>(null);
  const [excReason, setExcReason] = useState("");
  const [excMsg, setExcMsg] = useState<string | null>(null);
  const [signalNote, setSignalNote] = useState<string | null>(null);

  const {
    fences,
    currentFence,
    monitored,
    backgroundGranted,
    refreshBackgroundPermission,
    refreshFences,
    isLoading: fencesLoading,
  } = useFences(fix);

  const history = useQuery({
    queryKey: ["attendance", "history"],
    queryFn: () => getAttendanceRecords({ limit: 20 }),
  });

  /** Takes a fix up front so the map and fence badge are live before punching. */
  const locate = useCallback(async () => {
    setBusy("locating");
    try {
      const [nextFix] = await Promise.all([getPunchFix(), refreshFences()]);
      setFix(nextFix);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not get a location");
      setMsgTone("danger");
    } finally {
      setBusy(null);
    }
  }, [refreshFences]);

  useEffect(() => {
    void locate();
  }, [locate]);

  const punch = async (kind: "CHECK_IN" | "CHECK_OUT") => {
    setMsg(null);
    setSignalNote(null);
    setBusy(kind === "CHECK_IN" ? "in" : "out");
    try {
      let employeeId: string;
      try {
        const emp = await getEmployeesMe();
        employeeId = emp.id;
      } catch {
        throw new Error("No employee linked to this user");
      }
      const fx = await getPunchFix();
      setFix(fx);

      // Anti-fraud signals are advisory and never block the punch here — the
      // server scores them and decides whether to raise a review.
      const previous = await loadLastFix();
      const signals = buildPunchSignals(previous, fx);
      await saveLastFix(fx);
      if (signals.review_suggested) {
        setSignalNote(
          signals.movement?.impossible_travel
            ? "This position is far from your last punch for the time elapsed. It will be flagged for review."
            : signals.device.suspected_emulator
              ? "This device looks like an emulator. The punch will be flagged for review."
              : "Mock location is enabled. The punch will be flagged for review.",
        );
      }

      const input = {
        employee_id: employeeId,
        event_type: kind,
        client_timestamp: new Date().toISOString(),
        latitude: fx.latitude,
        longitude: fx.longitude,
        gps_accuracy: fx.accuracy ?? undefined,
        mock_location: fx.mocked,
        device_id: Device.modelName ?? undefined,
        app_version: "mobile/1.0.0",
        device_signals: signals,
      };
      setMsg(
        await submitQueued({
          entity: "attendance_event",
          op: `${kind.toLowerCase()}:${input.client_timestamp}`,
          payload: input,
        }),
      );
      setMsgTone(signals.review_suggested ? "warning" : "success");
      void history.refetch();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Punch failed");
      setMsgTone("danger");
    } finally {
      setBusy(null);
    }
  };

  const fileException = async () => {
    setExcMsg(null);
    try {
      const emp = await getEmployeesMe();
      const v = validateAttendanceException({
        employee_id: emp.id,
        exception_type: "REGULARIZATION",
        reason: excReason,
      });
      if (!v.ok) {
        setExcMsg(v.errors.map((e) => e.message).join("; "));
        return;
      }
      setExcMsg(
        await submitQueued({
          entity: "attendance_exception",
          op: `regularize:${Date.now()}`,
          payload: {
            employee_id: emp.id,
            exception_type: "REGULARIZATION",
            reason: excReason.trim(),
          },
        }),
      );
      setExcReason("");
    } catch (e) {
      setExcMsg(e instanceof Error ? e.message : "Submit failed");
    }
  };

  const poor = fix ? isPoorAccuracy(fix) : false;
  const busyPunching = busy === "in" || busy === "out";

  return (
    <Screen>
      <Title>Attendance</Title>
      <Muted style={{ marginTop: 2, marginBottom: space.lg }}>
        Punch in and out at your assigned site.
      </Muted>

      <Card
        title="Where you are"
        right={
          currentFence ? (
            <StatusDot text="Inside fence" tone="success" />
          ) : fix && fences.length === 0 ? (
            <StatusDot text="No fence assigned" tone="neutral" />
          ) : fix ? (
            <StatusDot text="Outside fence" tone="warning" />
          ) : null
        }
      >
        <MapCanvas
          fences={fences}
          activeFenceId={currentFence?.id ?? null}
          center={fix ? { latitude: fix.latitude, longitude: fix.longitude } : null}
          points={
            fix
              ? [{ id: "me", latitude: fix.latitude, longitude: fix.longitude, title: "You" }]
              : []
          }
          height={220}
        />

        <Row style={{ marginTop: space.md, flexWrap: "wrap" }} gap={space.sm}>
          <Ionicons name="locate-outline" size={15} color={t.textSubtle} />
          <Muted>{accuracyLabel(fix)}</Muted>
          {currentFence ? <Badge text={currentFence.name} tone="success" /> : null}
          {fix?.mocked ? <Badge text="Mock location" tone="danger" /> : null}
        </Row>

        {poor ? (
          <Banner
            tone="warning"
            icon="warning-outline"
            title="Weak GPS signal"
            message="Move into the open before punching, or this will be queued for review."
          />
        ) : null}

        {!currentFence && fix && fences.length > 0 ? (
          <Banner
            tone="warning"
            icon="navigate-circle-outline"
            title="You are not inside a work site"
            message="You can still punch — it will be recorded as an outside-fence exception."
          />
        ) : null}

        <Button
          title="Refresh location"
          variant="secondary"
          icon="refresh-outline"
          loading={busy === "locating"}
          onPress={() => void locate()}
          style={{ marginTop: space.sm }}
        />
      </Card>

      <Card title="Punch">
        <Row gap={space.md}>
          <Button
            title="Check in"
            icon="log-in-outline"
            tone="success"
            loading={busy === "in"}
            disabled={busyPunching}
            onPress={() => void punch("CHECK_IN")}
            style={{ flex: 1 }}
          />
          <Button
            title="Check out"
            icon="log-out-outline"
            variant="secondary"
            loading={busy === "out"}
            disabled={busyPunching}
            onPress={() => void punch("CHECK_OUT")}
            style={{ flex: 1 }}
          />
        </Row>
        {signalNote ? (
          <View style={{ marginTop: space.md }}>
            <Banner tone="warning" icon="shield-outline" title="Flagged for review" message={signalNote} />
          </View>
        ) : null}
        {msg ? (
          <View style={{ marginTop: space.md }}>
            <Banner
              tone={msgTone === "success" ? "success" : msgTone}
              icon={msgTone === "success" ? "checkmark-circle-outline" : "alert-circle-outline"}
              title={msg}
            />
          </View>
        ) : null}
      </Card>

      {backgroundGranted === false ? (
        <Card title="Site alerts">
          <Muted>
            Allow location “Always” and Silverline will confirm arrivals and departures
            without you opening the app.
          </Muted>
          <Button
            title="Allow background location"
            variant="secondary"
            icon="notifications-outline"
            style={{ marginTop: space.md }}
            onPress={() => {
              void requestBackgroundPermission().then(() => refreshBackgroundPermission());
            }}
          />
        </Card>
      ) : monitored.length > 0 ? (
        <Card>
          <Row gap={space.sm}>
            <Ionicons name="shield-checkmark-outline" size={16} color={t.success} />
            <Muted>
              Watching {monitored.length} nearby {monitored.length === 1 ? "site" : "sites"} in the
              background
            </Muted>
          </Row>
        </Card>
      ) : null}

      <SectionLabel>Recent punches</SectionLabel>
      <Card>
        {history.isLoading ? (
          <Loading />
        ) : (history.data ?? []).length === 0 ? (
          <EmptyState
            icon="time-outline"
            title="No punches yet"
            message="Your attendance history will appear here once you check in."
          />
        ) : (
          (history.data ?? []).map((r, i, arr) => (
            <ListRow
              key={r.id}
              title={(r.work_date as string) ?? r.id.slice(0, 8)}
              subtitle={r.check_in_at ? `In ${String(r.check_in_at).slice(11, 16)}` : undefined}
              right={<Badge text={String(r.status ?? "?")} tone={statusTone(String(r.status ?? ""))} />}
              last={i === arr.length - 1}
            />
          ))
        )}
      </Card>

      <SectionLabel>Regularisation</SectionLabel>
      <Card>
        <Muted style={{ marginBottom: space.md }}>
          Missed a punch or were outside the fence? Explain what happened and your manager
          will review it.
        </Muted>
        <Input
          placeholder="Reason (required)"
          multiline
          value={excReason}
          onChangeText={setExcReason}
          style={{ minHeight: 88, paddingTop: space.md, textAlignVertical: "top" }}
        />
        <Button
          title="Submit for review"
          icon="send-outline"
          disabled={excReason.trim().length === 0}
          onPress={() => void fileException()}
        />
        {excMsg ? <Subtle style={{ marginTop: space.sm }}>{excMsg}</Subtle> : null}
      </Card>

      {fencesLoading ? <Subtle>Loading sites…</Subtle> : null}
    </Screen>
  );
}

function statusTone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "PRESENT" || status === "APPROVED") return "success";
  if (status === "REVIEW" || status === "PENDING") return "warning";
  if (status === "ABSENT" || status === "REJECTED") return "danger";
  return "neutral";
}
