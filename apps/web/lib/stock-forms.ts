import { LOCATION_KINDS } from '@silverline/shared';
import { choices, type Field, type Row } from '@/components/v2/Workbench';

/**
 * B-008: multi-location stock (stock-locations/stock-counts/stock-
 * reservations/stock/reorder) had API routes and zero UI. Field arrays kept
 * here, pure, so they can be checked against the API's own zod schemas
 * (packages/shared/src/inventory.ts) without rendering anything — see
 * tests/stock-forms.test.ts.
 */

/** POST /stock-locations — matches stockLocationSchema. `active` is left to the server's default(true). */
export const STOCK_LOCATION_FIELDS: Field[] = [
  { key: 'code', label: 'Location code', required: true },
  { key: 'name', label: 'Name', required: true },
  { key: 'kind', label: 'Kind', type: 'select', options: choices([...LOCATION_KINDS]), required: true },
  { key: 'parent_id', label: 'Parent location (required for a sub-location)', source: 'stock-locations?limit=100' },
  { key: 'project_id', label: 'Project (required for a site)', source: 'projects?limit=100' },
  { key: 'address_line', label: 'Address' },
];

/**
 * POST /stock-counts — matches stockCountSchema, minus its `lines` array:
 * the generic form framework here has no repeater field, so this records
 * one item per count (still a real physical count and a real variance).
 * stockCountBody() below folds the single line back into `lines`.
 */
export const STOCK_COUNT_FIELDS: Field[] = [
  { key: 'count_no', label: 'Count number', required: true },
  { key: 'location_id', label: 'Location', source: 'stock-locations?limit=100', required: true },
  { key: 'counted_on', label: 'Counted on', type: 'date', required: true },
  { key: 'item_id', label: 'Item', source: 'inventory/items?limit=100', required: true },
  { key: 'counted_quantity', label: 'Counted quantity', type: 'number', required: true },
  { key: 'batch_no', label: 'Batch number (if batch-tracked)' },
  { key: 'remarks', label: 'Remarks' },
];

/** Folds STOCK_COUNT_FIELDS's flat item_id/counted_quantity/batch_no/remarks into stockCountSchema's `lines` array. */
export function stockCountBody(v: Row): Row {
  const { item_id, counted_quantity, batch_no, remarks, ...rest } = v;
  return {
    ...rest,
    lines: [{
      item_id,
      counted_quantity: Number(counted_quantity),
      ...(batch_no !== undefined ? { batch_no } : {}),
      ...(remarks !== undefined ? { remarks } : {}),
    }],
  };
}
