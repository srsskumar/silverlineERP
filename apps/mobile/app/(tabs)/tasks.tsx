/**
 * Tasks: searchable list with a detail sheet (forward-only status advance with
 * If-Match, comments, evidence capture) and quick-add.
 *
 * Deep link: /(tabs)/tasks?taskId=<id> opens the detail sheet, which is how a
 * push notification lands the user on the right task.
 */
import { withScreenBoundary } from "../../src/ui/ErrorBoundary";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, ScrollView, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../../src/auth/AuthContext";
import { EvidenceCapture } from "../../src/device/EvidenceCapture";
import { submitQueued } from "../../src/sync/engine";
import {
  getProjects,
  getTask,
  getTaskComments,
  getTasks,
  type Task,
} from "../../src/api/endpoints";
import { validateComment, validateTaskCreate } from "../../src/validators";
import {
  Badge,
  Banner,
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
  Title,
} from "../../src/ui/primitives";
import { radius, space, useTheme } from "../../src/theme";

function statusTone(status: string): "success" | "warning" | "info" | "neutral" {
  if (status === "DONE") return "success";
  if (status === "BLOCKED") return "warning";
  if (status === "IN_PROGRESS" || status === "IN_REVIEW") return "info";
  return "neutral";
}

function TasksScreen() {
  const params = useLocalSearchParams<{ taskId?: string }>();
  const [search, setSearch] = useState("");
  const [onlyMine, setOnlyMine] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(
    typeof params.taskId === "string" ? params.taskId : null,
  );
  const { canDo } = useAuth();
  const projects = useQuery({ queryKey: ["projects"], queryFn: getProjects });
  const [quickProject, setQuickProject] = useState("");
  const [quickTitle, setQuickTitle] = useState("");
  const [quickMsg, setQuickMsg] = useState<string | null>(null);
  const [quickBusy, setQuickBusy] = useState(false);
  const [showQuickAdd, setShowQuickAdd] = useState(false);

  const list = useQuery({
    queryKey: ["tasks", onlyMine ? "mine" : "all"],
    queryFn: () => getTasks({ assignee_me: onlyMine || undefined, limit: 50 }),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const items = list.data?.items ?? [];
    if (!q) return items;
    return items.filter(
      (t) => t.title.toLowerCase().includes(q) || t.status.toLowerCase().includes(q),
    );
  }, [list.data, search]);

  const quickAdd = async () => {
    setQuickMsg(null);
    setQuickBusy(true);
    try {
      if (!quickProject) throw new Error("Select the project for this task");
      const v = validateTaskCreate({ project_id: quickProject, title: quickTitle });
      if (!v.ok) {
        setQuickMsg(v.errors.map((e) => e.message).join("; "));
        return;
      }
      setQuickMsg(
        await submitQueued({
          entity: "task_create",
          op: `quickadd:${Date.now()}`,
          payload: { project_id: quickProject, title: quickTitle.trim() },
        }),
      );
      setQuickTitle("");
      void list.refetch();
    } catch (e) {
      setQuickMsg(e instanceof Error ? e.message : "Quick-add failed");
    } finally {
      setQuickBusy(false);
    }
  };

  const openProjects = (projects.data ?? []).filter(
    (p) => !["CLOSED", "CANCELLED"].includes(p.status ?? ""),
  );

  return (
    <Screen>
      <Row style={{ justifyContent: "space-between" }}>
        <Title>Tasks</Title>
        {canDo("task.create") ? (
          <Button
            title={showQuickAdd ? "Cancel" : "Add"}
            icon={showQuickAdd ? "close-outline" : "add-outline"}
            variant={showQuickAdd ? "secondary" : "primary"}
            onPress={() => setShowQuickAdd((v) => !v)}
          />
        ) : null}
      </Row>
      <Muted style={{ marginTop: 2, marginBottom: space.lg }}>
        {onlyMine ? "Assigned to you" : "Everything in your scope"}
      </Muted>

      {showQuickAdd && canDo("task.create") ? (
        <Card title="New task">
          <Subtle style={{ marginBottom: space.xs }}>Project</Subtle>
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
                    variant={quickProject === p.id ? "primary" : "secondary"}
                    onPress={() => setQuickProject(p.id)}
                    style={{ borderRadius: radius.pill, minHeight: 36, paddingHorizontal: space.md }}
                  />
                ))}
              </Row>
            </ScrollView>
          )}
          <Input
            placeholder="What needs doing?"
            value={quickTitle}
            onChangeText={setQuickTitle}
            onSubmitEditing={() => void quickAdd()}
          />
          <Button
            title="Add task"
            icon="add-outline"
            loading={quickBusy}
            disabled={quickBusy || !quickTitle.trim() || !quickProject}
            onPress={() => void quickAdd()}
          />
          {quickMsg ? <Subtle style={{ marginTop: space.sm }}>{quickMsg}</Subtle> : null}
        </Card>
      ) : null}

      <Card>
        <Input placeholder="Search tasks…" value={search} onChangeText={setSearch} />
        <Row gap={space.sm}>
          <Button
            title="Mine"
            variant={onlyMine ? "primary" : "secondary"}
            onPress={() => setOnlyMine(true)}
            style={{ flex: 1, borderRadius: radius.pill, minHeight: 36 }}
          />
          <Button
            title="All"
            variant={!onlyMine ? "primary" : "secondary"}
            onPress={() => setOnlyMine(false)}
            style={{ flex: 1, borderRadius: radius.pill, minHeight: 36 }}
          />
        </Row>
      </Card>

      <SectionLabel>{filtered.length} {filtered.length === 1 ? "task" : "tasks"}</SectionLabel>
      <Card>
        {list.isLoading ? (
          <Loading />
        ) : list.isError ? (
          <EmptyState
            icon="cloud-offline-outline"
            title="Could not load tasks"
            message="You may be offline. Cached tasks show when available."
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon="checkmark-done-outline"
            title={search ? "No matches" : "Nothing assigned"}
            message={search ? "Try a different search." : "Tasks assigned to you appear here."}
          />
        ) : (
          filtered.map((t, i, arr) => (
            <ListRow
              key={t.id}
              title={t.title}
              subtitle={typeof t.due_date === "string" ? `Due ${t.due_date}` : undefined}
              right={<Badge text={t.status} tone={statusTone(t.status)} />}
              onPress={() => setSelectedId(t.id)}
              last={i === arr.length - 1}
            />
          ))
        )}
      </Card>

      <TaskSheet
        taskId={selectedId}
        onClose={() => {
          setSelectedId(null);
          void list.refetch();
        }}
      />
    </Screen>
  );
}

