/**
 * Record a ground control point while standing on it.
 *
 * Established once per village as a rule, occasionally more. The coordinates
 * come off the controller; the phone's own fix is offered as a starting
 * position and labelled as what it is, because a phone is metres-accurate and
 * a control point is not.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollView, View } from "react-native";
import { getPunchFix } from "../device/location";
import { getVillageGcps, type MyVillage } from "../api/endpoints";
import { submitQueued } from "../sync/engine";
import {
  Badge,
  Banner,
  Button,
  Card,
  Input,
  ListRow,
  Muted,
  Row,
  SectionLabel,
  Subtle,
  Title,
} from "../ui/primitives";
import { space } from "../theme";
import { buildPoint, emptyPoint, fromDeviceFix, type PointDraft } from "./controlPoint";
import { pointConfirmations, type DeviceFix } from "./fieldCrew";

export function ControlPointForm({
  village,
  workDate,
  onRecorded,
}: {
  village: MyVillage;
  workDate: string;
  onRecorded: (message: string) => void;
}) {
  const [draft, setDraft] = useState<PointDraft>(() => emptyPoint(workDate));
  const [problems, setProblems] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [fixNote, setFixNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The phone's last fix, so filing it untouched can be asked about (SG-004).
  const [lastFix, setLastFix] = useState<DeviceFix | null>(null);
  // The draft the person has already been asked about and said yes to.
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);

  const existing = useQuery({
    queryKey: ["survey", "gcps", village.id],
    queryFn: () => getVillageGcps(village.id),
  });

  const set = (patch: Partial<PointDraft>) => setDraft(d => ({ ...d, ...patch }));

  const useMyPosition = async () => {
    setFixNote(null);
    try {
      const fix = await getPunchFix();
      setDraft(d => fromDeviceFix(d, fix));
      setLastFix({ latitude: fix.latitude, longitude: fix.longitude, accuracy: fix.accuracy });
      setFixNote(
        `Filled from this phone, accurate to about ${
          fix.accuracy === null ? "an unknown distance" : `${Math.round(fix.accuracy)} m`
        }. Overwrite it with the controller's figures before filing.`,
      );
    } catch (e) {
      setFixNote(e instanceof Error ? e.message : "Could not get a position.");
    }
  };

  const record = async () => {
    setProblems([]);
    setWarnings([]);
    const built = buildPoint(draft);
    if (!built.ok) {
      setProblems(built.problems);
      return;
    }
    /*
     * Looked at twice (SG-004). The warnings used to appear only after the
     * point was queued, on a sheet that closed straight away, so a swapped
     * pair or an untouched phone fix went in with nobody seeing a word.
     */
    const asks = pointConfirmations(draft, lastFix);
    const key = JSON.stringify(draft);
    if (asks.length && confirmedFor !== key) {
      setWarnings(asks);
      setConfirmedFor(key);
      return;
    }
    setBusy(true);
    try {
      const message = await submitQueued({
        entity: "survey_gcp",
        op: `${village.id}:${draft.pointCode.trim()}`,
        payload: {
          survey_village_id: village.id,
          ...built.input,
        } as unknown as Record<string, unknown>,
      });
      onRecorded(built.warnings.length ? `${message} Recorded with a warning: check it on the web.` : message);
      setDraft(emptyPoint(workDate));
    } catch (e) {
      setProblems([e instanceof Error ? e.message : "The point could not be recorded."]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1 }}>
      <Title>Control point</Title>
      <Muted>{village.village_name}</Muted>

      {problems.length ? (
        <Banner
          tone="danger"
          icon="alert-circle-outline"
          title={problems.length === 1 ? "One thing to fix" : `${problems.length} things to fix`}
          message={problems.join("\n")}
        />
      ) : null}
      {warnings.length ? (
        <Banner
          tone="warning"
          icon="help-circle-outline"
          title="Check before recording — tap again to record anyway"
          message={warnings.join("\n")}
        />
      ) : null}

      <Card title="Points already recorded">
        {existing.isLoading ? (
          <Muted>Loading…</Muted>
        ) : (existing.data ?? []).length === 0 ? (
          <Muted>None yet for this village.</Muted>
        ) : (
          (existing.data ?? []).map((g, i, all) => (
            <ListRow
              key={g.id}
              title={g.point_code}
              subtitle={`${g.latitude.toFixed(6)}, ${g.longitude.toFixed(6)}`}
              right={g.warnings?.length ? <Badge text="check" tone="warning" /> : undefined}
              last={i === all.length - 1}
            />
          ))
        )}
      </Card>

      <Card title="New point">
        <Input
          label="Point name"
          value={draft.pointCode}
          onChangeText={(v: string) => set({ pointCode: v })}
          placeholder="GCP-1"
          autoCapitalize="characters"
        />
        <Button
          title="Use my current position"
          variant="secondary"
          icon="locate-outline"
          onPress={useMyPosition}
          style={{ marginBottom: space.md }}
        />
        {fixNote ? <Subtle>{fixNote}</Subtle> : null}
        <Row style={{ gap: space.sm, marginTop: space.sm }}>
          <View style={{ flex: 1 }}>
            <Input
              label="Latitude"
              value={draft.latitude}
              onChangeText={(v: string) => set({ latitude: v })}
              keyboardType="numeric"
              placeholder="16.512345"
            />
          </View>
          <View style={{ flex: 1 }}>
            <Input
              label="Longitude"
              value={draft.longitude}
              onChangeText={(v: string) => set({ longitude: v })}
              keyboardType="numeric"
              placeholder="80.612345"
            />
          </View>
        </Row>
        <Input
          label="Elevation (m)"
          value={draft.elevationM}
          onChangeText={(v: string) => set({ elevationM: v })}
          keyboardType="numeric"
        />

        {/*
          * The same point on a projected grid. Stored, never converted: an
          * Indian survey may be on WGS84 UTM or on an older Everest-based
          * grid, and computing one from the other would assert a projection
          * this survey may not be using.
          */}
        <SectionLabel>Grid reference, if the controller gives one</SectionLabel>
        <Row style={{ gap: space.sm }}>
          <View style={{ flex: 1 }}>
            <Input
              label="Easting (m)"
              value={draft.eastingM}
              onChangeText={(v: string) => set({ eastingM: v })}
              keyboardType="numeric"
            />
          </View>
          <View style={{ flex: 1 }}>
            <Input
              label="Northing (m)"
              value={draft.northingM}
              onChangeText={(v: string) => set({ northingM: v })}
              keyboardType="numeric"
            />
          </View>
        </Row>
        <Input
          label="Grid zone"
          value={draft.gridZone}
          onChangeText={(v: string) => set({ gridZone: v })}
          placeholder="44N"
          hint="Without a zone, an easting and a northing are two numbers rather than a position."
        />
        <Input
          label="Remarks"
          value={draft.remarks}
          onChangeText={(v: string) => set({ remarks: v })}
          placeholder="Where the pillar is, and anything odd about it"
          multiline
        />
        <Button
          title={warnings.length && confirmedFor === JSON.stringify(draft)
            ? "Record anyway" : "Record this point"}
          icon="pin-outline"
          loading={busy}
          onPress={record}
        />
      </Card>
      <View style={{ height: space.xxl * 2 }} />
    </ScrollView>
  );
}
