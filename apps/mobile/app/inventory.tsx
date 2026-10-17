/**
 * Inventory: the stock register — current quantity on hand per item — with
 * basic IN/OUT posting for anyone holding inventory.manage, plus the
 * multi-location stock module (§44, B-008): storage locations, physical
 * counts, reservations and reorder suggestions.
 *
 * Read-only lookup is the field-relevant case (a supervisor checking what is
 * left before ordering more); posting is included too since the API makes it
 * cheap and a storekeeper role plausibly needs to record a receipt or an
 * issue from the same phone, but it stays a single quantity/reference form —
 * not the full vendor/invoice/reservation machinery the web page has.
 *
 * The Locations/Counts/Reservations/Reorder tabs mirror where web put this
 * (a tab inside the same Inventory page, apps/web/app/inventory/page.tsx —
 * there is no separate stock module-catalog entry on either platform) and
 * web's own scope exactly: list+create locations, record one item per count
 * (web's generic form framework has no repeater field; mobile has no reason
 * to go further), list reservations, list reorder suggestions. No
 * release/approve action on mobile — those stay desktop-only for this pass.
 * Each tab is gated by the permission its own API route enforces
 * (location.*, stockcount.*, reservation.read, stock.read), not by
 * inventory.read/manage — the two permission sets are disjoint.
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, ScrollView, View } from "react-native";
import { describeApiError } from "../src/errorFormat";
import { useAuth } from "../src/auth/AuthContext";
import {
  getInventoryItems,
  getInventoryTransactions,
  getProjects,
  getStockCount,
  getStockCounts,
  getStockLocations,
  getStockReorderSuggestions,
  getStockReservations,
  postInventoryTransaction,
  postStockCount,
  postStockLocation,
  type InventoryItem,
  type StockCount,
} from "../src/api/endpoints";
import { isLowStock, stockTone } from "../src/inventoryFormat";
import {
  LOCATION_KINDS,
  type LocationKind,
  countStatusTone,
  reservationStateTone,
  visibleInventoryTabs,
  INVENTORY_TAB_LABELS,
  type InventoryTab,
} from "../src/stockFormat";
import { formToday } from "../src/formDate";
import {
  validateStockCountCreate,
  validateStockLocationCreate,
  validateStockTransaction,
} from "../src/validators";
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
import { radius, space, useTheme } from "../src/theme";
import { permissionLabel } from "../src/permissionLabels";

/**
 * Horizontal, non-stretched tab chips — the pattern analytics.tsx/leave.tsx
 * use for more than two tabs. `tabs` is already filtered to what the caller
 * can open (visibleInventoryTabs in src/stockFormat.ts) — a tab with no
 * permission has no chip here at all, never a greyed-out one.
 */
function TabChips({
  tabs,
  tab,
  onChange,
}: {
  tabs: InventoryTab[];
  tab: InventoryTab;
  onChange: (t: InventoryTab) => void;
}) {
  if (tabs.length < 2) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.lg }}>
      <Row gap={space.sm}>
        {tabs.map((t) => (
          <Button
            key={t}
            title={INVENTORY_TAB_LABELS[t]}
            variant={tab === t ? "primary" : "secondary"}
            onPress={() => onChange(t)}
            style={{ borderRadius: radius.pill, minHeight: 36, paddingHorizontal: space.md }}
          />
        ))}
      </Row>
    </ScrollView>
  );
}

