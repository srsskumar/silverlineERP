/**
 * Expenses (§16): submit a claim and track your own claims.
 *
 * Keeps to a single line per claim — the common field case (one fuel bill,
 * one hotel night) — rather than reproducing the web's multi-line editor.
 * Policy limits, duplicate-receipt fingerprinting and GST credit rules are
 * all applied server-side on submit; this screen only pre-checks that the
 * form is fillable (src/validators.ts's validateExpenseClaim).
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, View } from "react-native";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { randomUUID } from "expo-crypto";
import { ApiError } from "../src/api/client";
import { useAuth } from "../src/auth/AuthContext";
import {
  getExpenseClaim,
  getExpenseClaims,
  getExpenseReceipts,
  getExpenseReceiptFile,
  deleteExpenseReceipt,
  postExpenseClaim,
  postExpenseClaimSubmit,
  postExpenseClaimWithdraw,
  type ExpenseClaim,
  type ExpenseReceipt,
} from "../src/api/endpoints";
import { EXPENSE_CATEGORIES, validateExpenseClaim } from "../src/validators";
import { categoryLabel, expenseClaimActions, expenseStatusTone } from "../src/expensesFormat";
import { canAddReceipt, claimTakesReceipts, formatReceiptSize, receiptIcon } from "../src/expenseReceiptsFormat";
import { ReceiptCapture } from "../src/device/ReceiptCapture";
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
import { radius, space, useTheme } from "../src/theme";

function money(v: number | string | undefined): string {
  const n = Number(v ?? 0);
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function ExpensesScreen() {
  const { canDo } = useAuth();
  const canRead = canDo("expense.read");
  const canManage = canDo("expense.manage");
  const qc = useQueryClient();

  const [showForm, setShowForm] = useState(false);
  const [claimNo, setClaimNo] = useState(`EXP-${Date.now().toString().slice(-8)}`);
  const [claimDate, setClaimDate] = useState(today());
  const [purpose, setPurpose] = useState("");
  const [category, setCategory] = useState<string>(EXPENSE_CATEGORIES[0]);
  const [expenseDate, setExpenseDate] = useState(today());
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const list = useQuery({
    queryKey: ["expense-claims"],
    queryFn: () => getExpenseClaims(),
    enabled: canRead,
  });
  const detail = useQuery({
    queryKey: ["expense-claim", selectedId],
    queryFn: () => getExpenseClaim(selectedId!),
    enabled: Boolean(selectedId),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["expense-claims"] });
    void qc.invalidateQueries({ queryKey: ["expense-claim", selectedId] });
  };

  const resetForm = () => {
    setClaimNo(`EXP-${Date.now().toString().slice(-8)}`);
    setClaimDate(today());
    setPurpose("");
    setCategory(EXPENSE_CATEGORIES[0]);
    setExpenseDate(today());
    setDescription("");
    setAmount("");
    setVendorName("");
  };

  const submitNewClaim = async () => {
    setFormError(null);
    const v = validateExpenseClaim({
      claim_no: claimNo,
      claim_date: claimDate,
      purpose,
      category,
      expense_date: expenseDate,
      description,
      amount,
    });
    if (!v.ok) {
      setFormError(v.errors.map((e) => e.message).join("\n"));
      return;
    }
    setSubmitting(true);
    try {
      const claim = await postExpenseClaim({
        claim_no: claimNo.trim(),
        claim_date: claimDate,
        purpose: purpose.trim(),
        lines: [
          {
            category,
            expense_date: expenseDate,
            description: description.trim(),
            amount: Number(amount),
            ...(vendorName.trim() ? { vendor_name: vendorName.trim() } : {}),
          },
        ],
      });
      // Submitted straight away — a claim left in DRAFT on a field phone is a
      // claim nobody remembers to come back and send.
      try {
        await postExpenseClaimSubmit(claim.id, claim.version);
      } catch (submitErr) {
        // The claim exists; only the submit step failed (no approval policy,
        // etc.). It stays visible below as a DRAFT so it can be sent again.
        setFormError(
          submitErr instanceof ApiError
            ? `Claim saved, but could not be submitted yet: ${submitErr.message}`
            : "Claim saved, but could not be submitted yet.",
        );
      }
      resetForm();
      setShowForm(false);
      void list.refetch();
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : "Could not save the claim");
    } finally {
      setSubmitting(false);
    }
  };

  const resubmit = async () => {
    if (!detail.data) return;
    setBusy(true);
    setActionError(null);
    try {
      await postExpenseClaimSubmit(detail.data.id, detail.data.version);
      refresh();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : "Could not submit this claim");
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    if (!detail.data) return;
    setBusy(true);
    setActionError(null);
    try {
      await postExpenseClaimWithdraw(detail.data.id, detail.data.version, "Withdrawn from mobile");
      refresh();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : "Could not withdraw this claim");
    } finally {
      setBusy(false);
    }
  };

  const rows = list.data ?? [];

  return (
    <Screen>
      <BackHeader
        title="Expenses"
        onBack={() => router.back()}
        right={
          canManage ? (
            <Button
              title={showForm ? "Cancel" : "New claim"}
              variant={showForm ? "secondary" : "primary"}
              onPress={() => setShowForm((s) => !s)}
            />
          ) : undefined
        }
      />
      <Muted style={{ marginBottom: space.lg }}>Claims, what policy allows, and what is owed.</Muted>

      {!canRead && !canManage ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to expenses"
          message="This screen needs the expense.read permission."
        />
      ) : (
        <>
          {showForm ? (
            <Card title="New expense claim">
              {formError ? <Banner tone="danger" icon="alert-circle-outline" title={formError} /> : null}
              <Input label="Claim number" value={claimNo} onChangeText={setClaimNo} maxLength={50} />
              <Input label="Claim date" placeholder="YYYY-MM-DD" value={claimDate} onChangeText={setClaimDate} autoCapitalize="none" />
              <Input label="Purpose" placeholder="Why this claim" value={purpose} onChangeText={setPurpose} />
              <Subtle style={{ marginBottom: space.xs }}>Category</Subtle>
              <Row gap={space.sm} style={{ flexWrap: "wrap", marginBottom: space.md }}>
                {EXPENSE_CATEGORIES.map((c) => (
                  <Button
                    key={c}
                    title={categoryLabel(c)}
                    variant={category === c ? "primary" : "secondary"}
                    onPress={() => setCategory(c)}
                    style={{ paddingHorizontal: space.md, borderRadius: radius.pill, minHeight: 36 }}
                  />
                ))}
              </Row>
              <Input label="Expense date" placeholder="YYYY-MM-DD" value={expenseDate} onChangeText={setExpenseDate} autoCapitalize="none" />
              <Input label="Description" placeholder="What was it for" value={description} onChangeText={setDescription} />
              <Input label="Amount (₹)" placeholder="0" keyboardType="decimal-pad" value={amount} onChangeText={setAmount} />
              <Input label="Vendor (optional)" value={vendorName} onChangeText={setVendorName} />
              <Button
                title="Submit claim"
                icon="send-outline"
                loading={submitting}
                disabled={submitting}
                onPress={() => void submitNewClaim()}
              />
            </Card>
          ) : null}

          <SectionLabel>My claims</SectionLabel>
          <Card>
            {list.isLoading ? (
              <Loading />
            ) : rows.length === 0 ? (
              <EmptyState icon="receipt-outline" title="No claims yet" />
            ) : (
              rows.map((c, i, arr) => (
                <ListRow
                  key={c.id}
                  title={`${c.claim_no} · ${money(c.total_claimed)}`}
                  subtitle={c.purpose}
                  right={<Badge text={c.status} tone={expenseStatusTone(c.status)} />}
                  onPress={() => setSelectedId(c.id)}
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
        onRequestClose={() => {
          setSelectedId(null);
          setActionError(null);
        }}
      >
        <Screen>
          <BackHeader
            title="Claim"
            onBack={() => {
              setSelectedId(null);
              setActionError(null);
            }}
          />
          {detail.isLoading ? (
            <Loading />
          ) : !detail.data ? (
            <EmptyState icon="alert-circle-outline" title="Could not load this claim" />
          ) : (
            <ExpenseDetail
              claim={detail.data}
              canManage={canManage}
              busy={busy}
              actionError={actionError}
              onSubmit={() => void resubmit()}
              onWithdraw={() => void withdraw()}
            />
          )}
        </Screen>
      </Modal>
    </Screen>
  );
}

function ExpenseDetail({
  claim,
  canManage,
  busy,
  actionError,
  onSubmit,
  onWithdraw,
}: {
  claim: ExpenseClaim;
  canManage: boolean;
  busy: boolean;
  actionError: string | null;
  onSubmit: () => void;
  onWithdraw: () => void;
}) {
  const t = useTheme();
  const qc = useQueryClient();
  const actions = expenseClaimActions(claim.status);
  const canResubmit = canManage && actions.canSubmit;
  const canWithdraw = canManage && actions.canWithdraw;

  const [showCapture, setShowCapture] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const receipts = useQuery({
    queryKey: ["expense-receipts", claim.id],
    queryFn: () => getExpenseReceipts(claim.id),
  });
  // Removing a receipt must stay available even once a claim is AT the
  // 5-receipt cap (that's how you get back under it) — only adding a new
  // one is capped, so these are two different gates.
  const canManageReceipts = canManage && claimTakesReceipts(claim.status);
  // Same pre-check the picker itself runs on each upload attempt — also
  // gates whether "Add receipt" shows at all, so a claim already at the
  // cap doesn't invite a doomed upload.
  const canAddMore = canManageReceipts && canAddReceipt(claim.status, (receipts.data ?? []).length).ok;

  const refreshReceipts = () => void qc.invalidateQueries({ queryKey: ["expense-receipts", claim.id] });

  const view = async (r: ExpenseReceipt) => {
    setReceiptError(null);
    setViewingId(r.id);
    let file: File | undefined;
    try {
      if (!(await Sharing.isAvailableAsync())) throw new Error("Viewing files is unavailable on this device.");
      const bytes = await getExpenseReceiptFile(claim.id, r.id);
      const ext = r.mime_type === "application/pdf" ? "pdf" : r.mime_type === "image/png" ? "png" : "jpg";
      file = new File(Paths.cache, `receipt-${randomUUID()}.${ext}`);
      file.create();
      file.write(bytes);
      await Sharing.shareAsync(file.uri, { mimeType: r.mime_type ?? undefined, dialogTitle: r.file_name });
    } catch (e) {
      setReceiptError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Could not open this receipt");
    } finally {
      if (file?.exists) file.delete();
      setViewingId(null);
    }
  };

  const remove = async (r: ExpenseReceipt) => {
    setReceiptError(null);
    setRemovingId(r.id);
    try {
      await deleteExpenseReceipt(claim.id, r.id);
      refreshReceipts();
    } catch (e) {
      setReceiptError(e instanceof ApiError ? e.message : "Could not remove this receipt");
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <View>
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Muted style={{ color: t.text, fontWeight: "700" }}>{claim.claim_no}</Muted>
          <Badge text={claim.status} tone={expenseStatusTone(claim.status)} />
        </Row>
        <Muted style={{ color: t.text, fontSize: 22, fontWeight: "700", marginTop: space.xs }}>
          {money(claim.total_claimed)}
        </Muted>
        <Subtle style={{ marginTop: space.xs }}>{claim.purpose}</Subtle>
        {claim.policy_exception ? (
          <Banner
            tone="warning"
            icon="alert-circle-outline"
            title="Outside policy"
            message={`Allowed ${money(claim.total_allowed)}, excess ${money(claim.total_excess)}.`}
          />
        ) : null}
      </Card>

      <SectionLabel>Lines</SectionLabel>
      <Card>
        {(claim.lines ?? []).map((l, i, arr) => (
          <ListRow
            key={l.id ?? i}
            title={`${categoryLabel(String(l.category))} · ${money(l.amount)}`}
            subtitle={`${l.expense_date} · ${l.description}`}
            last={i === arr.length - 1}
          />
        ))}
      </Card>

      <SectionLabel>Receipts</SectionLabel>
      <Card>
        {receipts.isLoading ? (
          <Loading />
        ) : (receipts.data ?? []).length === 0 ? (
          <EmptyState icon="receipt-outline" title="No receipts attached" />
        ) : (
          (receipts.data ?? []).map((r, i, arr) => (
            <ListRow
              key={r.id}
              icon={receiptIcon(r.mime_type)}
              title={r.file_name}
              subtitle={formatReceiptSize(r.file_size)}
              onPress={() => void view(r)}
              right={
                viewingId === r.id ? (
                  <Subtle>Opening…</Subtle>
                ) : canManageReceipts ? (
                  <Button
                    title="Remove"
                    variant="ghost"
                    tone="danger"
                    loading={removingId === r.id}
                    onPress={() => void remove(r)}
                  />
                ) : undefined
              }
              last={i === arr.length - 1}
            />
          ))
        )}
      </Card>
      {canAddMore ? (
        <Button
          title="Add receipt"
          icon="attach-outline"
          variant="secondary"
          style={{ marginTop: space.sm }}
          onPress={() => setShowCapture(true)}
        />
      ) : null}
      {receiptError ? <Banner tone="danger" icon="alert-circle-outline" title={receiptError} /> : null}
      {showCapture ? (
        <ReceiptCapture
          claimId={claim.id}
          onClose={() => setShowCapture(false)}
          onSaved={() => { setShowCapture(false); refreshReceipts(); }}
        />
      ) : null}

      {actionError ? <Banner tone="danger" icon="alert-circle-outline" title={actionError} /> : null}

      {canResubmit || canWithdraw ? (
        <Row gap={space.sm} style={{ marginTop: space.md }}>
          {canResubmit ? (
            <Button title="Submit" icon="send-outline" loading={busy} onPress={onSubmit} style={{ flex: 1 }} />
          ) : null}
          {canWithdraw ? (
            <Button
              title="Withdraw"
              variant="secondary"
              tone="danger"
              icon="arrow-undo-outline"
              loading={busy}
              onPress={onWithdraw}
              style={{ flex: 1 }}
            />
          ) : null}
        </Row>
      ) : null}
      <Divider />
    </View>
  );
}

export default withScreenBoundary(ExpensesScreen);
