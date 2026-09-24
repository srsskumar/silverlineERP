/**
 * Automation: work rules (trigger → conditions → actions), read-only.
 *
 * Authoring a rule needs its own condition/action editor (fields, target
 * pickers, permission checks per action type) — that stays on the web
 * (apps/web/app/automation/page.tsx). This is the phone lookup: pick a
 * project, see what rules fire on it, whether each is on, and — tapping
 * one — its trigger, conditions, actions and recent run history. There is
 * no enable/disable toggle here: PATCH /automation-rules/:id validates the
 * whole rule body (automationSchema), not a single field, so it is not the
 * trivial toggle this round's brief allows onto the phone; it stays behind
 * automation.manage on web.
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, ScrollView } from "react-native";
import { useAuth } from "../src/auth/AuthContext";
import {
  getAutomationExecutions,
  getAutomationRules,
  getProjects,
  type AutomationRule,
} from "../src/api/endpoints";
import { actionLabel, executionStatusTone, triggerLabel } from "../src/automationFormat";
import { withScreenBoundary } from "../src/ui/ErrorBoundary";
import { usePullRefresh } from "../src/ui/usePullRefresh";
import { listState } from "../src/listState";
import { LoadError } from "../src/ui/LoadError";
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
import { day, dayTime } from "@silverline/shared";
import { codeLabel } from "../src/labels";

function AutomationScreen() {
  const { canDo } = useAuth();
  const canRead = canDo("automation.read");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [selected, setSelected] = useState<AutomationRule | null>(null);

  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => getProjects(),
    enabled: canRead,
  });
  const openProjects = (projects.data ?? []).filter(
    (p) => !["CLOSED", "CANCELLED"].includes(p.status ?? ""),
  );

  const rules = useQuery({
    queryKey: ["automation-rules", projectId],
    queryFn: () => getAutomationRules(projectId!),
    enabled: canRead && Boolean(projectId),
  });

  const rows = rules.data ?? [];

  const pull = usePullRefresh(canRead && projects, canRead && Boolean(projectId) && rules);


  return (
    <Screen refresh={pull}>
      <BackHeader title="Automation" onBack={() => router.back()} />
      <Muted style={{ marginBottom: space.lg }}>
        What rules fire on a project, and what each one does.
      </Muted>

      {!canRead ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to automation"
          message="This screen needs the automation.read permission."
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
            <EmptyState icon="git-branch-outline" title="Choose a project" message="Its automation rules show here." />
          ) : (
            <>
              <SectionLabel>Rules</SectionLabel>
              <Card>
                {listState(rules, rows.length) === "loading" ? (
                  <Loading />
                ) : listState(rules, rows.length) === "error" ? (
                  <LoadError query={rules} what="the rules" />
                ) : rows.length === 0 ? (
                  <EmptyState icon="git-branch-outline" title="No rules on this project" />
                ) : (
                  rows.map((r, i, arr) => (
                    <ListRow
                      key={r.id}
                      title={r.name}
                      subtitle={
                        `${triggerLabel(r.trigger)}` +
                        (r.last_run_at ? ` · last ran ${day(r.last_run_at)}` : " · never ran")
                      }
                      right={<Badge text={r.active ? "Active" : "Off"} tone={r.active ? "success" : "neutral"} />}
                      onPress={() => setSelected(r)}
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
        visible={Boolean(selected)}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSelected(null)}
      >
        {selected ? <RuleDetail rule={selected} onClose={() => setSelected(null)} /> : null}
      </Modal>
    </Screen>
  );
}

function RuleDetail({ rule, onClose }: { rule: AutomationRule; onClose: () => void }) {
  const t = useTheme();
  const executions = useQuery({
    queryKey: ["automation-executions", rule.id],
    queryFn: () => getAutomationExecutions(rule.id),
  });

  return (
    <Screen>
      <BackHeader title={rule.name} onBack={onClose} />
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Muted style={{ color: t.text, fontWeight: "700" }}>{triggerLabel(rule.trigger)}</Muted>
          <Badge text={rule.active ? "Active" : "Off"} tone={rule.active ? "success" : "neutral"} />
        </Row>
        <Subtle style={{ marginTop: space.xs }}>
          {rule.last_run_at ? `Last ran ${day(rule.last_run_at)}` : "Never run"}
        </Subtle>
      </Card>

      {rule.conditions.length > 0 ? (
        <>
          <SectionLabel>Only when</SectionLabel>
          <Card>
            {rule.conditions.map((c, i, arr) => (
              <ListRow
                key={`${c.field}:${i}`}
                title={c.field.replaceAll("_", " ")}
                subtitle={c.value}
                last={i === arr.length - 1}
              />
            ))}
          </Card>
        </>
      ) : null}

      <SectionLabel>Then</SectionLabel>
      <Card>
        {rule.actions.map((a, i, arr) => (
          <ListRow key={`${a.type}:${i}`} title={actionLabel(a)} last={i === arr.length - 1} />
        ))}
      </Card>

      <SectionLabel>Recent runs</SectionLabel>
      <Card>
        {listState(executions, (executions.data ?? []).length) === "loading" ? (
          <Loading />
        ) : listState(executions, (executions.data ?? []).length) === "error" ? (
          <LoadError query={executions} what="recent runs" />
        ) : (executions.data ?? []).length === 0 ? (
          <EmptyState icon="time-outline" title="No runs recorded yet" />
        ) : (
          (executions.data ?? []).map((e, i, arr) => (
            <ListRow
              key={e.id}
              title={dayTime(e.created_at)}
              subtitle={`${e.results.length} action${e.results.length === 1 ? "" : "s"}`}
              right={<Badge text={codeLabel(e.status)} tone={executionStatusTone(e.status)} />}
              last={i === arr.length - 1}
            />
          ))
        )}
      </Card>
      <Divider />
    </Screen>
  );
}

export default withScreenBoundary(AutomationScreen);
