/**
 * Survey: the villages this person is crewed to, and the day's return for each.
 *
 * The app already asked about the return at punch-out — "file the day's
 * return, or say why you cannot" — and until this screen existed there was no
 * way to file one. Every crew member was pushed down the "why you cannot"
 * branch by the absence of a form, and the figures were retyped at a desk
 * from a photograph of a notebook.
 */
import { withScreenBoundary } from "../../src/ui/ErrorBoundary";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, View } from "react-native";
import { useAuth } from "../../src/auth/AuthContext";
import { getMyVillages, type MyVillage, type SurveyEntryInput } from "../../src/api/endpoints";
import { readPayload } from "../../src/sync/queue";
import { reviewRequest } from "../../src/survey/reviewLink";
import { useLocalSearchParams } from "expo-router";
import { DailyReturn } from "../../src/survey/DailyReturn";
import { ControlPointForm } from "../../src/survey/ControlPointForm";
import { StageComplete } from "../../src/survey/StageComplete";
import { completionOffer } from "../../src/survey/fieldCrew";
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  ListRow,
  Loading,
  Muted,
  Row,
  Screen,
  SectionLabel,
  Subtle,
  Title,
} from "../../src/ui/primitives";
import { space, useTheme } from "../../src/theme";
import { day } from "@silverline/shared";

type Sheet = {
  village: MyVillage;
  kind: "return" | "point" | "stage";
  review?: { clientUuid: string; payload: SurveyEntryInput } | null;
} | null;

function SurveyScreen() {
  const t = useTheme();
  const { canDo } = useAuth();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [message, setMessage] = useState<string | null>(null);

  const mine = useQuery({ queryKey: ["survey", "my-villages"], queryFn: getMyVillages });
  const villages = mine.data?.villages ?? [];
  const workDate = mine.data?.workDate ?? "";

  const mayEnter = canDo("survey.enter");
  const outstanding = villages.filter(v => !v.filed_today);

  /*
   * Opened from the Sync queue on a conflicted return (fix round 2): the
   * queued draft, read back and reopened on its village for review.
   */
  // Keyed per tap (final review, item 4): a second Review on the same op reopens it.
  const request = reviewRequest(useLocalSearchParams<{ review?: string; at?: string }>());
  useEffect(() => {
    if (!request || !villages.length) return;
    const reviewId = request.clientUuid;
    void readPayload(reviewId).then(p => {
      const payload = p as SurveyEntryInput | null;
      const village = payload && villages.find(v => v.id === payload.survey_village_id);
      if (payload && village) {
        setSheet({ village, kind: "return", review: { clientUuid: reviewId, payload } });
      }
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.key, villages.length]);

  const close = (note?: string) => {
    setSheet(null);
    if (note) setMessage(note);
    void mine.refetch();
  };

  return (
    <Screen>
      <Title>Survey</Title>
      {workDate ? <Muted>Day of {day(workDate)}</Muted> : null}

      {message ? (
        <Banner tone="success" icon="checkmark-circle-outline" title={message} />
      ) : null}

      {/*
        * Read rights without entry rights is a real configuration — an
        * auditor, a client viewer — and one crew member on this programme
        * holds exactly that. Saying so beats a form that refuses on submit.
        */}
      {!mayEnter ? (
        <Banner
          tone="info"
          icon="lock-closed-outline"
          title="You can see this work but not record against it"
          message="Recording a day's progress needs the survey entry right. Ask your project manager."
        />
      ) : null}

      {mine.isLoading ? (
        <Loading label="Loading your villages…" />
      ) : mine.isError ? (
        <Banner
          tone="warning"
          icon="cloud-offline-outline"
          title="Could not reach the server"
          message="Your villages will appear when there is signal. Anything already filed is safely queued."
        />
      ) : villages.length === 0 ? (
        <EmptyState
          icon="map-outline"
          title="No survey work assigned"
          message="You are not on the crew of any village on an active programme. Nothing here needs you."
        />
      ) : (
        <>
          {outstanding.length ? (
            <Banner
              tone="warning"
              icon="alert-circle-outline"
              title={
                outstanding.length === 1
                  ? "One village has no return for today"
                  : `${outstanding.length} villages have no return for today`
              }
              message="File before you check out, or the day gets typed up from memory."
            />
          ) : null}

          <SectionLabel>Your villages</SectionLabel>
          <Card>
            {villages.map((v, i) => (
              <ListRow
                key={v.id}
                title={v.village_name}
                subtitle={[v.mandal_name, v.project_name].filter(Boolean).join(" · ")}
                icon="location-outline"
                right={
                  <Badge
                    text={v.filed_today ? "filed" : "due"}
                    tone={v.filed_today ? "success" : "warning"}
                  />
                }
                onPress={mayEnter ? () => setSheet({ village: v, kind: "return" }) : undefined}
                last={i === villages.length - 1}
              />
            ))}
          </Card>

          {/*
            * Finishing a stage (SG-013): only the stage this person is crewed
            * on, and only while it is running. Nobody else's stage is ever
            * offered here.
            */}
          {villages.some(v => completionOffer(v, mayEnter)) ? (
            <Card title="Finish your stage">
              <View style={{ gap: space.xs }}>
                {villages.filter(v => completionOffer(v, mayEnter)).map(v => (
                  <Button
                    key={v.id}
                    title={`${v.village_name}: ${v.stage_label} complete`}
                    variant="secondary"
                    icon="checkmark-done-outline"
                    onPress={() => setSheet({ village: v, kind: "stage" })}
                  />
                ))}
              </View>
            </Card>
          ) : null}

          {mayEnter ? (
            <Card title="Control points">
              <Muted>
                Established once per village, standing on the point. Pick the village to record one.
              </Muted>
              <View style={{ gap: space.xs, marginTop: space.sm }}>
                {villages.map(v => (
                  <Button
                    key={v.id}
                    title={v.village_name}
                    variant="secondary"
                    icon="pin-outline"
                    onPress={() => setSheet({ village: v, kind: "point" })}
                  />
                ))}
              </View>
            </Card>
          ) : null}
        </>
      )}

      <Modal
        visible={sheet !== null}
        animationType="slide"
        onRequestClose={() => close()}
        presentationStyle="pageSheet"
      >
        <View style={{ flex: 1, backgroundColor: t.canvas, padding: space.lg }}>
          <Row style={{ justifyContent: "flex-end" }}>
            <Button title="Close" variant="ghost" onPress={() => close()} />
          </Row>
          {sheet?.kind === "return" ? (
            <DailyReturn village={sheet.village} workDate={workDate} onFiled={close}
              review={sheet.review ?? null} />
          ) : sheet?.kind === "point" ? (
            <ControlPointForm village={sheet.village} workDate={workDate} onRecorded={close} />
          ) : sheet?.kind === "stage" ? (
            <StageComplete village={sheet.village} workDate={workDate} onDone={close} />
          ) : null}
        </View>
      </Modal>
      <Subtle>
        Returns file into the outbox and send themselves when there is signal. More → Sync queue
        shows anything still waiting.
      </Subtle>
    </Screen>
  );
}

export default withScreenBoundary(SurveyScreen);