function InventoryScreen() {
  const { canDo } = useAuth();
  const canRead = canDo("inventory.read");
  const canManage = canDo("inventory.manage");
  const canReadLocations = canDo("location.read");
  const canManageLocations = canDo("location.manage");
  const canReadCounts = canDo("stockcount.read");
  const canManageCounts = canDo("stockcount.manage");
  const canReadReservations = canDo("reservation.read");
  const canReadReorder = canDo("stock.read");

  const tabs = visibleInventoryTabs({
    inventoryRead: canRead,
    locationRead: canReadLocations,
    locationManage: canManageLocations,
    stockcountRead: canReadCounts,
    stockcountManage: canManageCounts,
    reservationRead: canReadReservations,
    stockRead: canReadReorder,
  });
  const [tabChoice, setTabChoice] = useState<InventoryTab | null>(null);
  // Fall back to the first tab the caller can actually open — never a tab
  // whose permission has since been switched off (or was never held).
  const tab: InventoryTab | undefined = tabChoice && tabs.includes(tabChoice) ? tabChoice : tabs[0];

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<InventoryItem | null>(null);

  const items = useQuery({
    queryKey: ["inventory", "items", search],
    queryFn: () => getInventoryItems(search.trim() ? { search: search.trim() } : undefined),
    enabled: canRead,
  });

  const rows = items.data ?? [];

  return (
    <Screen>
      <BackHeader title="Inventory" onBack={() => router.back()} />
      <Muted style={{ marginBottom: space.lg }}>
        What is on hand, plus locations, physical counts, reservations and reorder.
      </Muted>

      {tabs.length === 0 ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to inventory"
          message={`This screen needs permission to ${permissionLabel('inventory.read')}.`}
        />
      ) : (
        <>
          <TabChips tabs={tabs} tab={tab!} onChange={setTabChoice} />

          {tab === "items" ? (
            <>
              <Input placeholder="Search by name or code" value={search} onChangeText={setSearch} autoCapitalize="none" />
              <Card>
                {listState(items, rows.length) === "loading" ? (
                  <Loading />
                ) : listState(items, rows.length) === "error" ? (
                  <LoadError query={items} what="inventory" />
                ) : rows.length === 0 ? (
                  <EmptyState icon="cube-outline" title="No items found" />
                ) : (
                  rows.map((it, i, arr) => (
                    <ListRow
                      key={it.id}
                      title={`${it.name} · ${it.code}`}
                      subtitle={`${it.available} ${it.unit} on hand`}
                      right={
                        isLowStock(it.available, it.low_stock_threshold) ? (
                          <Badge text="LOW" tone={stockTone(it.available, it.low_stock_threshold)} />
                        ) : undefined
                      }
                      onPress={() => setSelected(it)}
                      last={i === arr.length - 1}
                    />
                  ))
                )}
              </Card>
            </>
          ) : null}

          {tab === "locations" ? <LocationsSection canRead={canReadLocations} canManage={canManageLocations} /> : null}

          {tab === "counts" ? (
            <CountsSection
              canRead={canReadCounts}
              canManage={canManageCounts}
              canReadItems={canRead}
              canReadLocations={canReadLocations}
            />
          ) : null}

          {tab === "reservations" ? <ReservationsSection canRead={canReadReservations} /> : null}

          {tab === "reorder" ? <ReorderSection canRead={canReadReorder} /> : null}
        </>
      )}

      <Modal
        visible={Boolean(selected)}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSelected(null)}
      >
        {selected ? (
          <ItemDetail item={selected} canManage={canManage} onClose={() => setSelected(null)} />
        ) : null}
      </Modal>
    </Screen>
  );
}

