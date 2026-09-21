/**
 * §077 -- the supply schedule.
 *
 * The arithmetic is unit-tested in shared and again on the server. What is
 * asserted here is what the screen does with it: that it stays silent on a
 * measured contract, that the catalogue seeds a line and then lets go of
 * it, that both GST directions are offered, and that it refuses to name a
 * tax head it cannot know.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

interface Line { [k: string]: unknown }
const getProjectSupply = vi.fn(async (_id: string) => ({}) as unknown);
const putProjectSupply = vi.fn(async (_id: string, _lines: Line[]) => ({
  totals: { in_words: 'Rupees Ten Thousand Only' },
}));
const listCatalogueItems = vi.fn(async () => [] as unknown[]);
vi.mock('@/lib/projects', () => ({
  getProjectSupply: (id: string) => getProjectSupply(id),
  putProjectSupply: (id: string, lines: Line[]) => putProjectSupply(id, lines),
  listCatalogueItems: () => listCatalogueItems(),
}));

const { SupplySchedule } = await import('@/components/projects/SupplySchedule');

const ITEM = {
  id: 'c1', code: 'RVR', name: 'GNSS rover', kind: 'GOOD', uom: 'nos',
  hsn_sac: '90158030', standard_rate: 250000, gst_rate: 18, notes: null,
  status: 'ACTIVE', version: 1,
};

const BASE = {
  project: { id: 'p1', code: 'PRJ-1', name: 'Rovers for the department',
             type_code: 'goods', client_name: 'AP Survey Department' },
  applies: true,
  lines: [{
    id: 'l1', line_no: 1, catalogue_item_id: 'c1', catalogue_code: 'RVR',
    standard_rate: 250000, description: 'GNSS rover', hsn_sac: '90158030',
    uom: 'nos', quantity: 10, unit_price: 225000, gst_rate: 18,
    price_includes_gst: false, notes: null,
    totals: { taxable: 2250000, gst: 405000, gross: 2655000 },
  }],
  totals: {
    lines: 1, taxable: 2250000, gst: 405000, gross: 2655000,
    by_rate: [{ gst_rate: 18, taxable: 2250000, gst: 405000 }],
    cgst: 0, sgst: 0, igst: 0, treatment: null,
    in_words: 'Rupees Twenty Six Lakh Fifty Five Thousand Only',
  },
  split_blocked_by: ["the client's state"],
};

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  getProjectSupply.mockReset().mockResolvedValue(structuredClone(BASE));
  listCatalogueItems.mockReset().mockResolvedValue([ITEM]);
  putProjectSupply.mockClear();
});

describe('when it applies', () => {
  it('shows the total in words, which is the question the client asks', async () => {
    wrap(<SupplySchedule projectId="p1" canManage />);
    expect(await screen.findByText(/Twenty Six Lakh Fifty Five Thousand/)).toBeTruthy();
  });

  it('shows the negotiated price against the standard one', async () => {
    wrap(<SupplySchedule projectId="p1" canManage />);
    await screen.findByDisplayValue('225000');
    expect(screen.getByText(/list/)).toBeTruthy();
  });

  it('says what stops it naming the tax heads rather than guessing', async () => {
    wrap(<SupplySchedule projectId="p1" canManage />);
    expect(await screen.findByText(/cannot be decided until we know the client's state/i)).toBeTruthy();
  });

  it('names the heads once it can', async () => {
    getProjectSupply.mockResolvedValue({
      ...structuredClone(BASE),
      totals: { ...BASE.totals, treatment: 'INTRA_STATE', cgst: 202500, sgst: 202500 },
      split_blocked_by: [],
    });
    wrap(<SupplySchedule projectId="p1" canManage />);
    expect(await screen.findByText(/CGST .* \+ SGST/)).toBeTruthy();
  });
});

describe('when it does not apply', () => {
  it('renders nothing at all on a measured contract', async () => {
    getProjectSupply.mockResolvedValue({
      ...structuredClone(BASE), applies: false, lines: [],
      project: { ...BASE.project, type_code: 'fieldwork' },
    });
    const { container } = wrap(<SupplySchedule projectId="p1" canManage />);
    // An empty table would read as missing data. Silence is the right answer.
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
  });
});

describe('editing', () => {
  it('recomputes as you type, without waiting for a save', async () => {
    wrap(<SupplySchedule projectId="p1" canManage />);
    const qty = await screen.findByDisplayValue('10');
    fireEvent.change(qty, { target: { value: '20' } });
    // 20 x 225000 = 4,500,000 taxable.
    await waitFor(() => expect(screen.getAllByText(/45,00,000|4,500,000/).length).toBeGreaterThan(0));
  });

  it('seeds a line from the catalogue and then lets go of the price', async () => {
    getProjectSupply.mockResolvedValue({ ...structuredClone(BASE), lines: [] });
    wrap(<SupplySchedule projectId="p1" canManage />);
    await screen.findByText(/Nothing on the schedule yet/);

    fireEvent.click(screen.getByRole('button', { name: /add a line/i }));
    fireEvent.change(screen.getByRole('combobox', { name: /catalogue item for line 1/i }),
      { target: { value: 'c1' } });

    // Seeded from the catalogue...
    await screen.findByDisplayValue('GNSS rover');
    const price = screen.getByDisplayValue('250000') as HTMLInputElement;
    // ...and still editable, because the price is negotiated.
    fireEvent.change(price, { target: { value: '225000' } });

    fireEvent.click(screen.getByRole('button', { name: /save schedule/i }));
    await waitFor(() => expect(putProjectSupply).toHaveBeenCalledTimes(1));
    expect(putProjectSupply.mock.calls[0][1][0]).toMatchObject({
      catalogue_item_id: 'c1', unit_price: 225000, description: 'GNSS rover',
    });
  });

  it('offers both directions on GST, because both are quoted in practice', async () => {
    wrap(<SupplySchedule projectId="p1" canManage />);
    const inclusive = await screen.findByLabelText(/rate includes it/i);
    expect((inclusive as HTMLInputElement).checked).toBe(false);
    fireEvent.click(inclusive);
    fireEvent.click(screen.getByRole('button', { name: /save schedule/i }));
    await waitFor(() => expect(putProjectSupply).toHaveBeenCalledTimes(1));
    expect(putProjectSupply.mock.calls[0][1][0]).toMatchObject({ price_includes_gst: true });
  });
});

describe('without permission to change it', () => {
  it('shows the schedule and no way to alter it', async () => {
    wrap(<SupplySchedule projectId="p1" canManage={false} />);
    await screen.findByText('GNSS rover');
    expect(screen.queryByRole('button', { name: /add a line/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /save schedule/i })).toBeNull();
  });
});

describe('what a screen reader gets', () => {
  it('names both dropdowns on every row', async () => {
    /*
     * They were two unlabelled comboboxes side by side, which is the same
     * to a screen reader as no controls at all. The test that found it was
     * looking for something else entirely.
     */
    wrap(<SupplySchedule projectId="p1" canManage />);
    await screen.findByDisplayValue('GNSS rover');
    expect(screen.getByRole('combobox', { name: /catalogue item for line 1/i })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: /gst rate for line 1/i })).toBeTruthy();
  });
});
