'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { useToast } from '@/components/ui/Toast';
import { money } from '@/lib/finance';
import {
  getProjectSupply, putProjectSupply, listCatalogueItems,
  type SupplyLine, type CatalogueItem,
} from '@/lib/projects';

/**
 * §077 -- what we are supplying, and what it comes to.
 *
 * A field-work project is measured and billed off a bill of quantities.
 * Goods, services and AMC are supplied against a list agreed in advance,
 * and the only question anybody asks of that list is "what is the total,
 * with GST, in words" -- which is why the words are on the screen and not
 * only on the printed invoice.
 *
 * Every figure here is computed from the quantity, the price and the rate.
 * None of it is stored: a stored line total is the same fact written twice,
 * and the second copy goes stale the moment somebody edits a quantity.
 */

const GST_SLABS = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28];

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** The same arithmetic the server does, so the screen can show it as you type. */
function lineTotals(line: SupplyLine) {
  const rate = (Number(line.gst_rate) || 0) / 100;
  const qty = Number(line.quantity) || 0;
  const price = Number(line.unit_price) || 0;
  if (line.price_includes_gst) {
    const gross = round2(qty * price);
    const taxable = round2(gross / (1 + rate));
    return { taxable, gst: round2(gross - taxable), gross };
  }
  const taxable = round2(qty * price);
  const gst = round2(taxable * rate);
  return { taxable, gst, gross: round2(taxable + gst) };
}

const EMPTY: SupplyLine = {
  catalogue_item_id: null, description: '', hsn_sac: null, uom: 'nos',
  quantity: 1, unit_price: 0, gst_rate: 18, price_includes_gst: false,
};

