/**
 * The day's return for one village, filed from the village.
 *
 * Today's figures only. There is no cumulative field here, and there is none
 * on the server either: the running total is summed from these, which is what
 * makes a return filed three days late still correct.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollView, View } from "react-native";
import { DELAY_REASONS, day } from "@silverline/shared";
import {
  getSurveyMeasures,
  getVillageRovers,
  type MyVillage,
  type SurveyMeasure,
} from "../api/endpoints";
import { submitQueued } from "../sync/engine";
import {
  Badge,
  Banner,
  Button,
  Card,
  Divider,
  Input,
  Loading,
  Muted,
  Row,
  SectionLabel,
  Subtle,
  Title,
} from "../ui/primitives";
import { space, useTheme } from "../theme";
import { buildEntry, emptyDraft, type ReturnDraft } from "./returnForm";

/** A rover, as against the tripod and the radio that travelled with it. */
function isSurveyInstrument(category: string | null): boolean {
  return String(category ?? "").toUpperCase() === "SURVEY";
}

function ReasonPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (code: string | null) => void;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs, marginBottom: space.sm }}>
      {DELAY_REASONS.map(r => (
        <Button
          key={r.code}
          title={r.label}
          variant={value === r.code ? "primary" : "secondary"}
          onPress={() => onChange(value === r.code ? null : r.code)}
          style={{ minHeight: 38, paddingHorizontal: space.md }}
        />
      ))}
    </View>
  );
}

