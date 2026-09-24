/**
 * Project finance (§15, §37.3): a project's RA bill register.
 *
 * Everything about drawing a bill — measurement, deductions, advance
 * recovery, certification — is worked out server-side from the measurement
 * book and the project's deduction policy; that stays on the web, where the
 * numbers are built up line by line. This screen is the read-only lookup a
 * field or site manager needs from a phone: pick a project, see its bills,
 * their status, what each is worth and when it falls due, including the
 * disputed flag and the payment-terms due date this round added server-side.
 */
import { formToday } from "../src/formDate";
import { router } from "expo-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, ScrollView, View } from "react-native";
import { useAuth } from "../src/auth/AuthContext";
import { getProjectRaBills, getProjects, getRaBill, type RaBill } from "../src/api/endpoints";
import { raBillAmount, raBillOverdue, raBillStatusTone } from "../src/raBillsFormat";
import { withScreenBoundary } from "../src/ui/ErrorBoundary";
import {
  BackHeader,
  Badge,
  Banner,
  Button,
  Card,
  Divider,
  EmptyState,
  ListRow,
  Loading,
  Muted,
  Row,
  Screen,
  SectionLabel,
  Subtle,
} from "../src/ui/primitives";
import { radius, space, useTheme } from "../src/theme";
import { day } from "@silverline/shared";
import { formatMoney as money } from "../src/money";


// The Indian day, not the UTC one: until 05:30 IST those differ (fix round 1).
const today = formToday;

