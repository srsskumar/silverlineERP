/**
 * Projects (§4): delivery projects grouped by status, with a summary detail
 * sheet — status, dates, track (government/private), contract value, task
 * counts. This is the manager/field-lead view of "what projects exist and
 * what state are they in", not the desktop board editor: creating a project,
 * changing its status, custom fields, SLA policy and the task board itself
 * all stay on the web. A user's own task list is already the Tasks tab; this
 * screen never repeats it.
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, ScrollView, View } from "react-native";
import { PROJECT_STATUSES, day } from "@silverline/shared";
import { useAuth } from "../src/auth/AuthContext";
import { getProject, getProjects, type ProjectDetail } from "../src/api/endpoints";
import { formatProjectKind, projectStatusTone } from "../src/projectsFormat";
import { withScreenBoundary } from "../src/ui/ErrorBoundary";
import {
  BackHeader,
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  Input,
  ListRow,
  Loading,
  Muted,
  Row,
  Screen,
  SectionLabel,
  Subtle,
} from "../src/ui/primitives";
import { space, useTheme } from "../src/theme";
import { formatMoneyOrNull as money } from "../src/money";


function ProjectsScreen() {
  const { canDo } = useAuth();
  const canRead = canDo("project.read");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["projects", status, search],
    queryFn: () => getProjects({ status: status || undefined, q: search.trim() || undefined }),
    enabled: canRead,
  });
  const detail = useQuery({
    queryKey: ["project", selectedId],
    queryFn: () => getProject(selectedId!),
    enabled: Boolean(selectedId),
  });

  const rows = list.data ?? [];

  return (
    <Screen>
      <BackHeader title="Projects" onBack={() => router.back()} />
      <Muted style={{ marginBottom: space.lg }}>Delivery projects, by status.</Muted>

      {!canRead ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to projects"
          message="This screen needs the project.read permission."
        />
      ) : (
        <>
          <Input
            placeholder="Search by code or name"
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
          />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.md }}>
            <Row gap={space.sm}>
              <Button title="All" variant={status === "" ? "primary" : "secondary"} onPress={() => setStatus("")} />
              {PROJECT_STATUSES.map((s) => (
                <Button
                  key={s}
                  title={s}
                  variant={status === s ? "primary" : "secondary"}
                  onPress={() => setStatus(s)}
                />
              ))}
            </Row>
          </ScrollView>

          <Card>
            {list.isLoading ? (
              <Loading />
            ) : rows.length === 0 ? (
              <EmptyState icon="folder-outline" title="No projects found" />
            ) : (
              rows.map((p, i, arr) => (
                <ListRow
                  key={p.id}
                  title={`${p.code ?? ""} · ${p.name}`}
                  subtitle={
                    [formatProjectKind(p.project_kind), money(p.contract_value) ?? undefined, p.priority ?? undefined]
                      .filter(Boolean)
                      .join(" · ")
                  }
                  right={<Badge text={String(p.status)} tone={projectStatusTone(String(p.status))} />}
                  onPress={() => setSelectedId(p.id)}
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
          <BackHeader title="Project" onBack={() => setSelectedId(null)} />
          {detail.isLoading ? (
            <Loading />
          ) : !detail.data ? (
            <EmptyState icon="alert-circle-outline" title="Could not load this project" />
          ) : (
            <ProjectDetailView project={detail.data} />
          )}
        </Screen>
      </Modal>
    </Screen>
  );
}

function ProjectDetailView({ project }: { project: ProjectDetail }) {
  const t = useTheme();
  const counts = project.counts ?? { total: 0, open: 0, done: 0 };
  return (
    <View>
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Muted style={{ color: t.text, fontWeight: "700", flex: 1 }}>{project.name}</Muted>
          <Badge text={String(project.status)} tone={projectStatusTone(String(project.status))} />
        </Row>
        <Subtle style={{ marginTop: space.xs }}>{project.code}</Subtle>
        <Divider />
        {formatProjectKind(project.project_kind) ? (
          <Field label="Track" value={formatProjectKind(project.project_kind)!} />
        ) : null}
        {project.priority ? <Field label="Priority" value={String(project.priority)} /> : null}
        {money(project.contract_value) ? <Field label="Contract value" value={money(project.contract_value)!} /> : null}
        {project.planned_start_date ? <Field label="Start" value={day(project.planned_start_date)} /> : null}
        {project.planned_end_date ? <Field label="Due" value={day(project.planned_end_date)} /> : null}
        {project.work_order_number ? <Field label="Work order" value={String(project.work_order_number)} /> : null}
        {project.description ? <Field label="Description" value={String(project.description)} /> : null}
      </Card>

      <SectionLabel>Tasks</SectionLabel>
      <Card>
        <Row style={{ justifyContent: "space-around" }}>
          <CountTile label="Total" value={counts.total} />
          <CountTile label="Open" value={counts.open} tone={counts.open > 0 ? "warning" : undefined} />
          <CountTile label="Done" value={counts.done} tone="success" />
        </Row>
      </Card>
      <Divider />
    </View>
  );
}

function CountTile({ label, value, tone }: { label: string; value: number; tone?: "success" | "warning" }) {
  const t = useTheme();
  const color = tone === "success" ? t.success : tone === "warning" ? t.warning : t.text;
  return (
    <View style={{ alignItems: "center" }}>
      <Muted style={{ color, fontSize: 22, fontWeight: "700" }}>{value}</Muted>
      <Subtle>{label}</Subtle>
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

export default withScreenBoundary(ProjectsScreen);
