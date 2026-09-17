'use client';

import Link from 'next/link';
import * as React from 'react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AssetAudit, AuditResults } from '@/components/v2/AssetAudit';
import {
  Workbench, Panel, Can, Collection, MutationForm, choices, type Row,
} from '@/components/v2/Workbench';
import { apiRequest, apiRequestRaw } from '@/lib/apiClient';
import { useReveal } from '@/lib/use-reveal';
import { Combobox } from '@/components/ui/Combobox';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
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

  // Selecting an asset opens its detail below a register of hundreds of
  // rows; without this the click reads as doing nothing.
  const detail = useReveal(asset ? String(asset.id) : null);

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
          somebody holds it. Select one to allocate it, record its return, or read its history.{' '}
          <Link href="/assets/movements" className="text-primary underline underline-offset-2">
            Every movement, across the whole register
          </Link>.
        </p>
        <Collection
          path="assets"
          columns={[
            { key: 'asset_code', label: 'Code' },
            { key: 'name', label: 'Asset' },
            { key: 'asset_type_label', label: 'Type' },
            { key: 'category_label', label: 'Category' },
            { key: 'location', label: 'Where' },
            // Who has it, on what number, and since when — so chasing a
            // missing instrument does not start with a directory lookup.
            { key: 'held_by', label: 'Assigned to' },
            { key: 'held_by_phone', label: 'Phone' },
            { key: 'assigned_on', label: 'Assigned on' },
            { key: 'held_for_project', label: 'For' },
            { key: 'condition', label: 'Condition' },
          ]}
          onSelect={setAsset}
        />
      </Panel>

      {/* The anchor the page scrolls to, so the click and its result are in
          the same place. scroll-mt keeps the heading clear of the top edge
          rather than flush against it. */}
      <div ref={detail} className="scroll-mt-4" />

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
              // Add a type without leaving the form: the alternative is
              // abandoning it, and people respond by picking the nearest
              // wrong type — which is how a master list stops meaning
              // anything.
              {
                key: 'asset_type_id', label: 'Type', source: 'asset-types', labelKey: 'label',
                createPath: 'asset-types', createField: 'label',
                hint: 'Not there? Type its name and add it.',
              },
              {
                key: 'category', label: 'Category', source: 'asset-categories', labelKey: 'label',
                required: true, createPath: 'asset-categories', createField: 'label',
              },
              { key: 'serial_number', label: 'Serial number' },
              { key: 'make', label: 'Make' },
              { key: 'model', label: 'Model' },
              {
                key: 'condition', label: 'Condition', type: 'select',
                options: CONDITIONS, default: 'GOOD', required: true,
              },
              { key: 'condition_note', label: 'Condition note (required for “Other”)' },
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
                  {
                    key: 'asset_type_id', label: 'Type', source: 'asset-types', labelKey: 'label',
                    createPath: 'asset-types', createField: 'label',
                  },
                  {
                    key: 'category', label: 'Category', source: 'asset-categories',
                    labelKey: 'label', required: true,
                    createPath: 'asset-categories', createField: 'label',
                  },
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

            {String(asset.location) === 'IN_FIELD' ? (
              <Panel title={`Hand ${asset.name} to somebody else`}>
                <p className="mb-4 text-sm text-text-muted">
                  {/* Not an edit of who holds it: the open spell records a
                      real period in somebody's hands, and rewriting it would
                      erase that they ever had the thing. */}
                  Currently with <strong>{String(asset.held_by ?? 'somebody')}</strong>
                  {asset.assigned_on ? ` since ${String(asset.assigned_on).slice(0, 10)}` : ''}.
                  Handing it on closes that spell and opens a new one, so both stay on the
                  record and the handover has a date.
                </p>
                <MutationForm
                  key={`${asset.id}${asset.version}transfer`}
                  path={`assets/${asset.id}/transfer`}
                  version={asset.version as number}
                  submit="Hand it over"
                  onSaved={setAsset}
                  fields={[
                    { key: 'to_employee_id', label: 'New assignee', source: 'assets/eligible-employees', required: true },
                    { key: 'project_id', label: 'For project', source: 'inventory/eligible-projects' },
                    { key: 'due_date', label: 'Return due', type: 'date' },
                    {
                      key: 'condition', label: 'Condition at handover', type: 'select',
                      options: CONDITIONS, default: String(asset.condition ?? 'GOOD'), required: true,
                    },
                    { key: 'condition_note', label: 'Condition note (required for “Other”)' },
                    { key: 'reason', label: 'Why it is moving', required: true },
                  ]}
                />
              </Panel>
            ) : null}

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

        <Panel title="Issue a kit to one person">
          <IssueKit />
        </Panel>

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

/**
 * Issue several pieces of equipment to one person.
 *
 * Typed and picked, not scrolled. A register of a few hundred instruments in
 * a multi-select list means hunting for "the rover with serial ...4471" by
 * eye, and the one that gets picked is whichever looked close enough — which
 * is how the wrong instrument ends up in somebody's van and the right one
 * goes missing on paper.
 *
 * Each item is identified the way a storeman identifies it: what it is, its
 * serial, its code. Three rows reading "Rover" tell nobody which is which.
 */
