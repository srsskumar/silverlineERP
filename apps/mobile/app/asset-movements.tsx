/**
 * Asset movements: where a piece of equipment has been (§note 7) — every
 * handover, in and out of the store, most recent first.
 *
 * The Assets tab is the register — what's on hand now, item by item.
 * This is deliberately the other half: a chronological feed of ISSUED/
 * RETURNED events built from the same asset_assignments rows, for someone
 * chasing a specific rover or laptop rather than browsing the register.
 * Read-only — filtering by equipment or person is a desktop combobox job
 * (apps/web/app/assets/movements/page.tsx); the phone gets the feed and,
 * tapping a row, the full record for that one handover.
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "react-native";
import { useAuth } from "../src/auth/AuthContext";
import { getAssetMovements, type AssetMovement } from "../src/api/endpoints";
import { conditionLabel, movementLabel, movementTone } from "../src/assetMovementsFormat";
import { withScreenBoundary } from "../src/ui/ErrorBoundary";
import { usePullRefresh } from "../src/ui/usePullRefresh";
import { listState } from "../src/listState";
import { LoadError } from "../src/ui/LoadError";
import {
  BackHeader,
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  ListRow,
  Loading,
  Muted,
  Row,
  Screen,
  SectionLabel,
  Subtle,
} from "../src/ui/primitives";
import { space, useTheme } from "../src/theme";
import { day, dayTime as when } from "@silverline/shared";

function AssetMovementsScreen() {
  const { canDo } = useAuth();
  const canRead = canDo("asset.read");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<AssetMovement | null>(null);

  const moves = useQuery({
    queryKey: ["asset-movements", offset],
    queryFn: () => getAssetMovements({ offset }),
    enabled: canRead,
  });

  const rows = moves.data?.items ?? [];

  const pull = usePullRefresh(canRead && moves);


  return (
    <Screen refresh={pull}>
      <BackHeader title="Asset movements" onBack={() => router.back()} />
      <Muted style={{ marginBottom: space.lg }}>
        Every time a piece of equipment changed hands, most recent first.
      </Muted>

      {!canRead ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to asset movements"
          message="This screen needs the asset.read permission."
        />
      ) : listState(moves, rows.length) === "loading" ? (
        <Loading />
      ) : listState(moves, rows.length) === "error" ? (
        <LoadError query={moves} what="asset movements" />
      ) : rows.length === 0 ? (
        <EmptyState icon="swap-horizontal-outline" title="No movements found" />
      ) : (
        <>
          <Card>
            {rows.map((m, i, arr) => (
              <ListRow
                key={`${m.allocation_id}:${m.movement}`}
                title={`${m.asset_name ?? "Equipment"} · ${m.asset_code ?? ""}`}
                subtitle={
                  `${m.movement === "ISSUED" ? (m.to_name ?? "the store") : (m.from_name ?? "the store")} · ${when(m.at)}`
                }
                right={<Badge text={movementLabel(m.movement)} tone={movementTone(m.movement)} />}
                onPress={() => setSelected(m)}
                last={i === arr.length - 1}
              />
            ))}
          </Card>
          <Row gap={space.sm} style={{ marginTop: space.md }}>
            <Button
              title="Newer"
              variant="secondary"
              disabled={offset === 0}
              onPress={() => setOffset(Math.max(0, offset - 50))}
              style={{ flex: 1 }}
            />
            <Button
              title="Older"
              variant="secondary"
              disabled={!moves.data?.hasMore}
              onPress={() => setOffset(offset + 50)}
              style={{ flex: 1 }}
            />
          </Row>
        </>
      )}

      <Modal
        visible={Boolean(selected)}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSelected(null)}
      >
        {selected ? <MovementDetail move={selected} onClose={() => setSelected(null)} /> : null}
      </Modal>
    </Screen>
  );
}

function MovementDetail({ move, onClose }: { move: AssetMovement; onClose: () => void }) {
  const t = useTheme();
  return (
    <Screen>
      <BackHeader title={move.asset_name ?? "Movement"} onBack={onClose} />
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Muted style={{ color: t.text, fontWeight: "700" }}>
            {move.asset_code}
            {move.serial_number ? ` · ${move.serial_number}` : ""}
          </Muted>
          <Badge text={movementLabel(move.movement)} tone={movementTone(move.movement)} />
        </Row>
        {move.type_label ? <Subtle style={{ marginTop: space.xs }}>{move.type_label}</Subtle> : null}
      </Card>

      <SectionLabel>Handover</SectionLabel>
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Subtle>When</Subtle>
          <Subtle>{when(move.at)}</Subtle>
        </Row>
        <Row style={{ justifyContent: "space-between", marginTop: space.xs }}>
          <Subtle>From</Subtle>
          <Subtle>{move.from_name ?? "The store"}</Subtle>
        </Row>
        <Row style={{ justifyContent: "space-between", marginTop: space.xs }}>
          <Subtle>To</Subtle>
          <Subtle>{move.to_name ?? "The store"}</Subtle>
        </Row>
        <Row style={{ justifyContent: "space-between", marginTop: space.xs }}>
          <Subtle>Condition</Subtle>
          <Subtle>{conditionLabel(move.condition)}</Subtle>
        </Row>
        {move.due_date ? (
          <Row style={{ justifyContent: "space-between", marginTop: space.xs }}>
            <Subtle>Due back</Subtle>
            <Subtle>{day(move.due_date)}</Subtle>
          </Row>
        ) : null}
        {move.project_name ? (
          <Row style={{ justifyContent: "space-between", marginTop: space.xs }}>
            <Subtle>For</Subtle>
            <Subtle>{move.project_name}</Subtle>
          </Row>
        ) : null}
        {move.reason ? (
          <Row style={{ justifyContent: "space-between", marginTop: space.xs }}>
            <Subtle>Reason</Subtle>
            <Subtle>{move.reason}</Subtle>
          </Row>
        ) : null}
        {move.recorded_by_username ? (
          <Row style={{ justifyContent: "space-between", marginTop: space.xs }}>
            <Subtle>Recorded by</Subtle>
            <Subtle>{move.recorded_by_username}</Subtle>
          </Row>
        ) : null}
      </Card>
      <Divider />
    </Screen>
  );
}

export default withScreenBoundary(AssetMovementsScreen);
