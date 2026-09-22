import { useState } from "react";
import { View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { randomUUID } from "expo-crypto";
import { apiFetch, asItem, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Badge, Button, Card, Input, Muted, Row, SectionLabel, Subtle } from "./primitives";
import { font, space, useTheme } from "../theme";
import { formatRupees, payslipSections } from "./payslipRows";

export function clearPayslipFiles() {
  try {
    for (const file of Paths.cache.list()) {
      if (file instanceof File && file.name.startsWith("silverline-payslip-")) file.delete();
    }
  } catch {
    /* cache may be unavailable during first launch */
  }
}

export function Payslip() {
  const t = useTheme();
  const { permissions } = useAuth();
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(month);

  const q = useQuery({
    queryKey: ["my-payslip", month],
    enabled: valid && permissions.includes("payslip.read"),
    retry: false,
    queryFn: async () => {
      const [y, m] = month.split("-").map(Number);
      const end = `${month}-${new Date(y, m, 0).getDate()}`;
      const result = await apiFetch<Record<string, any>>(
        `/api/v1/payslips/me?period_start=${month}-01&period_end=${end}`,
      );
      return asItem<Record<string, any>>(result.data);
    },
  });

  if (!permissions.includes("payslip.read")) return null;

  async function download() {
    if (!q.data) return;
    setBusy(true);
    setError("");
    let file: File | undefined;
    try {
      if (!(await Sharing.isAvailableAsync())) {
        throw new Error("File export is unavailable on this device.");
      }
      const { data } = await apiFetch<Uint8Array>(
        `/api/v1/payroll/payslips/${q.data.id}/pdf`,
      );
      file = new File(Paths.cache, `silverline-payslip-${randomUUID()}.pdf`);
      file.create();
      file.write(data);
      await Sharing.shareAsync(file.uri, {
        mimeType: "application/pdf",
        dialogTitle: "Save your payslip",
        UTI: "com.adobe.pdf",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payslip download failed.");
    } finally {
      if (file?.exists) file.delete();
      setBusy(false);
    }
  }

  return (
    <Card title="My payslip">
      <Input
        accessibilityLabel="Payslip month"
        label="Period"
        hint="YYYY-MM"
        value={month}
        onChangeText={setMonth}
        maxLength={7}
        keyboardType="numeric"
        error={month.length === 7 && !valid ? "Use the format YYYY-MM." : undefined}
      />
      {q.isLoading ? <Subtle>Loading payslip…</Subtle> : null}
      {q.error ? (
        <Subtle>
          {q.error instanceof ApiError && q.error.status === 404
            ? "No payslip for this period."
            : "Connect to load your payslip."}
        </Subtle>
      ) : null}
      {q.data ? (
        <>
          <Row style={{ justifyContent: "space-between", marginTop: space.sm }}>
            <Muted>Net pay</Muted>
            <Muted style={{ color: t.text, fontWeight: "700", fontSize: font.xl }}>
              {formatRupees(q.data.net_pay)}
            </Muted>
          </Row>
          <Row gap={space.sm} style={{ marginTop: space.sm }}>
            <Badge text={String(q.data.run_status ?? q.data.status ?? "")} tone="info" />
            <Subtle>version {String(q.data.version)}</Subtle>
          </Row>
          {/*
            The slip itself: days paid and unpaid (Sundays and holidays are
            paid days now, and shown as such), what the pay was worked out
            from, what came off, and loss of pay as the information it is --
            already outside gross, not a deduction. Grouped by the same
            function as the web slip and the PDF.
          */}
          {payslipSections(q.data).map((section) => (
            <View key={section.title}>
              <SectionLabel>{section.title}</SectionLabel>
              {section.rows.map((row) => (
                <Row key={row.key} style={{ justifyContent: "space-between", minHeight: 28 }}>
                  <Muted style={{ flex: 1 }}>{row.label}</Muted>
                  <Muted style={{ color: t.text, fontWeight: "600" }}>{row.value}</Muted>
                </Row>
              ))}
            </View>
          ))}
          <Row style={{ justifyContent: "space-between", marginTop: space.sm }}>
            <Muted>Gross</Muted>
            <Muted style={{ color: t.text }}>{formatRupees(q.data.gross)}</Muted>
          </Row>
          <Button
            title={busy ? "Preparing PDF…" : "Save payslip PDF"}
            icon="download-outline"
            variant="secondary"
            loading={busy}
            disabled={busy}
            style={{ marginTop: space.md }}
            onPress={() => void download()}
          />
        </>
      ) : null}
      {error ? <Subtle style={{ marginTop: space.sm }}>{error}</Subtle> : null}
    </Card>
  );
}
