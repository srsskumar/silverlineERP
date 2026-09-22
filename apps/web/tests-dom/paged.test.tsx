/**
 * A long list is drawn a page at a time.
 *
 * The dashboard drew every village in the programme -- twelve hundred rows,
 * thirty thousand nodes -- before the reader could see the number they came
 * for. The pager keeps the whole list for filters, selection and export and
 * draws fifty of it.
 */
import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Paged, pageOf } from '@/components/ui/Paged';

const rows = Array.from({ length: 1200 }, (_, i) => ({ id: `v${i}`, name: `Village ${i + 1}` }));

function mount(list = rows, focusIndex = -1) {
  return render(
    <Paged rows={list} noun="villages" focusIndex={focusIndex}>
      {(shown, offset) => (
        <ul>
          {shown.map((r, i) => <li key={r.id}>{offset + i + 1}. {r.name}</li>)}
        </ul>
      )}
    </Paged>,
  );
}

describe('Paged', () => {
  it('draws the first fifty and says how many there are', () => {
    mount();
    expect(screen.getAllByRole('listitem')).toHaveLength(50);
    expect(screen.getByText('1. Village 1')).toBeInTheDocument();
    expect(screen.getByText(/Showing 1–50 of 1,200 villages/)).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 24')).toBeInTheDocument();
  });

  it('moves through the pages and numbers rows from the whole list', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('51. Village 51')).toBeInTheDocument();
    expect(screen.getByText('Page 2 of 24')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Last page' }));
    expect(screen.getByText('1200. Village 1200')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'First page' }));
    expect(screen.getByText('1. Village 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  });

  it('shows no pager when the list fits on one page', () => {
    mount(rows.slice(0, 12));
    expect(screen.getAllByRole('listitem')).toHaveLength(12);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('falls back to the last page that exists when a filter shrinks the list', () => {
    const { rerender } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Last page' }));
    rerender(
      <Paged rows={rows.slice(0, 120)} noun="villages">
        {(shown, offset) => (
          <ul>{shown.map((r, i) => <li key={r.id}>{offset + i + 1}. {r.name}</li>)}</ul>
        )}
      </Paged>,
    );
    expect(screen.getByText('Page 3 of 3')).toBeInTheDocument();
    expect(screen.getByText('120. Village 120')).toBeInTheDocument();
  });

  it('opens on the page holding the row the reader was sent to', () => {
    mount(rows, 700);
    expect(screen.getByText('701. Village 701')).toBeInTheDocument();
    expect(pageOf(700)).toBe(14);
    expect(pageOf(-1)).toBe(0);
  });
});
