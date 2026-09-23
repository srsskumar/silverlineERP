/**
 * Tenders (§8): bids in flight, by closing date — read-only on mobile.
 *
 * The status machine (§8.2) is gated by its own permissions (tender.submit,
 * tender.award, tender.override) and an eligibility checklist that has to be
 * complete or explicitly overridden with a reason; none of that is a clean
 * single call worth offering from a phone, so this screen is what a bid/
 * tender manager checks on the move — what closes next, what a tender is
 * worth, whether its checklist is complete — not where they run the bid.
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, ScrollView, View } from "react-native";
import { TENDER_STATUSES } from "@silverline/shared";
import { useAuth } from "../src/auth/AuthContext";
import { getTender, getTenders, type TenderDetail } from "../src/api/endpoints";
import { tenderStatusTone } from "../src/tendersFormat";
import { withScreenBoundary } from "../src/ui/ErrorBoundary";
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

function money(v: number | string | undefined | null): string | null {
  const n = Number(v ?? 0);
  if (!n) return null;
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function TendersScreen() {
  const { canDo } = useAuth();
  const canRead = canDo("tender.read");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const tenders = useQuery({
    queryKey: ["tenders", status, search],
    queryFn: () => getTenders({ status: status || undefined, search: search.trim() || undefined }),
    enabled: canRead,
  });
  const detail = useQuery({
    queryKey: ["tender", selectedId],
    queryFn: () => getTender(selectedId!),
    enabled: Boolean(selectedId),
  });

  const rows = tenders.data?.items ?? [];

  return (
    <Screen>
      <BackHeader title="Tenders" onBack={() => router.back()} />
      <Muted style={{ marginBottom: space.lg }}>Bids in flight, by closing date.</Muted>

      {!canRead ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to tenders"
          message="This screen needs the tender.read permission."
        />
      ) : (
        <>
          <Input
            placeholder="Search by tender no., reference or department"
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
          />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.md }}>
            <Row gap={space.sm}>
              <Button
                title="All"
                variant={status === "" ? "primary" : "secondary"}
                onPress={() => setStatus("")}
              />
              {TENDER_STATUSES.map((s) => (
                <Button
                  key={s}
                  title={s.replaceAll("_", " ")}
                  variant={status === s ? "primary" : "secondary"}
                  onPress={() => setStatus(s)}
                />
              ))}
            </Row>
          </ScrollView>

          <Card>
            {tenders.isLoading ? (
              <Loading />
            ) : rows.length === 0 ? (
              <EmptyState icon="document-lock-outline" title="No tenders found" />
            ) : (
              rows.map((t, i, arr) => (
                <ListRow
                  key={t.id}
                  title={t.tender_no}
                  subtitle={
                    [t.client_name ?? t.department ?? undefined, t.closing_date ? `Closes ${t.closing_date}` : undefined]
                      .filter(Boolean)
                      .join(" · ")
                  }
                  right={<Badge text={t.status.replaceAll("_", " ")} tone={tenderStatusTone(t.status)} />}
                  onPress={() => setSelectedId(t.id)}
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
          <BackHeader title="Tender" onBack={() => setSelectedId(null)} />
          {detail.isLoading ? (
            <Loading />
          ) : !detail.data ? (
            <EmptyState icon="alert-circle-outline" title="Could not load this tender" />
          ) : (
            <TenderDetailView tender={detail.data} />
          )}
        </Screen>
      </Modal>
    </Screen>
  );
}

function TenderDetailView({ tender }: { tender: TenderDetail }) {
  const t = useTheme();
  return (
    <View>
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Muted style={{ color: t.text, fontWeight: "700", flex: 1 }}>{tender.tender_no}</Muted>
          <Badge text={tender.status.replaceAll("_", " ")} tone={tenderStatusTone(tender.status)} />
        </Row>
        {tender.client_name ? <Subtle style={{ marginTop: space.xs }}>{tender.client_name}</Subtle> : null}
        <Divider />
        {tender.department ? <Field label="Department" value={tender.department} /> : null}
        {tender.authority ? <Field label="Authority" value={tender.authority} /> : null}
        {tender.reference_number ? <Field label="Reference" value={tender.reference_number} /> : null}
        {money(tender.estimated_value) ? (
          <Field label="Estimated value" value={money(tender.estimated_value)!} />
        ) : null}
        {money(tender.bid_value) ? <Field label="Bid value" value={money(tender.bid_value)!} /> : null}
        {tender.opening_date ? <Field label="Opening date" value={tender.opening_date} /> : null}
        {tender.closing_date ? <Field label="Closing date" value={tender.closing_date} /> : null}
        {tender.submission_date ? <Field label="Submission date" value={tender.submission_date} /> : null}
      </Card>

      {tender.outstanding_required > 0 ? (
        <Banner
          tone="warning"
          icon="alert-circle-outline"
          title={`${tender.outstanding_required} required eligibility item${tender.outstanding_required === 1 ? "" : "s"} outstanding`}
          message="Complete these on the desktop before the tender can be submitted or awarded."
        />
      ) : null}

      {tender.project ? (
        <>
          <SectionLabel>Converted project</SectionLabel>
          <Card>
            <ListRow title={tender.project.name} subtitle={tender.project.code} right={<Badge text={tender.project.status} />} last />
          </Card>
        </>
      ) : null}

      {tender.eligibility.length > 0 ? (
        <>
          <SectionLabel>Eligibility checklist</SectionLabel>
          <Card>
            {tender.eligibility.map((item, i, arr) => (
              <ListRow
                key={item.id}
                title={item.requirement_name}
                subtitle={item.is_required ? "Required" : "Optional"}
                right={
                  <Badge
                    text={item.item_status.replaceAll("_", " ")}
                    tone={["READY", "SUBMITTED"].includes(item.item_status) ? "success" : "warning"}
                  />
                }
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

export default withScreenBoundary(TendersScreen);
