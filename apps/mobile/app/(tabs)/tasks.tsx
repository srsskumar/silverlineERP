import {useAuth} from "../../src/auth/AuthContext";
import {EvidenceCapture} from "../../src/device/EvidenceCapture";
import { submitQueued } from "../../src/sync/engine";
/**
 * Tasks: list w/ local search + detail modal (stepper / fwd-only status
 * advance with If-Match, comment, evidence photo button) + quick-add.
 * Deep link: /(tabs)/tasks?taskId=<id> opens the detail modal (from push).
 */
import { useEffect,useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { ApiError } from "../../src/api/client";
import {
  getProjects,
  getTask,
  getTaskComments,
  getTasks,
  patchTaskStatus,
  postTask,
  postTaskComment,
  type Task,
} from "../../src/api/endpoints";
import { validateComment, validateTaskCreate } from "../../src/validators";
import { enqueueOp } from "../../src/sync/queue";
import { Card, Pill, useStyles } from "../../src/ui";

/** Fwd-only stepper order (subset of the frozen S4 workflow's happy path). */
const STEP_ORDER = ["TO_DO", "IN_PROGRESS", "IN_REVIEW", "DONE"];

export default function TasksScreen() {
  const S=useStyles();
  const params = useLocalSearchParams<{ taskId?: string }>();
  const [search, setSearch] = useState("");
  const [onlyMine, setOnlyMine] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(
    typeof params.taskId === "string" ? params.taskId : null,
  );
  const {canDo}=useAuth();
  const projects=useQuery({queryKey:['projects'],queryFn:getProjects});
  const [quickProject,setQuickProject]=useState('');
  const [quickTitle, setQuickTitle] = useState("");
  const [quickMsg, setQuickMsg] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["tasks", onlyMine ? "mine" : "all"],
    queryFn: () =>
      getTasks({ assignee_me: onlyMine || undefined, limit: 50 }),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const items = list.data?.items ?? [];
    if (!q) return items;
    return items.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.status.toLowerCase().includes(q),
    );
  }, [list.data, search]);

  const quickAdd = async () => {
    setQuickMsg(null);
    try {
      const projectId = quickProject;
      if (!projectId) throw new Error("Select the project for this task");
      const v = validateTaskCreate({ project_id: projectId, title: quickTitle });
      if (!v.ok) {
        setQuickMsg(v.errors.map((e) => e.message).join("; "));
        return;
      }
      setQuickMsg(await submitQueued({entity:'task_create',op:`quickadd:${Date.now()}`,payload:{project_id:projectId,title:quickTitle.trim()}}));
      setQuickTitle("");
      void list.refetch();
    } catch (e) {
      setQuickMsg(e instanceof Error ? e.message : "Quick-add failed");
    }
  };

  return (
    <ScrollView style={S.screen}>
      <TextInput
        style={S.input}
        placeholder="Search tasks…"
        value={search}
        onChangeText={setSearch}
      />
      <View style={[S.row, { marginBottom: 12 }]}>
        <Pressable onPress={() => setOnlyMine((v) => !v)}>
          <Pill text={onlyMine ? "Mine" : "All"} tone="info" />
        </Pressable>
      </View>

      {canDo('task.create')?<Card title="Quick-add">
        <Text style={S.body}>Project</Text><ScrollView horizontal style={{marginVertical:8}}>{(projects.data??[]).filter(p=>!['CLOSED','CANCELLED'].includes(p.status??'')).map(p=><Pressable key={p.id} accessibilityRole="radio" accessibilityState={{checked:quickProject===p.id}} onPress={()=>setQuickProject(p.id)} style={{marginRight:8}}><Pill text={p.name} tone={quickProject===p.id?'ok':'info'}/></Pressable>)}</ScrollView>
        {projects.isError?<Text style={S.error}>Projects are unavailable. Reconnect to refresh them.</Text>:null}
        <TextInput
          style={S.input}
          placeholder="New task title…"
          value={quickTitle}
          onChangeText={setQuickTitle}
        />
        <Pressable style={S.btn} onPress={() => void quickAdd()}>
          <Text style={S.btnText}>Add</Text>
        </Pressable>
        {quickMsg ? <Text style={S.muted}>{quickMsg}</Text> : null}
      </Card>:null}

      {filtered.map((t) => (
        <Pressable key={t.id} onPress={() => setSelectedId(t.id)}>
          <Card>
            <View style={S.row}>
              <Text style={[S.body, { flex: 1 }]} numberOfLines={2}>
                {t.title}
              </Text>
              <Pill text={t.status} tone={t.status === "DONE" ? "ok" : "info"} />
            </View>
          </Card>
        </Pressable>
      ))}
      {list.isLoading ? <Text style={S.muted}>Loading…</Text> : null}
      {list.isError ? (
        <Text style={S.error}>Couldn&apos;t load tasks (offline?)</Text>
      ) : null}

      <TaskModal
        taskId={selectedId}
        onClose={() => {
          setSelectedId(null);
          void list.refetch();
        }}
      />
    </ScrollView>
  );
}

