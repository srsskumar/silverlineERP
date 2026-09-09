import {Payslip} from "../../src/ui/Payslip";
import {apiFetch} from "../../src/api/client";
import {registerDevice} from "../../src/device/registration";
/**
 * More: read-only profile, settings (biometric toggle), SyncQueue view,
 * notifications shortcut, sign out.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Pressable,
  ScrollView,
  Switch,
  Text,
  View,
} from "react-native";
import { useAuth } from "../../src/auth/AuthContext";
import { getEmployeesMe, getNotifications } from "../../src/api/endpoints";
import {
  getBiometricState,
  setBiometricEnabled,
  type BiometricState,
} from "../../src/device/auth";
import { registerForPushNotifications } from "../../src/device/push";
import { retryOp } from "../../src/sync/queue";
import { listPendingOps } from "../../src/sync/db";
import { useSyncEngine } from "../../src/sync/engine";
import { Card, Pill, useStyles } from "../../src/ui";

export default function MoreScreen() {
  const S=useStyles();
  const { user, roles, permissions, logout } = useAuth();
  const sync = useSyncEngine();
  const preferences=useQuery({queryKey:["notification-preferences"],queryFn:async()=>(await apiFetch<{notification_preferences:Record<string,boolean>}>("/api/v1/auth/preferences")).data});
  const [preferenceError,setPreferenceError]=useState("");
  async function setPreference(key:string,value:boolean){try{setPreferenceError("");await apiFetch("/api/v1/auth/preferences",{method:"PATCH",body:{[key]:value}});await preferences.refetch();}catch{setPreferenceError("Connect to the internet to update notification preferences.");}}
  const [bio, setBio] = useState<BiometricState | null>(null);
  const [pushToken, setPushToken] = useState<string | null>(null);

  const employee = useQuery({
    queryKey: ["employee", "me"],
    queryFn: getEmployeesMe,
  });
  const notifs = useQuery({
    queryKey: ["notifications"],
    queryFn: () => getNotifications(),
  });
  const [queue, setQueue] = useState<Awaited<ReturnType<typeof listPendingOps>>>([]);

  useEffect(() => {
    void getBiometricState().then(setBio).catch(() => undefined);
    void listPendingOps().then(setQueue).catch(() => setQueue([]));
  }, [sync.pending]);

  const toggleBio = async (v: boolean) => {
    try {
      await setBiometricEnabled(v);
      setBio(await getBiometricState());
    } catch {
      // enrolment cancelled — leave toggle as-is
    }
  };

  return (
    <ScrollView style={S.screen}>
      <Card title="Profile (read-only)">
        <Text style={S.body}>@{user?.username ?? "?"}</Text>
        <Text style={S.muted}>
          {String(
            employee.data?.full_name ?? employee.data?.name ?? "",
          )}
        </Text>
        <Text style={S.muted}>roles: {roles.join(", ") || "—"}</Text>

      </Card>

      <Payslip/>
      <Card title="Settings">
        <View style={S.row}>
          <Text style={[S.body, { flex: 1 }]}>Biometric unlock</Text>
          <Switch
            value={bio?.enabled ?? false}
            disabled={!bio?.hardware || !bio?.enrolled}
            onValueChange={(v) => void toggleBio(v)}
          />
        </View>
        {!bio?.hardware || !bio?.enrolled ? (
          <Text style={S.muted}>No enrolled biometrics on this device.</Text>
        ) : null}
        <Pressable
          style={S.btnGhost}
          onPress={() => {
            void registerForPushNotifications().then(async token=>{if(token){await registerDevice(token);setPushToken(token);}}).catch(()=>setPushToken(null));
          }}
        >
          <Text style={S.btnGhostText}>Enable push</Text>
        </Pressable>
        {pushToken ? (
          <Text style={S.muted}>registered ✓</Text>
        ) : null}
      </Card>

      <Card title="Notification preferences">{["push","sms","whatsapp"].map(key=><View style={S.row} key={key}><Text style={[S.body,{flex:1}]}>{key==='push'?'Push':key==='sms'?'SMS':'WhatsApp'}</Text><Switch value={preferences.data?.notification_preferences[key]??false} disabled={!preferences.data} onValueChange={v=>void setPreference(key,v)}/></View>)}<Text style={S.muted}>SMS and WhatsApp are available when your organization configures the service.</Text>{preferenceError?<Text style={S.muted}>{preferenceError}</Text>:null}</Card>

      <Card title={`Sync queue (${queue.length})`}>
        {queue.map((op) => (
          <View key={op.client_uuid} style={[S.row, { paddingVertical: 4 }]}>
            <Text style={[S.body, { flex: 1 }]} numberOfLines={1}>
              {op.entity} · {op.op}
            </Text>
            {op.state === 'FAILED' && !['CONFLICT','REJECTED'].includes(op.decision??'') ? <Pressable onPress={()=>void retryOp(op.client_uuid).then(()=>sync.syncNow())}><Text style={S.btnGhostText}>Retry</Text></Pressable> : null}
            <Pill
              text={op.state}
              tone={
                op.state === "SUCCEEDED"
                  ? "ok"
                  : op.state === "FAILED"
                    ? "bad"
                    : "warn"
              }
            />
          </View>
        ))}
        {queue.length === 0 ? (
          <Text style={S.muted}>Queue empty.</Text>
        ) : null}
        <Pressable style={S.btn} onPress={() => void sync.syncNow()}>
          <Text style={S.btnText}>Sync now</Text>
        </Pressable>
      </Card>

      <Card title={`Notifications (${notifs.data?.items.length ?? 0})`}>
        {(notifs.data?.items ?? []).slice(0, 10).map((n) => (
          <View key={n.id} style={{ marginBottom: 8 }}>
            <Text style={S.body} numberOfLines={2}>
              {String(n.title ?? n.type ?? n.id.slice(0, 8))}
            </Text>
            <Text style={S.muted}>
              {n.read_at ? "read" : "unread"} · {String(n.created_at ?? "")}
            </Text>
          </View>
        ))}
      </Card>

      <Pressable style={[S.btn, { backgroundColor: "#dc2626" }]} onPress={() => void logout()}>
        <Text style={S.btnText}>Sign out</Text>
      </Pressable>
      <View style={{ height: 24 }} />
    </ScrollView>
  );
}