function TaskSheet({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  const t = useTheme();
  const [comment, setComment] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const detail = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => getTask(taskId as string),
    enabled: taskId !== null,
  });
  const comments = useQuery({
    queryKey: ["task-comments", taskId],
    queryFn: () => getTaskComments(taskId as string),
    enabled: taskId !== null,
  });

  const advance = async (next: string) => {
    setMsg(null);
    const task: Task | undefined = detail.data;
    if (!task) return;
    setBusy(true);
    try {
      setMsg(
        await submitQueued({
          entity: "task_status",
          op: `status:${task.id}`,
          payload: { task_id: task.id, status: next, version: task.version },
          baseVersion: task.version,
        }),
      );
      await detail.refetch();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Advance failed");
    } finally {
      setBusy(false);
    }
  };

  const sendComment = async () => {
    setMsg(null);
    const task = detail.data;
    if (!task) return;
    const v = validateComment(comment);
    if (!v.ok) {
      setMsg(v.errors[0]?.message ?? "Invalid comment");
      return;
    }
    setBusy(true);
    try {
      setMsg(
        await submitQueued({
          entity: "task_comment",
          op: `comment:${task.id}:${Date.now()}`,
          payload: { task_id: task.id, body: comment.trim() },
        }),
      );
      setComment("");
      await comments.refetch();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Comment failed");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    setComment("");
    setMsg(null);
    setCapturing(false);
  }, [taskId]);

  const task = detail.data;
  const nextSteps = task?.allowed_next ?? [];

  return (
    <Modal visible={taskId !== null} animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <View style={{ flex: 1, backgroundColor: t.canvas }}>
        {/* Sheet header: a fixed bar keeps Close reachable while the body scrolls. */}
        <Row
          style={{
            justifyContent: "space-between",
            paddingHorizontal: space.lg,
            paddingVertical: space.md,
            borderBottomWidth: 1,
            borderBottomColor: t.border,
            backgroundColor: t.surface,
          }}
        >
          <Muted style={{ color: t.text, fontWeight: "700" }}>Task</Muted>
          <Button title="Close" variant="ghost" icon="close-outline" onPress={onClose} />
        </Row>

        <ScrollView
          contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2 }}
          keyboardShouldPersistTaps="handled"
        >
          {detail.isLoading ? <Loading /> : null}
          {task ? (
            <>
              <Card>
                <Muted style={{ color: t.text, fontWeight: "700", fontSize: 17 }}>
                  {task.title}
                </Muted>
                <Row gap={space.sm} style={{ marginTop: space.sm }}>
                  <Badge text={task.status} tone={statusTone(task.status)} />
                  <Subtle>version {task.version}</Subtle>
                </Row>

                {nextSteps.length > 0 ? (
                  <>
                    <Divider />
                    <Subtle style={{ marginBottom: space.sm }}>Move to</Subtle>
                    <View style={{ gap: space.sm }}>
                      {nextSteps.map((n) => (
                        <Button
                          key={n}
                          title={n.replaceAll("_", " ")}
                          icon="arrow-forward-outline"
                          loading={busy}
                          disabled={busy}
                          onPress={() => void advance(n)}
                        />
                      ))}
                    </View>
                  </>
                ) : (
                  <Subtle style={{ marginTop: space.md }}>
                    No transition available from this status.
                  </Subtle>
                )}
              </Card>

              {msg ? (
                <Banner tone="info" icon="information-circle-outline" title={msg} />
              ) : null}

              <SectionLabel>Evidence</SectionLabel>
              <Card>
                <Muted>
                  Capture a photo with the employee, GPS, date and project burned into the
                  image. It syncs when a connection is available.
                </Muted>
                <Button
                  title="Attach photo"
                  icon="camera-outline"
                  variant="secondary"
                  style={{ marginTop: space.md }}
                  onPress={() => setCapturing(true)}
                />
                {capturing ? (
                  <EvidenceCapture
                    task={task}
                    onClose={() => setCapturing(false)}
                    onSaved={(message) => {
                      setMsg(message);
                      setCapturing(false);
                    }}
                  />
                ) : null}
              </Card>

              <SectionLabel>Comments</SectionLabel>
              <Card>
                {(comments.data ?? []).length === 0 ? (
                  <EmptyState icon="chatbubble-outline" title="No comments yet" />
                ) : (
                  (comments.data ?? []).map((c) => (
                    <View key={c.id} style={{ marginBottom: space.md }}>
                      <Muted style={{ color: t.text }}>{c.body}</Muted>
                      <Subtle>
                        {c.author_username ?? "?"} · {c.created_at ?? ""}
                      </Subtle>
                    </View>
                  ))
                )}
                <Divider />
                <Input
                  placeholder="Add a comment… @mentions work"
                  value={comment}
                  onChangeText={setComment}
                  multiline
                  style={{ minHeight: 72, paddingTop: space.md, textAlignVertical: "top" }}
                />
                <Button
                  title="Send"
                  icon="send-outline"
                  loading={busy}
                  disabled={busy || !comment.trim()}
                  onPress={() => void sendComment()}
                />
              </Card>
            </>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

// Contained per screen: a render error here shows the recovery card in the
// content area while the tab bar and navigation stay usable, instead of
// unmounting the navigator and dropping the user back on Home.
export default withScreenBoundary(TasksScreen);
