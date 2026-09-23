/**
 * Attendance: punch in/out, with the punch position shown on a map.
 *
 * Silverline has no geo-fencing (decision 2026-09-22). The position is
 * captured and sent with the punch as evidence of where the day was worked;
 * it is never judged against a boundary, and the screen no longer says
 * "inside" or "outside" anything. The anti-fraud signals (mock location,
 * emulator, impossible travel) are unchanged and still advisory.
 *
 * Offline behaviour is unchanged: punches enqueue into pending_ops with a
 * client UUID and Idempotency-Key and flush on reconnect.
 */
import { withScreenBoundary } from "../../src/ui/ErrorBoundary";
import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Device from "expo-device";
import {
  getAttendanceRecords,
  getEmployeesMe,
  getMyVillages,
  type MyVillage,
} from "../../src/api/endpoints";
import {
  accuracyLabel,
  getPunchFix,
  isPoorAccuracy,
  type PunchFix,
} from "../../src/device/location";
import { loadLastFix, saveLastFix } from "../../src/device/lastFix";
import { buildPunchSignals } from "../../src/device/signals";
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
import { clock, day } from "@silverline/shared";

/**
 * Why a day's return could not be filed.
 *
 * Mirrors DELAY_REASONS in @silverline/shared, which this app deliberately
 * does not import (Metro workspace linking is deferred -- see src/rbac.ts).
 * Only the reasons that can apply to a whole day in the field are offered;
 * the full list belongs on the progress form, not the punch screen.
 */
const DEFER_REASONS = [
  { code: "DATA_TECHNICAL", label: "No signal or app problem" },
  { code: "EQUIPMENT", label: "Equipment problem" },
  { code: "FIELD_CONDITIONS", label: "Field conditions" },
  { code: "ACCESS", label: "Local or access issue" },
  { code: "OTHER", label: "Other" },
] as const;

