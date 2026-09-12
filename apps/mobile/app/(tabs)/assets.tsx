/**
 * Assets: search the cached register, scan a QR/barcode, transition or assign
 * an asset, and run a physical audit.
 *
 * Everything is queue-backed, so a scan or a transition made in a warehouse
 * with no signal is saved locally and sent on reconnect.
 */
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, asList } from "../../src/api/client";
import { cachedRead } from "../../src/sync/db";
import { submitQueued } from "../../src/sync/engine";
import { useAuth } from "../../src/auth/AuthContext";
import {
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
  Title,
} from "../../src/ui/primitives";
import { space, useTheme } from "../../src/theme";

type Asset = {
  id: string;
  asset_code: string;
  serial_number?: string;
  name: string;
  status: string;
  condition: string;
  version: number;
};
type Employee = { id: string; name: string };

/** Allowed status transitions, mirroring the server's asset state machine. */
const EDGES: Record<string, string[]> = {
  AVAILABLE: ["DAMAGED", "LOST"],
  ASSIGNED: ["IN_USE", "RETURNED", "DAMAGED", "LOST"],
  IN_USE: ["RETURNED", "DAMAGED", "LOST"],
  RETURNED: ["AVAILABLE", "DAMAGED"],
  DAMAGED: ["AVAILABLE", "WRITTEN_OFF"],
  LOST: ["RETURNED", "WRITTEN_OFF"],
};

function statusTone(status: string): "success" | "warning" | "danger" | "info" | "neutral" {
  if (status === "AVAILABLE") return "success";
  if (status === "ASSIGNED" || status === "IN_USE") return "info";
  if (status === "DAMAGED" || status === "RETURNED") return "warning";
  if (status === "LOST" || status === "WRITTEN_OFF") return "danger";
  return "neutral";
}

