/**
 * Planning (§4, cycle.read + project.read, nav.ts's /planning): the web page
 * behind this is a full sprint-planning workbench — calendar/timeline views,
 * drag-to-schedule, a workflow editor, custom fields and an SLA-policy editor,
 * all keyed off one selected project. None of that is a phone task: dragging
 * tasks onto calendar cells or editing a workflow graph needs a mouse and a
 * wide screen, and Silverline's field leads do not do that work from a phone.
 *
 * What *is* useful on a phone: "what iteration is project X in right now,
 * and what's next" — a quick check before or during a site visit. So this
 * screen is read-only: pick a project, see its cycles grouped into
 * active/upcoming/closed with each cycle's dates and (once closed) its
 * planned/done/remaining counts. Starting or closing a cycle, and everything
 * task-level, stays on the web.
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { View } from "react-native";
import { day } from "@silverline/shared";
import { codeLabel } from "../src/labels";
import { useAuth } from "../src/auth/AuthContext";
import { getCycles, getProjects, type Cycle } from "../src/api/endpoints";
import { cycleMetricsSummary, cycleStatusTone, groupCycles } from "../src/planningFormat";
import { withScreenBoundary } from "../src/ui/ErrorBoundary";
import { listState } from "../src/listState";
import { LoadError } from "../src/ui/LoadError";
import {
  BackHeader,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  ListRow,
  Loading,
  Muted,
  Row,
  Screen,
  SectionLabel,
} from "../src/ui/primitives";
import { space } from "../src/theme";

function PlanningScreen() {
  const { canDo } = useAuth();
  const canRead = canDo("cycle.read") && canDo("project.read");
  const [search, setSearch] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);

  const projects = useQuery({
    queryKey: ["projects", "planning", search],
    queryFn: () => getProjects({ q: search.trim() || undefined }),
    enabled: canRead && !projectId,
  });
  const cycles = useQuery({
    queryKey: ["cycles", projectId],
    queryFn: () => getCycles(projectId!),
    enabled: canRead && Boolean(projectId),
  });

  const selectedProject = projects.data?.find((p) => p.id === projectId);

  return (
    <Screen>
      <BackHeader title="Planning" onBack={() => router.back()} />
      <Muted style={{ marginBottom: space.lg }}>Cycles for a project — what's active, what's next.</Muted>

      {!canRead ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to planning"
          message="This screen needs the cycle.read and project.read permissions."
        />
      ) : !projectId ? (
        <>
          <Input
            placeholder="Search projects by code or name"
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
          />
          <SectionLabel>Choose a project</SectionLabel>
          <Card>
            {listState(projects, (projects.data ?? []).length) === "loading" ? (
              <Loading />
            ) : listState(projects, (projects.data ?? []).length) === "error" ? (
              <LoadError error={projects.error} what="projects" />
            ) : (projects.data ?? []).length === 0 ? (
              <EmptyState icon="folder-outline" title="No projects found" />
            ) : (
              (projects.data ?? []).map((p, i, arr) => (
                <ListRow
                  key={p.id}
                  title={`${p.code ?? ""} · ${p.name}`}
                  subtitle={p.status ? codeLabel(String(p.status)) : undefined}
                  onPress={() => setProjectId(p.id)}
                  last={i === arr.length - 1}
                />
              ))
            )}
          </Card>
        </>
      ) : (
        <>
          <Row style={{ justifyContent: "space-between", alignItems: "center", marginBottom: space.md }}>
            <Muted style={{ flex: 1 }}>{selectedProject ? `${selectedProject.code ?? ""} · ${selectedProject.name}` : "Project"}</Muted>
            <Button title="Change project" variant="secondary" onPress={() => setProjectId(null)} />
          </Row>
          {listState(cycles, (cycles.data ?? []).length) === "loading" ? (
            <Loading />
          ) : listState(cycles, (cycles.data ?? []).length) === "error" ? (
            <LoadError error={cycles.error} what="cycles" />
          ) : (
            <CycleGroups cycles={cycles.data ?? []} />
          )}
        </>
      )}
    </Screen>
  );
}

function CycleGroups({ cycles }: { cycles: Cycle[] }) {
  const grouped = groupCycles(cycles);
  if (cycles.length === 0) {
    return <EmptyState icon="calendar-outline" title="No cycles yet" message="This project has no planning iterations." />;
  }
  return (
    <View>
      {grouped.active.length > 0 ? (
        <>
          <SectionLabel>Active</SectionLabel>
          <Card>
            {grouped.active.map((c, i, arr) => (
              <CycleRow key={c.id} cycle={c} last={i === arr.length - 1} />
            ))}
          </Card>
        </>
      ) : null}
      {grouped.planned.length > 0 ? (
        <>
          <SectionLabel>Upcoming</SectionLabel>
          <Card>
            {grouped.planned.map((c, i, arr) => (
              <CycleRow key={c.id} cycle={c} last={i === arr.length - 1} />
            ))}
          </Card>
        </>
      ) : null}
      {grouped.closed.length > 0 ? (
        <>
          <SectionLabel>Closed</SectionLabel>
          <Card>
            {grouped.closed.map((c, i, arr) => (
              <CycleRow key={c.id} cycle={c} last={i === arr.length - 1} />
            ))}
          </Card>
        </>
      ) : null}
    </View>
  );
}

function CycleRow({ cycle, last }: { cycle: Cycle; last: boolean }) {
  return (
    <ListRow
      title={cycle.name}
      subtitle={
        [
          `${day(cycle.start_date)} – ${day(cycle.end_date)}`,
          cycle.goal ?? undefined,
          cycleMetricsSummary(cycle.metrics) ?? undefined,
        ]
          .filter(Boolean)
          .join(" · ")
      }
      right={<Badge text={codeLabel(cycle.status)} tone={cycleStatusTone(cycle.status)} />}
      last={last}
    />
  );
}

export default withScreenBoundary(PlanningScreen);
