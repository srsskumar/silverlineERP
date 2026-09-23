/**
 * Locations: the org unit hierarchy — district → division → mandal →
 * village → site — read-only.
 *
 * Creating a unit needs a parent picker that falls back across two tiers
 * (a mandal may sit under a division or straight under a district — see
 * apps/web/app/org/locations/page.tsx's PARENT_OF/PARENT_FALLBACK) and
 * deactivation is blocked server-side while children are still active; none
 * of that is a phone job. This is the reference lookup: which units exist,
 * by tier, and whether each is active — for someone confirming a site's
 * code or name before filing something against it.
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, ScrollView } from "react-native";
import { useAuth } from "../src/auth/AuthContext";
import { getOrgUnits, type OrgUnit, type OrgUnitType } from "../src/api/endpoints";
import { withScreenBoundary } from "../src/ui/ErrorBoundary";
import {
  BackHeader,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  ListRow,
  Loading,
  Muted,
  Row,
  Screen,
  Subtle,
} from "../src/ui/primitives";
import { space } from "../src/theme";

const TABS: OrgUnitType[] = ["district", "division", "mandal", "village", "site"];

function OrgLocationsScreen() {
  const { canDo } = useAuth();
  const canRead = canDo("org.units.read");
  const [tab, setTab] = useState<OrgUnitType>("district");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<OrgUnit | null>(null);

  const units = useQuery({
    queryKey: ["org-units", tab, search],
    queryFn: () => getOrgUnits({ type: tab, q: search.trim() || undefined, limit: 100 }),
    enabled: canRead,
  });

  const rows = units.data?.items ?? [];

  return (
    <Screen>
      <BackHeader title="Locations" onBack={() => router.back()} />
      <Muted style={{ marginBottom: space.lg }}>District → mandal → village → site hierarchy.</Muted>

      {!canRead ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to locations"
          message="This screen needs the org.units.read permission."
        />
      ) : (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.md }}>
            <Row gap={space.sm}>
              {TABS.map((t) => (
                <Button
                  key={t}
                  title={`${t}s`}
                  variant={tab === t ? "primary" : "secondary"}
                  onPress={() => setTab(t)}
                />
              ))}
            </Row>
          </ScrollView>
          <Input
            placeholder="Search by code or name"
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
          />
          <Card>
            {units.isLoading ? (
              <Loading />
            ) : rows.length === 0 ? (
              <EmptyState icon="location-outline" title={`No ${tab}s found`} />
            ) : (
              rows.map((u, i, arr) => (
                <ListRow
                  key={u.id}
                  title={u.name}
                  subtitle={u.code}
                  right={<Badge text={u.status} tone={u.status === "ACTIVE" ? "success" : "neutral"} />}
                  onPress={() => setSelected(u)}
                  last={i === arr.length - 1}
                />
              ))
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
        {selected ? <UnitDetail unit={selected} onClose={() => setSelected(null)} /> : null}
      </Modal>
    </Screen>
  );
}

function UnitDetail({ unit, onClose }: { unit: OrgUnit; onClose: () => void }) {
  return (
    <Screen>
      <BackHeader title={unit.name} onBack={onClose} />
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Subtle>Type</Subtle>
          <Subtle>{unit.type}</Subtle>
        </Row>
        <Row style={{ justifyContent: "space-between", marginTop: space.xs }}>
          <Subtle>Code</Subtle>
          <Subtle>{unit.code}</Subtle>
        </Row>
        <Row style={{ justifyContent: "space-between", marginTop: space.xs }}>
          <Subtle>Status</Subtle>
          <Badge text={unit.status} tone={unit.status === "ACTIVE" ? "success" : "neutral"} />
        </Row>
        {unit.parent_id ? (
          <Row style={{ justifyContent: "space-between", marginTop: space.xs }}>
            <Subtle>Parent</Subtle>
            <Subtle>{unit.parent_id.slice(0, 8)}…</Subtle>
          </Row>
        ) : null}
      </Card>
    </Screen>
  );
}

export default withScreenBoundary(OrgLocationsScreen);