export default function Assets() {
  const t = useTheme();
  const { canDo } = useAuth();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Asset | null>(null);
  const [scanning, setScanning] = useState(false);
  const [permission, ask] = useCameraPermissions();
  const [condition, setCondition] = useState("GOOD");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const scanBusy = useRef(false);

  const [employee, setEmployee] = useState("");
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [audit, setAudit] = useState(false);
  const [auditName, setAuditName] = useState("");
  const [expected, setExpected] = useState<string[]>([]);
  const [scans, setScans] = useState<Record<string, string>>({});

  const assets = useQuery({
    queryKey: ["assets"],
    queryFn: () =>
      cachedRead("assets", async () =>
        asList<Asset>((await apiFetch("/api/v1/assets?limit=100")).data),
      ),
    enabled: canDo("asset.read"),
  });
  const employees = useQuery({
    queryKey: ["asset-employees"],
    queryFn: () =>
      cachedRead("asset-employees", async () =>
        asList<Employee>((await apiFetch("/api/v1/assets/eligible-employees")).data),
      ),
    enabled: canDo("asset.manage"),
  });

  const filtered =
    assets.data?.filter((a) =>
      `${a.name} ${a.asset_code}`.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];

  const pick = (a: Asset) => {
    setSelected(a);
    setCondition(a.condition);
    setMessage("");
  };

  async function scan(code: string) {
    if (scanBusy.current) return;
    scanBusy.current = true;
    setScanning(false);
    try {
      let asset = assets.data?.find((a) => a.asset_code === code || a.serial_number === code);
      if (!asset) {
        const { data } = await apiFetch<{ id: string }>(
          `/api/v1/assets/resolve?code=${encodeURIComponent(code)}`,
        );
        asset = (await apiFetch<Asset>(`/api/v1/assets/${data.id}`)).data;
      }
      if (audit) setScans((old) => ({ ...old, [asset!.id]: condition }));
      else pick(asset);
    } catch (e) {
      setMessage(
        e instanceof Error
          ? e.message
          : "Asset not found. Uncached assets require a connection.",
      );
    } finally {
      scanBusy.current = false;
    }
  }

  async function queue(
    entity: "asset_transition" | "asset_assignment" | "asset_audit",
    payload: Record<string, unknown>,
  ) {
    setBusy(true);
    setMessage("");
    try {
      setMessage(
        await submitQueued({
          entity,
          op: `${entity}:${selected?.id ?? auditName}:${Date.now()}`,
          payload,
          baseVersion: entity === "asset_audit" ? undefined : selected?.version,
        }),
      );
      await assets.refetch();
      if (entity === "asset_audit") {
        setAudit(false);
        setExpected([]);
        setScans({});
      } else {
        setSelected(null);
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  const openScanner = async () => {
    if (!permission?.granted && !(await ask()).granted) {
      setMessage("Camera permission is required to scan.");
      return;
    }
    setScanning(true);
  };

  if (!canDo("asset.read")) {
    return (
      <Screen>
        <EmptyState
          icon="lock-closed-outline"
          title="No asset access"
          message="Your role does not include asset permissions. Ask an administrator if you need them."
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title>Assets</Title>
      <Muted style={{ marginTop: 2, marginBottom: space.lg }}>
        Scan or search the register. Works offline from the cached list.
      </Muted>

      <Card>
        <Input
          accessibilityLabel="Search assets"
          placeholder="Search by name or code"
          value={search}
          onChangeText={setSearch}
        />
        <Row gap={space.md}>
          <Button
            title={audit ? "Scan observed" : "Scan code"}
            icon="scan-outline"
            onPress={() => void openScanner()}
            style={{ flex: 1 }}
          />
          {canDo("asset.manage") ? (
            <Button
              title={audit ? "Close audit" : "Physical audit"}
              variant="secondary"
              icon="clipboard-outline"
              onPress={() => setAudit((v) => !v)}
              style={{ flex: 1 }}
            />
          ) : null}
        </Row>
      </Card>

      {message ? (
        <Banner tone="info" icon="information-circle-outline" title={message} />
      ) : null}
      {assets.error ? (
        <Banner
          tone="danger"
          icon="cloud-offline-outline"
          title="Could not refresh the register"
          message={assets.error.message}
        />
      ) : null}

      {audit ? (
        <Card title="Physical audit">
          <Input label="Audit name" placeholder="e.g. Warehouse A — March" value={auditName} onChangeText={setAuditName} />
          <Input
            label="Observed condition for next scan"
            placeholder="GOOD"
            value={condition}
            onChangeText={setCondition}
          />
          <Muted>
            Tick the assets you expect to find, then scan the ones actually present. Expected
            assets with no scan are reported missing.
          </Muted>
          {Object.keys(scans).length > 0 ? (
            <>
              <Divider />
              <Subtle>Scanned ({Object.keys(scans).length})</Subtle>
              {Object.entries(scans).map(([id, c], i, arr) => (
                <ListRow
                  key={id}
                  title={assets.data?.find((a) => a.id === id)?.asset_code ?? id}
                  subtitle={c}
                  right={<Ionicons name="close-circle-outline" size={18} color={t.danger} />}
                  onPress={() =>
                    setScans((old) => {
                      const next = { ...old };
                      delete next[id];
                      return next;
                    })
                  }
                  last={i === arr.length - 1}
                />
              ))}
            </>
          ) : null}
          <Button
            title="Complete audit"
            icon="checkmark-done-outline"
            loading={busy}
            disabled={busy || !auditName.trim() || expected.length === 0}
            onPress={() =>
              void queue("asset_audit", {
                name: auditName.trim(),
                expected_ids: expected,
                scans: Object.entries(scans).map(([asset_id, c]) => ({
                  asset_id,
                  condition: c,
                })),
              })
            }
          />
        </Card>
      ) : null}

      <SectionLabel>
        {audit ? `Expected assets (${expected.length} selected)` : `Register (${filtered.length})`}
      </SectionLabel>
      <Card>
        {assets.isLoading ? (
          <Loading />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon="cube-outline"
            title="No matching assets"
            message="Refresh while online to update the cached register."
          />
        ) : (
          filtered.map((a, i, arr) => (
            <ListRow
              key={a.id}
              title={a.name}
              subtitle={`${a.asset_code} · ${a.condition}`}
              icon={
                audit
                  ? expected.includes(a.id)
                    ? "checkbox"
                    : "square-outline"
                  : undefined
              }
              right={<Badge text={a.status} tone={statusTone(a.status)} />}
              onPress={() =>
                audit
                  ? setExpected((ids) =>
                      ids.includes(a.id) ? ids.filter((id) => id !== a.id) : [...ids, a.id],
                    )
                  : pick(a)
              }
              last={i === arr.length - 1}
            />
          ))
        )}
      </Card>

      {selected && !audit ? (
        <Card title={selected.name} right={<Badge text={selected.status} tone={statusTone(selected.status)} />}>
          <Muted style={{ marginBottom: space.md }}>{selected.asset_code}</Muted>
          {canDo("asset.manage") ? (
            <>
              <Input accessibilityLabel="Condition" label="Condition" value={condition} onChangeText={setCondition} />
              <Input
                accessibilityLabel="Reason"
                label="Reason"
                placeholder="Why is this changing?"
                value={reason}
                onChangeText={setReason}
              />

              {["AVAILABLE", "RETURNED"].includes(selected.status) ? (
                <>
                  <Divider />
                  <Subtle>Assign to</Subtle>
                  <Input
                    placeholder="Find an employee"
                    value={employeeSearch}
                    onChangeText={setEmployeeSearch}
                  />
                  {employees.data
                    ?.filter((e) => e.name.toLowerCase().includes(employeeSearch.toLowerCase()))
                    .slice(0, 10)
                    .map((e, i, arr) => (
                      <ListRow
                        key={e.id}
                        title={e.name}
                        icon={employee === e.id ? "radio-button-on" : "radio-button-off"}
                        onPress={() => setEmployee(e.id)}
                        last={i === arr.length - 1}
                      />
                    ))}
                  <Button
                    title="Assign to employee"
                    icon="person-add-outline"
                    loading={busy}
                    disabled={busy || !employee || !reason.trim()}
                    onPress={() =>
                      void queue("asset_assignment", {
                        asset_id: selected.id,
                        employee_id: employee,
                        condition,
                        reason,
                      })
                    }
                  />
                </>
              ) : null}

              {(EDGES[selected.status] ?? []).length > 0 ? (
                <>
                  <Divider />
                  <Subtle>Change status</Subtle>
                  <View style={{ gap: space.sm, marginTop: space.sm }}>
                    {(EDGES[selected.status] ?? []).map((status) => (
                      <Button
                        key={status}
                        title={status.replaceAll("_", " ")}
                        variant="secondary"
                        tone={statusTone(status) === "danger" ? "danger" : undefined}
                        disabled={busy || !reason.trim()}
                        onPress={() =>
                          void queue("asset_transition", {
                            asset_id: selected.id,
                            status,
                            condition,
                            reason,
                          })
                        }
                      />
                    ))}
                  </View>
                  {!reason.trim() ? (
                    <Subtle style={{ marginTop: space.sm }}>A reason is required.</Subtle>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
        </Card>
      ) : null}

      <Modal visible={scanning} onRequestClose={() => setScanning(false)} animationType="slide">
        <View style={{ flex: 1, backgroundColor: "#000" }}>
          <CameraView
            style={{ flex: 1 }}
            barcodeScannerSettings={{ barcodeTypes: ["qr", "code128", "code39", "ean13"] }}
            onBarcodeScanned={({ data }) => void scan(data)}
          />
          {/* Reticle: without it there is no cue where to aim the camera. */}
          <View pointerEvents="none" style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" }}>
            <View
              style={{
                width: 220,
                height: 220,
                borderWidth: 2,
                borderColor: "rgba(255,255,255,0.9)",
                borderRadius: 16,
              }}
            />
          </View>
          <View style={{ position: "absolute", left: space.lg, right: space.lg, bottom: space.xxl }}>
            <Button title="Cancel" variant="secondary" onPress={() => setScanning(false)} />
          </View>
        </View>
      </Modal>
    </Screen>
  );
}
