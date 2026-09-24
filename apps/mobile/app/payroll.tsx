/**
 * Payroll (P1): the org-wide run register — status, period, totals and lock
 * state — distinct from the employee's own "My payslip", which is web-only
 * for now (no mobile screen exists yet; it is not in BUILT_MODULE_ROUTES and
 * surfaces as "Coming soon" in the More-tab launcher — see A-002 in
 * docs/qa/2026-09-24/findings-a.md). This is the manager's lookup: is this
 * period's run open, calculated, under review, approved or locked, and
 * roughly what did it total. Read-only — generating, approving and locking a
 * run is a period-close action with the warnings list and every employee's
 * figures in front of it, not a phone lookup, and it stays on the web.
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, View } from "react-native";
import { useAuth } from "../src/auth/AuthContext";
import { getPayrollRun, getPayrollRunPayslips, getPayrollRuns, type PayrollRun } from "../src/api/endpoints";
import { payrollPeriodLabel, payrollRunStatusTone } from "../src/payrollFormat";
import { day } from "@silverline/shared";
import { withScreenBoundary } from "../src/ui/ErrorBoundary";
import { usePullRefresh } from "../src/ui/usePullRefresh";
import { listState } from "../src/listState";
import { LoadError } from "../src/ui/LoadError";
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
  Subtle,
} from "../src/ui/primitives";
import { space, useTheme } from "../src/theme";
import { formatMoney as money } from "../src/money";


function PayrollScreen() {
  const { canDo } = useAuth();
  const canRead = canDo("payroll.read");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const runs = useQuery({
    queryKey: ["payroll-runs"],
    queryFn: () => getPayrollRuns(),
    enabled: canRead,
  });
  const detail = useQuery({
    queryKey: ["payroll-run", selectedId],
    queryFn: () => getPayrollRun(selectedId!),
    enabled: Boolean(selectedId),
  });

  const rows = runs.data?.items ?? [];

  const pull = usePullRefresh(canRead && runs);


  return (
    <Screen refresh={pull}>
      <BackHeader title="Payroll" onBack={() => router.back()} />
      <Muted style={{ marginBottom: space.lg }}>
        Payroll runs across the organisation — status, period and totals.
      </Muted>

      {!canRead ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to payroll"
          message="This screen needs the payroll.read permission."
        />
      ) : (
        <>
          <SectionLabel>Runs</SectionLabel>
          <Card>
            {listState(runs, rows.length) === "loading" ? (
              <Loading />
            ) : listState(runs, rows.length) === "error" ? (
              <LoadError query={runs} what="payroll runs" />
            ) : rows.length === 0 ? (
              <EmptyState icon="wallet-outline" title="No payroll runs yet" />
            ) : (
              rows.map((r, i, arr) => (
                <ListRow
                  key={r.id}
                  title={payrollPeriodLabel(r.period_start, r.period_end)}
                  subtitle={`${r.employee_count} employee${r.employee_count === 1 ? "" : "s"} · ${money(r.total_net)} net`}
                  right={<Badge text={r.status} tone={payrollRunStatusTone(r.status)} />}
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
        onRequestClose={() => setSelectedId(null)}
      >
        <Screen>
          <BackHeader title="Payroll run" onBack={() => setSelectedId(null)} />
          {detail.isLoading ? (
            <Loading />
          ) : !detail.data ? (
            <EmptyState icon="alert-circle-outline" title="Could not load this run" />
          ) : (
            <RunDetail run={detail.data} />
          )}
        </Screen>
      </Modal>
    </Screen>
  );
}

function RunDetail({ run }: { run: PayrollRun }) {
  const t = useTheme();
  const payslips = useQuery({
    queryKey: ["payroll-run-payslips", run.id],
    queryFn: () => getPayrollRunPayslips(run.id),
  });

  return (
    <View>
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Muted style={{ color: t.text, fontWeight: "700" }}>
            {payrollPeriodLabel(run.period_start, run.period_end)}
          </Muted>
          <Badge text={run.status} tone={payrollRunStatusTone(run.status)} />
        </Row>
        <Muted style={{ color: t.text, fontSize: 22, fontWeight: "700", marginTop: space.xs }}>
          {money(run.total_net)}
        </Muted>
        <Subtle style={{ marginTop: space.xs }}>{run.employee_count} employees in this run</Subtle>
        {run.locked_at ? <Subtle>Locked {day(run.locked_at)}</Subtle> : null}
        {run.approved_at ? <Subtle>Approved {day(run.approved_at)}</Subtle> : null}
      </Card>

      <SectionLabel>Totals</SectionLabel>
      <Card>
        <Field label="Gross" value={money(run.total_gross)} />
        <Field label="Deductions" value={money(run.total_deductions)} />
        <Field label="Net" value={money(run.total_net)} />
      </Card>

      {run.warnings.length > 0 ? (
        <Banner
          tone="warning"
          icon="alert-circle-outline"
          title={`${run.warnings.length} warning${run.warnings.length === 1 ? "" : "s"}`}
          message={run.warnings
            .slice(0, 3)
            .map((w) => w.message)
            .join("; ")}
        />
      ) : null}

      <SectionLabel>Payslips</SectionLabel>
      <Card>
        {listState(payslips, (payslips.data?.items ?? []).length) === "loading" ? (
          <Loading />
        ) : listState(payslips, (payslips.data?.items ?? []).length) === "error" ? (
          <LoadError query={payslips} what="payslips" />
        ) : (payslips.data?.items ?? []).length === 0 ? (
          <EmptyState icon="document-text-outline" title="No payslips in this run" />
        ) : (
          (payslips.data?.items ?? []).map((p, i, arr) => (
            <ListRow
              key={p.id}
              title={`${p.emp_no} · ${p.employee_name}`}
              right={<Muted style={{ color: t.text }}>{money(p.net_pay)}</Muted>}
              last={i === arr.length - 1}
            />
          ))
        )}
        {payslips.data?.hasMore ? <Subtle style={{ marginTop: space.sm }}>More payslips on the web.</Subtle> : null}
      </Card>
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

export default withScreenBoundary(PayrollScreen);
