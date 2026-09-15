'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { contractValueBreakdown, amountInWords } from '@silverline/shared';
import { apiRequest, apiRequestRaw } from '@/lib/apiClient';
import { Button } from '@/components/ui/Button';
import { money } from '@/lib/finance';

type Row = Record<string, any>;

/**
 * Every page of a list, not just the first.
 *
 * The server caps a page at 100. A picker that asks for 200 gets 100 and has
 * no way to know it is missing the rest — so the hundred-and-first client is
 * simply unselectable, and the user concludes the record was never created.
 */
const PAGE = 100;
const MAX_PAGES = 20;

async function fetchAll(path: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let offset = 0, page = 0; page < MAX_PAGES; page += 1, offset += PAGE) {
    const sep = path.includes('?') ? '&' : '?';
    const body = (await apiRequestRaw(`${path}${sep}limit=${PAGE}&offset=${offset}`)).body as {
      data?: Row[]; has_more?: boolean;
    };
    const rows = Array.isArray(body) ? body : (body?.data ?? []);
    out.push(...rows);
    if (!body || Array.isArray(body) || !body.has_more) break;
  }
  return out;
}

const inputClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1';

/** The four priorities the server accepts. Free text only ever produced typos. */
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

/**
 * A select over a master list, with a way to add a missing entry in place.
 *
 * Every one of these lists — workspace, project type, category, client — had
 * the same problem: the value you need is not there, and the only way to add
 * it is to abandon the form and go somewhere else. People respond by picking
 * the nearest wrong option, which is how a master list stops meaning anything.
 */
export function MasterSelect({
  label, value, onChange, options, isLoading, placeholder, onCreate, createLabel, disabled, hint,
}: {
  label: string;
  value: string;
  onChange: (id: string) => void;
  options: Array<{ id: string; label: string }>;
  isLoading?: boolean;
  placeholder: string;
  /** Omitted when the caller has no permission to add one. */
  onCreate?: (name: string) => Promise<{ id: string }>;
  createLabel?: string;
  disabled?: boolean;
  hint?: React.ReactNode;
}) {
  const [adding, setAdding] = React.useState(false);
  const [name, setName] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function create() {
    if (!name.trim() || !onCreate) return;
    setBusy(true);
    setError(null);
    try {
      const created = await onCreate(name.trim());
      onChange(created.id);
      setName('');
      setAdding(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add that');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-text-muted">{label}</label>
      {adding ? (
        <div className="flex gap-2">
          <input
            autoFocus
            className={inputClass}
            placeholder={createLabel ?? `New ${label.toLowerCase()}`}
            value={name}
            maxLength={255}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void create(); }
              if (e.key === 'Escape') { setAdding(false); setName(''); }
            }}
          />
          <Button type="button" loading={busy} disabled={!name.trim()} onClick={() => void create()}>
            Add
          </Button>
          <Button type="button" variant="secondary" onClick={() => { setAdding(false); setName(''); setError(null); }}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <select
            className={inputClass}
            value={value}
            disabled={disabled || isLoading}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">{isLoading ? 'Loading…' : placeholder}</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
          {onCreate ? (
            <Button type="button" variant="secondary" onClick={() => setAdding(true)}>
              + New
            </Button>
          ) : null}
        </div>
      )}
      {error ? <p className="mt-1 text-2xs text-danger">{error}</p> : null}
      {hint && !adding ? <p className="mt-1 text-2xs text-text-subtle">{hint}</p> : null}
    </div>
  );
}

/* -------------------------------------------------------------- the lists */

export function useWorkspaces() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['workspaces', 'master'],
    queryFn: () => fetchAll('/api/v1/workspaces'),
    staleTime: 300_000,
    retry: false,
  });
  const create = async (name: string) => {
    const res = await apiRequest<Row>('/api/v1/workspaces', { method: 'POST', body: { name } });
    await client.invalidateQueries({ queryKey: ['workspaces'] });
    return { id: String(res.data.id) };
  };
  return { query, create };
}

export function useProjectTypes() {
  const query = useQuery({
    queryKey: ['project-types', 'master'],
    queryFn: () => fetchAll('/api/v1/project-types'),
    staleTime: 300_000,
    retry: false,
  });
  return { query };
}

export function useProjectCategories() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['project-categories', 'master'],
    queryFn: () => fetchAll('/api/v1/project-categories'),
    staleTime: 300_000,
    retry: false,
  });
  const create = async (name: string) => {
    const res = await apiRequest<Row>('/api/v1/project-categories', { method: 'POST', body: { name } });
    await client.invalidateQueries({ queryKey: ['project-categories'] });
    return { id: String(res.data.id) };
  };
  return { query, create };
}

/**
 * Clients, narrowed to the track the project is on.
 *
 * A government job is awarded by a department and a private one by a company;
 * showing both lists together makes the user scan past every irrelevant name,
 * and picking the wrong kind of client is a mistake nothing downstream
 * catches. When no track is chosen yet, everybody is shown — filtering to
 * nothing would be worse than filtering to too much.
 */