function TaskModal({
  taskId,
  onClose,
}: {
  taskId: string | null;
  onClose: () => void;
}) {
  const S=useStyles();
  const [comment, setComment] = useState("");
  const [capturing,setCapturing]=useState(false);
  const [msg, setMsg] = useState<string | null>(null);
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
    const t: Task | undefined = detail.data;
    if (!t) return;
    try {
      setMsg(await submitQueued({entity:'task_status',op:`status:${t.id}`,payload:{task_id:t.id,status:next,version:t.version},baseVersion:t.version}));
      await detail.refetch();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Advance failed");
    }
  };

  const sendComment = async () => {
    setMsg(null);
    const t = detail.data;
    if (!t) return;
    const v = validateComment(comment);
    if (!v.ok) {
      setMsg(v.errors[0]?.message ?? "Invalid comment");
      return;
    }
    try {
      setMsg(await submitQueued({entity:'task_comment',op:`comment:${t.id}:${Date.now()}`,payload:{task_id:t.id,body:comment.trim()}}));
      setComment("");
      await comments.refetch();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Comment failed");
    }
  };

  useEffect(()=>{setComment('');setMsg(null);setCapturing(false);},[taskId]);
  const t = detail.data;
  const nextSteps = useMemo(() => {
    if (!t) return [] as string[];
    return t.allowed_next ?? [];
  }, [t]);

  return (
    <Modal visible={taskId !== null} animationType="slide" onRequestClose={onClose}>
      <ScrollView style={[S.screen, { marginTop: 40 }]}>
        <Pressable style={S.btnGhost} onPress={onClose}>
          <Text style={S.btnGhostText}>Close</Text>
        </Pressable>
        {detail.isLoading ? <Text style={S.muted}>Loading…</Text> : null}
        {t ? (
          <>
            <Card title={t.title}>
              <View style={S.row}>
                <Pill text={t.status} tone="info" />
                <Text style={S.muted}>v{t.version}</Text>
              </View>
              <View style={[S.row, { marginTop: 10 }]}>
                {nextSteps.map((n) => (
                  <Pressable
                    key={n}
                    style={[S.btn, { flex: 1, marginTop: 0 }]}
                    onPress={() => void advance(n)}
                  >
                    <Text style={S.btnText}>→ {n}</Text>
                  </Pressable>
                ))}
              </View>
              {nextSteps.length === 0 ? (
                <Text style={S.muted}>No transition available.</Text>
              ) : null}
            </Card>
            <Card title="Comments">
              {(comments.data ?? []).map((c) => (
                <View key={c.id} style={{ marginBottom: 8 }}>
                  <Text style={S.body}>{c.body}</Text>
                  <Text style={S.muted}>
                    {c.author_username ?? "?"} · {c.created_at ?? ""}
                  </Text>
                </View>
              ))}
              <TextInput
                style={S.input}
                placeholder="Add a comment… (@user mentions work)"
                value={comment}
                onChangeText={setComment}
              />
              <Pressable style={S.btn} onPress={() => void sendComment()}>
                <Text style={S.btnText}>Send</Text>
              </Pressable>
            </Card>
            <Card title="Evidence">
              <Text style={S.muted}>Capture a photo with employee, GPS, date and project details burned into the image. It syncs when a connection is available.</Text>
              <Pressable style={S.btnGhost} onPress={()=>setCapturing(true)}><Text style={S.btnGhostText}>Attach photo</Text></Pressable>
              {capturing?<EvidenceCapture task={t} onClose={()=>setCapturing(false)} onSaved={message=>{setMsg(message);setCapturing(false);}}/>:null}
            </Card>       </>
        ) : null}
        {msg ? <Text style={S.muted}>{msg}</Text> : null}
      </ScrollView>
    </Modal>
  );
}