export function SupplySchedule({
  projectId, canManage,
}: { projectId: string; canManage: boolean }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [lines, setLines] = React.useState<SupplyLine[] | null>(null);

  const supply = useQuery({
    queryKey: ['project', projectId, 'supply'],
    queryFn: () => getProjectSupply(projectId),
  });
  const catalogue = useQuery({
    queryKey: ['catalogue-items'],
    queryFn: () => listCatalogueItems(),
    enabled: !!supply.data?.applies,
    staleTime: 300_000,
  });

  React.useEffect(() => { if (supply.data) setLines(supply.data.lines); }, [supply.data]);

  const save = useMutation({
    mutationFn: () => putProjectSupply(projectId, lines ?? []),
    onSuccess: async (result) => {
      toast.success('Schedule saved', result.totals.in_words);
      await queryClient.invalidateQueries({ queryKey: ['project', projectId, 'supply'] });
    },
    onError: (e) => toast.error('Could not save', e instanceof Error ? e.message : undefined),
  });

  if (supply.isLoading) return <Skeleton className="h-64 w-full" />;
  if (supply.isError) {
    return <ErrorCard title="Could not load the supply schedule" error={supply.error}
      onRetry={() => supply.refetch()} />;
  }
  /*
   * A measured contract is billed from its bill of quantities. Saying
   * nothing at all is better than an empty table that reads as missing data.
   */
  if (!supply.data?.applies || !lines) return null;

  const totals = lines.reduce(
    (acc, l) => {
      const t = lineTotals(l);
      return {
        taxable: round2(acc.taxable + t.taxable),
        gst: round2(acc.gst + t.gst),
        gross: round2(acc.gross + t.gross),
      };
    },
    { taxable: 0, gst: 0, gross: 0 },
  );
  const dirty = JSON.stringify(lines.map(strip)) !== JSON.stringify(supply.data.lines.map(strip));
  const saved = supply.data.totals;

  const set = (i: number, patch: Partial<SupplyLine>) =>
    setLines((ls) => ls && ls.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  const pick = (i: number, item: CatalogueItem | undefined) => {
    if (!item) { set(i, { catalogue_item_id: null }); return; }
    /*
     * The catalogue seeds the line and then lets go of it. The price is
     * negotiated, so it stays editable, and it is the line's own copy from
     * here on -- a rate rise next quarter must not restate this contract.
     */
    set(i, {
      catalogue_item_id: item.id,
      description: item.name,
      uom: item.uom,
      hsn_sac: item.hsn_sac,
      unit_price: item.standard_rate,
      gst_rate: item.gst_rate,
      standard_rate: item.standard_rate,
    });
  };

  return (
    <section aria-label="Supply schedule" className="rounded-lg border border-border bg-surface p-4 sm:p-6">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-text">Goods and services supplied</h2>
        {supply.data.project.client_name ? (
          <Badge tone="neutral" size="sm">{supply.data.project.client_name}</Badge>
        ) : null}
      </div>
      <p className="mb-4 text-xs text-text-muted">
        Agreed in advance, priced per line. Each line keeps its own copy of the price, so
        changing a standard rate later does not restate this contract.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[56rem] text-xs">
          <thead>
            <tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-text-muted">
              <th className="px-2 py-2">#</th>
              <th className="px-2 py-2">Item</th>
              <th className="px-2 py-2">HSN/SAC</th>
              <th className="px-2 py-2">Unit</th>
              <th className="px-2 py-2 text-right">Qty</th>
              <th className="px-2 py-2 text-right">Rate</th>
              <th className="px-2 py-2">GST</th>
              <th className="px-2 py-2 text-right">Taxable</th>
              <th className="px-2 py-2 text-right">GST amount</th>
              <th className="px-2 py-2 text-right">Total</th>
              {canManage ? <th className="px-2 py-2" /> : null}
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => {
              const t = lineTotals(line);
              const below = line.standard_rate != null
                && Number(line.unit_price) !== Number(line.standard_rate);
              return (
                <tr key={i} className="border-b border-border align-top last:border-0">
                  <td className="px-2 py-2 text-text-subtle tabular-nums">{i + 1}</td>
                  <td className="px-2 py-2">
                    {canManage ? (
                      <>
                        <select
                          aria-label={`Catalogue item for line ${i + 1}`}
                          value={line.catalogue_item_id ?? ''}
                          onChange={(e) => pick(i, (catalogue.data ?? [])
                            .find((c) => c.id === e.target.value))}
                          className="mb-1 h-7 w-full rounded-md border border-border bg-canvas px-1 text-2xs text-text"
                        >
                          <option value="">From the catalogue…</option>
                          {(catalogue.data ?? []).map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name} ({c.code})
                            </option>
                          ))}
                        </select>
                        <Input
                          value={line.description}
                          onChange={(e) => set(i, { description: e.target.value })}
                          placeholder="What is being supplied"
                          className="h-7 text-2xs"
                        />
                      </>
                    ) : (
                      <span className="text-text">{line.description}</span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    {canManage ? (
                      <Input value={line.hsn_sac ?? ''} placeholder="—"
                        onChange={(e) => set(i, { hsn_sac: e.target.value || null })}
                        className="h-7 w-20 text-2xs" />
                    ) : <span className="text-text-muted">{line.hsn_sac ?? '—'}</span>}
                  </td>
                  <td className="px-2 py-2">
                    {canManage ? (
                      <Input value={line.uom}
                        onChange={(e) => set(i, { uom: e.target.value })}
                        className="h-7 w-16 text-2xs" />
                    ) : <span className="text-text-muted">{line.uom}</span>}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {canManage ? (
                      <Input type="number" step="0.001" min="0" value={String(line.quantity)}
                        onChange={(e) => set(i, { quantity: Number(e.target.value) })}
                        className="h-7 w-20 text-right text-2xs" />
                    ) : line.quantity}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {canManage ? (
                      <Input type="number" step="0.01" min="0" value={String(line.unit_price)}
                        onChange={(e) => set(i, { unit_price: Number(e.target.value) })}
                        className="h-7 w-28 text-right text-2xs" />
                    ) : money(line.unit_price)}
                    {below ? (
                      /* The negotiated price, against the standard one. Shown
                         rather than corrected: it is the agreed figure. */
                      <div className="text-2xs text-text-subtle">
                        list {money(line.standard_rate)}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-2 py-2">
                    {canManage ? (
                      <>
                        <select
                          aria-label={`GST rate for line ${i + 1}`}
                          value={String(line.gst_rate)}
                          onChange={(e) => set(i, { gst_rate: Number(e.target.value) })}
                          className="h-7 w-16 rounded-md border border-border bg-canvas px-1 text-2xs text-text">
                          {GST_SLABS.map((r) => <option key={r} value={r}>{r}%</option>)}
                        </select>
                        <label className="mt-1 flex items-center gap-1 text-2xs text-text-muted">
                          <input type="checkbox" checked={line.price_includes_gst}
                            onChange={(e) => set(i, { price_includes_gst: e.target.checked })} />
                          rate includes it
                        </label>
                      </>
                    ) : (
                      <span className="text-text-muted">
                        {line.gst_rate}%{line.price_includes_gst ? ' incl.' : ''}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-text-muted">{money(t.taxable)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-text-muted">{money(t.gst)}</td>
                  <td className="px-2 py-2 text-right tabular-nums font-medium text-text">{money(t.gross)}</td>
                  {canManage ? (
                    <td className="px-2 py-2">
                      <Button variant="ghost" size="icon" aria-label={`Remove line ${i + 1}`}
                        onClick={() => setLines((ls) => ls && ls.filter((_, n) => n !== i))}>
                        <Trash2 />
                      </Button>
                    </td>
                  ) : null}
                </tr>
              );
            })}
            {lines.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 11 : 10}
                  className="px-2 py-6 text-center text-xs text-text-subtle">
                  Nothing on the schedule yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {canManage ? (
        <Button variant="ghost" size="sm" className="mt-2"
          onClick={() => setLines((ls) => [...(ls ?? []), { ...EMPTY }])}>
          <Plus /> Add a line
        </Button>
      ) : null}

      <div className="mt-4 flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 text-xs">
          {/* The answer to the question the client actually asks. */}
          <p className="font-medium text-text">{saved.in_words}</p>
          {saved.treatment ? (
            <p className="mt-1 text-2xs text-text-muted">
              {saved.treatment === 'INTRA_STATE'
                ? `CGST ${money(saved.cgst)} + SGST ${money(saved.sgst)}`
                : `IGST ${money(saved.igst)}`}
            </p>
          ) : supply.data.split_blocked_by.length ? (
            <p className="mt-1 text-2xs text-text-subtle">
              {/* Named rather than guessed: a guess is a wrong tax head on a
                  real invoice. */}
              CGST/SGST or IGST cannot be decided until we know {supply.data.split_blocked_by.join(' and ')}.
            </p>
          ) : null}
        </div>
        <dl className="shrink-0 space-y-0.5 text-right text-xs tabular-nums">
          <div className="flex justify-between gap-8">
            <dt className="text-text-muted">Taxable value</dt>
            <dd className="text-text">{money(totals.taxable)}</dd>
          </div>
          <div className="flex justify-between gap-8">
            <dt className="text-text-muted">GST</dt>
            <dd className="text-text">{money(totals.gst)}</dd>
          </div>
          <div className="flex justify-between gap-8 border-t border-border pt-0.5">
            <dt className="font-semibold text-text">Total</dt>
            <dd className="font-semibold text-text">{money(totals.gross)}</dd>
          </div>
        </dl>
      </div>

      {canManage && dirty ? (
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null}
            Save schedule
          </Button>
          <Button variant="ghost" size="sm"
            onClick={() => supply.data && setLines(supply.data.lines)}>
            Discard
          </Button>
          <span className="text-2xs text-text-subtle">
            The totals above the line are live; the words update on save.
          </span>
        </div>
      ) : null}
    </section>
  );
}

/** Compare what was typed, not what was computed. */
function strip(l: SupplyLine) {
  return {
    catalogue_item_id: l.catalogue_item_id, description: l.description,
    hsn_sac: l.hsn_sac || null, uom: l.uom, quantity: Number(l.quantity),
    unit_price: Number(l.unit_price), gst_rate: Number(l.gst_rate),
    price_includes_gst: !!l.price_includes_gst,
  };
}
