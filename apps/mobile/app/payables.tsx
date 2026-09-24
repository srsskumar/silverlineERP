/**
 * Payables (§58.3): whom we owe, and by when the law actually fixes.
 *
 * Reads the same ageing summary the web page does, led by the vendor list
 * with each vendor's invoices embedded in the same response. MSME interest —
 * a real, non-deductible liability whether or not anyone records it — gets
 * its own line, same as the web. Read-only: building and releasing a payment
 * run stay a desk job with the full ledger in front of it, not a phone
 * lookup — and so does executing one (B-002): this screen only shows a run's
 * status, and once PAID, the bank reference and date it settled on.
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "react-native";
import { useAuth } from "../src/auth/AuthContext";
import { getApAgeing, getPaymentRuns, type ApVendor } from "../src/api/endpoints";
import { oldestBucket, partyTone, paymentRunTone, AGEING_BUCKET_LABELS } from "../src/ledgersFormat";
import { withScreenBoundary } from "../src/ui/ErrorBoundary";
import {
  BackHeader,
  Badge,
  Banner,
  Card,
  Divider,
  EmptyState,
  ListRow,
  Loading,
  Muted,
  Row,
  Screen,
  SectionLabel,
  StatTile,
  Subtle,
} from "../src/ui/primitives";
import { space, useTheme } from "../src/theme";
import { day } from "@silverline/shared";
import { formatMoney as money } from "../src/money";


function PayablesScreen() {
  const { canDo } = useAuth();
  const canRead = canDo("ap.read");
  const canReadRuns = canDo("paymentrun.read");
  const [selected, setSelected] = useState<ApVendor | null>(null);

  const ageing = useQuery({
    queryKey: ["ap-ageing"],
    queryFn: () => getApAgeing(),
    enabled: canRead,
  });

  const runs = useQuery({
    queryKey: ["payment-runs"],
    queryFn: () => getPaymentRuns(),
    enabled: canReadRuns,
  });

  const data = ageing.data;
  const vendors = data?.vendors ?? [];
  const paymentRuns = runs.data?.items ?? [];

  return (
    <Screen>
      <BackHeader title="Payables" onBack={() => router.back()} />
      <Muted style={{ marginBottom: space.lg }}>
        What we owe, aged on the date the law — or the contract — actually fixes.
      </Muted>

      {!canRead ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to payables"
          message="This screen needs the ap.read permission."
        />
      ) : ageing.isLoading ? (
        <Loading />
      ) : !data ? (
        <EmptyState icon="alert-circle-outline" title="Could not load payables" />
      ) : (
        <>
          <Row gap={space.sm} style={{ flexWrap: "wrap", marginBottom: space.md }}>
            <StatTile label="Overdue" value={money(data.overdue)} tone={data.overdue > 0 ? "danger" : "success"} />
            <StatTile label="Total outstanding" value={money(data.total)} />
            <StatTile label="On hold" value={money(data.onHold)} tone={data.onHold > 0 ? "warning" : "neutral"} />
            <StatTile
              label="MSME interest accrued"
              value={money(data.msme_accrued_interest)}
              tone={data.msme_accrued_interest > 0 ? "danger" : "neutral"}
            />
          </Row>

          <SectionLabel>By vendor</SectionLabel>
          <Card>
            {vendors.length === 0 ? (
              <EmptyState icon="business-outline" title="Nothing outstanding" />
            ) : (
              vendors.map((v, i, arr) => {
                const bucket = oldestBucket(v.buckets);
                return (
                  <ListRow
                    key={v.vendor_id ?? i}
                    title={v.vendor_name}
                    subtitle={bucket ? AGEING_BUCKET_LABELS[bucket] : "Not yet due"}
                    right={<Badge text={money(v.total)} tone={partyTone(v)} />}
                    onPress={() => setSelected(v)}
                    last={i === arr.length - 1}
                  />
                );
              })
            )}
          </Card>

          {canReadRuns ? (
            <>
              <SectionLabel>Payment runs</SectionLabel>
              <Card>
                {runs.isLoading ? (
                  <Loading />
                ) : paymentRuns.length === 0 ? (
                  <EmptyState icon="card-outline" title="No payment runs yet" />
                ) : (
                  paymentRuns.map((r, i, arr) => (
                    <ListRow
                      key={r.id}
                      title={`${r.run_no} · ${money(r.total_amount)}`}
                      subtitle={
                        r.status === "PAID" && r.paid_on
                          ? `Paid ${day(r.paid_on)}${r.bank_reference ? ` · ${r.bank_reference}` : ""}`
                          : `Run date ${day(r.run_date)}`
                      }
                      right={<Badge text={r.status} tone={paymentRunTone(r.status)} />}
                      last={i === arr.length - 1}
                    />
                  ))
                )}
              </Card>
            </>
          ) : null}
        </>
      )}

      <Modal
        visible={Boolean(selected)}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSelected(null)}
      >
        {selected ? <VendorDetail vendor={selected} onClose={() => setSelected(null)} /> : null}
      </Modal>
    </Screen>
  );
}

function VendorDetail({ vendor, onClose }: { vendor: ApVendor; onClose: () => void }) {
  const t = useTheme();
  return (
    <Screen>
      <BackHeader title={vendor.vendor_name} onBack={onClose} />
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Muted style={{ color: t.text, fontWeight: "700" }}>Outstanding</Muted>
          <Muted style={{ color: t.text, fontWeight: "700" }}>{money(vendor.total)}</Muted>
        </Row>
        <Row style={{ justifyContent: "space-between", marginTop: space.xs }}>
          <Subtle>Overdue</Subtle>
          <Subtle>{money(vendor.overdue)}</Subtle>
        </Row>
        {vendor.accrued_interest > 0 ? (
          <Row style={{ justifyContent: "space-between" }}>
            <Subtle>MSME interest accrued</Subtle>
            <Subtle>{money(vendor.accrued_interest)}</Subtle>
          </Row>
        ) : null}
      </Card>

      <SectionLabel>Invoices</SectionLabel>
      <Card>
        {vendor.invoices.length === 0 ? (
          <EmptyState icon="document-text-outline" title="Nothing outstanding" />
        ) : (
          vendor.invoices.map((inv, i, arr) => (
            <ListRow
              key={inv.invoice_id}
              title={`${inv.serial_number} · ${money(inv.outstanding)}`}
              subtitle={
                (inv.effective_due_date ? `Due ${day(inv.effective_due_date)}` : "No due date") +
                (inv.is_msme ? " · MSME" : "")
              }
              right={
                <Row gap={space.xs}>
                  {inv.on_hold ? <Badge text="ON HOLD" tone="warning" /> : null}
                  {inv.disputed ? <Badge text="DISPUTED" tone="danger" /> : null}
                </Row>
              }
              last={i === arr.length - 1}
            />
          ))
        )}
      </Card>
      <Divider />
    </Screen>
  );
}

export default withScreenBoundary(PayablesScreen);
