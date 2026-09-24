/**
 * Receivables (§58.2): who owes us, and how late.
 *
 * A collections call is made to a client, not to an invoice, so this reads
 * the same ageing summary the web page does and leads with the client list;
 * the bills behind a balance are one tap down, already embedded in the same
 * response. Read-only — a manager checking exposure, not posting a receipt.
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, View } from "react-native";
import { useAuth } from "../src/auth/AuthContext";
import { getArAgeing, type ArClient } from "../src/api/endpoints";
import { oldestBucket, partyTone, payableFlagTone, AGEING_BUCKET_LABELS } from "../src/ledgersFormat";
import { withScreenBoundary } from "../src/ui/ErrorBoundary";
import {
  BackHeader,
  Badge,
  Banner,
  Card,
  Divider,
  EmptyState,
  ListRow,
  Loading,
  Muted,
  Row,
  Screen,
  SectionLabel,
  StatTile,
  Subtle,
} from "../src/ui/primitives";
import { space, useTheme } from "../src/theme";
import { day } from "@silverline/shared";
import { formatMoney as money } from "../src/money";


function ReceivablesScreen() {
  const { canDo } = useAuth();
  const canRead = canDo("ar.read");
  const [selected, setSelected] = useState<ArClient | null>(null);

  const ageing = useQuery({
    queryKey: ["ar-ageing"],
    queryFn: () => getArAgeing(),
    enabled: canRead,
  });

  const data = ageing.data;
  const clients = data?.clients ?? [];

  return (
    <Screen>
      <BackHeader title="Receivables" onBack={() => router.back()} />
      <Muted style={{ marginBottom: space.lg }}>
        What clients owe, aged from the date each bill fell due.
      </Muted>

      {!canRead ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to receivables"
          message="This screen needs the ar.read permission."
        />
      ) : ageing.isLoading ? (
        <Loading />
      ) : !data ? (
        <EmptyState icon="alert-circle-outline" title="Could not load receivables" />
      ) : (
        <>
          <Row gap={space.sm} style={{ flexWrap: "wrap", marginBottom: space.md }}>
            <StatTile label="Overdue" value={money(data.overdue)} tone={data.overdue > 0 ? "danger" : "success"} />
            <StatTile label="Total outstanding" value={money(data.total)} />
            <StatTile label="Retention held" value={money(data.retention)} tone="info" />
            <StatTile label="DSO" value={data.dso === null ? "—" : `${Math.round(data.dso)}d`} />
          </Row>
          {data.disputed > 0 ? (
            <Banner
              tone="warning"
              icon="alert-circle-outline"
              title={`${money(data.disputed)} disputed`}
              message="Excluded from ageing — a different problem from slow payment."
            />
          ) : null}

          <SectionLabel>By client</SectionLabel>
          <Card>
            {clients.length === 0 ? (
              <EmptyState icon="people-outline" title="Nothing outstanding" />
            ) : (
              clients.map((c, i, arr) => {
                const bucket = oldestBucket(c.buckets);
                return (
                  <ListRow
                    key={c.client_id ?? i}
                    title={c.client_name}
                    subtitle={bucket ? AGEING_BUCKET_LABELS[bucket] : "Not yet due"}
                    right={
                      <Row gap={space.xs}>
                        {c.credit.breached ? <Badge text="OVER LIMIT" tone="danger" /> : null}
                        <Badge text={money(c.total)} tone={partyTone(c)} />
                      </Row>
                    }
                    onPress={() => setSelected(c)}
                    last={i === arr.length - 1}
                  />
                );
              })
            )}
          </Card>
        </>
      )}

      <Modal
        visible={Boolean(selected)}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSelected(null)}
      >
        {selected ? <ClientDetail client={selected} onClose={() => setSelected(null)} /> : null}
      </Modal>
    </Screen>
  );
}

function ClientDetail({ client, onClose }: { client: ArClient; onClose: () => void }) {
  const t = useTheme();
  return (
    <Screen>
      <BackHeader title={client.client_name} onBack={onClose} />
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Muted style={{ color: t.text, fontWeight: "700" }}>Outstanding</Muted>
          <Muted style={{ color: t.text, fontWeight: "700" }}>{money(client.total)}</Muted>
        </Row>
        <Row style={{ justifyContent: "space-between", marginTop: space.xs }}>
          <Subtle>Overdue</Subtle>
          <Subtle>{money(client.overdue)}</Subtle>
        </Row>
        <Row style={{ justifyContent: "space-between" }}>
          <Subtle>Retention held</Subtle>
          <Subtle>{money(client.retention)}</Subtle>
        </Row>
        {client.credit.limit !== null ? (
          <Row style={{ justifyContent: "space-between" }}>
            <Subtle>Credit limit</Subtle>
            <Subtle>
              {money(client.credit.limit)}
              {client.credit.utilisationPct !== null ? ` · ${Math.round(client.credit.utilisationPct)}%` : ""}
            </Subtle>
          </Row>
        ) : null}
        {client.credit.breached ? (
          <Banner tone="danger" icon="alert-circle-outline" title="Over the credit limit" />
        ) : null}
      </Card>

      <SectionLabel>Bills</SectionLabel>
      <Card>
        {client.bills.length === 0 ? (
          <EmptyState icon="receipt-outline" title="Nothing outstanding" />
        ) : (
          client.bills.map((b, i, arr) => (
            <ListRow
              key={b.bill_id}
              title={`${b.bill_type === "FINAL" ? "Final bill" : `RA bill ${b.bill_no}`} · ${money(b.outstanding)}`}
              subtitle={
                `${b.project_name ?? b.project_code ?? "—"}` +
                (b.due_date ? ` · due ${day(b.due_date)}` : "")
              }
              right={b.disputed ? <Badge text="DISPUTED" tone={payableFlagTone('disputed')} /> : undefined}
              last={i === arr.length - 1}
            />
          ))
        )}
      </Card>
      <Divider />
    </Screen>
  );
}

export default withScreenBoundary(ReceivablesScreen);
