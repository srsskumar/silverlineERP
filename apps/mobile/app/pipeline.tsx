/**
 * Pipeline (§7): leads by stage, with a detail sheet that can advance the
 * stage — the one action that matters from a phone. Everything else about a
 * lead (owner reassignment, project-type/category, promoting to an
 * opportunity) stays on the desktop form; this is a sales/BD person checking
 * where things stand and moving one forward between meetings.
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, ScrollView, View } from "react-native";
import { LEAD_STAGES, day, dayTime } from "@silverline/shared";
import { codeLabel } from "../src/labels";
import { ApiError } from "../src/api/client";
import { describeApiError } from "../src/errorFormat";
import { useAuth } from "../src/auth/AuthContext";
import { getLead, getLeads, postLead, postLeadStage, type LeadDetail } from "../src/api/endpoints";
import {
  LEAD_SOURCES,
  LEAD_TYPES,
  formatLeadSource,
  formatLeadStage,
  leadStageTone,
  validateLeadCreate,
  validateLeadStageChange,
} from "../src/leadsFormat";
import { canGoNewer, canGoOlder, newerOffset, olderOffset } from "../src/paging";
import { withScreenBoundary } from "../src/ui/ErrorBoundary";
import { usePullRefresh } from "../src/ui/usePullRefresh";
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


function PipelineScreen() {
  const { canDo } = useAuth();
  const canRead = canDo("lead.read");
  const canManage = canDo("lead.manage");
  const [stage, setStage] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNewLead, setShowNewLead] = useState(false);
  const qc = useQueryClient();

  const leads = useQuery({
    queryKey: ["leads", stage, search, offset],
    queryFn: () => getLeads({ stage: stage || undefined, search: search.trim() || undefined, offset }),
    enabled: canRead,
  });
  const detail = useQuery({
    queryKey: ["lead", selectedId],
    queryFn: () => getLead(selectedId!),
    enabled: Boolean(selectedId),
  });

  const rows = leads.data?.items ?? [];

  const close = () => setSelectedId(null);
  const afterChange = () => {
    void qc.invalidateQueries({ queryKey: ["leads"] });
    void qc.invalidateQueries({ queryKey: ["lead", selectedId] });
  };
  const afterCreate = () => {
    setOffset(0);
    void qc.invalidateQueries({ queryKey: ["leads"] });
  };

  const pull = usePullRefresh(canRead && leads);


  return (
    <Screen refresh={pull}>
      <BackHeader
        title="Pipeline"
        onBack={() => router.back()}
        right={
          canManage ? (
            <Button
              title={showNewLead ? "Cancel" : "New lead"}
              variant={showNewLead ? "secondary" : "primary"}
              onPress={() => setShowNewLead((v) => !v)}
            />
          ) : undefined
        }
      />
      <Muted style={{ marginBottom: space.lg }}>Leads, by stage.</Muted>

      {!canRead ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to the pipeline"
          message="This screen needs the lead.read permission."
        />
      ) : (
        <>
          {showNewLead && canManage ? (
            <NewLeadForm
              onCreated={() => {
                setShowNewLead(false);
                afterCreate();
              }}
            />
          ) : null}

          <Input
            placeholder="Search by organisation or lead number"
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
                variant={stage === "" ? "primary" : "secondary"}
                onPress={() => {
                  setStage("");
                  setOffset(0);
                }}
              />
              {LEAD_STAGES.map((s) => (
                <Button
                  key={s}
                  title={formatLeadStage(s)}
                  variant={stage === s ? "primary" : "secondary"}
                  onPress={() => {
                    setStage(s);
                    setOffset(0);
                  }}
                />
              ))}
            </Row>
          </ScrollView>

          <Card>
            {listState(leads, rows.length) === "loading" ? (
              <Loading />
            ) : listState(leads, rows.length) === "error" ? (
              <LoadError query={leads} what="leads" />
            ) : rows.length === 0 ? (
              <EmptyState icon="trending-up-outline" title="No leads found" />
            ) : (
              rows.map((l, i, arr) => (
                <ListRow
                  key={l.id}
                  title={l.organization_name}
                  subtitle={
                    [l.lead_no, l.owner_username ?? undefined, money(l.estimated_value) ?? undefined]
                      .filter(Boolean)
                      .join(" · ")
                  }
                  right={<Badge text={formatLeadStage(l.stage)} tone={leadStageTone(l.stage)} />}
                  onPress={() => setSelectedId(l.id)}
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
                disabled={!canGoOlder(leads.data?.hasMore)}
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
        onRequestClose={close}
      >
        <Screen>
          <BackHeader title="Lead" onBack={close} />
          {detail.isLoading ? (
            <Loading />
          ) : !detail.data ? (
            <EmptyState icon="alert-circle-outline" title="Could not load this lead" />
          ) : (
            <LeadDetailView
              lead={detail.data}
              canManage={canManage}
              onChanged={afterChange}
            />
          )}
        </Screen>
      </Modal>
    </Screen>
  );
}

/**
 * B-011: a lead create form gated by lead.manage — the same required fields
 * as packages/shared/src/crm.ts's leadSchema (lead_no, organization_name,
 * lead_type, source), sent with no extra or stripped fields. Everything else
 * the schema allows (client_id, contact_id, project_type/category,
 * owner_id, next_follow_up_date) is optional there and stays a desktop-only
 * field, same reasoning as this screen's header comment.
 */
