/**
 * Documents (§46): the compliance register — licences, policies, certificates
 * and agreements, and when each one runs out.
 *
 * apps/api/src/modules/documents is an INDEX, not a file store: the bytes,
 * where a document has any, live wherever the owning module already keeps
 * them (task evidence, employee documents, …), and this module has no
 * download route or upload route reachable from mobile (no Expo file-picker
 * module is already in package.json — see the task 5d report for why that
 * stays out of scope). Task 5d (B-009) adds the one write worth carrying:
 * renewing a document that is due, gated like web (document.manage) — the
 * rest of the register stays read-only, with a detail sheet for one entry.
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, View } from "react-native";
import { useAuth } from "../src/auth/AuthContext";
import {
  getDocument,
  getDocumentRenewals,
  getDocuments,
  postDocumentRenew,
  type DocumentRow,
} from "../src/api/endpoints";
import { day } from "@silverline/shared";
import {
  documentOwnerLabel,
  documentStateLabel,
  documentStateTone,
  validateDocumentRenew,
} from "../src/documentsFormat";
import { listState } from "../src/listState";
import { LoadError } from "../src/ui/LoadError";
import { describeApiError } from "../src/errorFormat";
import { withScreenBoundary } from "../src/ui/ErrorBoundary";
import { usePullRefresh } from "../src/ui/usePullRefresh";
import {
  BackHeader,
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
} from "../src/ui/primitives";
import { space, useTheme } from "../src/theme";

function DocumentsScreen() {
  const { canDo } = useAuth();
  const canRead = canDo("document.read");
  const canManage = canDo("document.manage");
  const qc = useQueryClient();
  const [tab, setTab] = useState<"renewals" | "register">("renewals");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const renewals = useQuery({
    queryKey: ["documents", "renewals"],
    queryFn: () => getDocumentRenewals(60),
    enabled: canRead && tab === "renewals",
  });
  const register = useQuery({
    queryKey: ["documents", "register"],
    queryFn: () => getDocuments(),
    enabled: canRead && tab === "register",
  });
  const detail = useQuery({
    queryKey: ["document", selectedId],
    queryFn: () => getDocument(selectedId!),
    enabled: Boolean(selectedId),
  });

  const rows = tab === "renewals" ? (renewals.data?.items ?? []) : (register.data?.items ?? []);
  const active = tab === "renewals" ? renewals : register;

  const pull = usePullRefresh(canRead && tab === "renewals" && renewals, canRead && tab === "register" && register);


  return (
    <Screen refresh={pull}>
      <BackHeader title="Documents" onBack={() => router.back()} />
      <Muted style={{ marginBottom: space.lg }}>
        Licences, policies, certificates and agreements — and when each one runs out.
      </Muted>

      {!canRead ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to the document register"
          message="This screen needs the document.read permission."
        />
      ) : (
        <>
          <Row gap={space.sm} style={{ marginBottom: space.md }}>
            <Button
              title="Renewals"
              variant={tab === "renewals" ? "primary" : "secondary"}
              onPress={() => setTab("renewals")}
              style={{ flex: 1 }}
            />
            <Button
              title="Register"
              variant={tab === "register" ? "primary" : "secondary"}
              onPress={() => setTab("register")}
              style={{ flex: 1 }}
            />
          </Row>

          {tab === "renewals" && (renewals.data?.blocking ?? 0) > 0 ? (
            <Banner
              tone="danger"
              icon="alert-circle-outline"
              title={`${renewals.data?.blocking} document(s) have expired`}
              message="These block operations until renewed."
            />
          ) : null}
          {tab === "renewals" && (renewals.data?.blockingSoon ?? 0) > 0 ? (
            <Banner
              tone="warning"
              icon="time-outline"
              title={`${renewals.data?.blockingSoon} expiring soon`}
              message="Due within the notice window."
            />
          ) : null}

          <Card>
            {listState(active, rows.length) === "loading" ? (
              <Loading />
            ) : listState(active, rows.length) === "error" ? (
              <LoadError query={active} what="the register" />
            ) : rows.length === 0 ? (
              <EmptyState
                icon="document-text-outline"
                title={tab === "renewals" ? "Nothing due for renewal" : "No documents on record"}
              />
            ) : (
              rows.map((d, i, arr) => (
                <ListRow
                  key={d.id}
                  title={d.title}
                  subtitle={
                    d.expires_on
                      ? `${d.type_label} · expires ${day(d.expires_on)}`
                      : d.type_label
                  }
                  right={<Badge text={documentStateLabel(d.state)} tone={documentStateTone(d.state)} />}
                  onPress={() => setSelectedId(d.id)}
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
          <BackHeader title="Document" onBack={() => setSelectedId(null)} />
          {detail.isLoading ? (
            <Loading />
          ) : !detail.data ? (
            <EmptyState icon="alert-circle-outline" title="Could not load this document" />
          ) : (
            <DocumentDetail
              doc={detail.data}
              canManage={canManage}
              onRenewed={() => {
                setSelectedId(null);
                void qc.invalidateQueries({ queryKey: ["documents"] });
                void qc.invalidateQueries({ queryKey: ["document"] });
              }}
            />
          )}
        </Screen>
      </Modal>
    </Screen>
  );
}

function DocumentDetail({
  doc,
  canManage,
  onRenewed,
}: {
  doc: DocumentRow & { supersedes: DocumentRow | null };
  canManage: boolean;
  onRenewed: () => void;
}) {
  const t = useTheme();
  const [showRenew, setShowRenew] = useState(false);
  // A document that already has a successor (409 ALREADY_RENEWED server-
  // side) has nothing to renew again — proactively hide the action instead
  // of letting the tap round-trip to learn that.
  const canRenew = canManage && doc.state !== "SUPERSEDED";
  return (
    <View>
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Muted style={{ color: t.text, fontWeight: "700", flex: 1 }}>{doc.title}</Muted>
          <Badge text={documentStateLabel(doc.state)} tone={documentStateTone(doc.state)} />
        </Row>
        <Subtle style={{ marginTop: space.xs }}>{doc.type_label}</Subtle>

        {doc.restricted ? (
          <Banner
            tone="info"
            icon="eye-off-outline"
            title="Confidential"
            message="Reference number and notes are withheld from this account."
          />
        ) : null}
        {doc.blocks_operations && doc.state === "EXPIRED" ? (
          <Banner tone="danger" icon="alert-circle-outline" title="This has expired and blocks operations" />
        ) : null}

        <Divider />
        <Field label="Owner" value={documentOwnerLabel(doc.owner_type)} />
        <Field label="Reference number" value={doc.reference_number ?? "—"} />
        <Field label="Issuing authority" value={doc.issuing_authority ?? "—"} />
        <Field label="Issued on" value={day(doc.issued_on)} />
        <Field label="Valid from" value={day(doc.valid_from)} />
        <Field label="Expires on" value={doc.expires_on ? day(doc.expires_on) : "Does not expire"} />
        {doc.days_remaining !== null ? (
          <Field
            label="Days remaining"
            value={doc.days_remaining < 0 ? `${-doc.days_remaining} days overdue` : String(doc.days_remaining)}
          />
        ) : null}
        {doc.notes ? <Field label="Notes" value={doc.notes} /> : null}
      </Card>

      {canRenew ? (
        showRenew ? (
          <RenewForm doc={doc} onCancel={() => setShowRenew(false)} onRenewed={onRenewed} />
        ) : (
          <Button
            title="Renew"
            icon="refresh-outline"
            variant="secondary"
            style={{ marginTop: space.md }}
            onPress={() => setShowRenew(true)}
          />
        )
      ) : null}

      {doc.supersedes ? (
        <>
          <SectionLabel>Previous revision</SectionLabel>
          <Card>
            <Muted style={{ color: t.text, fontWeight: "600" }}>{doc.supersedes.title}</Muted>
            <Subtle>Expired {day(doc.supersedes.expires_on)}</Subtle>
          </Card>
        </>
      ) : null}
    </View>
  );
}

/**
 * B-009: records a new document that supersedes this one — not an edit of
 * the expiry date. The old certificate stays on the register and readable;
 * an inspector may ask for it (mirrors web's RenewDialog copy exactly).
 */
