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
import { LEAD_STAGES } from "@silverline/shared";
import { ApiError } from "../src/api/client";
import { useAuth } from "../src/auth/AuthContext";
import { getLead, getLeads, postLeadStage, type LeadDetail } from "../src/api/endpoints";
import { formatLeadStage, leadStageTone, validateLeadStageChange } from "../src/leadsFormat";
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

function PipelineScreen() {
  const { canDo } = useAuth();
  const canRead = canDo("lead.read");
  const canManage = canDo("lead.manage");
  const [stage, setStage] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const qc = useQueryClient();

  const leads = useQuery({
    queryKey: ["leads", stage, search],
    queryFn: () => getLeads({ stage: stage || undefined, search: search.trim() || undefined }),
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

  return (
    <Screen>
      <BackHeader title="Pipeline" onBack={() => router.back()} />
      <Muted style={{ marginBottom: space.lg }}>Leads, by stage.</Muted>

      {!canRead ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to the pipeline"
          message="This screen needs the lead.read permission."
        />
      ) : (
        <>
          <Input
            placeholder="Search by organisation or lead number"
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
          />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.md }}>
            <Row gap={space.sm}>
              <Button
                title="All"
                variant={stage === "" ? "primary" : "secondary"}
                onPress={() => setStage("")}
              />
              {LEAD_STAGES.map((s) => (
                <Button
                  key={s}
                  title={formatLeadStage(s)}
                  variant={stage === s ? "primary" : "secondary"}
                  onPress={() => setStage(s)}
                />
              ))}
            </Row>
          </ScrollView>

          <Card>
            {leads.isLoading ? (
              <Loading />
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
        e instanceof ApiError
          ? e.status === 409
            ? "This lead changed while you were looking at it. Reload and try again."
            : e.message
          : "Could not change the stage",
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
        <Field label="Type" value={lead.lead_type} />
        <Field label="Source" value={lead.source} />
        {lead.owner_username ? <Field label="Owner" value={lead.owner_username} /> : null}
        {money(lead.estimated_value) ? (
          <Field label="Estimated value" value={money(lead.estimated_value)!} />
        ) : null}
        {lead.next_follow_up_date ? (
          <Field label="Next follow-up" value={lead.next_follow_up_date} />
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
                  [entry.interaction_type, entry.logged_by_username ?? undefined]
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
