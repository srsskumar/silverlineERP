/**
 * Attendance: big CheckIn/Out + accuracy readout + history + exception form.
 * Offline: punches enqueue into pending_ops with client UUID + Idempotency-Key
 * and flush on reconnect (202 REVIEW outcomes surface inline).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Device from "expo-device";
import { ApiError } from "../../src/api/client";
import {
  getAttendanceRecords,
  getEmployeesMe,
  postAttendanceEvent,
} from "../../src/api/endpoints";
import {
  accuracyLabel,
  getPunchFix,
  isPoorAccuracy,
  type PunchFix,
} from "../../src/device/location";
import { enqueueOp } from "../../src/sync/queue";
import { syncNow, submitQueued } from "../../src/sync/engine";
import { validateAttendanceException } from "../../src/validators";
import { Card, Pill, useStyles } from "../../src/ui";

export default function AttendanceScreen() {
  const S=useStyles();
  const [fix, setFix] = useState<PunchFix | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<"in" | "out" | null>(null);
  const [excReason, setExcReason] = useState("");
  const [excMsg, setExcMsg] = useState<string | null>(null);

  const history = useQuery({
    queryKey: ["attendance", "history"],
    queryFn: () => getAttendanceRecords({ limit: 20 }),
  });

  const punch = async (kind: "CHECK_IN" | "CHECK_OUT") => {
    setMsg(null);
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
      };
      setMsg(await submitQueued({entity: 'attendance_event', op: `${kind.toLowerCase()}:${input.client_timestamp}`, payload: input}));
      void history.refetch();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Punch failed");
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
      setExcMsg(await submitQueued({entity:'attendance_exception',op:`regularize:${Date.now()}`,payload:{employee_id:emp.id,exception_type:'REGULARIZATION',reason:excReason.trim()}}));
      setExcReason('');
    } catch (e) {
      setExcMsg(e instanceof Error ? e.message : "Submit failed");
    }
  };

  return (
    <ScrollView style={S.screen}>
      <Card title="Punch">
        <Text style={S.muted}>GPS: {accuracyLabel(fix)}</Text>
        {fix && isPoorAccuracy(fix) ? (
          <Text style={S.error}>
            Poor accuracy — the server will likely queue this for review.
          </Text>
        ) : null}
        <View style={{ height: 8 }} />
        <View style={S.row}>
          <Pressable
            style={[S.btn, { flex: 1 }]}
            onPress={() => void punch("CHECK_IN")}
            disabled={busy !== null}
          >
            <Text style={S.btnText}>
              {busy === "in" ? "…" : "Check In"}
            </Text>
          </Pressable>
          <Pressable
            style={[S.btnGhost, { flex: 1, marginTop: 10 }]}
            onPress={() => void punch("CHECK_OUT")}
            disabled={busy !== null}
          >
            <Text style={S.btnGhostText}>
              {busy === "out" ? "…" : "Check Out"}
            </Text>
          </Pressable>
        </View>
        {msg ? <Text style={S.muted}>{msg}</Text> : null}
      </Card>

      <Card title="History">
        {(history.data ?? []).map((r) => (
          <View key={r.id} style={[S.row, { paddingVertical: 5 }]}>
            <Text style={[S.body, { flex: 1 }]}>
              {(r.work_date as string) ?? r.id.slice(0, 8)}
            </Text>
            <Pill text={String(r.status ?? "?")} tone="info" />
          </View>
        ))}
        {history.isLoading ? <Text style={S.muted}>Loading…</Text> : null}
      </Card>

      <Card title="File exception / regularization">
        <TextInput
          style={S.input}
          placeholder="Reason (required)"
          multiline
          value={excReason}
          onChangeText={setExcReason}
        />
        <Pressable style={S.btn} onPress={() => void fileException()}>
          <Text style={S.btnText}>Submit</Text>
        </Pressable>
        {excMsg ? <Text style={S.muted}>{excMsg}</Text> : null}
      </Card>
    </ScrollView>
  );
}
