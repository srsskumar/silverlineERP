'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AssetAudit, AuditResults } from '@/components/v2/AssetAudit';
import {
  Workbench, Panel, Can, Collection, MutationForm, choices, type Row,
} from '@/components/v2/Workbench';
import { apiRequestRaw } from '@/lib/apiClient';
import { ASSET_CONDITIONS, ASSET_LOCATION_LABELS } from '@silverline/shared';

/**
 * The asset register (enhancement note 3).
 *
 * Four things this screen has to answer about any piece of equipment: what it
 * is, what condition it is in, where it is right now, and who had it before.
 * The first two were free text, the third was not recorded at all, and the
 * fourth ended at "assigned to" with nothing about the handover back.
 */

const CONDITIONS = ASSET_CONDITIONS.map((c) => ({ value: c.code, label: c.label }));

export default function Page() {
  const [asset, setAsset] = useState<Row | null>(null);
  const [audit, setAudit] = useState<Row | null>(null);

  return (
    <Workbench
      title="Assets"
      description="What each piece of equipment is, where it is, who has it, and what state it came back in."
    >
      <Panel title="Asset register">
        <p className="mb-4 text-sm text-text-muted">
          {/* Location is worked out from whether anybody currently holds the
              thing — a stored column would let the two disagree with no way
              to tell which is lying. */}
          Location is worked out from the allocations: an asset is in the field exactly when
          somebody holds it. Select one to allocate it, record its return, or read its history.
        </p>
        <Collection
          path="assets"
          columns={[
            { key: 'asset_code', label: 'Code' },
            { key: 'name', label: 'Asset' },
            { key: 'asset_type_label', label: 'Type' },
            { key: 'category_label', label: 'Category' },
            { key: 'location', label: 'Where' },
            { key: 'held_by', label: 'With' },
            { key: 'held_for_project', label: 'For' },
            { key: 'condition', label: 'Condition' },
          ]}
          onSelect={setAsset}
        />
      </Panel>

      {asset ? <AssetHistory asset={asset} /> : null}

      <Can permission="asset.manage">
        <Panel title="Register an asset">
          <MutationForm
            path="assets"
            submit="Add to the register"
            fields={[
              { key: 'asset_code', label: 'Asset code', required: true },
              { key: 'name', label: 'Name', required: true },
              // Both are lists the organisation can extend, below.
              { key: 'asset_type_id', label: 'Type', source: 'asset-types', labelKey: 'label' },
              { key: 'category', label: 'Category', source: 'asset-categories', labelKey: 'label', required: true },
              { key: 'serial_number', label: 'Serial number' },
              { key: 'make', label: 'Make' },
              { key: 'model', label: 'Model' },
              {
                key: 'condition', label: 'Condition', type: 'select',
                options: CONDITIONS, default: 'GOOD', required: true,
              },
              { key: 'condition_note', label: 'Condition note (required for “Other”)' },
              { key: 'vendor_id', label: 'Vendor', source: 'vendors?limit=100' },
            ]}
          />
        </Panel>

        {asset ? (
          <>
            <Panel title={`Correct ${asset.name}`}>
              <p className="mb-4 text-sm text-text-muted">
                Changes what the register says about the asset itself. To move it between
                people, use the allocation below.
              </p>
              <MutationForm
                key={`${asset.id}${asset.version}edit`}
                path={`assets/${asset.id}`}
                method="PATCH"
                version={asset.version as number}
                submit="Save changes"
                onSaved={setAsset}
                fields={[
                  { key: 'asset_code', label: 'Asset code', default: String(asset.asset_code ?? ''), required: true },
                  { key: 'name', label: 'Name', default: String(asset.name ?? ''), required: true },
                  { key: 'asset_type_id', label: 'Type', source: 'asset-types', labelKey: 'label' },
                  { key: 'category', label: 'Category', source: 'asset-categories', labelKey: 'label', required: true },
                  { key: 'serial_number', label: 'Serial number', default: String(asset.serial_number ?? '') },
                  { key: 'make', label: 'Make', default: String(asset.make ?? '') },
                  { key: 'model', label: 'Model', default: String(asset.model ?? '') },
                  {
                    key: 'condition', label: 'Condition', type: 'select',
                    options: CONDITIONS, default: String(asset.condition ?? 'GOOD'), required: true,
                  },
                  { key: 'condition_note', label: 'Condition note', default: String(asset.condition_note ?? '') },
                ]}
              />
            </Panel>

            <Panel title={`Allocate ${asset.name}`}>
              <p className="mb-4 text-sm text-text-muted">
                The condition here is the state it goes out in. What it comes back in is
                recorded separately, by whoever receives it.
              </p>
              <MutationForm
                key={`${asset.id}${asset.version}assign`}
                path={`assets/${asset.id}/assign`}
                version={asset.version as number}
                submit="Allocate"
                onSaved={setAsset}
                fields={[
                  { key: 'employee_id', label: 'To employee', source: 'assets/eligible-employees', required: true },
                  { key: 'project_id', label: 'For project', source: 'inventory/eligible-projects' },
                  { key: 'due_date', label: 'Return due', type: 'date' },
                  {
                    key: 'condition', label: 'Condition going out', type: 'select',
                    options: CONDITIONS, default: String(asset.condition ?? 'GOOD'), required: true,
                  },
                  { key: 'reason', label: 'What it is for', required: true },
                ]}
              />
            </Panel>

            <Panel title="Record a return, or a change of state">
              <p className="mb-4 text-sm text-text-muted">
                {/* The receiver's reading is the point: the person handing
                    equipment back has every reason to call it fine. */}
                The condition here is what the <strong>receiver</strong> observes, and it is kept
                apart from the state the asset went out in — so the register can show that
                something left in good order and came back needing repair.
              </p>
              <MutationForm
                key={`${asset.id}${asset.version}status`}
                path={`assets/${asset.id}/transition`}
                version={asset.version as number}
                submit="Record it"
                onSaved={setAsset}
                fields={[
                  {
                    key: 'status', label: 'New status', type: 'select',
                    options: choices(['IN_USE', 'RETURNED', 'AVAILABLE', 'DAMAGED', 'LOST', 'WRITTEN_OFF']),
                    required: true,
                  },
                  {
                    key: 'condition', label: 'Condition as received', type: 'select',
                    options: CONDITIONS, default: String(asset.condition ?? 'GOOD'), required: true,
                  },
                  { key: 'condition_note', label: 'Condition note (required for “Other”)' },
                  { key: 'returned_to_employee_id', label: 'Returned to', source: 'assets/eligible-employees' },
                  { key: 'reason', label: 'Reason', required: true },
                ]}
              />
            </Panel>
          </>
        ) : null}

        <Panel title="Types and categories">
          <p className="mb-4 text-sm text-text-muted">
            Nobody can list in advance every instrument a survey firm will buy, so both lists
            can be extended. Adding a code that was retired brings it back rather than failing.
          </p>
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <Collection
                path="asset-types"
                columns={[{ key: 'label', label: 'Type' }, { key: 'code', label: 'Code' }]}
              />
              <div className="mt-3">
                <MutationForm
                  path="asset-types"
                  submit="Add type"
                  fields={[
                    { key: 'code', label: 'Code (CAPITALS)', required: true },
                    { key: 'label', label: 'Name', required: true },
                  ]}
                />
              </div>
            </div>
            <div>
              <Collection
                path="asset-categories"
                columns={[{ key: 'label', label: 'Category' }, { key: 'code', label: 'Code' }]}
              />
              <div className="mt-3">
                <MutationForm
                  path="asset-categories"
                  submit="Add category"
                  fields={[
                    { key: 'code', label: 'Code (CAPITALS)', required: true },
                    { key: 'label', label: 'Name', required: true },
                  ]}
                />
              </div>
            </div>
          </div>
        </Panel>

        <Panel title="New physical audit"><AssetAudit /></Panel>
        <Panel title="Physical audits">
          <Collection
            onSelect={setAudit}
            path="asset-audits"
            columns={[
              { key: 'name', label: 'Audit' },
              { key: 'results', label: 'Results' },
              { key: 'created_at', label: 'Completed' },
            ]}
          />
          {audit ? <AuditResults audit={audit} /> : null}
        </Panel>
      </Can>
    </Workbench>
  );
}

