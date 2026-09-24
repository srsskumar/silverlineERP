/**
 * Mark the stage this person is crewed on as complete, from the village
 * (SG-013).
 *
 * Offered only on their own stage (see completionOffer), which follows the
 * owner's rule of 2026-09-24: the assigned employee, their manager, a team
 * lead, the project manager or an admin completes a stage. Queued like the
 * return, because the village it is finished in has no signal either.
 */
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { DELAY_REASONS, day, gtReasonRequired } from "@silverline/shared";
import type { MyVillage } from "../api/endpoints";
import { submitQueued } from "../sync/engine";
import { Banner, Button, Card, Input, Muted, SectionLabel, Title } from "../ui/primitives";
import { space } from "../theme";
import { stageSubmission } from "./fieldCrew";

export function StageComplete({
  village,
  workDate,
  onDone,
}: {
  village: MyVillage;
  workDate: string;
  onDone: (message: string) => void;
}) {
  const [reason, setReason] = useState<string | null>(null);
  const [remarks, setRemarks] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const late = village.stage_code === "GROUND_TRUTHING" && gtReasonRequired({
    expectedEndOn: village.stage_expected_end_on ?? null,
    completedOn: workDate,
    varianceReason: village.stage_variance_reason ?? null,
  }, workDate);

  const complete = async () => {
    setProblem(null);
    const built = stageSubmission(village, workDate, reason, remarks);
    if (!built.ok) { setProblem(built.problem); return; }
    setBusy(true);
    try {
      const message = await submitQueued({
        entity: built.op.entity, op: built.op.op, payload: built.op.payload,
      });
      onDone(message);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "The stage could not be marked complete.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1 }}>
      <Title>{`Finish ${village.stage_label.toLowerCase()}`}</Title>
      <Muted>{`${village.village_name} · completed ${day(workDate)}`}</Muted>
      {problem ? (
        <Banner tone="danger" icon="alert-circle-outline" title="One thing to fix" message={problem} />
      ) : null}
      {late ? (
        <Card title="It finished after its date">
          <Muted>{`This was due on ${village.stage_expected_end_on}. Say why before signing it off.`}</Muted>
          <SectionLabel>Reason</SectionLabel>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
            {DELAY_REASONS.map(r => (
              <Button
                key={r.code}
                title={r.label}
                variant={reason === r.code ? "primary" : "secondary"}
                onPress={() => setReason(reason === r.code ? null : r.code)}
                style={{ minHeight: 38, paddingHorizontal: space.md }}
              />
            ))}
          </View>
          {reason ? (
            <Input label="What happened" value={remarks} onChangeText={setRemarks}
              placeholder={reason === "OTHER" ? "Required" : "Optional"} multiline />
          ) : null}
        </Card>
      ) : null}
      <Button title="Mark complete" icon="checkmark-done-outline" loading={busy} onPress={complete}
        style={{ marginTop: space.md }} />
    </ScrollView>
  );
}