function ProjectFinanceScreen() {
  const { canDo } = useAuth();
  const canRead = canDo("rabill.read");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => getProjects(),
    enabled: canRead,
  });
  const openProjects = (projects.data ?? []).filter(
    (p) => !["CLOSED", "CANCELLED"].includes(p.status ?? ""),
  );

  const bills = useQuery({
    queryKey: ["project-ra-bills", projectId],
    queryFn: () => getProjectRaBills(projectId!),
    enabled: canRead && Boolean(projectId),
  });
  const detail = useQuery({
    queryKey: ["ra-bill", selectedId],
    queryFn: () => getRaBill(selectedId!),
    enabled: Boolean(selectedId),
  });

  const rows = bills.data ?? [];
  const dateToday = today();

  return (
    <Screen>
      <BackHeader title="Project finance" onBack={() => router.back()} />
      <Muted style={{ marginBottom: space.lg }}>
        RA bills by project — status, amount and when each falls due.
      </Muted>

      {!canRead ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to project finance"
          message="This screen needs the rabill.read permission."
        />
      ) : (
        <>
          <SectionLabel>Project</SectionLabel>
          {projects.isError ? (
            <Banner
              tone="warning"
              icon="cloud-offline-outline"
              title="Projects unavailable"
              message="Reconnect to load the project list."
            />
          ) : openProjects.length === 0 ? (
            <Subtle>No open projects.</Subtle>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.md }}>
              <Row gap={space.sm}>
                {openProjects.map((p) => (
                  <Button
                    key={p.id}
                    title={p.name}
                    variant={projectId === p.id ? "primary" : "secondary"}
                    onPress={() => setProjectId(p.id)}
                    style={{ borderRadius: radius.pill, minHeight: 36, paddingHorizontal: space.md }}
                  />
                ))}
              </Row>
            </ScrollView>
          )}

          {!projectId ? (
            <EmptyState icon="business-outline" title="Choose a project" message="Its bill register shows here." />
          ) : (
            <>
              <SectionLabel>Bills</SectionLabel>
              <Card>
                {bills.isLoading ? (
                  <Loading />
                ) : rows.length === 0 ? (
                  <EmptyState icon="receipt-outline" title="No bills raised on this project yet" />
                ) : (
                  rows.map((b, i, arr) => (
                    <ListRow
                      key={b.id}
                      title={`${b.bill_type === "FINAL" ? "Final bill" : `RA bill ${b.bill_no}`} · ${money(raBillAmount(b))}`}
                      subtitle={
                        b.due_date
                          ? `Due ${day(b.due_date)}${raBillOverdue(b, dateToday) ? " · overdue" : ""}`
                          : b.status
                      }
                      right={
                        <Row gap={space.xs}>
                          {b.disputed ? <Badge text="DISPUTED" tone="danger" /> : null}
                          <Badge text={b.status} tone={raBillStatusTone(b.status)} />
                        </Row>
                      }
                      onPress={() => setSelectedId(b.id)}
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
        visible={Boolean(selectedId)}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSelectedId(null)}
      >
        <Screen>
          <BackHeader title="RA bill" onBack={() => setSelectedId(null)} />
          {detail.isLoading ? (
            <Loading />
          ) : !detail.data ? (
            <EmptyState icon="alert-circle-outline" title="Could not load this bill" />
          ) : (
            <BillDetail bill={detail.data} />
          )}
        </Screen>
      </Modal>
    </Screen>
  );
}

function BillDetail({ bill }: { bill: RaBill }) {
  const t = useTheme();
  return (
    <View>
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Muted style={{ color: t.text, fontWeight: "700" }}>
            {bill.bill_type === "FINAL" ? "Final bill" : `RA bill ${bill.bill_no}`}
          </Muted>
          <Badge text={bill.status} tone={raBillStatusTone(bill.status)} />
        </Row>
        <Muted style={{ color: t.text, fontSize: 22, fontWeight: "700", marginTop: space.xs }}>
          {money(raBillAmount(bill))}
        </Muted>
        {bill.period_from && bill.period_to ? (
          <Subtle style={{ marginTop: space.xs }}>
            Period {day(bill.period_from)} – {day(bill.period_to)}
          </Subtle>
        ) : null}
        {bill.due_date ? <Subtle>Due {day(bill.due_date)}</Subtle> : null}

        {bill.disputed ? (
          <Banner
            tone="danger"
            icon="alert-circle-outline"
            title="Disputed by the client"
            message={bill.dispute_reason ?? undefined}
          />
        ) : null}
        {bill.status === "CANCELLED" && bill.cancelled_reason ? (
          <Banner tone="neutral" icon="close-circle-outline" title="Cancelled" message={bill.cancelled_reason} />
        ) : null}
      </Card>

      <SectionLabel>Value</SectionLabel>
      <Card>
        <Field label="Gross value" value={money(bill.gross_value)} />
        <Field label="GST" value={money(bill.gst_amount)} />
        <Field label="Deductions" value={money(bill.total_deductions)} />
        <Field label="Net payable" value={money(bill.net_payable)} />
        {bill.certified_amount !== null && bill.certified_amount !== undefined ? (
          <Field label="Certified amount" value={money(bill.certified_amount)} />
        ) : null}
      </Card>

      {(bill.deductions ?? []).length > 0 ? (
        <>
          <SectionLabel>Deductions</SectionLabel>
          <Card>
            {(bill.deductions ?? []).map((d, i, arr) => (
              <ListRow
                key={d.id ?? i}
                title={d.label}
                subtitle={d.reason ?? undefined}
                right={<Muted style={{ color: t.text }}>{money(d.amount)}</Muted>}
                last={i === arr.length - 1}
              />
            ))}
          </Card>
        </>
      ) : null}

      {(bill.items ?? []).length > 0 ? (
        <>
          <SectionLabel>Measured items</SectionLabel>
          <Card>
            {(bill.items ?? []).map((line, i, arr) => (
              <ListRow
                key={line.id ?? i}
                title={`${line.item_code ?? ""} ${line.description ?? ""}`.trim()}
                subtitle={`${line.cumulative_quantity} ${line.unit ?? ""} cumulative`}
                right={<Muted style={{ color: t.text }}>{money(line.this_amount)}</Muted>}
                last={i === arr.length - 1}
              />
            ))}
          </Card>
        </>
      ) : null}
      <Divider />
    </View>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <Row style={{ justifyContent: "space-between", paddingVertical: space.xs }}>
      <Subtle>{label}</Subtle>
      <Muted style={{ textAlign: "right", flexShrink: 1, marginLeft: space.md }}>{value}</Muted>
    </Row>
  );
}

export default withScreenBoundary(ProjectFinanceScreen);
