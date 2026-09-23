/**
 * Documents (§46): the compliance register — licences, policies, certificates
 * and agreements, and when each one runs out.
 *
 * apps/api/src/modules/documents is an INDEX, not a file store: the bytes,
 * where a document has any, live wherever the owning module already keeps
 * them (task evidence, employee documents, …), and this module has no
 * download route. So this screen is read-only: what needs renewing, and the
 * full register, with a detail sheet for one entry. There is nothing to
 * open or save on a phone here — see the mobile brief's report for why.
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, View } from "react-native";
import { useAuth } from "../src/auth/AuthContext";
import {
  getDocument,
  getDocumentRenewals,
  getDocuments,
  type DocumentRow,
} from "../src/api/endpoints";
import { documentStateTone } from "../src/documentsFormat";
import { withScreenBoundary } from "../src/ui/ErrorBoundary";
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
import { space, useTheme } from "../src/theme";

function DocumentsScreen() {
  const { canDo } = useAuth();
  const canRead = canDo("document.read");
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

  return (
    <Screen>
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
            {active.isLoading ? (
              <Loading />
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
                      ? `${d.type_label} · expires ${d.expires_on}`
                      : d.type_label
                  }
                  right={<Badge text={d.state} tone={documentStateTone(d.state)} />}
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
            <DocumentDetail doc={detail.data} />
          )}
        </Screen>
      </Modal>
    </Screen>
  );
}

function DocumentDetail({ doc }: { doc: DocumentRow & { supersedes: DocumentRow | null } }) {
  const t = useTheme();
  return (
    <View>
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Muted style={{ color: t.text, fontWeight: "700", flex: 1 }}>{doc.title}</Muted>
          <Badge text={doc.state} tone={documentStateTone(doc.state)} />
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
        <Field label="Owner" value={`${doc.owner_type}${doc.owner_id ? ` · ${doc.owner_id.slice(0, 8)}` : ""}`} />
        <Field label="Reference number" value={doc.reference_number ?? "—"} />
        <Field label="Issuing authority" value={doc.issuing_authority ?? "—"} />
        <Field label="Issued on" value={doc.issued_on ?? "—"} />
        <Field label="Valid from" value={doc.valid_from ?? "—"} />
        <Field label="Expires on" value={doc.expires_on ?? "Does not expire"} />
        {doc.days_remaining !== null ? (
          <Field
            label="Days remaining"
            value={doc.days_remaining < 0 ? `${-doc.days_remaining} days overdue` : String(doc.days_remaining)}
          />
        ) : null}
        {doc.notes ? <Field label="Notes" value={doc.notes} /> : null}
      </Card>

      {doc.supersedes ? (
        <>
          <SectionLabel>Previous revision</SectionLabel>
          <Card>
            <Muted style={{ color: t.text, fontWeight: "600" }}>{doc.supersedes.title}</Muted>
            <Subtle>Expired {doc.supersedes.expires_on ?? "—"}</Subtle>
          </Card>
        </>
      ) : null}
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

export default withScreenBoundary(DocumentsScreen);
