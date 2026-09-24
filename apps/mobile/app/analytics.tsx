/**
 * Analytics: a project's throughput, workload and delivery-risk advisory,
 * read-only.
 *
 * The web page (apps/web/app/analytics/page.tsx) also draws a 30-day
 * burndown as an inline SVG polyline and takes feedback on the advisory
 * through a small form. Both are left off the phone on purpose: a chart
 * whose only content is its shape is a poor fit for a small screen, and
 * feedback capture is a desktop-workbench action, not a lookup. What is
 * genuinely structured data — the summary counters, flow by status, team
 * workload and cycle progress, plus the plain-text delivery advisory — is a
 * stat-tile view here, same numbers the web page shows.
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollView } from "react-native";
import { useAuth } from "../src/auth/AuthContext";
import { getProjectAnalytics, getProjectInsights, getProjects } from "../src/api/endpoints";
import { delayRiskTone, formatConfidence } from "../src/analyticsFormat";
import { withScreenBoundary } from "../src/ui/ErrorBoundary";
import { usePullRefresh } from "../src/ui/usePullRefresh";
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
  StatTile,
  Subtle,
} from "../src/ui/primitives";
import { radius, space } from "../src/theme";
import { day } from "@silverline/shared";
import { codeLabel } from "../src/labels";

function AnalyticsScreen() {
  const { canDo } = useAuth();
  const canRead = canDo(["analytics.read", "project.read"]);
  const [projectId, setProjectId] = useState<string | null>(null);

  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => getProjects(),
    enabled: canRead,
  });
  const openProjects = (projects.data ?? []).filter(
    (p) => !["CLOSED", "CANCELLED"].includes(p.status ?? ""),
  );

  const metrics = useQuery({
    queryKey: ["project-analytics", projectId],
    queryFn: () => getProjectAnalytics(projectId!),
    enabled: canRead && Boolean(projectId),
  });
  const insights = useQuery({
    queryKey: ["project-insights", projectId],
    queryFn: () => getProjectInsights(projectId!),
    enabled: canRead && Boolean(projectId),
  });

  const data = metrics.data;

  const pull = usePullRefresh(canRead && projects, canRead && Boolean(projectId) && metrics, canRead && Boolean(projectId) && insights);


  return (
    <Screen refresh={pull}>
      <BackHeader title="Analytics" onBack={() => router.back()} />
      <Muted style={{ marginBottom: space.lg }}>
        Throughput, workload and delivery risk, from operational records.
      </Muted>

      {!canRead ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to analytics"
          message="This screen needs the analytics.read and project.read permissions."
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
            <EmptyState icon="stats-chart-outline" title="Choose a project" message="Its metrics show here." />
          ) : metrics.isLoading ? (
            <Loading />
          ) : !data ? (
            <LoadError query={metrics} what="analytics" />
          ) : (
            <>
              <Row gap={space.sm} style={{ flexWrap: "wrap", marginBottom: space.md }}>
                <StatTile label="Total tasks" value={String(data.summary.total)} />
                <StatTile label="Completed" value={String(data.summary.completed)} tone="success" />
                <StatTile
                  label="Blocked"
                  value={String(data.summary.blocked)}
                  tone={data.summary.blocked > 0 ? "danger" : "success"}
                />
                <StatTile
                  label="Overdue"
                  value={String(data.summary.overdue)}
                  tone={data.summary.overdue > 0 ? "danger" : "success"}
                />
                {data.summary.cycle_time_days !== null ? (
                  <StatTile label="Cycle time" value={`${data.summary.cycle_time_days}d`} />
                ) : null}
                {data.summary.lead_time_days !== null ? (
                  <StatTile label="Lead time" value={`${data.summary.lead_time_days}d`} />
                ) : null}
              </Row>

              {data.flow.length > 0 ? (
                <>
                  <SectionLabel>Flow by status</SectionLabel>
                  <Card>
                    {data.flow.map((f, i, arr) => (
                      <ListRow
                        key={f.status}
                        title={codeLabel(f.status)}
                        subtitle={f.average_age_days !== null ? `Average age: ${f.average_age_days} days` : undefined}
                        right={<Badge text={String(f.count)} tone="neutral" />}
                        last={i === arr.length - 1}
                      />
                    ))}
                  </Card>
                </>
              ) : null}

              {data.workload.length > 0 ? (
                <>
                  <SectionLabel>Team workload</SectionLabel>
                  <Card>
                    {data.workload.map((w, i, arr) => (
                      <ListRow
                        key={w.assignee_id ?? `unassigned-${i}`}
                        title={w.name ?? w.username ?? "Unassigned"}
                        subtitle={`${w.open} open · ${w.overdue} overdue`}
                        right={w.overdue > 0 ? <Badge text="OVERDUE" tone="danger" /> : undefined}
                        last={i === arr.length - 1}
                      />
                    ))}
                  </Card>
                </>
              ) : null}

              {data.cycles.length > 0 ? (
                <>
                  <SectionLabel>Cycle velocity</SectionLabel>
                  <Card>
                    {data.cycles.map((c, i, arr) => (
                      <ListRow
                        key={c.id}
                        title={c.name}
                        subtitle={
                          c.metrics
                            ? `${c.metrics.completed ?? 0} completed / ${c.metrics.planned ?? 0} planned`
                            : c.status
                        }
                        last={i === arr.length - 1}
                      />
                    ))}
                  </Card>
                </>
              ) : null}

              {insights.data ? (
                <>
                  <SectionLabel>Delivery advisory</SectionLabel>
                  <Card>
                    {insights.data.status === "INSUFFICIENT_DATA" ? (
                      <Muted>Insufficient data for an advisory yet.</Muted>
                    ) : (
                      <>
                        <Row style={{ justifyContent: "space-between" }}>
                          <Muted style={{ fontWeight: "700" }}>
                            {insights.data.prediction?.delay_risk} delay risk
                          </Muted>
                          <Badge
                            text={insights.data.prediction?.delay_risk ?? "—"}
                            tone={delayRiskTone(insights.data.prediction?.delay_risk)}
                          />
                        </Row>
                        <Subtle style={{ marginTop: space.xs }}>{insights.data.recommended_action}</Subtle>
                        <Subtle style={{ marginTop: space.sm }}>
                          {insights.data.model_version} · {day(insights.data.prediction_timestamp)} · Confidence:{" "}
                          {formatConfidence(insights.data.confidence)} · Advisory only
                        </Subtle>
                      </>
                    )}
                  </Card>
                </>
              ) : null}
            </>
          )}
        </>
      )}
    </Screen>
  );
}

export default withScreenBoundary(AnalyticsScreen);
