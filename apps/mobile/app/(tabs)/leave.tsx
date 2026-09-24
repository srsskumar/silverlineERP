/**
 * Leave: balances, a request form, and the approvals inbox (gated by
 * leave.decide / leave.admin / leave.manage — everyone else sees only their own
 * requests).
 */
import { withScreenBoundary } from "../../src/ui/ErrorBoundary";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { View } from "react-native";
import { ApiError } from "../../src/api/client";
import {
  getLeaveBalances,
  getLeaveRequests,
  getLeaveTypes,
  postLeaveDecision,
} from "../../src/api/endpoints";
import { useAuth } from "../../src/auth/AuthContext";
import { LEAVE_APPROVER_PERMISSIONS, TAB_PERMISSIONS, canAny } from "../../src/rbac";
import { submitQueued } from "../../src/sync/engine";
import { validateLeaveRequest } from "../../src/validators";
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
  Subtle,
  Title,
} from "../../src/ui/primitives";
import { radius, space, useTheme } from "../../src/theme";
import { day } from "@silverline/shared";

function statusTone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "APPROVED") return "success";
  if (status === "PENDING") return "warning";
  if (status === "REJECTED" || status === "CANCELLED") return "danger";
  return "neutral";
}

function LeaveScreen() {
  const t = useTheme();
  const { permissions } = useAuth();
  /**
   * M-005: unlike Attendance/Assets/Survey, this tab ran unconditionally --
   * no gate anywhere in the file -- so a role with neither leave.request nor
   * leave.read (src/rbac.ts's TAB_PERMISSIONS.leave) saw the full form and
   * balance/request queries fire, which 403 for that role instead of a
   * locked-state message like every other gated tab.
   */
  const canAccess = canAny(permissions, TAB_PERMISSIONS.leave);
  const isApprover = canAny(permissions, LEAVE_APPROVER_PERMISSIONS);

  const [typeId, setTypeId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [msgTone, setMsgTone] = useState<"success" | "danger">("success");
  const [busy, setBusy] = useState(false);

  const balances = useQuery({
    queryKey: ["leave", "balances"],
    queryFn: getLeaveBalances,
    enabled: canAccess,
  });
  const types = useQuery({ queryKey: ["leave", "types"], queryFn: getLeaveTypes, enabled: canAccess });
  const mine = useQuery({
    queryKey: ["leave", "mine"],
    queryFn: () => getLeaveRequests(),
    enabled: canAccess,
  });
  const inbox = useQuery({
    queryKey: ["leave", "inbox"],
    queryFn: () => getLeaveRequests({ status: "PENDING" }),
    enabled: canAccess && isApprover,
  });

  // The form previously asked the user to type a leave-type UUID. Selecting
  // from the real list is the only workable version of this on a phone.
  const leaveTypes = useMemo(() => types.data ?? [], [types.data]);
  const selectedType = typeId || (leaveTypes[0]?.id ?? "");

  const submit = async () => {
    setMsg(null);
    const v = validateLeaveRequest({
      leave_type_id: selectedType,
      from_date: from.trim(),
      to_date: to.trim(),
    });
    if (!v.ok) {
      setMsg(v.errors.map((e) => `${e.field}: ${e.message}`).join("\n"));
      setMsgTone("danger");
      return;
    }
    setBusy(true);
    try {
      setMsg(
        await submitQueued({
          entity: "leave_request",
          op: `leave:${Date.now()}`,
          payload: {
            leave_type_id: selectedType,
            from_date: from.trim(),
            to_date: to.trim(),
            ...(reason.trim() ? { reason: reason.trim() } : {}),
          },
        }),
      );
      setMsgTone("success");
      setFrom("");
      setTo("");
      setReason("");
      void mine.refetch();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Submit failed");
      setMsgTone("danger");
    } finally {
      setBusy(false);
    }
  };

  const decide = async (id: string, d: "APPROVE" | "REJECT", version?: number) => {
    setMsg(null);
    try {
      await postLeaveDecision(id, d, version ?? 0);
      setMsg(`Request ${d === "APPROVE" ? "approved" : "rejected"}.`);
      setMsgTone("success");
      void inbox.refetch();
    } catch (e) {
      setMsg(
        e instanceof ApiError && e.status === 409
          ? "This request changed while you were looking at it. Refresh and try again."
          : e instanceof Error
            ? e.message
            : "Decision failed",
      );
      setMsgTone("danger");
    }
  };

  if (!canAccess) {
    return (
      <Screen>
        <EmptyState
          icon="lock-closed-outline"
          title="No leave access"
          message="Your role does not include leave permissions. Ask an administrator if you need them."
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title>Leave</Title>
      <Muted style={{ marginTop: 2, marginBottom: space.lg }}>
        Check your balance and request time off.
      </Muted>

      {msg ? (
        <Banner
          tone={msgTone === "success" ? "success" : "danger"}
          icon={msgTone === "success" ? "checkmark-circle-outline" : "alert-circle-outline"}
          title={msg}
        />
      ) : null}

      <Card title="Balances">
        {balances.isLoading ? (
          <Loading />
        ) : (balances.data ?? []).length === 0 ? (
          <EmptyState icon="calendar-outline" title="No balances yet" />
        ) : (
          (balances.data ?? []).map((b, i, arr) => (
            <ListRow
              key={String(b.leave_type_id ?? i)}
              title={String(b.leave_type_code ?? b.code ?? b.leave_type_id ?? "?")}
              right={
                <Muted style={{ color: t.text, fontWeight: "700" }}>
                  {String(b.available ?? b.opening_balance ?? "?")}
                </Muted>
              }
              last={i === arr.length - 1}
            />
          ))
        )}
      </Card>

      <SectionLabel>New request</SectionLabel>
      <Card>
        <Subtle style={{ marginBottom: space.xs }}>Leave type</Subtle>
        {leaveTypes.length === 0 ? (
          <Subtle>Loading leave types…</Subtle>
        ) : (
          <Row gap={space.sm} style={{ flexWrap: "wrap", marginBottom: space.md }}>
            {leaveTypes.map((lt) => {
              const active = selectedType === lt.id;
              return (
                <Button
                  key={lt.id}
                  title={String(lt.code ?? lt.name ?? "Type")}
                  variant={active ? "primary" : "secondary"}
                  onPress={() => setTypeId(lt.id)}
                  style={{ paddingHorizontal: space.md, borderRadius: radius.pill, minHeight: 36 }}
                />
              );
            })}
          </Row>
        )}
        <Input
          label="From"
          placeholder="YYYY-MM-DD"
          keyboardType="numeric"
          autoCapitalize="none"
          value={from}
          onChangeText={setFrom}
        />
        <Input
          label="To"
          placeholder="YYYY-MM-DD"
          keyboardType="numeric"
          autoCapitalize="none"
          value={to}
          onChangeText={setTo}
        />
        <Input
          label="Reason"
          hint="Optional, but helps your approver decide."
          placeholder="Why are you away?"
          value={reason}
          onChangeText={setReason}
        />
        <Button
          title="Submit request"
          icon="send-outline"
          loading={busy}
          disabled={busy || !from.trim() || !to.trim() || !selectedType}
          onPress={() => void submit()}
        />
      </Card>

      <SectionLabel>My requests</SectionLabel>
      <Card>
        {mine.isLoading ? (
          <Loading />
        ) : (mine.data ?? []).length === 0 ? (
          <EmptyState icon="document-text-outline" title="No requests yet" />
        ) : (
          (mine.data ?? []).map((r, i, arr) => (
            <ListRow
              key={r.id}
              title={
                r.from_date && r.to_date ? `${day(r.from_date)} → ${day(r.to_date)}` : r.id.slice(0, 8)
              }
              subtitle={r.reason ? String(r.reason) : undefined}
              right={<Badge text={r.status} tone={statusTone(r.status)} />}
              last={i === arr.length - 1}
            />
          ))
        )}
      </Card>

      <SectionLabel>Approvals</SectionLabel>
      <Card>
        {!isApprover ? (
          <EmptyState
            icon="lock-closed-outline"
            title="No approval rights"
            message="Approving leave needs the leave.decide or leave.admin permission."
          />
        ) : inbox.isLoading ? (
          <Loading />
        ) : (inbox.data ?? []).length === 0 ? (
          <EmptyState icon="checkmark-done-outline" title="Nothing pending" />
        ) : (
          (inbox.data ?? []).map((r) => (
            <View key={r.id} style={{ paddingVertical: space.sm }}>
              <Muted style={{ color: t.text, fontWeight: "600" }}>
                {r.from_date && r.to_date
                  ? `${day(r.from_date)} → ${day(r.to_date)}`
                  : r.id.slice(0, 8)}
              </Muted>
              {r.reason ? <Subtle>{String(r.reason)}</Subtle> : null}
              <Row gap={space.sm} style={{ marginTop: space.sm }}>
                <Button
                  title="Approve"
                  icon="checkmark-outline"
                  tone="success"
                  onPress={() => void decide(r.id, "APPROVE", r.version)}
                  style={{ flex: 1 }}
                />
                <Button
                  title="Reject"
                  icon="close-outline"
                  variant="secondary"
                  tone="danger"
                  onPress={() => void decide(r.id, "REJECT", r.version)}
                  style={{ flex: 1 }}
                />
              </Row>
            </View>
          ))
        )}
      </Card>
    </Screen>
  );
}

// Contained per screen: a render error here shows the recovery card in the
// content area while the tab bar and navigation stay usable, instead of
// unmounting the navigator and dropping the user back on Home.
export default withScreenBoundary(LeaveScreen);
