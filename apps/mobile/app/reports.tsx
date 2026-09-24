/**
 * Reports (§6, report.generate, nav.ts's /reports): the web page is a
 * type picker that generates a csv/xlsx/pdf export plus a recurring-schedule
 * editor that emails those on a timer. A phone has no useful place to put a
 * "schedule this to run every Monday" form — the result still lands in the
 * same report list either way — so mobile only does the one-off case:
 * pick a type this user is allowed to run, generate it, and save/share it.
 *
 * Mobile always asks the server for a pdf. That is the one binary
 * content-type api/client.ts already unwraps to bytes (see src/ui/Payslip.tsx's
 * payslip download) — reusing that path means a generated report can be
 * saved with no change to the shared fetch wrapper. A csv/xlsx report created
 * elsewhere (a desktop recurring schedule, say) still lists under "Your
 * reports" with its status; there is just no working Save button for it here
 * (reportsFormat.ts's reportCanDownload says so), since csv/xlsx bytes are
 * not something this build's fetch wrapper hands back.
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { View } from "react-native";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { randomUUID } from "expo-crypto";
import { dayTime } from "@silverline/shared";
import { codeLabel } from "../src/labels";
import { describeApiError } from "../src/errorFormat";
import { useAuth } from "../src/auth/AuthContext";
import { REPORT_TYPE_META, getReportPdf, getReports, postReport, type ReportJob } from "../src/api/endpoints";
import { availableReportTypes, reportCanDownload, reportStatusTone } from "../src/reportsFormat";
import { withScreenBoundary } from "../src/ui/ErrorBoundary";
import { listState } from "../src/listState";
import { LoadError } from "../src/ui/LoadError";
import {
  BackHeader,
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  ListRow,
  Loading,
  Muted,
  Row,
  Screen,
  SectionLabel,
} from "../src/ui/primitives";
import { space } from "../src/theme";

function ReportsScreen() {
  const { permissions } = useAuth();
  const qc = useQueryClient();
  const types = availableReportTypes(permissions, REPORT_TYPE_META);
  const [type, setType] = useState(types[0]?.type ?? "");
  const [generating, setGenerating] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({ queryKey: ["reports"], queryFn: getReports });

  const generate = async () => {
    if (!type) return;
    setGenerating(true);
    setError(null);
    setNote(null);
    try {
      const job = await postReport(type);
      setNote(
        job.status === "READY"
          ? "Report is ready below — tap it to save."
          : "Report queued — it will finish shortly. Check back here.",
      );
      void qc.invalidateQueries({ queryKey: ["reports"] });
    } catch (e) {
      setError(describeApiError(e, "Could not generate this report."));
    } finally {
      setGenerating(false);
    }
  };

  const save = async (report: ReportJob) => {
    setSavingId(report.id);
    setError(null);
    let file: File | undefined;
    try {
      if (!(await Sharing.isAvailableAsync())) {
        throw new Error("File export is unavailable on this device.");
      }
      const bytes = await getReportPdf(report.download_url);
      file = new File(Paths.cache, `silverline-report-${randomUUID()}.pdf`);
      file.create();
      file.write(bytes);
      await Sharing.shareAsync(file.uri, {
        mimeType: "application/pdf",
        dialogTitle: "Save this report",
        UTI: "com.adobe.pdf",
      });
    } catch (e) {
      setError(describeApiError(e, "Could not save this report."));
    } finally {
      if (file?.exists) file.delete();
      setSavingId(null);
    }
  };

  return (
    <Screen>
      <BackHeader title="Reports" onBack={() => router.back()} />
      <Muted style={{ marginBottom: space.lg }}>
        Generate a one-off report. Recurring schedules and csv/xlsx exports stay on the web.
      </Muted>

      {types.length === 0 ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No reports available"
          message="This screen needs report.generate plus permission to read at least one report's data."
        />
      ) : (
        <>
          <Card title="Generate a report">
            <Row gap={space.sm} style={{ flexWrap: "wrap" }}>
              {types.map((m) => (
                <Button
                  key={m.type}
                  title={m.label}
                  variant={type === m.type ? "primary" : "secondary"}
                  onPress={() => setType(m.type)}
                />
              ))}
            </Row>
            <Button
              title="Generate PDF"
              icon="document-text-outline"
              loading={generating}
              disabled={generating || !type}
              onPress={() => void generate()}
              style={{ marginTop: space.md }}
            />
          </Card>

          {note ? <Banner tone="success" icon="checkmark-circle-outline" title={note} /> : null}
          {error ? <Banner tone="danger" icon="alert-circle-outline" title={error} /> : null}

          <SectionLabel>Your reports</SectionLabel>
          <Card>
            {listState(list, (list.data?.items ?? []).length) === "loading" ? (
              <Loading />
            ) : listState(list, (list.data?.items ?? []).length) === "error" ? (
              <LoadError error={list.error} what="your reports" />
            ) : (list.data?.items ?? []).length === 0 ? (
              <EmptyState icon="document-outline" title="No reports yet" />
            ) : (
              (list.data?.items ?? []).map((r, i, arr) => {
                const canDownload = reportCanDownload(r);
                return (
                  <ListRow
                    key={r.id}
                    title={REPORT_TYPE_META.find((m) => m.type === r.type)?.label ?? r.type}
                    subtitle={
                      [
                        `${String(r.format ?? "").toUpperCase()} · ${r.rows} rows`,
                        r.created_at ? dayTime(r.created_at) : undefined,
                        r.error ?? undefined,
                        !canDownload && r.status === "READY" ? "View on desktop (not a pdf)" : undefined,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    }
                    right={<Badge text={codeLabel(r.status)} tone={reportStatusTone(r.status)} />}
                    onPress={canDownload ? () => void save(r) : undefined}
                    last={i === arr.length - 1}
                  />
                );
              })
            )}
          </Card>
          {savingId ? (
            <View style={{ marginTop: space.sm }}>
              <Loading />
            </View>
          ) : null}
        </>
      )}
    </Screen>
  );
}

export default withScreenBoundary(ReportsScreen);
