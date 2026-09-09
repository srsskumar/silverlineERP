import { submitQueued } from "../../src/sync/engine";
/**
 * Leave: balances + request form + approvals inbox (gated by leave.decide /
 * leave.admin / leave.manage — others see their own requests only).
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
import { ApiError } from "../../src/api/client";
import {
  getLeaveBalances,
  getLeaveRequests,
  getLeaveTypes,
  postLeaveDecision,
  postLeaveRequest,
} from "../../src/api/endpoints";
import { useAuth } from "../../src/auth/AuthContext";
import { LEAVE_APPROVER_PERMISSIONS, canAny } from "../../src/rbac";
import { enqueueOp } from "../../src/sync/queue";
import { validateLeaveRequest } from "../../src/validators";
import { Card, Pill, useStyles } from "../../src/ui";

export default function LeaveScreen() {
  const S=useStyles();
  const { permissions } = useAuth();
  const isApprover = canAny(permissions, LEAVE_APPROVER_PERMISSIONS);

  const [typeId, setTypeId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const balances = useQuery({
    queryKey: ["leave", "balances"],
    queryFn: getLeaveBalances,
  });
  const types = useQuery({ queryKey: ["leave", "types"], queryFn: getLeaveTypes });
  const mine = useQuery({
    queryKey: ["leave", "mine"],
    queryFn: () => getLeaveRequests(),
  });
  const inbox = useQuery({
    queryKey: ["leave", "inbox"],
    queryFn: () => getLeaveRequests({ status: "PENDING" }),
    enabled: isApprover,
  });

  const submit = async () => {
    setMsg(null);
    const v = validateLeaveRequest({
      leave_type_id: typeId || (types.data?.[0]?.id ?? ""),
      from_date: from.trim(),
      to_date: to.trim(),
    });
    if (!v.ok) {
      setMsg(v.errors.map((e) => `${e.field}: ${e.message}`).join("\n"));
      return;
    }
    const payload = {
      leave_type_id: typeId || (types.data?.[0]?.id as string),
      from_date: from.trim(),
      to_date: to.trim(),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    };
    try {
      setMsg(await submitQueued({entity:'leave_request',op:`leave:${Date.now()}`,payload}));
      setFrom("");
      setTo("");
      setReason("");
      void mine.refetch();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Submit failed");
    }
  };

  const decide = async (id: string, d: "APPROVE" | "REJECT", version?: number) => {
    setMsg(null);
    try {
      await postLeaveDecision(id, d, version ?? 0);
      setMsg(`Request ${d === "APPROVE" ? "approved" : "rejected"}.`);
      void inbox.refetch();
    } catch (e) {
      setMsg(
        e instanceof ApiError && e.status === 409
          ? "Conflict: request changed — refresh and retry."
          : e instanceof Error
            ? e.message
            : "Decision failed",
      );
    }
  };

  return (
    <ScrollView style={S.screen}>
      <Card title="Balances">
        {(balances.data ?? []).map((b, i) => (
          <View key={String(b.leave_type_id ?? i)} style={[S.row, { paddingVertical: 4 }]}>
            <Text style={[S.body, { flex: 1 }]}>
              {String(b.leave_type_code ?? b.code ?? b.leave_type_id ?? "?")}
            </Text>
            <Text style={S.body}>
              {String(b.available ?? b.opening_balance ?? "?")}
            </Text>
          </View>
        ))}
        {balances.isLoading ? <Text style={S.muted}>Loading…</Text> : null}
      </Card>

      <Card title="New request">
        <Text style={S.muted}>Leave type (UUID, default: first)</Text>
        <TextInput
          style={S.input}
          placeholder={types.data?.[0]?.code ?? "leave_type_id"}
          value={typeId}
          onChangeText={setTypeId}
        />
        <TextInput
          style={S.input}
          placeholder="From YYYY-MM-DD"
          value={from}
          onChangeText={setFrom}
        />
        <TextInput
          style={S.input}
          placeholder="To YYYY-MM-DD"
          value={to}
          onChangeText={setTo}
        />
        <TextInput
          style={S.input}
          placeholder="Reason (optional)"
          value={reason}
          onChangeText={setReason}
        />
        <Pressable style={S.btn} onPress={() => void submit()}>
          <Text style={S.btnText}>Submit</Text>
        </Pressable>
        {msg ? <Text style={S.muted}>{msg}</Text> : null}
      </Card>

      <Card title="My requests">
        {(mine.data ?? []).map((r) => (
          <View key={r.id} style={[S.row, { paddingVertical: 4 }]}>
            <Text style={[S.body, { flex: 1 }]} numberOfLines={1}>
              {r.id.slice(0, 8)}
            </Text>
            <Pill
              text={r.status}
              tone={r.status === "APPROVED" ? "ok" : r.status === "PENDING" ? "warn" : "bad"}
            />
          </View>
        ))}
      </Card>

      {isApprover ? (
        <Card title="Approvals inbox">
          {(inbox.data ?? []).map((r) => (
            <View key={r.id} style={[S.row, { paddingVertical: 6 }]}>
              <Text style={[S.body, { flex: 1 }]} numberOfLines={1}>
                {r.id.slice(0, 8)} · {r.status}
              </Text>
              <Pressable onPress={() => void decide(r.id, "APPROVE", r.version)}>
                <Pill text="Approve" tone="ok" />
              </Pressable>
              <Pressable onPress={() => void decide(r.id, "REJECT", r.version)}>
                <Pill text="Reject" tone="bad" />
              </Pressable>
            </View>
          ))}
          {(inbox.data ?? []).length === 0 && !inbox.isLoading ? (
            <Text style={S.muted}>Nothing pending.</Text>
          ) : null}
        </Card>
      ) : (
        <Card title="Approvals inbox">
          <Text style={S.muted}>
            Locked — needs leave.decide / leave.admin rights.
          </Text>
        </Card>
      )}
    </ScrollView>
  );
}