function NewLeadForm({ onCreated }: { onCreated: () => void }) {
  const [leadNo, setLeadNo] = useState(`LD-${Date.now().toString().slice(-8)}`);
  const [orgName, setOrgName] = useState("");
  const [leadType, setLeadType] = useState<string>("");
  const [source, setSource] = useState<string>("");
  const [estimatedValue, setEstimatedValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    const v = validateLeadCreate({
      lead_no: leadNo,
      organization_name: orgName,
      lead_type: leadType,
      source,
      estimated_value: estimatedValue,
    });
    if (!v.ok) {
      setError(v.errors.map((e) => e.message).join("\n"));
      return;
    }
    setBusy(true);
    try {
      await postLead({
        lead_no: leadNo.trim(),
        organization_name: orgName.trim(),
        lead_type: leadType,
        source,
        ...(estimatedValue.trim() ? { estimated_value: Number(estimatedValue) } : {}),
      });
      onCreated();
    } catch (e) {
      setError(describeApiError(e, "Could not create this lead"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="New lead">
      {error ? <Banner tone="danger" icon="alert-circle-outline" title={error} /> : null}
      <Input label="Lead number" value={leadNo} onChangeText={setLeadNo} maxLength={50} />
      <Input label="Organisation" placeholder="Who is this for?" value={orgName} onChangeText={setOrgName} />

      <Subtle style={{ marginBottom: space.xs }}>Type</Subtle>
      <Row gap={space.sm} style={{ marginBottom: space.md }}>
        {LEAD_TYPES.map((lt) => (
          <Button
            key={lt}
            title={lt === "GOVERNMENT" ? "Government" : "Private"}
            variant={leadType === lt ? "primary" : "secondary"}
            onPress={() => setLeadType(lt)}
            style={{ flex: 1 }}
          />
        ))}
      </Row>

      <Subtle style={{ marginBottom: space.xs }}>Source</Subtle>
      <Row gap={space.sm} style={{ flexWrap: "wrap", marginBottom: space.md }}>
        {LEAD_SOURCES.map((s) => (
          <Button
            key={s}
            title={formatLeadSource(s)}
            variant={source === s ? "primary" : "secondary"}
            onPress={() => setSource(s)}
          />
        ))}
      </Row>

      <Input
        label="Estimated value (optional)"
        placeholder="0"
        keyboardType="decimal-pad"
        value={estimatedValue}
        onChangeText={setEstimatedValue}
      />
      <Button
        title="Save lead"
        icon="add-circle-outline"
        loading={busy}
        disabled={busy}
        onPress={() => void submit()}
      />
    </Card>
  );
}

function LeadDetailView({
  lead,
  canManage,
  onChanged,
}: {
  lead: LeadDetail;
  canManage: boolean;
  onChanged: () => void;
}) {
  const t = useTheme();
  const [pendingStage, setPendingStage] = useState<string | null>(null);
  const [lostReason, setLostReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const needsReason = pendingStage === "LOST" || pendingStage === "DISQUALIFIED";

  const confirmStage = async (stage: string) => {
    setError(null);
    const v = validateLeadStageChange(stage, lostReason);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    setBusy(true);
    try {
      await postLeadStage(lead.id, stage, lead.version, lostReason.trim() || undefined);
      setPendingStage(null);
      setLostReason("");
      onChanged();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? "This lead changed while you were looking at it. Reload and try again."
          : describeApiError(e, "Could not change the stage"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Muted style={{ color: t.text, fontWeight: "700", flex: 1 }}>{lead.organization_name}</Muted>
          <Badge text={formatLeadStage(lead.stage)} tone={leadStageTone(lead.stage)} />
        </Row>
        <Subtle style={{ marginTop: space.xs }}>{lead.lead_no}</Subtle>
        <Divider />
        <Field label="Type" value={codeLabel(lead.lead_type)} />
        <Field label="Source" value={formatLeadSource(lead.source)} />
        {lead.owner_username ? <Field label="Owner" value={lead.owner_username} /> : null}
        {money(lead.estimated_value) ? (
          <Field label="Estimated value" value={money(lead.estimated_value)!} />
        ) : null}
        {lead.next_follow_up_date ? (
          <Field label="Next follow-up" value={day(lead.next_follow_up_date)} />
        ) : null}
        {lead.notes ? <Field label="Notes" value={lead.notes} /> : null}
      </Card>

      {error ? <Banner tone="danger" icon="alert-circle-outline" title={error} /> : null}

      {canManage && lead.allowed_stages.length > 0 ? (
        <>
          <SectionLabel>Advance stage</SectionLabel>
          <Card>
            <Row gap={space.sm} style={{ flexWrap: "wrap" }}>
              {lead.allowed_stages.map((s) => (
                <Button
                  key={s}
                  title={formatLeadStage(s)}
                  variant={pendingStage === s ? "primary" : "secondary"}
                  tone={s === "LOST" || s === "DISQUALIFIED" ? "danger" : undefined}
                  onPress={() => setPendingStage(pendingStage === s ? null : s)}
                />
              ))}
            </Row>
            {pendingStage ? (
              <View style={{ marginTop: space.md }}>
                {needsReason ? (
                  <Input
                    label="Reason"
                    hint="Required to mark a lead lost or disqualified."
                    placeholder="Why?"
                    value={lostReason}
                    onChangeText={setLostReason}
                    multiline
                  />
                ) : null}
                <Button
                  title={`Confirm: ${formatLeadStage(pendingStage)}`}
                  loading={busy}
                  onPress={() => void confirmStage(pendingStage)}
                />
              </View>
            ) : null}
          </Card>
        </>
      ) : null}

      {lead.timeline.length > 0 ? (
        <>
          <SectionLabel>Recent activity</SectionLabel>
          <Card>
            {lead.timeline.slice(0, 10).map((entry, i, arr) => (
              <ListRow
                key={entry.id}
                title={entry.summary}
                subtitle={
                  [codeLabel(entry.interaction_type), entry.logged_by_username ?? undefined, entry.occurred_at ? dayTime(entry.occurred_at) : undefined]
                    .filter(Boolean)
                    .join(" · ")
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

export default withScreenBoundary(PipelineScreen);
