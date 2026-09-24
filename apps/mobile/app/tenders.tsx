/**
 * Tenders (§8): bids in flight, by closing date.
 *
 * The status machine (§8.2) is gated by its own permissions (tender.submit,
 * tender.award, tender.override) and an eligibility checklist that has to be
 * complete or explicitly overridden with a reason; none of that is a clean
 * single call worth offering from a phone, so this screen is what a bid/
 * tender manager checks on the move — what closes next, what a tender is
 * worth, whether its checklist is complete — not where they run the bid.
 * Task 5d (B-011 follow-on) adds the one cheap write: registering a new
 * tender with just its number and type, the rest of the checklist-heavy
 * workflow stays on the desktop.
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, ScrollView, View } from "react-native";
import { TENDER_STATUSES, day } from "@silverline/shared";
import { codeLabel } from "../src/labels";
import { useAuth } from "../src/auth/AuthContext";
import { getTender, getTenders, postTender, type TenderDetail } from "../src/api/endpoints";
import { describeApiError } from "../src/errorFormat";
import { canGoNewer, canGoOlder, newerOffset, olderOffset } from "../src/paging";
import { TENDER_TYPES, tenderStatusTone, validateTenderCreate } from "../src/tendersFormat";
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


function TendersScreen() {
  const { canDo } = useAuth();
  const canRead = canDo("tender.read");
  const canManage = canDo("tender.manage");
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNewTender, setShowNewTender] = useState(false);

  const tenders = useQuery({
    queryKey: ["tenders", status, search, offset],
    queryFn: () =>
      getTenders({ status: status || undefined, search: search.trim() || undefined, offset }),
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
      <BackHeader
        title="Tenders"
        onBack={() => router.back()}
        right={
          canManage ? (
            <Button
              title={showNewTender ? "Cancel" : "New tender"}
              variant={showNewTender ? "secondary" : "primary"}
              onPress={() => setShowNewTender((v) => !v)}
            />
          ) : undefined
        }
      />
      <Muted style={{ marginBottom: space.lg }}>Bids in flight, by closing date.</Muted>

      {!canRead ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to tenders"
          message="This screen needs the tender.read permission."
        />
      ) : (
        <>
          {showNewTender && canManage ? (
            <NewTenderForm
              onCreated={() => {
                setShowNewTender(false);
                setOffset(0);
                void qc.invalidateQueries({ queryKey: ["tenders"] });
              }}
            />
          ) : null}

          <Input
            placeholder="Search by tender no., reference or department"
            value={search}
            onChangeText={(v) => {
              setSearch(v);
              setOffset(0);
            }}
            autoCapitalize="none"
          />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.md }}>
            <Row gap={space.sm}>
              <Button
                title="All"
                variant={status === "" ? "primary" : "secondary"}
                onPress={() => {
                  setStatus("");
                  setOffset(0);
                }}
              />
              {TENDER_STATUSES.map((s) => (
                <Button
                  key={s}
                  title={codeLabel(s)}
                  variant={status === s ? "primary" : "secondary"}
                  onPress={() => {
                    setStatus(s);
                    setOffset(0);
                  }}
                />
              ))}
            </Row>
          </ScrollView>

          <Card>
            {listState(tenders, rows.length) === "loading" ? (
              <Loading />
            ) : listState(tenders, rows.length) === "error" ? (
              <LoadError error={tenders.error} what="tenders" />
            ) : rows.length === 0 ? (
              <EmptyState icon="document-lock-outline" title="No tenders found" />
            ) : (
              rows.map((t, i, arr) => (
                <ListRow
                  key={t.id}
                  title={t.tender_no}
                  subtitle={
                    [t.client_name ?? t.department ?? undefined, t.closing_date ? `Closes ${day(t.closing_date)}` : undefined]
                      .filter(Boolean)
                      .join(" · ")
                  }
                  right={<Badge text={codeLabel(t.status)} tone={tenderStatusTone(t.status)} />}
                  onPress={() => setSelectedId(t.id)}
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
                disabled={!canGoOlder(tenders.data?.hasMore)}
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

function NewTenderForm({ onCreated }: { onCreated: () => void }) {
  const [tenderNo, setTenderNo] = useState(`TN-${Date.now().toString().slice(-8)}`);
  const [tenderType, setTenderType] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    const v = validateTenderCreate({ tender_no: tenderNo, tender_type: tenderType });
    if (!v.ok) {
      setError(v.errors.map((e) => e.message).join("\n"));
      return;
    }
    setBusy(true);
    try {
      await postTender({ tender_no: tenderNo.trim(), tender_type: tenderType });
      onCreated();
    } catch (e) {
      setError(describeApiError(e, "Could not create this tender"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="New tender">
      {error ? <Banner tone="danger" icon="alert-circle-outline" title={error} /> : null}
      <Input label="Tender number" value={tenderNo} onChangeText={setTenderNo} maxLength={50} />
      <Subtle style={{ marginBottom: space.xs }}>Type</Subtle>
      <Row gap={space.sm} style={{ flexWrap: "wrap", marginBottom: space.md }}>
        {TENDER_TYPES.map((tt) => (
          <Button
            key={tt}
            title={codeLabel(tt)}
            variant={tenderType === tt ? "primary" : "secondary"}
            onPress={() => setTenderType(tt)}
          />
        ))}
      </Row>
      <Button
        title="Save tender"
        icon="add-circle-outline"
        loading={busy}
        disabled={busy}
        onPress={() => void submit()}
      />
    </Card>
  );
}

function TenderDetailView({ tender }: { tender: TenderDetail }) {
  const t = useTheme();
  return (
    <View>
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Muted style={{ color: t.text, fontWeight: "700", flex: 1 }}>{tender.tender_no}</Muted>
          <Badge text={codeLabel(tender.status)} tone={tenderStatusTone(tender.status)} />
        </Row>
        {tender.client_name ? <Subtle style={{ marginTop: space.xs }}>{tender.client_name}</Subtle> : null}
        <Divider />
        <Field label="Type" value={codeLabel(tender.tender_type)} />
        {tender.department ? <Field label="Department" value={tender.department} /> : null}
        {tender.authority ? <Field label="Authority" value={tender.authority} /> : null}
        {tender.reference_number ? <Field label="Reference" value={tender.reference_number} /> : null}
        {money(tender.estimated_value) ? (
          <Field label="Estimated value" value={money(tender.estimated_value)!} />
        ) : null}
        {money(tender.bid_value) ? <Field label="Bid value" value={money(tender.bid_value)!} /> : null}
        {tender.opening_date ? <Field label="Opening date" value={day(tender.opening_date)} /> : null}
        {tender.closing_date ? <Field label="Closing date" value={day(tender.closing_date)} /> : null}
        {tender.submission_date ? <Field label="Submission date" value={day(tender.submission_date)} /> : null}
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
            <ListRow title={tender.project.name} subtitle={tender.project.code} right={<Badge text={codeLabel(tender.project.status)} />} last />
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
                    text={codeLabel(item.item_status)}
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
