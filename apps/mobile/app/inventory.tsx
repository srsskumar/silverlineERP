/**
 * Inventory: the stock register — current quantity on hand per item — with
 * basic IN/OUT posting for anyone holding inventory.manage.
 *
 * Read-only lookup is the field-relevant case (a supervisor checking what is
 * left before ordering more); posting is included too since the API makes it
 * cheap and a storekeeper role plausibly needs to record a receipt or an
 * issue from the same phone, but it stays a single quantity/reference form —
 * not the full vendor/invoice/reservation machinery the web page has.
 */
import { router } from "expo-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, View } from "react-native";
import { ApiError } from "../src/api/client";
import { useAuth } from "../src/auth/AuthContext";
import {
  getInventoryItems,
  getInventoryTransactions,
  postInventoryTransaction,
  type InventoryItem,
} from "../src/api/endpoints";
import { isLowStock, stockTone } from "../src/inventoryFormat";
import { validateStockTransaction } from "../src/validators";
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

function InventoryScreen() {
  const { canDo } = useAuth();
  const canRead = canDo("inventory.read");
  const canManage = canDo("inventory.manage");
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
      <Muted style={{ marginBottom: space.lg }}>What is on hand, item by item.</Muted>

      {!canRead ? (
        <EmptyState
          icon="lock-closed-outline"
          title="No access to inventory"
          message="This screen needs the inventory.read permission."
        />
      ) : (
        <>
          <Input placeholder="Search by name or code" value={search} onChangeText={setSearch} autoCapitalize="none" />
          <Card>
            {items.isLoading ? (
              <Loading />
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
      setError(e instanceof ApiError ? e.message : "Could not post this transaction");
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
        {txns.isLoading ? (
          <Loading />
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

export default withScreenBoundary(InventoryScreen);