export function useClients(track: string) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['clients', 'master'],
    queryFn: () => fetchAll('/api/v1/clients'),
    staleTime: 300_000,
    retry: false,
  });
  const all = query.data ?? [];
  const filtered = track ? all.filter((c) => String(c.client_type) === track) : all;
  const create = async (name: string) => {
    const res = await apiRequest<Row>('/api/v1/clients', {
      method: 'POST',
      body: { name, client_type: track || 'PRIVATE' },
    });
    await client.invalidateQueries({ queryKey: ['clients'] });
    return { id: String(res.data.id) };
  };
  return { query, options: filtered, hiddenCount: all.length - filtered.length, create };
}

export function useUsers() {
  return useQuery({
    queryKey: ['users', 'master'],
    queryFn: () => fetchAll('/api/v1/people'),
    staleTime: 300_000,
    retry: false,
  });
}

/* ------------------------------------------------------- contract value */

export interface ContractState {
  contract_value: string;
  contract_gst_included: '' | 'true' | 'false';
  contract_gst_rate: string;
}

/**
 * The contract value, and what it means once GST is accounted for.
 *
 * The figure on a work order is quoted either inclusive or exclusive of tax,
 * and which one it is decides the project's revenue. Booking an inclusive
 * figure as exclusive overstates the margin by the tax rate — at 18% that is
 * not a rounding difference, and nothing downstream would ever catch it.
 *
 * The total is also shown in words, which is how the figure appears on the
 * order itself: a reader checking one against the other is comparing
 * sentences, and a mis-keyed digit shows up immediately.
 */
export function ContractValueFields({
  state, onChange, disabled,
}: {
  state: ContractState;
  onChange: (next: ContractState) => void;
  disabled?: boolean;
}) {
  const amount = Number(state.contract_value);
  const rate = Number(state.contract_gst_rate);
  const known = state.contract_gst_included !== '' && Number.isFinite(rate);
  const breakdown = Number.isFinite(amount) && amount > 0 && known
    ? contractValueBreakdown({
        amount,
        gstIncluded: state.contract_gst_included === 'true',
        ratePct: rate,
      })
    : null;

  const set = (patch: Partial<ContractState>) => onChange({ ...state, ...patch });

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-text-muted">Contract value (₹)</label>
          <input
            type="number" min="0" step="0.01" className={inputClass} disabled={disabled}
            placeholder="As written on the order"
            value={state.contract_value}
            onChange={(e) => set({ contract_value: e.target.value })}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-text-muted">Is GST included?</label>
          <select
            className={inputClass} disabled={disabled}
            value={state.contract_gst_included}
            onChange={(e) => set({ contract_gst_included: e.target.value as ContractState['contract_gst_included'] })}
          >
            <option value="">Not stated</option>
            <option value="true">Yes — the figure includes GST</option>
            <option value="false">No — GST is on top</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-text-muted">GST rate</label>
          <select
            className={inputClass}
            disabled={disabled || state.contract_gst_included === ''}
            value={state.contract_gst_rate}
            onChange={(e) => set({ contract_gst_rate: e.target.value })}
          >
            <option value="">Choose a rate</option>
            {[0, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28].map((r) => (
              <option key={r} value={String(r)}>{r}%</option>
            ))}
          </select>
        </div>
      </div>

      {breakdown ? (
        <div className="rounded-lg border border-border bg-surface-sunken p-3">
          <dl className="grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-2xs uppercase tracking-wide text-text-subtle">Value excluding GST</dt>
              <dd className="mt-0.5 tabular-nums text-text">{money(breakdown.net)}</dd>
            </div>
            <div>
              <dt className="text-2xs uppercase tracking-wide text-text-subtle">GST at {breakdown.ratePct}%</dt>
              <dd className="mt-0.5 tabular-nums text-text-muted">{money(breakdown.gst)}</dd>
            </div>
            <div>
              <dt className="text-2xs uppercase tracking-wide text-text-subtle">Value including GST</dt>
              <dd className="mt-0.5 font-medium tabular-nums text-text">{money(breakdown.gross)}</dd>
            </div>
          </dl>
          <p className="mt-2 border-t border-border pt-2 text-xs text-text-muted">
            {amountInWords(breakdown.gross)}
          </p>
          <p className="mt-1 text-2xs text-text-subtle">
            Margin is measured on the value excluding GST — the tax is collected for the government and
            was never the contractor&rsquo;s money.
          </p>
        </div>
      ) : Number(state.contract_value) > 0 ? (
        <p className="text-2xs text-warning">
          Say whether the figure includes GST, and at what rate, or the project&rsquo;s revenue cannot be
          worked out from it.
        </p>
      ) : null}
    </div>
  );
}
