/**
 * Clients (§6.3): the client master, looked up by name — reference data a
 * field or sales person checks before a visit or a call. The desktop form
 * carries the full edit workflow (duplicate detection, GST registration
 * management across states); this screen adds only the one cheap write
 * worth carrying from a phone (Task 5d, B-011 follow-on) — a bare name +
 * client_type, the same minimal shape as Pipeline's "New lead".
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, View } from "react-native";
import { useAuth } from "../src/auth/AuthContext";
import {
  getClient,
  getClientGstRegistrations,
  getClients,
  postClient,
  type ClientRow,
} from "../src/api/endpoints";
import { CLIENT_TYPES, validateClientCreate } from "../src/clientsFormat";
import { describeApiError } from "../src/errorFormat";
import { canGoNewer, canGoOlder, newerOffset, olderOffset } from "../src/paging";
import { withScreenBoundary } from "../src/ui/ErrorBoundary";
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
import { codeLabel } from "../src/labels";


function ClientsScreen() {
  const { canDo } = useAuth();
  const canRead = canDo("client.read");
  const canManage = canDo("client.manage");
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNewClient, setShowNewClient] = useState(false);

  const clients = useQuery({
    queryKey: ["clients", search, offset],
    queryFn: () => getClients({ ...(search.trim() ? { search: search.trim() } : {}), offset }),
    enabled: canRead,
  });
  const detail = useQuery({
    queryKey: ["client", selectedId],
    queryFn: () => getClient(selectedId!),
    enabled: Boolean(selectedId),
  });
  const gst = useQuery({
    queryKey: ["client-gst", selectedId],
    queryFn: () => getClientGstRegistrations(selectedId!),
    enabled: Boolean(selectedId),
  });

  const rows = clients.data?.items ?? [];

  return (
    <Screen>
      <BackHeader
        title="Clients"
        onBack={() => router.back()}
        right={
          canManage ? (
            <Button
              title={showNewClient ? "Cancel" : "New client"}
              variant={showNewClient ? "secondary" : "primary"}
              onPress={() => setShowNewClient((v) => !v)}
            />
          ) : undefined
        }
      />
      <Muted style={{ marginBottom: space.lg }}>The client master — look up who they are before you call.</Muted>

      {!canRead ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to clients"
          message="This screen needs the client.read permission."
        />
      ) : (
        <>
          {showNewClient && canManage ? (
            <NewClientForm
              onCreated={() => {
                setShowNewClient(false);
                setOffset(0);
                void qc.invalidateQueries({ queryKey: ["clients"] });
              }}
            />
          ) : null}

          <Input
            placeholder="Search by name or code"
            value={search}
            onChangeText={(v) => {
              setSearch(v);
              setOffset(0);
            }}
            autoCapitalize="none"
          />
          <Card>
            {listState(clients, rows.length) === "loading" ? (
              <Loading />
            ) : listState(clients, rows.length) === "error" ? (
              <LoadError error={clients.error} what="clients" />
            ) : rows.length === 0 ? (
              <EmptyState icon="business-outline" title="No clients found" />
            ) : (
              rows.map((c, i, arr) => (
                <ListRow
                  key={c.id}
                  title={c.name}
                  subtitle={[c.code, c.district ?? c.state ?? undefined].filter(Boolean).join(" · ")}
                  right={<Badge text={codeLabel(c.client_type)} tone={c.client_type === "GOVERNMENT" ? "info" : "neutral"} />}
                  onPress={() => setSelectedId(c.id)}
                  last={i === arr.length - 1}
                />
              ))
            )}
          </Card>
          {rows.length > 0 || offset > 0 ? (
            <Row gap={space.sm} style={{ marginTop: space.md }}>
              <Button
                title="Newer"
                variant="secondary"
                disabled={!canGoNewer(offset)}
                onPress={() => setOffset(newerOffset(offset))}
                style={{ flex: 1 }}
              />
              <Button
                title="Older"
                variant="secondary"
                disabled={!canGoOlder(clients.data?.hasMore)}
                onPress={() => setOffset(olderOffset(offset))}
                style={{ flex: 1 }}
              />
            </Row>
          ) : null}
        </>
      )}

      <Modal
        visible={Boolean(selectedId)}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSelectedId(null)}
      >
        <Screen>
          <BackHeader title="Client" onBack={() => setSelectedId(null)} />
          {detail.isLoading ? (
            <Loading />
          ) : !detail.data ? (
            <EmptyState icon="alert-circle-outline" title="Could not load this client" />
          ) : (
            <ClientDetail client={detail.data} gst={gst.data ?? []} />
          )}
        </Screen>
      </Modal>
    </Screen>
  );
}

function NewClientForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [clientType, setClientType] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    const v = validateClientCreate({ name, client_type: clientType });
    if (!v.ok) {
      setError(v.errors.map((e) => e.message).join("\n"));
      return;
    }
    setBusy(true);
    try {
      await postClient({ name: name.trim(), client_type: clientType });
      setName("");
      setClientType("");
      onCreated();
    } catch (e) {
      setError(describeApiError(e, "Could not create this client"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="New client">
      {error ? <Banner tone="danger" icon="alert-circle-outline" title={error} /> : null}
      <Input label="Name" placeholder="Organisation name" value={name} onChangeText={setName} />
      <Subtle style={{ marginBottom: space.xs }}>Type</Subtle>
      <Row gap={space.sm} style={{ marginBottom: space.md }}>
        {CLIENT_TYPES.map((ct) => (
          <Button
            key={ct}
            title={ct === "GOVERNMENT" ? "Government" : "Private"}
            variant={clientType === ct ? "primary" : "secondary"}
            onPress={() => setClientType(ct)}
            style={{ flex: 1 }}
          />
        ))}
      </Row>
      <Button
        title="Save client"
        icon="add-circle-outline"
        loading={busy}
        disabled={busy}
        onPress={() => void submit()}
      />
    </Card>
  );
}

function ClientDetail({
  client,
  gst,
}: {
  client: ClientRow & { contacts: Array<{ id: string; name: string; designation?: string | null; phone?: string | null; email?: string | null; contact_type?: string }> };
  gst: Array<{ id: string; gstin: string; state_code: string; is_primary: boolean }>;
}) {
  const t = useTheme();
  const primaryGst = gst.find((g) => g.is_primary) ?? gst[0];
  const location = [client.village, client.mandal, client.district, client.state].filter(Boolean).join(", ");

  return (
    <View>
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Muted style={{ color: t.text, fontWeight: "700", flex: 1 }}>{client.name}</Muted>
          <Badge text={codeLabel(client.status ?? "ACTIVE")} tone={client.status === "INACTIVE" ? "neutral" : "success"} />
        </Row>
        <Subtle style={{ marginTop: space.xs }}>{client.code}</Subtle>
        <Divider />
        <Field label="Type" value={codeLabel(client.client_type)} />
        {client.category ? <Field label="Category" value={codeLabel(client.category)} /> : null}
        {location ? <Field label="Location" value={location} /> : null}
        {client.address_line ? <Field label="Address" value={client.address_line} /> : null}
        {client.pincode ? <Field label="PIN code" value={client.pincode} /> : null}
        {client.website ? <Field label="Website" value={client.website} /> : null}
        {client.pan ? <Field label="PAN" value={client.pan} /> : null}
        {primaryGst ? <Field label="GSTIN" value={`${primaryGst.gstin} (${primaryGst.state_code})`} /> : null}
        {client.payment_terms ? <Field label="Payment terms" value={client.payment_terms} /> : null}
        {money(client.credit_limit) ? <Field label="Credit limit" value={money(client.credit_limit)!} /> : null}
      </Card>

      {gst.length > 1 ? (
        <>
          <SectionLabel>Other GST registrations</SectionLabel>
          <Card>
            {gst
              .filter((g) => g.id !== primaryGst?.id)
              .map((g, i, arr) => (
                <ListRow
                  key={g.id}
                  title={g.gstin}
                  subtitle={g.state_code}
                  last={i === arr.length - 1}
                />
              ))}
          </Card>
        </>
      ) : null}

      {client.contacts.length > 0 ? (
        <>
          <SectionLabel>Contacts</SectionLabel>
          <Card>
            {client.contacts.map((c, i, arr) => (
              <ListRow
                key={c.id}
                title={c.name}
                subtitle={[c.designation ?? undefined, c.phone ?? c.email ?? undefined].filter(Boolean).join(" · ")}
                right={c.contact_type === "PRIMARY" ? <Badge text="Primary" tone="info" /> : undefined}
                last={i === arr.length - 1}
              />
            ))}
          </Card>
        </>
      ) : null}
      <Divider />
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

export default withScreenBoundary(ClientsScreen);