function ItemDetail({
  item,
  canManage,
  onClose,
}: {
  item: InventoryItem;
  canManage: boolean;
  onClose: () => void;
}) {
  const t = useTheme();
  const qc = useQueryClient();
  const [direction, setDirection] = useState<"IN" | "OUT">("OUT");
  const [quantity, setQuantity] = useState("");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  const txns = useQuery({
    queryKey: ["inventory", "transactions", item.id],
    queryFn: () => getInventoryTransactions(item.id),
  });

  const post = async () => {
    setError(null);
    const v = validateStockTransaction({
      item_id: item.id,
      direction,
      quantity,
      reference,
    });
    if (!v.ok) {
      setError(v.errors.map((e) => e.message).join("\n"));
      return;
    }
    setPosting(true);
    try {
      await postInventoryTransaction({
        item_id: item.id,
        direction,
        quantity: Number(quantity),
        reference: reference.trim(),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      setQuantity("");
      setReference("");
      setReason("");
      void txns.refetch();
      void qc.invalidateQueries({ queryKey: ["inventory", "items"] });
    } catch (e) {
      setError(describeApiError(e, "Could not post this transaction"));
    } finally {
      setPosting(false);
    }
  };

  return (
    <Screen>
      <BackHeader title={item.name} onBack={onClose} />
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Muted style={{ color: t.text, fontWeight: "700" }}>{item.code}</Muted>
          <Badge
            text={`${item.available} ${item.unit}`}
            tone={stockTone(item.available, item.low_stock_threshold)}
          />
        </Row>
        <Subtle style={{ marginTop: space.xs }}>
          Low-stock threshold: {item.low_stock_threshold} {item.unit}
        </Subtle>
      </Card>

      {canManage ? (
        <>
          <SectionLabel>Post a movement</SectionLabel>
          <Card>
            {error ? <Banner tone="danger" icon="alert-circle-outline" title={error} /> : null}
            <Row gap={space.sm} style={{ marginBottom: space.md }}>
              <Button
                title="Stock in"
                variant={direction === "IN" ? "primary" : "secondary"}
                onPress={() => setDirection("IN")}
                style={{ flex: 1 }}
              />
              <Button
                title="Stock out"
                variant={direction === "OUT" ? "primary" : "secondary"}
                onPress={() => setDirection("OUT")}
                style={{ flex: 1 }}
              />
            </Row>
            <Input label="Quantity" placeholder="0" keyboardType="decimal-pad" value={quantity} onChangeText={setQuantity} />
            <Input label="Reference" placeholder="Delivery note, work order…" value={reference} onChangeText={setReference} />
            <Input label="Reason (optional)" value={reason} onChangeText={setReason} />
            <Button
              title={direction === "IN" ? "Record stock in" : "Record stock out"}
              icon="swap-vertical-outline"
              loading={posting}
              onPress={() => void post()}
            />
          </Card>
        </>
      ) : null}

      <SectionLabel>Recent movements</SectionLabel>
      <Card>
        {listState(txns, (txns.data ?? []).length) === "loading" ? (
          <Loading />
        ) : listState(txns, (txns.data ?? []).length) === "error" ? (
          <LoadError query={txns} what="recent movements" />
        ) : (txns.data ?? []).length === 0 ? (
          <EmptyState icon="swap-vertical-outline" title="No movements recorded" />
        ) : (
          (txns.data ?? []).map((tx, i, arr) => (
            <ListRow
              key={tx.id}
              title={`${tx.direction === "IN" ? "+" : "−"}${tx.quantity} · ${tx.reference}`}
              subtitle={tx.reason ?? undefined}
              right={<Badge text={tx.direction} tone={tx.direction === "IN" ? "success" : "warning"} />}
              last={i === arr.length - 1}
            />
          ))
        )}
      </Card>
      <Divider />
    </Screen>
  );
}

/** B-008: storage locations — list (location.read) plus create (location.manage). */
function LocationsSection({ canRead, canManage }: { canRead: boolean; canManage: boolean }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<LocationKind>("WAREHOUSE");
  const [parentId, setParentId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectSearch, setProjectSearch] = useState("");
  const [addressLine, setAddressLine] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const locations = useQuery({
    queryKey: ["stock-locations"],
    queryFn: () => getStockLocations(),
    enabled: canRead,
  });
  const projects = useQuery({
    queryKey: ["projects", "stock-location-form", projectSearch],
    queryFn: () => getProjects({ q: projectSearch.trim() || undefined }),
    enabled: canManage && kind === "SITE",
  });

  const rows = locations.data ?? [];

  const chooseKind = (k: LocationKind) => {
    setKind(k);
    setParentId(null);
    setProjectId(null);
  };

  const resetForm = () => {
    setCode("");
    setName("");
    chooseKind("WAREHOUSE");
    setProjectSearch("");
    setAddressLine("");
  };

  const submit = async () => {
    setFormError(null);
    const v = validateStockLocationCreate({
      code,
      name,
      kind,
      parent_id: parentId ?? undefined,
      project_id: projectId ?? undefined,
    });
    if (!v.ok) {
      setFormError(v.errors.map((e) => e.message).join("\n"));
      return;
    }
    setSubmitting(true);
    try {
      await postStockLocation({
        code: code.trim(),
        name: name.trim(),
        kind,
        ...(parentId ? { parent_id: parentId } : {}),
        ...(projectId ? { project_id: projectId } : {}),
        ...(addressLine.trim() ? { address_line: addressLine.trim() } : {}),
      });
      resetForm();
      void locations.refetch();
    } catch (e) {
      setFormError(describeApiError(e, "Could not create this location"));
    } finally {
      setSubmitting(false);
    }
  };

  // location.read and location.manage are independent (the Counts tab below
  // treats stockcount.read/manage the same way): a manage-only caller still
  // gets the create form, just not the list beneath it, matching web's
  // StockSection.tsx, where the two panels sit behind separate <Can> gates
  // rather than one shared check.
  if (!canRead && !canManage) {
    return (
      <EmptyState
        icon="lock-closed-outline"
        title="No access to storage locations"
        message={`This screen needs permission to ${permissionLabel('location.read')}.`}
      />
    );
  }

  return (
    <>
      {canRead ? (
        <>
          <SectionLabel>Storage locations</SectionLabel>
          <Card>
            {listState(locations, rows.length) === "loading" ? (
              <Loading />
            ) : listState(locations, rows.length) === "error" ? (
              <LoadError query={locations} what="storage locations" />
            ) : rows.length === 0 ? (
              <EmptyState icon="business-outline" title="No locations yet" />
            ) : (
              rows.map((l, i, arr) => (
                <ListRow
                  key={l.id}
                  title={`${l.name} · ${l.code}`}
                  subtitle={[l.kind, l.project_code].filter(Boolean).join(" · ")}
                  right={!l.active ? <Badge text="INACTIVE" /> : undefined}
                  last={i === arr.length - 1}
                />
              ))
            )}
          </Card>
        </>
      ) : null}

      {canManage ? (
        <>
          <SectionLabel>New storage location</SectionLabel>
          <Card>
            {formError ? <Banner tone="danger" icon="alert-circle-outline" title={formError} /> : null}
            <Input label="Location code" value={code} onChangeText={setCode} autoCapitalize="characters" />
            <Input label="Name" value={name} onChangeText={setName} />

            <Subtle style={{ marginBottom: space.xs }}>Kind</Subtle>
            <Row gap={space.sm} style={{ marginBottom: space.md }}>
              {LOCATION_KINDS.map((k) => (
                <Button
                  key={k}
                  title={k.replace("_", " ")}
                  variant={kind === k ? "primary" : "secondary"}
                  onPress={() => chooseKind(k)}
                  style={{ flex: 1 }}
                />
              ))}
            </Row>

            {kind === "SUB_LOCATION" ? (
              <View style={{ marginBottom: space.md }}>
                <Subtle style={{ marginBottom: space.xs }}>Parent location</Subtle>
                {rows.length === 0 ? (
                  <Subtle>No locations to pick from yet.</Subtle>
                ) : (
                  <Row gap={space.sm} style={{ flexWrap: "wrap" }}>
                    {rows.map((l) => (
                      <Button
                        key={l.id}
                        title={l.code}
                        variant={parentId === l.id ? "primary" : "secondary"}
                        onPress={() => setParentId(l.id)}
                        style={{ paddingHorizontal: space.md, borderRadius: radius.pill, minHeight: 36 }}
                      />
                    ))}
                  </Row>
                )}
              </View>
            ) : null}

            {kind === "SITE" ? (
              <View style={{ marginBottom: space.md }}>
                <Input
                  label="Project"
                  placeholder="Search projects by code or name"
                  value={projectSearch}
                  onChangeText={setProjectSearch}
                  autoCapitalize="none"
                />
                {(projects.data ?? []).length === 0 ? (
                  <Subtle>{projects.isLoading ? "Loading projects…" : "No projects found"}</Subtle>
                ) : (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <Row gap={space.sm}>
                      {(projects.data ?? []).map((p) => (
                        <Button
                          key={p.id}
                          title={p.name}
                          variant={projectId === p.id ? "primary" : "secondary"}
                          onPress={() => setProjectId(p.id)}
                          style={{ borderRadius: radius.pill, minHeight: 36, paddingHorizontal: space.md }}
                        />
                      ))}
                    </Row>
                  </ScrollView>
                )}
              </View>
            ) : null}

            <Input label="Address (optional)" value={addressLine} onChangeText={setAddressLine} />
            <Button title="Create location" icon="add-circle-outline" loading={submitting} onPress={() => void submit()} />
          </Card>
        </>
      ) : null}
    </>
  );
}

/** B-008: physical stock counts — list (stockcount.read), record one item per count (stockcount.manage), and its variance. */
function CountsSection({
  canRead,
  canManage,
  canReadItems,
  canReadLocations,
}: {
  canRead: boolean;
  canManage: boolean;
  canReadItems: boolean;
  canReadLocations: boolean;
}) {
  const [countNo, setCountNo] = useState(`SC-${Date.now().toString().slice(-8)}`);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [countedOn, setCountedOn] = useState(formToday());
  const [itemId, setItemId] = useState<string | null>(null);
  const [itemSearch, setItemSearch] = useState("");
  const [countedQuantity, setCountedQuantity] = useState("");
  const [batchNo, setBatchNo] = useState("");
  const [remarks, setRemarks] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [selected, setSelected] = useState<StockCount | null>(null);
  const [createdNotice, setCreatedNotice] = useState<string | null>(null);

  const counts = useQuery({
    queryKey: ["stock-counts"],
    queryFn: () => getStockCounts(),
    enabled: canRead,
  });
  const locations = useQuery({
    queryKey: ["stock-locations", "count-form"],
    queryFn: () => getStockLocations(),
    enabled: canManage && canReadLocations,
  });
  const pickerItems = useQuery({
    queryKey: ["inventory", "items", "count-form", itemSearch],
    queryFn: () => getInventoryItems(itemSearch.trim() ? { search: itemSearch.trim() } : undefined),
    enabled: canManage && canReadItems,
  });
  const detail = useQuery({
    queryKey: ["stock-count", selected?.id],
    queryFn: () => getStockCount(selected!.id),
    // GET /stock-counts/:id needs stockcount.read same as the list — a
    // manage-only caller who just recorded a count cannot open this detail
    // either, so the success path below shows a notice instead of a modal
    // that would only 403.
    enabled: Boolean(selected) && canRead,
  });

  const rows = counts.data ?? [];

  const resetForm = () => {
    setCountNo(`SC-${Date.now().toString().slice(-8)}`);
    setLocationId(null);
    setCountedOn(formToday());
    setItemId(null);
    setItemSearch("");
    setCountedQuantity("");
    setBatchNo("");
    setRemarks("");
  };

  const submit = async () => {
    setFormError(null);
    const v = validateStockCountCreate({
      count_no: countNo,
      location_id: locationId ?? "",
      counted_on: countedOn,
      item_id: itemId ?? "",
      counted_quantity: countedQuantity,
    });
    if (!v.ok) {
      setFormError(v.errors.map((e) => e.message).join("\n"));
      return;
    }
    setSubmitting(true);
    try {
      const created = await postStockCount({
        count_no: countNo.trim(),
        location_id: locationId!,
        counted_on: countedOn,
        item_id: itemId!,
        counted_quantity: Number(countedQuantity),
        ...(batchNo.trim() ? { batch_no: batchNo.trim() } : {}),
        ...(remarks.trim() ? { remarks: remarks.trim() } : {}),
      });
      resetForm();
      void counts.refetch();
      if (canRead) {
        setCreatedNotice(null);
        setSelected(created);
      } else {
        // Recorded, but viewing the variance needs stockcount.read too —
        // say so instead of opening a detail modal that would just 403.
        setCreatedNotice(created.count_no);
      }
    } catch (e) {
      setFormError(describeApiError(e, "Could not record this count"));
    } finally {
      setSubmitting(false);
    }
  };

  // stockcount.read and stockcount.manage are independent: a manage-only
  // caller still gets the create form below, just not the list or the
  // variance detail, matching web's StockSection.tsx (separate <Can> gates
  // around the list panel and the create panel).
  if (!canRead && !canManage) {
    return (
      <EmptyState
        icon="lock-closed-outline"
        title="No access to stock counts"
        message={`This screen needs permission to ${permissionLabel('stockcount.read')}.`}
      />
    );
  }

  return (
    <>
      {canRead ? (
        <>
          <SectionLabel>Physical stock counts</SectionLabel>
          <Card>
            {listState(counts, rows.length) === "loading" ? (
              <Loading />
            ) : listState(counts, rows.length) === "error" ? (
              <LoadError query={counts} what="stock counts" />
            ) : rows.length === 0 ? (
              <EmptyState icon="clipboard-outline" title="No counts recorded yet" />
            ) : (
              rows.map((c, i, arr) => (
                <ListRow
                  key={c.id}
                  title={`${c.count_no} · ${c.location_name ?? ""}`}
                  subtitle={`Counted ${c.counted_on}${c.variance_count ? ` · ${c.variance_count} line(s) with variance` : ""}`}
                  right={<Badge text={c.status} tone={countStatusTone(c.status)} />}
                  onPress={() => setSelected(c)}
                  last={i === arr.length - 1}
                />
              ))
            )}
          </Card>
        </>
      ) : null}

      {canManage ? (
        <>
          <SectionLabel>Record a physical count</SectionLabel>
          <Card>
            {formError ? <Banner tone="danger" icon="alert-circle-outline" title={formError} /> : null}
            <Input label="Count number" value={countNo} onChangeText={setCountNo} />

            <View style={{ marginBottom: space.md }}>
              <Subtle style={{ marginBottom: space.xs }}>Location</Subtle>
              {!canReadLocations ? (
                <Subtle>No access to the location list.</Subtle>
              ) : (locations.data ?? []).length === 0 ? (
                <Subtle>{locations.isLoading ? "Loading locations…" : "No locations yet — create one first."}</Subtle>
              ) : (
                <Row gap={space.sm} style={{ flexWrap: "wrap" }}>
                  {(locations.data ?? []).map((l) => (
                    <Button
                      key={l.id}
                      title={l.code}
                      variant={locationId === l.id ? "primary" : "secondary"}
                      onPress={() => setLocationId(l.id)}
                      style={{ paddingHorizontal: space.md, borderRadius: radius.pill, minHeight: 36 }}
                    />
                  ))}
                </Row>
              )}
            </View>

            <Input label="Counted on" placeholder="YYYY-MM-DD" value={countedOn} onChangeText={setCountedOn} autoCapitalize="none" />

            <View style={{ marginBottom: space.md }}>
              <Subtle style={{ marginBottom: space.xs }}>Item</Subtle>
              {!canReadItems ? (
                <Subtle>No access to the item list.</Subtle>
              ) : (
                <>
                  <Input placeholder="Search by name or code" value={itemSearch} onChangeText={setItemSearch} autoCapitalize="none" />
                  {(pickerItems.data ?? []).length === 0 ? (
                    <Subtle>{pickerItems.isLoading ? "Loading items…" : "No items found"}</Subtle>
                  ) : (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                      <Row gap={space.sm}>
                        {(pickerItems.data ?? []).map((it) => (
                          <Button
                            key={it.id}
                            title={`${it.code} · ${it.name}`}
                            variant={itemId === it.id ? "primary" : "secondary"}
                            onPress={() => setItemId(it.id)}
                            style={{ borderRadius: radius.pill, minHeight: 36, paddingHorizontal: space.md }}
                          />
                        ))}
                      </Row>
                    </ScrollView>
                  )}
                </>
              )}
            </View>

            <Input
              label="Counted quantity"
              placeholder="0"
              keyboardType="decimal-pad"
              value={countedQuantity}
              onChangeText={setCountedQuantity}
            />
            <Input label="Batch number (if batch-tracked)" value={batchNo} onChangeText={setBatchNo} />
            <Input label="Remarks (optional)" value={remarks} onChangeText={setRemarks} />
            <Button title="Record count" icon="checkmark-circle-outline" loading={submitting} onPress={() => void submit()} />
          </Card>
        </>
      ) : null}

      {createdNotice ? (
        <Banner
          tone="success"
          icon="checkmark-circle-outline"
          title={`Count ${createdNotice} recorded`}
          message={`Viewing its variance needs permission to ${permissionLabel('stockcount.read')}.`}
        />
      ) : null}

      <Modal
        visible={Boolean(selected)}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSelected(null)}
      >
        <Screen>
          <BackHeader title={selected ? `Count ${selected.count_no}` : "Count"} onBack={() => setSelected(null)} />
          {detail.isLoading ? (
            <Loading />
          ) : !detail.data ? (
            <EmptyState icon="alert-circle-outline" title="Could not load this count" />
          ) : (
            <CountVariance count={detail.data} />
          )}
        </Screen>
      </Modal>
    </>
  );
}

/** The lines a stock count posted, with the variance the count actually found. */
function CountVariance({ count }: { count: StockCount }) {
  const t = useTheme();
  const lines = count.lines ?? [];
  return (
    <View>
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Muted style={{ color: t.text, fontWeight: "700" }}>{count.location_name ?? count.location_id}</Muted>
          <Badge text={count.status} tone={countStatusTone(count.status)} />
        </Row>
        <Subtle style={{ marginTop: space.xs }}>Counted on {count.counted_on}</Subtle>
      </Card>
      <SectionLabel>Lines</SectionLabel>
      <Card>
        {lines.length === 0 ? (
          <EmptyState icon="list-outline" title="No lines on this count" />
        ) : (
          lines.map((l, i, arr) => {
            const variance = Number(l.variance);
            return (
              <ListRow
                key={String(l.id ?? i)}
                title={`${l.item_name ?? l.item_id} · ${l.unit ?? ""}`}
                subtitle={`System ${l.system_quantity} → Counted ${l.counted_quantity}`}
                right={
                  <Badge
                    text={variance > 0 ? `+${variance}` : String(variance)}
                    tone={variance === 0 ? "neutral" : variance > 0 ? "success" : "danger"}
                  />
                }
                last={i === arr.length - 1}
              />
            );
          })
        )}
      </Card>
      <Divider />
    </View>
  );
}

const RESERVATION_STATES = ["", "ACTIVE", "RELEASED", "EXPIRED", "CONSUMED"];

/** B-008: stock reservations — list-only on mobile (reservation.read); creating/releasing stays desktop-only. */
function ReservationsSection({ canRead }: { canRead: boolean }) {
  const [state, setState] = useState("");
  const reservations = useQuery({
    queryKey: ["stock-reservations", state],
    queryFn: () => getStockReservations(state ? { state } : undefined),
    enabled: canRead,
  });
  const rows = reservations.data ?? [];

  if (!canRead) {
    return (
      <EmptyState
        icon="lock-closed-outline"
        title="No access to reservations"
        message={`This screen needs permission to ${permissionLabel('reservation.read')}.`}
      />
    );
  }

  return (
    <>
      <SectionLabel>Reservations</SectionLabel>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.md }}>
        <Row gap={space.sm}>
          {RESERVATION_STATES.map((s) => (
            <Button
              key={s || "ALL"}
              title={s || "All"}
              variant={state === s ? "primary" : "secondary"}
              onPress={() => setState(s)}
              style={{ borderRadius: radius.pill, minHeight: 36, paddingHorizontal: space.md }}
            />
          ))}
        </Row>
      </ScrollView>
      <Card>
        {listState(reservations, rows.length) === "loading" ? (
          <Loading />
        ) : listState(reservations, rows.length) === "error" ? (
          <LoadError query={reservations} what="reservations" />
        ) : rows.length === 0 ? (
          <EmptyState icon="bookmark-outline" title="No reservations found" />
        ) : (
          rows.map((r, i, arr) => (
            <ListRow
              key={r.id}
              title={`${r.item_name ?? r.item_code ?? r.item_id} · ${r.quantity}`}
              subtitle={[r.location_name, r.project_code].filter(Boolean).join(" · ")}
              right={<Badge text={r.state} tone={reservationStateTone(r.state)} />}
              last={i === arr.length - 1}
            />
          ))
        )}
      </Card>
    </>
  );
}

