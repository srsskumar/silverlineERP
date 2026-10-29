/**
 * My payslip (A-002, docs/qa/2026-09-24/findings-a.md): the employee's own
 * full slip for a pay period — earnings, days and deductions, same
 * breakdown the web page and the More-tab Payslip card both read from
 * GET /api/v1/payslips/me?period_start=&period_end=. That card (src/ui/
 * Payslip.tsx) stays where it is for the "what did I just get paid" glance;
 * this screen is the catalog's "My payslip" module entry (packages/shared/
 * src/modules.ts) getting a real destination instead of "Coming soon".
 *
 * Mirrors web's /my-payslip page: a period picker defaulting to the current
 * month, an explicit "Load payslip" (nothing fetches until asked), then one
 * of — pick-a-period, loading, no payslip for this period (NO_PAYSLIP, an
 * expected outcome, not a failure), no employee record linked
 * (NO_EMPLOYEE_LINK), a genuine load failure (LoadError, with Retry when
 * retrying could help), or the slip itself.
 */
import { router } from "expo-router";
import { usePreventScreenCapture } from "expo-screen-capture";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { View } from "react-native";
import { useAuth } from "../src/auth/AuthContext";
import { getMyPayslip, type MyPayslip } from "../src/api/endpoints";
import { isNoEmployeeLink, isNoPayslip, monthToPeriod, myPayslipSections } from "../src/myPayslip";
import { formatMoney } from "../src/money";
import { withScreenBoundary } from "../src/ui/ErrorBoundary";
import { LoadError } from "../src/ui/LoadError";
import {
  BackHeader,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Loading,
  Muted,
  Row,
  Screen,
  SectionLabel,
  Subtle,
} from "../src/ui/primitives";
import { font, space, useTheme } from "../src/theme";
import { permissionLabel } from "../src/permissionLabels";

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function MyPayslipScreen() {
  // Salary figures stay off the camera roll and out of screen recordings.
  usePreventScreenCapture("payslip");
  const { canDo } = useAuth();
  const canRead = canDo("payslip.read");
  const [month, setMonth] = useState(() => currentMonth());
  const [loaded, setLoaded] = useState<{ period_start: string; period_end: string } | null>(null);
  const period = monthToPeriod(month);

  const slip = useQuery({
    queryKey: ["my-payslip", loaded?.period_start, loaded?.period_end],
    queryFn: () => getMyPayslip(loaded as { period_start: string; period_end: string }),
    enabled: canRead && loaded !== null,
    retry: false,
  });

  const state = !loaded
    ? "pick-period"
    : slip.isLoading
      ? "loading"
      : slip.isError && isNoPayslip(slip.error)
        ? "no-payslip"
        : slip.isError && isNoEmployeeLink(slip.error)
          ? "no-link"
          : slip.isError
            ? "error"
            : slip.data
              ? "rows"
              : "pick-period";

  return (
    <Screen>
      <BackHeader title="My payslip" onBack={() => router.back()} />
      <Muted style={{ marginBottom: space.lg }}>
        Your full slip for a pay period — earnings, days and deductions.
      </Muted>

      {!canRead ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to payslips"
          message={`This screen needs permission to ${permissionLabel("payslip.read")}.`}
        />
      ) : (
        <>
          <Card>
            <Input
              accessibilityLabel="Payslip month"
              label="Period"
              hint="YYYY-MM — defaults to the current month"
              value={month}
              onChangeText={setMonth}
              maxLength={7}
              keyboardType="numeric"
              error={month.length === 7 && !period ? "Use the format YYYY-MM." : undefined}
            />
            <Button
              title="Load payslip"
              disabled={!period}
              onPress={() => setLoaded(period)}
              style={{ marginTop: space.sm }}
            />
          </Card>

          {state === "pick-period" ? (
            <EmptyState
              icon="calendar-outline"
              title="Pick a period"
              message="Defaults to the current month. Your full slip loads here once you tap Load payslip."
            />
          ) : state === "loading" ? (
            <Loading label="Loading payslip…" />
          ) : state === "no-payslip" ? (
            <EmptyState
              icon="document-text-outline"
              title="No payslip for this period"
              message={`Nothing was calculated for ${loaded!.period_start} → ${loaded!.period_end}. The run may still be open, or you were not on its payroll.`}
            />
          ) : state === "no-link" ? (
            <EmptyState
              icon="person-remove-outline"
              title="No employee record linked"
              message="Your account is not linked to an employee record, so there is no slip to show. Ask HR to link your user to your employee profile."
            />
          ) : state === "error" ? (
            <LoadError query={slip} what="your payslip" />
          ) : slip.data ? (
            <PayslipCard slip={slip.data} />
          ) : null}
        </>
      )}
    </Screen>
  );
}

function PayslipCard({ slip }: { slip: MyPayslip }) {
  const t = useTheme();
  const sections = myPayslipSections(slip);
  return (
    <Card>
      <Row style={{ justifyContent: "space-between" }}>
        <Muted style={{ color: t.text, fontWeight: "700" }}>
          {slip.period?.start} → {slip.period?.end}
        </Muted>
        <Badge text={slip.run_status} tone="info" />
      </Row>
      <Subtle style={{ marginTop: space.xs }}>
        {slip.employee?.name} · {slip.employee?.emp_no}
        {slip.employee?.designation ? ` · ${slip.employee.designation}` : ""}
      </Subtle>

      {sections.length === 0 ? (
        <Subtle style={{ marginTop: space.md }}>No earnings or deductions recorded on this slip.</Subtle>
      ) : (
        sections.map((section) => (
          <View key={section.title}>
            <SectionLabel>{section.title}</SectionLabel>
            {section.rows.map((row) => (
              <Row key={row.key} style={{ justifyContent: "space-between", minHeight: 28 }}>
                <Muted style={{ flex: 1 }}>{row.label}</Muted>
                <Muted style={{ color: t.text, fontWeight: "600" }}>{row.value}</Muted>
              </Row>
            ))}
          </View>
        ))
      )}

      <Row style={{ justifyContent: "space-between", marginTop: space.md }}>
        <Muted>Gross</Muted>
        <Muted style={{ color: t.text }}>{formatMoney(slip.gross)}</Muted>
      </Row>
      <Row style={{ justifyContent: "space-between", marginTop: space.xs }}>
        <Muted style={{ fontWeight: "700" }}>Net pay</Muted>
        <Muted style={{ color: t.text, fontWeight: "700", fontSize: font.lg }}>
          {formatMoney(slip.net_pay)}
        </Muted>
      </Row>
      <Subtle style={{ marginTop: space.sm }}>Slip ID: {slip.id} · v{slip.version}</Subtle>
    </Card>
  );
}

export default withScreenBoundary(MyPayslipScreen);