export function DailyReturn({
  village,
  workDate,
  onFiled,
}: {
  village: MyVillage;
  workDate: string;
  onFiled: (message: string) => void;
}) {
  const t = useTheme();
  const [draft, setDraft] = useState<ReturnDraft>(emptyDraft);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const catalogue = useQuery({ queryKey: ["survey", "measures"], queryFn: getSurveyMeasures });
  const kit = useQuery({
    queryKey: ["survey", "rovers", village.id],
    queryFn: () => getVillageRovers(village.id),
  });

  const measures: SurveyMeasure[] = useMemo(
    () => [...(catalogue.data?.measures ?? [])].sort((a, b) => a.display_order - b.display_order),
    [catalogue.data],
  );

  /*
   * Only the instruments, and only the ones still out.
   *
   * Kit is issued to a person, not to a place, so a crew's allocation carries
   * whatever they signed for — a tripod, a radio, on one village a welding
   * set. Asking the crew to mark a welding set "in use or idle" every evening
   * teaches them the whole question is noise.
   */
  const rovers = useMemo(
    () => (kit.data ?? []).filter(r => r.out && isSurveyInstrument(r.category)),
    [kit.data],
  );
  const otherKitOut = useMemo(
    () => (kit.data ?? []).filter(r => r.out && !isSurveyInstrument(r.category)).length,
    [kit.data],
  );

  const setQuantity = (code: string, text: string) =>
    setDraft(d => ({ ...d, quantities: { ...d.quantities, [code]: text } }));

  /** An instrument not yet touched defaults to in use, which is the usual day. */
  const ROVER_DEFAULT: ReturnDraft["rovers"][string] = {
    status: "UTILIZED", idleReason: null, remarks: "",
  };

  const setRover = (assetId: string, patch: Partial<ReturnDraft["rovers"][string]>) =>
    setDraft(d => ({
      ...d,
      rovers: {
        ...d.rovers,
        [assetId]: { ...ROVER_DEFAULT, ...d.rovers[assetId], ...patch },
      },
    }));

  const file = async () => {
    setProblems([]);
    const built = buildEntry({
      villageId: village.id,
      entryDate: workDate,
      measures,
      draft,
      lowProgressThresholdAc: village.low_progress_threshold_ac,
      groundTruthing: {
        state: village.gt_state,
        expectedEndOn: village.gt_expected_end_on,
        completedOn: village.gt_completed_on,
        varianceReason: village.gt_variance_reason,
      },
      today: workDate,
    });
    if (!built.ok) {
      setProblems(built.problems);
      return;
    }
    setBusy(true);
    try {
      const message = await submitQueued({
        entity: "survey_entry",
        // One return per village per day is the rule the server enforces, so
        // it is also the dedupe key: a double tap cannot queue two.
        op: `${village.id}:${workDate}`,
        payload: built.entry as unknown as Record<string, unknown>,
      });
      onFiled(message);
    } catch (e) {
      setProblems([e instanceof Error ? e.message : "The return could not be filed."]);
    } finally {
      setBusy(false);
    }
  };

  if (catalogue.isLoading || kit.isLoading) return <Loading label="Loading the day's form…" />;

  const grouped = new Map<string, SurveyMeasure[]>();
  for (const m of measures) {
    const key = m.group_label ?? "Measures";
    grouped.set(key, [...(grouped.get(key) ?? []), m]);
  }

  return (
    <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1 }}>
      <Title>{village.village_name}</Title>
      <Muted>
        {[village.mandal_name, village.district_name].filter(Boolean).join(" · ")}
      </Muted>
      <Row style={{ marginTop: space.sm, marginBottom: space.md }}>
        <Badge text={village.stage_label} tone="info" />
        <Subtle>Return for {day(workDate)}</Subtle>
      </Row>

      {catalogue.isError || kit.isError ? (
        <Banner
          tone="warning"
          icon="cloud-offline-outline"
          title="Working from the last copy on this device"
          message="The form was loaded when you were last online. File the return anyway — it will send when there is signal."
        />
      ) : null}

      {problems.length ? (
        <Banner
          tone="danger"
          icon="alert-circle-outline"
          title={problems.length === 1 ? "One thing to fix" : `${problems.length} things to fix`}
          message={problems.join("\n")}
        />
      ) : null}

      {[...grouped.entries()].map(([group, items]) => (
        <Card key={group} title={group}>
          {items.map(m => (
            <Input
              key={m.code}
              label={`${m.label} (${m.unit})`}
              value={draft.quantities[m.code] ?? ""}
              onChangeText={(v: string) => setQuantity(m.code, v)}
              keyboardType="decimal-pad"
              placeholder="0"
              // Left blank rather than pre-filled with a zero: a zero somebody
              // did not type is a zero nobody checked.
              hint={m.basis === "EXTENT" ? "Acres done today" : undefined}
            />
          ))}
        </Card>
      ))}

      <Card title="Instruments">
        {rovers.length === 0 ? (
          <Muted>No survey instrument is allocated to this village.</Muted>
        ) : (
          rovers.map((r, i) => {
            const line = draft.rovers[r.asset_id];
            const idle = line?.status === "IDLE";
            return (
              <View key={r.asset_id}>
                <Subtle>{r.asset_code}</Subtle>
                <Row style={{ marginTop: space.xs, marginBottom: space.sm }}>
                  <Button
                    title="In use"
                    variant={line && !idle ? "primary" : "secondary"}
                    onPress={() => setRover(r.asset_id, { status: "UTILIZED", idleReason: null })}
                    style={{ flex: 1 }}
                  />
                  <Button
                    title="Idle"
                    variant={idle ? "primary" : "secondary"}
                    tone={idle ? "warning" : undefined}
                    onPress={() => setRover(r.asset_id, { status: "IDLE" })}
                    style={{ flex: 1 }}
                  />
                </Row>
                <Muted>{r.asset_name}</Muted>
                {idle ? (
                  <View style={{ marginTop: space.sm }}>
                    <SectionLabel>Why was it idle?</SectionLabel>
                    <ReasonPicker
                      value={line?.idleReason ?? null}
                      onChange={code => setRover(r.asset_id, { idleReason: code })}
                    />
                    <Input
                      label="Remarks"
                      value={line?.remarks ?? ""}
                      onChangeText={(v: string) => setRover(r.asset_id, { remarks: v })}
                      placeholder={line?.idleReason === "OTHER" ? "Required — say what happened" : "Optional"}
                      multiline
                    />
                  </View>
                ) : null}
                {i === rovers.length - 1 ? null : <Divider />}
              </View>
            );
          })
        )}
        {otherKitOut > 0 ? (
          <Muted>
            {otherKitOut} other item{otherKitOut === 1 ? " is" : "s are"} out on this village and
            {otherKitOut === 1 ? " is" : " are"} not accounted for here.
          </Muted>
        ) : null}
      </Card>

      {/*
        * Asked only for ground truthing, which is the stage walked alongside
        * the department's staff. On the other stages there is nobody to count
        * and the question would collect noise.
        */}
      {village.stage_code === "GROUND_TRUTHING" ? (
        <Card title="Who was in the village">
          <Input
            label="Government staff present"
            value={draft.govtStaffPresent}
            onChangeText={(v: string) => setDraft(d => ({ ...d, govtStaffPresent: v }))}
            keyboardType="number-pad"
            hint="Enter 0 if none came. Leave blank only if nobody was asked."
          />
          <Input
            label="Crew present"
            value={draft.crewPresent}
            onChangeText={(v: string) => setDraft(d => ({ ...d, crewPresent: v }))}
            keyboardType="number-pad"
          />
        </Card>
      ) : null}

      {/*
        * Asked only while it is owed.
        *
        * Ground truthing past its date has to say why, and the server refuses
        * the day until it does. Once the reason is on the stage the question
        * disappears — the point is to get the explanation on file, not to
        * make a crew retype it every evening.
        */}
      {village.gt_expected_end_on
        && !village.gt_variance_reason
        && village.gt_completed_on === null
        && village.gt_expected_end_on < workDate ? (
          <Card title="Ground truthing is past its date">
            <Muted>
              {`This village was due to finish ground truthing on ${
                village.gt_expected_end_on}. Say why before recording another day.`}
            </Muted>
            <View style={{ marginTop: space.sm }}>
              <ReasonPicker
                value={draft.gtVarianceReason}
                onChange={code => setDraft(d => ({ ...d, gtVarianceReason: code }))}
              />
              {draft.gtVarianceReason ? (
                <Input
                  label="What happened"
                  value={draft.gtVarianceRemarks}
                  onChangeText={(v: string) =>
                    setDraft(d => ({ ...d, gtVarianceRemarks: v }))}
                  placeholder={draft.gtVarianceReason === "OTHER" ? "Required" : "Optional"}
                  multiline
                />
              ) : null}
            </View>
          </Card>
        ) : null}

      <Card title="Anything else">
        <SectionLabel>Reason, if the day was short</SectionLabel>
        <ReasonPicker
          value={draft.lowProgressReason}
          onChange={code => setDraft(d => ({ ...d, lowProgressReason: code }))}
        />
        {draft.lowProgressReason ? (
          <Input
            label="What happened"
            value={draft.lowProgressRemarks}
            onChangeText={(v: string) => setDraft(d => ({ ...d, lowProgressRemarks: v }))}
            placeholder={draft.lowProgressReason === "OTHER" ? "Required" : "Optional"}
            multiline
          />
        ) : null}
        <Input
          label="Notes"
          value={draft.notes}
          onChangeText={(v: string) => setDraft(d => ({ ...d, notes: v }))}
          multiline
        />
      </Card>

      <Button
        title="File the day's return"
        icon="cloud-upload-outline"
        loading={busy}
        onPress={file}
        style={{ marginBottom: space.xxl }}
      />
      <View style={{ height: space.xxl, backgroundColor: t.canvas }} />
    </ScrollView>
  );
}
