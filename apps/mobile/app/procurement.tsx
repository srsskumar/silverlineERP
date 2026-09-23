/**
 * Procurement (§6.6, §13.2, §43): requisitions and purchase orders by status.
 *
 * A read-only lookup for the common phone case — "where is my requisition,
 * has the order gone out" — plus the one authoring action cheap enough to
 * carry: raising a single-line requisition, the same shape as an expense
 * claim (one item, one quantity). Everything past that — RFQs, comparisons,
 * awards, amendments, GRNs, three-way matching — needs the full order and
 * vendor context the web page has and stays there.
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, View } from "react-native";
import { ApiError } from "../src/api/client";
import { useAuth } from "../src/auth/AuthContext";
import {
  getPurchaseOrder,
  getPurchaseOrders,
  getRequisition,
  getRequisitions,
  postRequisition,
  postRequisitionSubmit,
  type PurchaseOrder,
  type Requisition,
} from "../src/api/endpoints";
import { poStatusTone, requisitionCanSubmit, requisitionStatusTone } from "../src/procurementFormat";
import { validateRequisitionCreate } from "../src/validators";
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
import { day } from "@silverline/shared";

function money(v: number | string | undefined | null): string {
  const n = Number(v ?? 0);
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function ProcurementScreen() {
  const { canDo } = useAuth();
  const canReadReq = canDo("requisition.read");
  const canManageReq = canDo("requisition.manage");
  const canReadPo = canDo("po.read");
  const qc = useQueryClient();

  const [tab, setTab] = useState<"requisitions" | "orders">("requisitions");
  const [showForm, setShowForm] = useState(false);
  const [selectedReqId, setSelectedReqId] = useState<string | null>(null);
  const [selectedPoId, setSelectedPoId] = useState<string | null>(null);

  const [reqNo, setReqNo] = useState(`PR-${Date.now().toString().slice(-8)}`);
  const [justification, setJustification] = useState("");
  const [description, setDescription] = useState("");
  const [unit, setUnit] = useState("");
  const [quantity, setQuantity] = useState("");
  const [estimatedRate, setEstimatedRate] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const requisitions = useQuery({
    queryKey: ["requisitions"],
    queryFn: () => getRequisitions(),
    enabled: canReadReq && tab === "requisitions",
  });
  const orders = useQuery({
    queryKey: ["purchase-orders"],
    queryFn: () => getPurchaseOrders(),
    enabled: canReadPo && tab === "orders",
  });
  const reqDetail = useQuery({
    queryKey: ["requisition", selectedReqId],
    queryFn: () => getRequisition(selectedReqId!),
    enabled: Boolean(selectedReqId),
  });
  const poDetail = useQuery({
    queryKey: ["purchase-order", selectedPoId],
    queryFn: () => getPurchaseOrder(selectedPoId!),
    enabled: Boolean(selectedPoId),
  });

  const resetForm = () => {
    setReqNo(`PR-${Date.now().toString().slice(-8)}`);
    setJustification("");
    setDescription("");
    setUnit("");
    setQuantity("");
    setEstimatedRate("");
  };

  const submitNewRequisition = async () => {
    setFormError(null);
    const v = validateRequisitionCreate({
      requisition_no: reqNo,
      justification,
      description,
      unit,
      quantity,
    });
    if (!v.ok) {
      setFormError(v.errors.map((e) => e.message).join("\n"));
      return;
    }
    setSubmitting(true);
    try {
      await postRequisition({
        requisition_no: reqNo.trim(),
        justification: justification.trim(),
        lines: [
          {
            description: description.trim(),
            unit: unit.trim(),
            quantity: Number(quantity),
            ...(estimatedRate.trim() ? { estimated_rate: Number(estimatedRate) } : {}),
          },
        ],
      });
      resetForm();
      setShowForm(false);
      void requisitions.refetch();
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : "Could not raise this requisition");
    } finally {
      setSubmitting(false);
    }
  };

  const submitForApproval = async () => {
    if (!reqDetail.data) return;
    setBusy(true);
    setActionError(null);
    try {
      await postRequisitionSubmit(reqDetail.data.id, reqDetail.data.version);
      await reqDetail.refetch();
      void qc.invalidateQueries({ queryKey: ["requisitions"] });
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : "Could not submit this requisition");
    } finally {
      setBusy(false);
    }
  };

  const requisitionRows = requisitions.data?.items ?? [];
  const orderRows = orders.data?.items ?? [];
  const noAccess = !canReadReq && !canReadPo;

  return (
    <Screen>
      <BackHeader
        title="Procurement"
        onBack={() => router.back()}
        right={
          tab === "requisitions" && canManageReq ? (
            <Button
              title={showForm ? "Cancel" : "Raise"}
              variant={showForm ? "secondary" : "primary"}
              onPress={() => setShowForm((s) => !s)}
            />
          ) : undefined
        }
      />
      <Muted style={{ marginBottom: space.lg }}>Requisitions and purchase orders, by status.</Muted>

      {noAccess ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to procurement"
          message="This screen needs the requisition.read permission."
        />
      ) : (
        <>
          <Row gap={space.sm} style={{ marginBottom: space.md }}>
            <Button
              title="Requisitions"
              variant={tab === "requisitions" ? "primary" : "secondary"}
              onPress={() => setTab("requisitions")}
              style={{ flex: 1 }}
            />
            <Button
              title="Purchase orders"
              variant={tab === "orders" ? "primary" : "secondary"}
              onPress={() => setTab("orders")}
              style={{ flex: 1 }}
            />
          </Row>

          {tab === "requisitions" ? (
            !canReadReq ? (
              <EmptyState
                icon="lock-closed-outline"
                title="No access to requisitions"
                message="This screen needs the requisition.read permission."
              />
            ) : (
              <>
                {showForm && canManageReq ? (
                  <Card title="Raise a requisition">
                    {formError ? <Banner tone="danger" icon="alert-circle-outline" title={formError} /> : null}
                    <Input label="Requisition number" value={reqNo} onChangeText={setReqNo} maxLength={50} />
                    <Input
                      label="Justification"
                      placeholder="Why this is needed"
                      value={justification}
                      onChangeText={setJustification}
                      multiline
                    />
                    <Input label="Description" placeholder="What is needed" value={description} onChangeText={setDescription} />
                    <Row gap={space.sm}>
                      <Input
                        label="Unit"
                        placeholder="bag, nos…"
                        value={unit}
                        onChangeText={setUnit}
                        style={{ flex: 1 }}
                      />
                      <Input
                        label="Quantity"
                        placeholder="0"
                        keyboardType="decimal-pad"
                        value={quantity}
                        onChangeText={setQuantity}
                        style={{ flex: 1 }}
                      />
                    </Row>
                    <Input
                      label="Estimated rate (optional)"
                      placeholder="0"
                      keyboardType="decimal-pad"
                      value={estimatedRate}
                      onChangeText={setEstimatedRate}
                    />
                    <Button
                      title="Save requisition"
                      icon="add-circle-outline"
                      loading={submitting}
                      disabled={submitting}
                      onPress={() => void submitNewRequisition()}
                    />
                  </Card>
                ) : null}

                <SectionLabel>Requisitions</SectionLabel>
                <Card>
                  {requisitions.isLoading ? (
                    <Loading />
                  ) : requisitionRows.length === 0 ? (
                    <EmptyState icon="clipboard-outline" title="No requisitions yet" />
                  ) : (
                    requisitionRows.map((r, i, arr) => (
                      <ListRow
                        key={r.id}
                        title={`${r.requisition_no} · ${money(r.estimated_value)}`}
                        subtitle={r.justification}
                        right={<Badge text={r.status} tone={requisitionStatusTone(r.status)} />}
                        onPress={() => setSelectedReqId(r.id)}
                        last={i === arr.length - 1}
                      />
                    ))
                  )}
                </Card>
              </>
            )
          ) : !canReadPo ? (
            <EmptyState
              icon="lock-closed-outline"
              title="No access to purchase orders"
              message="This screen needs the po.read permission."
            />
          ) : (
            <>
              <SectionLabel>Purchase orders</SectionLabel>
              <Card>
                {orders.isLoading ? (
                  <Loading />
                ) : orderRows.length === 0 ? (
                  <EmptyState icon="cart-outline" title="No purchase orders yet" />
                ) : (
                  orderRows.map((o, i, arr) => (
                    <ListRow
                      key={o.id}
                      title={`${o.po_number} · ${money(o.total_value)}`}
                      subtitle={`${o.vendor_name ?? "—"} · ${day(o.po_date)}`}
                      right={<Badge text={o.status} tone={poStatusTone(o.status)} />}
                      onPress={() => setSelectedPoId(o.id)}
                      last={i === arr.length - 1}
                    />
                  ))
                )}
              </Card>
            </>
          )}
        </>
      )}

      <Modal
        visible={Boolean(selectedReqId)}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => {
          setSelectedReqId(null);
          setActionError(null);
        }}
      >
        <Screen>
          <BackHeader
            title="Requisition"
            onBack={() => {
              setSelectedReqId(null);
              setActionError(null);
            }}
          />
          {reqDetail.isLoading ? (
            <Loading />
          ) : !reqDetail.data ? (
            <EmptyState icon="alert-circle-outline" title="Could not load this requisition" />
          ) : (
            <RequisitionDetail
              requisition={reqDetail.data}
              canManage={canManageReq}
              busy={busy}
              actionError={actionError}
              onSubmit={() => void submitForApproval()}
            />
          )}
        </Screen>
      </Modal>

      <Modal
        visible={Boolean(selectedPoId)}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSelectedPoId(null)}
      >
        <Screen>
          <BackHeader title="Purchase order" onBack={() => setSelectedPoId(null)} />
          {poDetail.isLoading ? (
            <Loading />
          ) : !poDetail.data ? (
            <EmptyState icon="alert-circle-outline" title="Could not load this order" />
          ) : (
            <PurchaseOrderDetail order={poDetail.data} />
          )}
        </Screen>
      </Modal>
    </Screen>
  );
}

function RequisitionDetail({
  requisition,
  canManage,
  busy,
  actionError,
  onSubmit,
}: {
  requisition: Requisition;
  canManage: boolean;
  busy: boolean;
  actionError: string | null;
  onSubmit: () => void;
}) {
  const t = useTheme();
  const canSubmit = canManage && requisitionCanSubmit(requisition.status);
  return (
    <View>
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Muted style={{ color: t.text, fontWeight: "700" }}>{requisition.requisition_no}</Muted>
          <Badge text={requisition.status} tone={requisitionStatusTone(requisition.status)} />
        </Row>
        <Muted style={{ color: t.text, fontSize: 22, fontWeight: "700", marginTop: space.xs }}>
          {money(requisition.estimated_value)}
        </Muted>
        <Subtle style={{ marginTop: space.xs }}>{requisition.justification}</Subtle>
        {requisition.required_by ? <Subtle>Required by {day(requisition.required_by)}</Subtle> : null}
      </Card>

      <SectionLabel>Lines</SectionLabel>
      <Card>
        {(requisition.lines ?? []).map((l, i, arr) => (
          <ListRow
            key={l.id ?? i}
            title={`${l.description} · ${l.quantity} ${l.unit}`}
            subtitle={l.estimated_rate ? `${money(l.estimated_rate)} / ${l.unit}` : undefined}
            last={i === arr.length - 1}
          />
        ))}
      </Card>

      {(requisition.purchase_orders ?? []).length > 0 ? (
        <>
          <SectionLabel>Orders raised from this requisition</SectionLabel>
          <Card>
            {(requisition.purchase_orders ?? []).map((po, i, arr) => (
              <ListRow
                key={po.id}
                title={`${po.po_number} · ${money(po.total_value)}`}
                right={<Badge text={po.status} tone={poStatusTone(po.status)} />}
                last={i === arr.length - 1}
              />
            ))}
          </Card>
        </>
      ) : null}

      {actionError ? <Banner tone="danger" icon="alert-circle-outline" title={actionError} /> : null}
      {canSubmit ? (
        <Button
          title="Submit for approval"
          icon="send-outline"
          loading={busy}
          onPress={onSubmit}
          style={{ marginTop: space.md }}
        />
      ) : null}
      <Divider />
    </View>
  );
}

function PurchaseOrderDetail({ order }: { order: PurchaseOrder }) {
  const t = useTheme();
  const lines = (order.lines ?? []) as unknown as Array<{
    id?: string;
    description?: string;
    quantity?: number | string;
    unit?: string;
    line_total?: number | string;
    status?: string;
    pendingQuantity?: number | string;
  }>;
  return (
    <View>
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Muted style={{ color: t.text, fontWeight: "700" }}>{order.po_number}</Muted>
          <Badge text={order.status} tone={poStatusTone(order.status)} />
        </Row>
        <Muted style={{ color: t.text, fontSize: 22, fontWeight: "700", marginTop: space.xs }}>
          {money(order.total_value)}
        </Muted>
        <Subtle style={{ marginTop: space.xs }}>{order.vendor_name ?? "—"}</Subtle>
        <Subtle>Ordered {day(order.po_date)}</Subtle>
        {order.delivery_date ? <Subtle>Delivery due {day(order.delivery_date)}</Subtle> : null}
      </Card>

      <SectionLabel>Lines</SectionLabel>
      <Card>
        {lines.length === 0 ? (
          <EmptyState icon="list-outline" title="No lines on this order" />
        ) : (
          lines.map((l, i, arr) => (
            <ListRow
              key={l.id ?? i}
              title={`${l.description ?? ""} · ${l.quantity ?? ""} ${l.unit ?? ""}`}
              subtitle={l.status ? `Receipt: ${l.status}` : undefined}
              right={<Muted style={{ color: t.text }}>{money(l.line_total)}</Muted>}
              last={i === arr.length - 1}
            />
          ))
        )}
      </Card>
      <Divider />
    </View>
  );
}

export default withScreenBoundary(ProcurementScreen);
