/**
 * Attendance exceptions (§2): decide an exception a supervisor already knows
 * the id of — Approve or Reject, with an optional note.
 *
 * This is NOT a queue, because the API has none to back one: there is no
 * `GET /attendance/exceptions` list (or single-item) route — confirmed
 * against apps/api/src/modules/attendance/routes.ts, which registers only
 * POST .../exceptions (file) and PATCH .../:id/decision. The web client hits
 * the same wall (apps/web/app/attendance/exceptions/page.tsx says so
 * verbatim) and works the same way this screen does: track ids as they turn
 * up — from filing an exception or a regularization, or from a 202 punch
 * response's `exception_id` — and decide against a tracked id. A true
 * "what's pending for my team" queue needs a server list endpoint; see this
 * round's report.
 */
import { router } from "expo-router";
import { useState } from "react";
import { Modal, View } from "react-native";
import { ApiError } from "../src/api/client";
import { useAuth } from "../src/auth/AuthContext";
import { postAttendanceExceptionDecision } from "../src/api/endpoints";
import {
  exceptionStatusTone,
  isTrackableExceptionId,
  parseVersionInput,
} from "../src/attendanceExceptionsFormat";
import { withScreenBoundary } from "../src/ui/ErrorBoundary";
import {
  BackHeader,
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Input,
  ListRow,
  Muted,
  Row,
  Screen,
  SectionLabel,
} from "../src/ui/primitives";
import { space, useTheme } from "../src/theme";

interface TrackedException {
  id: string;
  version: number;
  status: "PENDING" | "APPROVED" | "REJECTED";
}

function AttendanceExceptionsScreen() {
  const { canDo } = useAuth();
  const canRead = canDo("attendance.read");
  const canDecide = canDo("attendance.decide");

  const [known, setKnown] = useState<TrackedException[]>([]);
  const [idInput, setIdInput] = useState("");
  const [versionInput, setVersionInput] = useState("1");
  const [trackError, setTrackError] = useState<string | null>(null);
  const [selected, setSelected] = useState<TrackedException | null>(null);

  const track = () => {
    setTrackError(null);
    const id = idInput.trim();
    if (!isTrackableExceptionId(id)) {
      setTrackError("Paste a full exception id (a UUID from a filed exception or a punch response).");
      return;
    }
    const version = parseVersionInput(versionInput);
    if (version === null) {
      setTrackError("Version must be a positive whole number.");
      return;
    }
    setKnown((prev) =>
      prev.some((k) => k.id === id) ? prev : [...prev, { id, version, status: "PENDING" }],
    );
    setIdInput("");
    setVersionInput("1");
  };

  const onDecided = (id: string, status: "APPROVED" | "REJECTED") => {
    setKnown((prev) => prev.map((k) => (k.id === id ? { ...k, status } : k)));
    setSelected(null);
  };

  return (
    <Screen>
      <BackHeader title="Exceptions" onBack={() => router.back()} />
      <Muted style={{ marginBottom: space.md }}>
        Decide an attendance exception you already have the id for.
      </Muted>

      {!canRead ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to attendance exceptions"
          message="This screen needs the attendance.read permission."
        />
      ) : (
        <>
          <Banner
            tone="info"
            icon="information-circle-outline"
            title="No server-side queue"
            message="There is no list of pending exceptions to fetch (a known API gap). Track an id from a filed exception, a regularization, or a punch response, then decide it below."
          />

          <SectionLabel>Track an exception</SectionLabel>
          <Card>
            <Input
              label="Exception ID"
              placeholder="00000000-0000-0000-0000-000000000000"
              value={idInput}
              onChangeText={setIdInput}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Input
              label="Version"
              hint="From where the id came — a 202 punch response, or a filed exception's own record."
              keyboardType="number-pad"
              value={versionInput}
              onChangeText={setVersionInput}
            />
            {trackError ? <Banner tone="danger" icon="alert-circle-outline" title={trackError} /> : null}
            <Button title="Track" icon="add-outline" variant="secondary" onPress={track} />
          </Card>

          <SectionLabel>{`Tracked (${known.length})`}</SectionLabel>
          <Card>
            {known.length === 0 ? (
              <EmptyState icon="file-tray-outline" title="Nothing tracked yet" />
            ) : (
              known.map((k, i, arr) => (
                <ListRow
                  key={k.id}
                  title={k.id}
                  subtitle={`v${k.version}`}
                  right={<Badge text={k.status} tone={exceptionStatusTone(k.status)} />}
                  onPress={k.status === "PENDING" && canDecide ? () => setSelected(k) : undefined}
                  last={i === arr.length - 1}
                />
              ))
            )}
            {known.length > 0 && !canDecide ? (
              <Muted style={{ marginTop: space.sm }}>Deciding needs the attendance.decide permission.</Muted>
            ) : null}
          </Card>
        </>
      )}

      <Modal
        visible={Boolean(selected)}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSelected(null)}
      >
        {selected ? (
          <DecisionSheet
            exception={selected}
            onClose={() => setSelected(null)}
            onDecided={onDecided}
          />
        ) : null}
      </Modal>
    </Screen>
  );
}

function DecisionSheet({
  exception,
  onClose,
  onDecided,
}: {
  exception: TrackedException;
  onClose: () => void;
  onDecided: (id: string, status: "APPROVED" | "REJECTED") => void;
}) {
  const t = useTheme();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const decide = async (decision: "APPROVE" | "REJECT") => {
    setBusy(true);
    setError(null);
    try {
      const result = await postAttendanceExceptionDecision(
        exception.id,
        decision,
        exception.version,
        note.trim() || undefined,
      );
      onDecided(exception.id, result.status === "APPROVED" ? "APPROVED" : "REJECTED");
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.status === 409
            ? "This exception changed (or was already decided) since you tracked it. Update the version and try again."
            : e.message
          : "Decision failed",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <BackHeader title="Decide exception" onBack={onClose} />
      <Card>
        <Muted style={{ color: t.text, fontWeight: "600" }}>{exception.id}</Muted>
        <Muted style={{ marginTop: space.xs }}>{`Version ${exception.version}`}</Muted>
      </Card>

      {error ? <Banner tone="danger" icon="alert-circle-outline" title={error} /> : null}

      <Card>
        <Input
          label="Note"
          hint="Optional — not required to reject, unlike an approval request."
          placeholder="Decision rationale…"
          value={note}
          onChangeText={setNote}
          multiline
        />
        <Row gap={space.sm}>
          <Button title="Approve" icon="checkmark-outline" tone="success" loading={busy} onPress={() => void decide("APPROVE")} style={{ flex: 1 }} />
          <Button
            title="Reject"
            icon="close-outline"
            variant="secondary"
            tone="danger"
            loading={busy}
            onPress={() => void decide("REJECT")}
            style={{ flex: 1 }}
          />
        </Row>
      </Card>
    </Screen>
  );
}

export default withScreenBoundary(AttendanceExceptionsScreen);
