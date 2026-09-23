/**
 * Approvals (§41): the inbox of requests waiting on the signed-in user, and
 * the ones they raised themselves.
 *
 * Maker-checker is enforced server-side (a self-approval, or acting out of
 * sequence, both come back as a plain ApiError) — this screen only shows
 * that refusal cleanly, it never tries to pre-empt it beyond the one rule
 * that is cheap to check on the phone: a rejection needs a reason.
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, View } from "react-native";
import { ApiError } from "../src/api/client";
import { useAuth } from "../src/auth/AuthContext";
import {
  getApproval,
  getApprovalInbox,
  getMyApprovals,
  postApprovalDecision,
  postApprovalRecall,
  type ApprovalInstance,
} from "../src/api/endpoints";
import { approvalStatusTone, formatDocumentType, validateApprovalDecision } from "../src/approvalsFormat";
import { withScreenBoundary } from "../src/ui/ErrorBoundary";
import {
  BackHeader,
  Badge,
  Banner,
  Button,
  Card,
  Divider,
  EmptyState,
  Input,
  ListRow,
  Loading,
  Muted,
  Row,
  Screen,
  SectionLabel,
  Subtle,
} from "../src/ui/primitives";
import { space, useTheme } from "../src/theme";

function money(v: number | string | undefined): string {
  const n = Number(v ?? 0);
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function ApprovalsScreen() {
  const { canDo } = useAuth();
  const canAct = canDo("approval.act");
  const canRead = canDo("approval.read");
  const qc = useQueryClient();

  const [tab, setTab] = useState<"inbox" | "mine">(canAct ? "inbox" : "mine");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [comments, setComments] = useState("");
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const inbox = useQuery({
    queryKey: ["approvals", "inbox"],
    queryFn: getApprovalInbox,
    enabled: canAct && tab === "inbox",
  });
  const mine = useQuery({
    queryKey: ["approvals", "mine"],
    queryFn: () => getMyApprovals(),
    enabled: canRead && tab === "mine",
  });
  const detail = useQuery({
    queryKey: ["approval", selectedId],
    queryFn: () => getApproval(selectedId!),
    enabled: Boolean(selectedId),
  });

  const rows = tab === "inbox" ? inbox.data ?? [] : mine.data ?? [];
  const active = tab === "inbox" ? inbox : mine;

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ["approvals"] });
    void qc.invalidateQueries({ queryKey: ["approval", selectedId] });
  };

  const close = () => {
    setSelectedId(null);
    setComments("");
    setDecisionError(null);
  };

  const decide = async (decision: "APPROVE" | "REJECT") => {
    if (!detail.data) return;
    const v = validateApprovalDecision(decision, comments);
    if (!v.ok) {
      setDecisionError(v.error);
      return;
    }
    setBusy(true);
    setDecisionError(null);
    try {
      await postApprovalDecision(detail.data.id, decision, detail.data.version, comments.trim() || undefined);
      refreshAll();
      close();
    } catch (e) {
      setDecisionError(
        e instanceof ApiError
          ? e.status === 409
            ? "This request changed while you were looking at it. Reload and try again."
            : e.message
          : "Decision failed",
      );
    } finally {
      setBusy(false);
    }
  };

  const recall = async () => {
    if (!detail.data) return;
    setBusy(true);
    setDecisionError(null);
    try {
      await postApprovalRecall(detail.data.id, detail.data.version, "Withdrawn from mobile");
      refreshAll();
      close();
    } catch (e) {
      setDecisionError(e instanceof ApiError ? e.message : "Could not withdraw this request");
    } finally {
      setBusy(false);
    }
  };

  const canDecideThis = tab === "inbox" && canAct;

  return (
    <Screen>
      <BackHeader title="Approvals" onBack={() => router.back()} />
      <Muted style={{ marginBottom: space.lg }}>
        The authority ladder every financial document climbs.
      </Muted>

      {!canRead && !canAct ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to approvals"
          message="This screen needs the approval.read permission."
        />
      ) : (
        <>
          <Row gap={space.sm} style={{ marginBottom: space.md }}>
            {canAct ? (
              <Button
                title="To decide"
                variant={tab === "inbox" ? "primary" : "secondary"}
                onPress={() => setTab("inbox")}
                style={{ flex: 1 }}
              />
            ) : null}
            <Button
              title="Raised by me"
              variant={tab === "mine" ? "primary" : "secondary"}
              onPress={() => setTab("mine")}
              style={{ flex: 1 }}
            />
          </Row>

          <Card>
            {active.isLoading ? (
              <Loading />
            ) : rows.length === 0 ? (
              <EmptyState
                icon="checkmark-done-outline"
                title={tab === "inbox" ? "Nothing waiting on you" : "No requests yet"}
              />
            ) : (
              rows.map((r, i, arr) => (
                <ListRow
                  key={r.id}
                  title={`${formatDocumentType(r.document_type)} · ${money(r.amount)}`}
                  subtitle={
                    tab === "inbox"
                      ? r.pending_since
                        ? `Waiting since ${new Date(r.pending_since).toLocaleDateString()}`
                        : "Waiting"
                      : (r.requested_by_username ?? undefined)
                  }
                  right={tab === "mine" ? <Badge text={r.status} tone={approvalStatusTone(r.status)} /> : undefined}
                  onPress={() => setSelectedId(r.id)}
                  last={i === arr.length - 1}
                />
              ))
            )}
          </Card>
        </>
      )}

      <Modal
        visible={Boolean(selectedId)}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={close}
      >
        <Screen>
          <BackHeader title="Request" onBack={close} />
          {detail.isLoading ? (
            <Loading />
          ) : !detail.data ? (
            <EmptyState icon="alert-circle-outline" title="Could not load this request" />
          ) : (
            <ApprovalDetail
              instance={detail.data}
              canDecide={canDecideThis}
              comments={comments}
              setComments={setComments}
              decisionError={decisionError}
              busy={busy}
              onApprove={() => void decide("APPROVE")}
              onReject={() => void decide("REJECT")}
              onRecall={tab === "mine" ? () => void recall() : undefined}
            />
          )}
        </Screen>
      </Modal>
    </Screen>
  );
}

function ApprovalDetail({
  instance,
  canDecide,
  comments,
  setComments,
  decisionError,
  busy,
  onApprove,
  onReject,
  onRecall,
}: {
  instance: ApprovalInstance & { steps: Array<Record<string, any>>; next_step: Record<string, any> | null };
  canDecide: boolean;
  comments: string;
  setComments: (v: string) => void;
  decisionError: string | null;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onRecall?: () => void;
}) {
  const t = useTheme();
  const canWithdraw = Boolean(onRecall) && instance.status === "PENDING";

  return (
    <View>
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Muted style={{ color: t.text, fontWeight: "700" }}>
            {formatDocumentType(instance.document_type)}
          </Muted>
          <Badge text={instance.status} tone={approvalStatusTone(instance.status)} />
        </Row>
        <Muted style={{ color: t.text, fontSize: 22, fontWeight: "700", marginTop: space.xs }}>
          {money(instance.amount)}
        </Muted>
        {instance.requested_by_username ? (
          <Subtle style={{ marginTop: space.xs }}>Raised by {instance.requested_by_username}</Subtle>
        ) : null}
        {instance.policy_name ? <Subtle>{instance.policy_name}</Subtle> : null}
        {instance.rejection_reason ? (
          <Banner tone="danger" icon="close-circle-outline" title="Rejected" message={instance.rejection_reason} />
        ) : null}
      </Card>

      <SectionLabel>Ladder</SectionLabel>
      <Card>
        {instance.steps.map((s, i, arr) => (
          <ListRow
            key={s.id}
            title={`Level ${s.sequence}${s.approver_role ? ` · ${s.approver_role}` : ""}`}
            subtitle={
              s.acted_by_username
                ? `${s.status === "APPROVED" ? "Approved" : s.status === "REJECTED" ? "Rejected" : s.status} by ${s.acted_by_username}`
                : s.status
            }
            right={<Badge text={s.status} tone={approvalStatusTone(s.status)} />}
            last={i === arr.length - 1}
          />
        ))}
      </Card>

      {decisionError ? (
        <Banner tone="danger" icon="alert-circle-outline" title={decisionError} />
      ) : null}

      {canDecide ? (
        <>
          <SectionLabel>Your decision</SectionLabel>
          <Card>
            <Input
              label="Comments"
              hint="Required if you reject this request."
              placeholder="Why? (required to reject)"
              value={comments}
              onChangeText={setComments}
              multiline
            />
            <Row gap={space.sm}>
              <Button title="Approve" icon="checkmark-outline" tone="success" loading={busy} onPress={onApprove} style={{ flex: 1 }} />
              <Button
                title="Reject"
                icon="close-outline"
                variant="secondary"
                tone="danger"
                loading={busy}
                onPress={onReject}
                style={{ flex: 1 }}
              />
            </Row>
          </Card>
        </>
      ) : null}

      {canWithdraw ? (
        <Button
          title="Withdraw this request"
          variant="secondary"
          tone="danger"
          icon="arrow-undo-outline"
          loading={busy}
          onPress={onRecall}
          style={{ marginTop: space.md }}
        />
      ) : null}
      <Divider />
    </View>
  );
}

export default withScreenBoundary(ApprovalsScreen);