function IssueKit() {
  const qc = useQueryClient();
  const [basket, setBasket] = React.useState<Array<{ id: string; label: string }>>([]);
  const [form, setForm] = React.useState({
    employee_id: '', project_id: '', due_date: '', condition: 'GOOD', reason: '',
  });
  const [outcome, setOutcome] = React.useState<string | null>(null);

  const assets = useQuery({
    queryKey: ['assets', 'all'], queryFn: fetchAllAssets, staleTime: 300_000,
  });
  const people = useQuery({
    queryKey: ['assets', 'eligible-employees'],
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/assets/eligible-employees')).body as { data: Row[] }).data,
    staleTime: 300_000,
  });
  const projects = useQuery({
    queryKey: ['inventory', 'eligible-projects'],
    queryFn: async () =>
      ((await apiRequestRaw('/api/v1/inventory/eligible-projects')).body as { data: Row[] }).data,
    staleTime: 300_000,
  });

  const issue = useMutation({
    mutationFn: async () =>
      apiRequest('/api/v1/assets/assign-bulk', {
        method: 'POST',
        body: {
          asset_ids: basket.map((b) => b.id),
          employee_id: form.employee_id,
          project_id: form.project_id || undefined,
          due_date: form.due_date || undefined,
          condition: form.condition,
          reason: form.reason,
        },
      }),
    onSuccess: (res: any) => {
      const d = res?.data ?? res ?? {};
      const busy = (d.busy ?? []) as Array<{ asset_code: string; with_whom: string }>;
      setOutcome([
        d.issued ? `${d.issued} issued` : '',
        busy.length
          ? busy.map((b) => `${b.asset_code} is already with ${b.with_whom}`).join('; ')
          : '',
      ].filter(Boolean).join('. '));
      setBasket([]);
      setForm({ ...form, reason: '' });
      qc.invalidateQueries({ queryKey: ['assets'] });
    },
  });

  const field = 'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text';
  const ready = basket.length > 0 && form.employee_id && form.reason.trim();

  return (
    <div className="space-y-3">
      <p className="text-sm text-text-muted">
        A surveyor going out carries a rover, a tripod, a radio and a battery. Search for each,
        add them all, issue them once. Anything already out with somebody else is named and the
        rest still go.
      </p>

      <div>
        <label className="mb-1 block text-sm font-medium text-text-muted">Equipment</label>
        <Combobox
          value=""
          onChange={(id) => {
            const a = (assets.data ?? []).find((x) => String(x.id) === id);
            if (!a || basket.some((b) => b.id === id)) return;
            setBasket([...basket, { id, label: String(a.picker_label ?? a.asset_code) }]);
            setOutcome(null);
          }}
          isLoading={assets.isLoading}
          placeholder="Type a type, serial or code — add as many as you need…"
          options={(assets.data ?? [])
            .filter((a) => !basket.some((b) => b.id === String(a.id)))
            .map((a) => ({
              id: String(a.id),
              label: String(a.picker_label ?? a.name ?? a.asset_code),
              // Where it already is, so a clash is seen before it is picked
              // rather than after the server refuses it.
              hint: a.location === 'IN_FIELD' && a.held_by
                ? `out with ${a.held_by}` : 'in office',
            }))}
          emptyHint="Search by what it is, its serial number or its code"
        />
        {basket.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {basket.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => setBasket(basket.filter((x) => x.id !== b.id))}
                className="rounded-full border border-border bg-surface px-2 py-0.5 text-2xs
                  text-text hover:border-danger hover:text-danger"
                title="Remove"
              >
                {b.label} ×
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block text-sm font-medium text-text-muted">
          <span className="mb-1 block">To employee *</span>
          <Combobox
            value={form.employee_id}
            onChange={(id) => setForm({ ...form, employee_id: id })}
            isLoading={people.isLoading}
            placeholder="Search the directory…"
            options={(people.data ?? []).map((e) => ({
              id: String(e.id),
              label: [e.first_name, e.last_name].filter(Boolean).join(' ') || String(e.emp_no),
              hint: String(e.emp_no ?? ''),
            }))}
          />
        </label>
        <label className="block text-sm font-medium text-text-muted">
          <span className="mb-1 block">For project</span>
          <select className={field} value={form.project_id}
            onChange={(e) => setForm({ ...form, project_id: e.target.value })}>
            <option value="">None</option>
            {(projects.data ?? []).map((p) => (
              <option key={String(p.id)} value={String(p.id)}>
                {String(p.code ?? '')} {String(p.name)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-text-muted">
          <span className="mb-1 block">Return due</span>
          <input type="date" className={field} value={form.due_date}
            onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
        </label>
        <label className="block text-sm font-medium text-text-muted">
          <span className="mb-1 block">Condition going out *</span>
          <select className={field} value={form.condition}
            onChange={(e) => setForm({ ...form, condition: e.target.value })}>
            {CONDITIONS.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-text-muted sm:col-span-2">
          <span className="mb-1 block">What it is for *</span>
          <input className={field} value={form.reason}
            placeholder="Ground truthing, Koyyuru mandal"
            onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        </label>
      </div>

      {issue.isError ? <ErrorCard error={issue.error} /> : null}
      {outcome ? <p className="text-sm text-text-muted">{outcome}</p> : null}

      <Button type="button" variant="primary" loading={issue.isPending}
        disabled={!ready} onClick={() => issue.mutate()}>
        {basket.length > 1 ? `Issue ${basket.length} items` : 'Issue it'}
      </Button>
    </div>
  );
}

/** The whole asset register, a page at a time: the server caps a page at 100. */
async function fetchAllAssets(): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 0, offset = 0; page < 20; page += 1, offset += 100) {
    const body = (await apiRequestRaw(`/api/v1/assets?limit=100&offset=${offset}`)).body as {
      data?: Row[]; has_more?: boolean;
    };
    out.push(...(body?.data ?? []));
    if (!body?.has_more) break;
  }
  return out;
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
