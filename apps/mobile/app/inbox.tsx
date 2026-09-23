/**
 * Inbox (§5, nav.ts's /inbox): mentions, assignments and status changes
 * addressed to the signed-in user. Opening a row marks it read, the same
 * "the whole row is the action" pattern as the web InboxList. A type filter
 * (built from whatever types are actually on the page, not a hardcoded
 * list) narrows a long inbox; "Mark all read" clears it in one tap.
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ScrollView } from "react-native";
import {
  getNotifications,
  patchNotificationRead,
  postNotificationsReadAll,
  type AppNotification,
} from "../src/api/endpoints";
import { distinctTypes, formatNotificationType, isUnread } from "../src/inboxFormat";
import { withScreenBoundary } from "../src/ui/ErrorBoundary";
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
} from "../src/ui/primitives";
import { space, useTheme } from "../src/theme";
import { dayTime } from "@silverline/shared";

function InboxScreen() {
  const t = useTheme();
  const qc = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [type, setType] = useState("");
  const [markingAll, setMarkingAll] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["notifications", unreadOnly],
    queryFn: () => getNotifications({ unread: unreadOnly || undefined, limit: 50 }),
  });

  const items = list.data?.items ?? [];
  const types = distinctTypes(items);
  const rows = type ? items.filter((n) => n.type === type) : items;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["notifications"] });
  };

  const openRow = async (item: AppNotification) => {
    if (isUnread(item)) {
      try {
        await patchNotificationRead(item.id);
        refresh();
      } catch {
        // Best-effort: the row still shows; the next refresh will retry the read state.
      }
    }
  };

  const markAllRead = async () => {
    setMarkingAll(true);
    setError(null);
    try {
      const res = await postNotificationsReadAll();
      setNote(`Marked ${res.marked} notification${res.marked === 1 ? "" : "s"} as read.`);
      refresh();
    } catch {
      setError("Could not mark all as read.");
    } finally {
      setMarkingAll(false);
    }
  };

  return (
    <Screen>
      <BackHeader
        title="Inbox"
        onBack={() => router.back()}
        right={<Button title="Mark all read" variant="secondary" loading={markingAll} onPress={() => void markAllRead()} />}
      />
      <Muted style={{ marginBottom: space.md }}>Mentions, assignments and status changes.</Muted>

      <Row gap={space.sm} style={{ marginBottom: space.md }}>
        <Button
          title={unreadOnly ? "Unread only" : "All"}
          variant={unreadOnly ? "primary" : "secondary"}
          onPress={() => setUnreadOnly((v) => !v)}
        />
      </Row>

      {types.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.md }}>
          <Row gap={space.sm}>
            <Button title="All types" variant={type === "" ? "primary" : "secondary"} onPress={() => setType("")} />
            {types.map((tCode) => (
              <Button
                key={tCode}
                title={formatNotificationType(tCode)}
                variant={type === tCode ? "primary" : "secondary"}
                onPress={() => setType(tCode)}
              />
            ))}
          </Row>
        </ScrollView>
      ) : null}

      {note ? <Banner tone="success" icon="checkmark-circle-outline" title={note} /> : null}
      {error ? <Banner tone="danger" icon="alert-circle-outline" title={error} /> : null}

      <Card>
        {list.isLoading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="mail-open-outline"
            title={unreadOnly ? "No unread notifications" : "Inbox is empty"}
            message="Mentions, assignments and status changes land here."
          />
        ) : (
          rows.map((n, i, arr) => (
            <ListRow
              key={n.id}
              title={String(n.title ?? formatNotificationType(n.type))}
              subtitle={[n.body ? String(n.body) : undefined, n.created_at ? dayTime(n.created_at) : undefined]
                .filter(Boolean)
                .join(" · ")}
              right={
                <Row gap={space.xs} style={{ alignItems: "center" }}>
                  {isUnread(n) ? (
                    <Badge text="Unread" tone="info" />
                  ) : (
                    <Muted style={{ color: t.textMuted, fontSize: 12 }}>Read</Muted>
                  )}
                </Row>
              }
              onPress={() => void openRow(n)}
              last={i === arr.length - 1}
            />
          ))
        )}
      </Card>
    </Screen>
  );
}

export default withScreenBoundary(InboxScreen);
