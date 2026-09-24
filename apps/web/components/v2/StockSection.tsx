'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequestRaw } from '@/lib/apiClient';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Panel, Can, Collection, MutationForm, type Row } from '@/components/v2/Workbench';
import { STOCK_LOCATION_FIELDS, STOCK_COUNT_FIELDS, stockCountBody } from '@/lib/stock-forms';

/**
 * B-008: multi-location stock had API routes (stock-locations,
 * stock-counts, stock-reservations, stock/reorder) and no web UI at all.
 * Each panel is gated by the same permission its route enforces, not by
 * `inventory.read`/`inventory.manage` (the older single-location module's
 * permissions) -- the two permission sets are disjoint, e.g.
 * BID_TENDER_MANAGER holds `stock.read` but not `location.read`.
 */

/** The lines a stock count posted, with the variance the count actually found -- not just how many lines had one. */
function StockCountVariance({ id }: { id: string }) {
  const query = useQuery({
    queryKey: ['v2', 'stock-counts', id],
    queryFn: async () => (await apiRequestRaw(`/api/v1/stock-counts/${id}`)).body as Row,
  });
  if (query.isLoading) return <p role="status">Loading…</p>;
  if (query.isError) return <ErrorCard error={query.error} onRetry={() => void query.refetch()} />;
  const lines = (query.data?.lines as Row[] | undefined) ?? [];
  if (!lines.length) return <p className="text-text-muted">No lines on this count.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b text-text-muted">
            <th className="p-3 font-medium">Item</th>
            <th className="p-3 font-medium">Unit</th>
            <th className="p-3 font-medium">System qty</th>
            <th className="p-3 font-medium">Counted qty</th>
            <th className="p-3 font-medium">Variance</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const variance = Number(l.variance);
            return (
              <tr key={String(l.id ?? i)} className="border-b last:border-0">
                <td className="p-3">{l.item_name}</td>
                <td className="p-3">{l.unit}</td>
                <td className="p-3">{l.system_quantity}</td>
                <td className="p-3">{l.counted_quantity}</td>
                <td className="p-3">{variance > 0 ? `+${variance}` : variance}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function StockSection() {
  const [count, setCount] = useState<Row | null>(null);

  return (
    <>
      <Can permission="location.read">
        <Panel title="Storage locations">
          <Collection
            path="stock-locations"
            columns={[
              { key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'kind', label: 'Kind' },
              { key: 'project_code', label: 'Project' }, { key: 'active', label: 'Active' },
            ]}
          />
        </Panel>
      </Can>
      <Can permission="location.manage">
        <Panel title="New storage location">
          <MutationForm path="stock-locations" fields={STOCK_LOCATION_FIELDS} submit="Create location" />
        </Panel>
      </Can>

      <Can permission="stockcount.read">
        <Panel title="Physical stock counts">
          <Collection
            path="stock-counts"
            columns={[
              { key: 'count_no', label: 'Count' }, { key: 'location_name', label: 'Location' },
              { key: 'counted_on', label: 'Counted on' }, { key: 'status', label: 'Status' },
              { key: 'variance_count', label: 'Lines with variance' },
            ]}
            onSelect={setCount}
          />
        </Panel>
      </Can>
      <Can permission="stockcount.manage">
        <Panel title="Record a physical count">
          <MutationForm
            path="stock-counts" fields={STOCK_COUNT_FIELDS} transform={stockCountBody}
            submit="Record count" onSaved={setCount}
          />
        </Panel>
      </Can>
      {count ? (
        <Can permission="stockcount.read">
          <Panel title={`Variance — ${count.count_no}`}>
            <StockCountVariance id={String(count.id)} />
          </Panel>
        </Can>
      ) : null}

      <Can permission="reservation.read">
        <Panel title="Reservations">
          <Collection
            path="stock-reservations"
            columns={[
              { key: 'item_name', label: 'Item' }, { key: 'location_name', label: 'Location' },
              { key: 'quantity', label: 'Quantity' }, { key: 'state', label: 'State' },
              { key: 'project_code', label: 'Project' }, { key: 'expires_on', label: 'Expires' },
            ]}
          />
        </Panel>
      </Can>

      <Can permission="stock.read">
        <Panel title="Reorder suggestions">
          <Collection
            path="stock/reorder"
            columns={[
              { key: 'code', label: 'Code' }, { key: 'name', label: 'Item' }, { key: 'unit', label: 'Unit' },
              { key: 'onHand', label: 'On hand' }, { key: 'reserved', label: 'Reserved' },
              { key: 'available', label: 'Available' }, { key: 'reorder_quantity', label: 'Reorder qty' },
            ]}
          />
        </Panel>
      </Can>
    </>
  );
}