function AttendanceScreen() {
  const t = useTheme();
  const [fix, setFix] = useState<PunchFix | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgTone, setMsgTone] = useState<"success" | "warning" | "danger">("success");
  const [busy, setBusy] = useState<"in" | "out" | "locating" | null>(null);
  /** The village this punch is for. Null on an office or training day. */
  const [village, setVillage] = useState<MyVillage | null>(null);
  /** Why the day's return cannot be filed, when it has not been. */
  const [deferReason, setDeferReason] = useState<string | null>(null);
  const [deferRemarks, setDeferRemarks] = useState("");
  const [excReason, setExcReason] = useState("");
  const [excMsg, setExcMsg] = useState<string | null>(null);
  const [signalNote, setSignalNote] = useState<string | null>(null);

  const history = useQuery({
    queryKey: ["attendance", "history"],
    queryFn: () => getAttendanceRecords({ limit: 20 }),
  });

  /**
   * The villages this person is crewed to, and what is outstanding on them.
   *
   * Read before the punch rather than after. Checking out of a field day asks
   * for the day's return, and the server refuses a live punch-out that has
   * neither the return nor a reason -- but punches go through the offline
   * queue, which cannot put that question to anybody. So the question is
   * asked here, while the person is still looking at the screen.
   *
   * A crew member with no survey work gets an empty list and sees none of
   * this; the punch card stays exactly as it was.
   */
  const myVillages = useQuery({
    queryKey: ["survey", "my-villages"],
    queryFn: getMyVillages,
    retry: false,
  });
  const villages = myVillages.data?.villages ?? [];

  /** Takes a fix up front so the map is live before punching. */
  const locate = useCallback(async () => {
    setBusy("locating");
    try {
      setFix(await getPunchFix());
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not get a location");
      setMsgTone("danger");
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void locate();
  }, [locate]);

  const punch = async (kind: "CHECK_IN" | "CHECK_OUT") => {
    setMsg(null);
    setSignalNote(null);

    /*
     * Ask about the day's return here, not at the server.
     *
     * The punch goes into the offline queue and may not reach the server for
     * hours, and the queue abandons an op the server rejects. A refusal that
     * arrives then is no use to anybody -- so the question is put while the
     * person can still answer it, and the punch is not sent until they have.
     */
    if (kind === "CHECK_OUT" && village && !village.filed_today && !deferReason) {
      setMsg(
        `No progress is recorded for ${village.village_name} today. `
        + "File it on the Survey tab, or say below why you cannot.",
      );
      setMsgTone("warning");
      return;
    }

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
        ...(village ? { survey_village_id: village.id } : {}),
        ...(kind === "CHECK_OUT" && village && !village.filed_today && deferReason
          ? {
              progress_deferred_reason: deferReason,
              ...(deferRemarks.trim() ? { progress_deferred_remarks: deferRemarks.trim() } : {}),
            }
          : {}),
      };
      setMsg(
        await submitQueued({
          entity: "attendance_event",
          op: `${kind.toLowerCase()}:${input.client_timestamp}`,
          payload: input,
        }),
      );
      setMsgTone(signals.review_suggested ? "warning" : "success");
      if (kind === "CHECK_OUT") {
        setDeferReason(null);
        setDeferRemarks("");
      }
      void history.refetch();
      void myVillages.refetch();
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
        right={fix ? <StatusDot text="Located" tone="success" /> : null}
      >
        <MapCanvas
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
          {fix?.mocked ? <Badge text="Mock location" tone="danger" /> : null}
        </Row>

        {poor ? (
          <Banner
            tone="warning"
            icon="warning-outline"
            title="Weak GPS signal"
            message="The punch is still accepted; its position will be recorded as approximate."
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
        {villages.length > 0 ? (
          <View style={{ marginBottom: space.md }}>
            <SectionLabel>What you are punching for</SectionLabel>
            <Row style={{ flexWrap: "wrap" }} gap={space.sm}>
              {villages.map(v => (
                <Button
                  key={v.id}
                  title={v.village_name}
                  variant={village?.id === v.id ? "primary" : "secondary"}
                  onPress={() => {
                    setVillage(village?.id === v.id ? null : v);
                    setDeferReason(null);
                    setMsg(null);
                  }}
                />
              ))}
              <Button
                title="Office day"
                variant={village === null ? "primary" : "secondary"}
                onPress={() => {
                  setVillage(null);
                  setDeferReason(null);
                  setMsg(null);
                }}
              />
            </Row>
            {village ? (
              <Row style={{ marginTop: space.sm, flexWrap: "wrap" }} gap={space.sm}>
                <Badge text={village.stage_label} tone="neutral" />
                <Muted>
                  {[village.mandal_name, village.district_name].filter(Boolean).join(", ")}
                </Muted>
                <StatusDot
                  text={village.filed_today ? "Return filed" : "Return not filed"}
                  tone={village.filed_today ? "success" : "warning"}
                />
              </Row>
            ) : null}
          </View>
        ) : null}

        {village && !village.filed_today ? (
          <View style={{ marginBottom: space.md }}>
            <Banner
              tone="warning"
              icon="document-text-outline"
              title="Today's return is not filed"
              message={`File the day's progress for ${village.village_name} before you check out. If you cannot, say why — it will be recorded.`}
            />
            <Row style={{ marginTop: space.sm, flexWrap: "wrap" }} gap={space.sm}>
              {DEFER_REASONS.map(r => (
                <Button
                  key={r.code}
                  title={r.label}
                  variant={deferReason === r.code ? "primary" : "secondary"}
                  onPress={() => {
                    setDeferReason(deferReason === r.code ? null : r.code);
                    setMsg(null);
                  }}
                />
              ))}
            </Row>
            {deferReason === "OTHER" ? (
              <Input
                label="What happened"
                value={deferRemarks}
                onChangeText={setDeferRemarks}
                placeholder="Say what stopped the return being filed"
                style={{ marginTop: space.sm }}
              />
            ) : null}
          </View>
        ) : null}

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
              title={r.work_date ? day(r.work_date) : r.id.slice(0, 8)}
              subtitle={r.check_in_at ? `In ${clock(r.check_in_at)}` : undefined}
              right={<Badge text={String(r.status ?? "?")} tone={statusTone(String(r.status ?? ""))} />}
              last={i === arr.length - 1}
            />
          ))
        )}
      </Card>

      <SectionLabel>Regularisation</SectionLabel>
      <Card>
        <Muted style={{ marginBottom: space.md }}>
          Missed a punch? Explain what happened and your manager will review it.
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
    </Screen>
  );
}

function statusTone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "PRESENT" || status === "APPROVED") return "success";
  if (status === "REVIEW" || status === "PENDING") return "warning";
  if (status === "ABSENT" || status === "REJECTED") return "danger";
  return "neutral";
}

// Contained per screen: a render error here shows the recovery card in the
// content area while the tab bar and navigation stay usable, instead of
// unmounting the navigator and dropping the user back on Home.
export default withScreenBoundary(AttendanceScreen);