/**
 * Everything that ever happened to one asset.
 *
 * "Who had it when it broke" should not be a question somebody has to know
 * how to ask. Each spell shows who held it, on what, the state it went out
 * in, the state it came back in, and who took it back.
 */
function AssetHistory({ asset }: { asset: Row }) {
  const detail = useQuery({
    queryKey: ['asset', asset.id],
    queryFn: async () =>
      ((await apiRequestRaw(`/api/v1/assets/${asset.id}`)).body as Row),
  });

  const d = detail.data;
  const history: Row[] = (d?.assignments as Row[]) ?? [];

  return (
    <Panel title={`${asset.name} — where it has been`}>
      {d ? (
        <dl className="mb-4 grid gap-3 text-sm sm:grid-cols-4">
          <Fact label="Where" value={
            ASSET_LOCATION_LABELS[d.location as 'IN_OFFICE' | 'IN_FIELD'] ?? '—'} />
          <Fact label="With" value={String(d.currently_with?.employee_name ?? '—')} />
          <Fact label="For" value={String(d.currently_with?.project_name ?? '—')} />
          <Fact label="Serial" value={String(d.serial_number ?? '—')} />
        </dl>
      ) : null}

      {history.length === 0 ? (
        <p className="text-sm text-text-muted">This asset has never been allocated.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-text-muted">
                <th className="py-2 pr-3">Held by</th>
                <th className="py-2 pr-3">For</th>
                <th className="py-2 pr-3">Out</th>
                <th className="py-2 pr-3">Back</th>
                <th className="py-2 pr-3">Went out as</th>
                <th className="py-2 pr-3">Came back as</th>
                <th className="py-2 pr-3">Returned to</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={String(h.id)} className="border-b border-border last:border-0">
                  <td className="py-2 pr-3 text-text">{String(h.employee_name ?? '—')}</td>
                  <td className="py-2 pr-3 text-text-muted">{String(h.project_name ?? '—')}</td>
                  <td className="py-2 pr-3 text-text-muted">{day(h.issued_at)}</td>
                  <td className="py-2 pr-3 text-text-muted">
                    {h.returned_at ? day(h.returned_at) : <em>still out</em>}
                  </td>
                  <td className="py-2 pr-3 text-text-muted">{label(h.condition)}</td>
                  <td className="py-2 pr-3 text-text-muted">{label(h.return_condition)}</td>
                  <td className="py-2 pr-3 text-text-muted">{String(h.returned_to_name ?? '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function Fact({ label: name, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-wide text-text-subtle">{name}</dt>
      <dd className="mt-0.5 text-text">{value}</dd>
    </div>
  );
}

/** A condition code as words, including the ones the register held before. */
function label(code: unknown): string {
  if (!code) return '—';
  const known = ASSET_CONDITIONS.find((c) => c.code === code);
  if (known) return known.label;
  const raw = String(code);
  return raw.charAt(0) + raw.slice(1).toLowerCase().replace(/_/g, ' ');
}

function day(value: unknown): string {
  if (!value) return '—';
  return String(value).slice(0, 10);
}
