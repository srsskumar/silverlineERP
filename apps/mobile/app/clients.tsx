/**
 * Clients (§6.3): the client master, looked up by name — reference data a
 * field or sales person checks before a visit or a call, not edited from a
 * phone. The desktop form carries the create/edit workflow (duplicate
 * detection, GST registration management across states); this is read-only.
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, View } from "react-native";
import { useAuth } from "../src/auth/AuthContext";
import {
  getClient,
  getClientGstRegistrations,
  getClients,
  type ClientRow,
} from "../src/api/endpoints";
import { withScreenBoundary } from "../src/ui/ErrorBoundary";
import {
  BackHeader,
  Badge,
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

function money(v: number | string | undefined | null): string | null {
  const n = Number(v ?? 0);
  if (!n) return null;
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function ClientsScreen() {
  const { canDo } = useAuth();
  const canRead = canDo("client.read");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const clients = useQuery({
    queryKey: ["clients", search],
    queryFn: () => getClients(search.trim() ? { search: search.trim() } : undefined),
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
      <BackHeader title="Clients" onBack={() => router.back()} />
      <Muted style={{ marginBottom: space.lg }}>The client master — look up who they are before you call.</Muted>

      {!canRead ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to clients"
          message="This screen needs the client.read permission."
        />
      ) : (
        <>
          <Input placeholder="Search by name or code" value={search} onChangeText={setSearch} autoCapitalize="none" />
          <Card>
            {clients.isLoading ? (
              <Loading />
            ) : rows.length === 0 ? (
              <EmptyState icon="business-outline" title="No clients found" />
            ) : (
              rows.map((c, i, arr) => (
                <ListRow
                  key={c.id}
                  title={c.name}
                  subtitle={[c.code, c.district ?? c.state ?? undefined].filter(Boolean).join(" · ")}
                  right={<Badge text={c.client_type} tone={c.client_type === "GOVERNMENT" ? "info" : "neutral"} />}
                  onPress={() => setSelectedId(c.id)}
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
          <Badge text={client.status ?? "ACTIVE"} tone={client.status === "INACTIVE" ? "neutral" : "success"} />
        </Row>
        <Subtle style={{ marginTop: space.xs }}>{client.code}</Subtle>
        <Divider />
        <Field label="Type" value={client.client_type} />
        {client.category ? <Field label="Category" value={client.category} /> : null}
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
                right={c.contact_type === "PRIMARY" ? <Badge text="PRIMARY" tone="info" /> : undefined}
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
