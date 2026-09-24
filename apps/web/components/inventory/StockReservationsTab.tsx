'use client';

import { useState } from 'react';
import { Panel, Collection, MutationForm, Can, type Row } from '@/components/v2/Workbench';
import { Button } from '@/components/ui/Button';

/**
 * Stock reservations (§44) — a tab beside Stock/Ledger/Vendors/Invoices in
 * the inventory Workbench, built from the same generic Collection/MutationForm
 * DSL those tabs already use, so it inherits the same request-building,
 * version handling and error rendering they already have tests for.
 */
export function StockReservationsTab() {
  const [state, setState] = useState('');
  const [selected, setSelected] = useState<Row | null>(null);

  const path = `stock-reservations${state ? `?state=${state}` : ''}`;

  return (
    <>
      <Panel title="Reservations">
        <div className="mb-3 flex items-center gap-2">
          <label className="text-sm font-medium text-text-muted">
            State
            <select
              className="ml-2 rounded-md border border-border p-1.5 text-sm"
              value={state}
              onChange={(e) => setState(e.target.value)}
            >
              <option value="">All</option>
              <option value="ACTIVE">Active</option>
              <option value="RELEASED">Released</option>
              <option value="EXPIRED">Expired</option>
              <option value="CONSUMED">Consumed</option>
            </select>
          </label>
        </div>
        <Collection
          path={path}
          columns={[
            { key: 'item_code', label: 'Item' },
            { key: 'item_name', label: 'Name' },
            { key: 'location_name', label: 'Location' },
            { key: 'quantity', label: 'Quantity' },
            { key: 'project_code', label: 'Project' },
            { key: 'state', label: 'State' },
            { key: 'expires_on', label: 'Expires' },
          ]}
          onSelect={setSelected}
        />
      </Panel>

      <Can permission="reservation.manage">
        <Panel title="New reservation">
          <MutationForm
            path="stock-reservations"
            submit="Reserve"
            fields={[
              { key: 'item_id', label: 'Item', source: 'inventory/items?limit=100', required: true },
              { key: 'location_id', label: 'Location', source: 'stock-locations?limit=100', required: true },
              { key: 'quantity', label: 'Quantity', type: 'number', required: true },
              { key: 'project_id', label: 'Project', source: 'projects?limit=100' },
              { key: 'expires_on', label: 'Expires on', type: 'date' },
              { key: 'notes', label: 'Notes', type: 'textarea' },
            ]}
          />
        </Panel>

        {selected ? (
          <Panel title={`Reservation: ${selected.item_code ?? selected.item_id}`}>
            <p className="text-sm text-text-muted">
              {selected.quantity} of {selected.item_name} at {selected.location_name} —{' '}
              <span className="font-medium text-text">{selected.state}</span>
            </p>
            {selected.state === 'ACTIVE' ? (
              <div className="mt-3">
                <MutationForm
                  key={`${selected.id}-${selected.version}`}
                  path={`stock-reservations/${selected.id}/release`}
                  method="POST"
                  version={selected.version}
                  fields={[]}
                  submit="Release"
                  onSaved={(row) => setSelected(row)}
                />
              </div>
            ) : null}
            <Button variant="secondary" className="mt-3" onClick={() => setSelected(null)}>
              Close
            </Button>
          </Panel>
        ) : null}
      </Can>
    </>
  );
}