/** B-008: items at or below their reorder level — list-only (stock.read), already filtered server-side. */
function ReorderSection({ canRead }: { canRead: boolean }) {
  const reorder = useQuery({
    queryKey: ["stock-reorder"],
    queryFn: getStockReorderSuggestions,
    enabled: canRead,
  });
  const rows = reorder.data ?? [];

  if (!canRead) {
    return (
      <EmptyState
        icon="lock-closed-outline"
        title="No access to reorder suggestions"
        message={`This screen needs permission to ${permissionLabel('stock.read')}.`}
      />
    );
  }

  return (
    <>
      <SectionLabel>Reorder suggestions</SectionLabel>
      <Card>
        {listState(reorder, rows.length) === "loading" ? (
          <Loading />
        ) : listState(reorder, rows.length) === "error" ? (
          <LoadError query={reorder} what="reorder suggestions" />
        ) : rows.length === 0 ? (
          <EmptyState icon="checkmark-done-outline" title="Nothing below its reorder level" />
        ) : (
          rows.map((r, i, arr) => (
            <ListRow
              key={r.item_id}
              title={`${r.name} · ${r.code}`}
              subtitle={`On hand ${r.onHand} ${r.unit} · Reserved ${r.reserved} · Available ${r.available}`}
              right={<Badge text={r.reorder_quantity != null ? `Reorder ${r.reorder_quantity}` : "Reorder"} tone="warning" />}
              last={i === arr.length - 1}
            />
          ))
        )}
      </Card>
    </>
  );
}

export default withScreenBoundary(InventoryScreen);
