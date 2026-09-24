/**
 * Employee directory (§1): search by name, look someone up — read-only.
 *
 * The desktop form owns create/edit/exit/reactivate and the whole HR
 * lifecycle; a phone is for finding a phone number or a reporting line, not
 * editing a personnel record. PII stays exactly as the server sends it —
 * Aadhaar/PAN/bank account arrive masked to their last four digits for
 * everyone (apps/api's toShape() masks the LIST unconditionally, HR-15), and
 * this screen makes no attempt to request or reconstruct the full numbers.
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, View } from "react-native";
import { useAuth } from "../src/auth/AuthContext";
import { getEmployee, getEmployeeDirectory, type DirectoryEmployee } from "../src/api/endpoints";
import { employeeStatusTone, formatEmployeeName } from "../src/employeesFormat";
import { day } from "@silverline/shared";
import { withScreenBoundary } from "../src/ui/ErrorBoundary";
import { usePullRefresh } from "../src/ui/usePullRefresh";
import { listState } from "../src/listState";
import { LoadError } from "../src/ui/LoadError";
import {
  BackHeader,
  Badge,
  Card,
  Divider,
  EmptyState,
  Input,
  ListRow,
  Loading,
  Muted,
  Row,
  Screen,
  Subtle,
} from "../src/ui/primitives";
import { space, useTheme } from "../src/theme";

function EmployeesScreen() {
  const { canDo } = useAuth();
  const canRead = canDo("employee.read");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const directory = useQuery({
    queryKey: ["employees", "directory", search],
    queryFn: () => getEmployeeDirectory(search.trim() ? { q: search.trim() } : undefined),
    enabled: canRead,
  });
  const detail = useQuery({
    queryKey: ["employee", selectedId],
    queryFn: () => getEmployee(selectedId!),
    enabled: Boolean(selectedId),
  });

  const rows = directory.data?.items ?? [];

  const pull = usePullRefresh(canRead && directory);


  return (
    <Screen refresh={pull}>
      <BackHeader title="Directory" onBack={() => router.back()} />
      <Muted style={{ marginBottom: space.lg }}>Everyone in the organisation, by name.</Muted>

      {!canRead ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to the directory"
          message="This screen needs the employee.read permission."
        />
      ) : (
        <>
          <Input
            placeholder="Search by name, emp. no. or phone"
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
          />
          <Card>
            {listState(directory, rows.length) === "loading" ? (
              <Loading />
            ) : listState(directory, rows.length) === "error" ? (
              <LoadError query={directory} what="the directory" />
            ) : rows.length === 0 ? (
              <EmptyState icon="people-outline" title="No one found" />
            ) : (
              rows.map((e, i, arr) => (
                <ListRow
                  key={e.id}
                  title={formatEmployeeName(e) || e.emp_no}
                  subtitle={[e.emp_no, e.designation ?? undefined].filter(Boolean).join(" · ")}
                  right={e.status !== "ACTIVE" ? <Badge text={e.status} tone={employeeStatusTone(e.status)} /> : undefined}
                  onPress={() => setSelectedId(e.id)}
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
          <BackHeader title="Employee" onBack={() => setSelectedId(null)} />
          {detail.isLoading ? (
            <Loading />
          ) : !detail.data ? (
            <EmptyState icon="alert-circle-outline" title="Could not load this record" />
          ) : (
            <EmployeeDetail employee={detail.data} />
          )}
        </Screen>
      </Modal>
    </Screen>
  );
}

function EmployeeDetail({ employee }: { employee: DirectoryEmployee }) {
  const t = useTheme();
  return (
    <View>
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Muted style={{ color: t.text, fontWeight: "700", flex: 1 }}>
            {formatEmployeeName(employee) || employee.emp_no}
          </Muted>
          <Badge text={employee.status} tone={employeeStatusTone(employee.status)} />
        </Row>
        <Subtle style={{ marginTop: space.xs }}>{employee.emp_no}</Subtle>
        <Divider />
        {employee.designation ? <Field label="Designation" value={employee.designation} /> : null}
        {employee.department ? <Field label="Department" value={employee.department} /> : null}
        {employee.reports_to_name ? <Field label="Reports to" value={employee.reports_to_name} /> : null}
        <Field label="Phone" value={employee.phone} />
        {employee.phone_secondary ? <Field label="Alternate phone" value={employee.phone_secondary} /> : null}
        {employee.email ? <Field label="Email" value={employee.email} /> : null}
        {employee.date_of_joining ? <Field label="Date of joining" value={day(employee.date_of_joining)} /> : null}
        {employee.aadhaar_last4 ? <Field label="Aadhaar" value={`•••• ${employee.aadhaar_last4}`} /> : null}
        {employee.pan_last4 ? <Field label="PAN" value={`•••• ${employee.pan_last4}`} /> : null}
        {employee.bank_account_last4 ? (
          <Field label="Bank account" value={`•••• ${employee.bank_account_last4}`} />
        ) : null}
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

export default withScreenBoundary(EmployeesScreen);