function RenewForm({
  doc,
  onCancel,
  onRenewed,
}: {
  doc: DocumentRow;
  onCancel: () => void;
  onRenewed: () => void;
}) {
  const [expiresOn, setExpiresOn] = useState("");
  const [issuedOn, setIssuedOn] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    const v = validateDocumentRenew({ expires_on: expiresOn, issued_on: issuedOn || undefined });
    if (!v.ok) {
      setError(v.errors.map((e) => e.message).join("\n"));
      return;
    }
    setBusy(true);
    try {
      await postDocumentRenew(doc.id, {
        expires_on: expiresOn.trim(),
        ...(issuedOn.trim() ? { issued_on: issuedOn.trim() } : {}),
        ...(referenceNumber.trim() ? { reference_number: referenceNumber.trim() } : {}),
      });
      onRenewed();
    } catch (e) {
      setError(describeApiError(e, "Could not record this renewal"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={`Renew ${doc.title}`}>
      <Muted style={{ marginBottom: space.md }}>
        This records a new document that supersedes the current one. The old certificate stays on
        the register and stays readable — an inspector may ask for it.
      </Muted>
      {error ? <Banner tone="danger" icon="alert-circle-outline" title={error} /> : null}
      <Input
        label="New expiry date"
        placeholder="YYYY-MM-DD"
        keyboardType="numeric"
        autoCapitalize="none"
        value={expiresOn}
        onChangeText={setExpiresOn}
      />
      <Input
        label="Issued on (optional)"
        placeholder="YYYY-MM-DD"
        keyboardType="numeric"
        autoCapitalize="none"
        value={issuedOn}
        onChangeText={setIssuedOn}
      />
      <Input
        label="New reference (optional)"
        placeholder={doc.reference_number ?? "Unchanged"}
        value={referenceNumber}
        onChangeText={setReferenceNumber}
      />
      <Row gap={space.sm}>
        <Button
          title="Record the renewal"
          loading={busy}
          disabled={busy || !expiresOn.trim()}
          onPress={() => void submit()}
          style={{ flex: 1 }}
        />
        <Button title="Cancel" variant="secondary" onPress={onCancel} style={{ flex: 1 }} />
      </Row>
    </Card>
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

export default withScreenBoundary(DocumentsScreen);
