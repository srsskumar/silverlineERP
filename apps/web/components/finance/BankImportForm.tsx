'use client';

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { parseCsv } from '@/lib/csv';
import { importBankTransactions, type BankImportSummary } from '@/lib/bank-transactions';
import { bankTransactionRowSchema, type BankTransactionRowInput } from '@/lib/validation';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Table, TableWrap, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { Notice, Section } from '@/components/finance/Primitives';

/** Matches POST /api/v1/bank-transactions/import's own `transactions` cap
 *  (bankImportSchema in packages/shared/src/financial-control.ts) — sending
 *  more than this 422s the whole batch, so it is refused client-side first,
 *  before anyone waits on a round trip to be told the same thing. */
const MAX_ROWS = 1000;

/** Matches the API's general body-size limit (apps/api/src/createApp.ts's
 *  `bodyLimit`) — a statement past this would be refused at the transport
 *  layer, with no field-level message to show. */
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

interface PreviewRow {
  rowNumber: number;
  raw: { statement_ref: string; value_date: string; amount: string; narration: string; bank_account: string };
  parsed: BankTransactionRowInput | null;
  error: string | null;
}

/** The date column exactly as typed or pasted, not reformatted — this is a
 *  preview of what the row says, not a value read back from the API, so it
 *  is not what day()/dayTime() are for. */
function typedValueDate(row: PreviewRow): string {
  return row.raw.value_date || '—';
}

/**
 * Bank statement CSV import (§45.4).
 *
 * Header row: statement_ref, value_date, amount, narration (optional),
 * bank_account (optional) — the same field names bank-transactions.ts sends
 * on to POST /api/v1/bank-transactions/import. Reuses lib/csv.ts's generic
 * `parseCsv`, the same RFC-4180-ish parser the employee import already uses,
 * rather than writing a second one.
 *
 * Fix round 1 item 2: this used to import silently past bad rows (dropped
 * from the batch while the button stayed enabled, with only a count in the
 * preview) and had no cap of its own, relying entirely on the API's 422 to
 * catch an oversized batch after the round trip. Every parsed row is shown,
 * good or bad; Import is blocked outright while any row has an error --
 * the stricter of the two options the review asked to pick between, since a
 * bank statement is not a place to guess which rows were meant to be
 * silently skipped.
 */
export function BankImportForm({ onImported }: { onImported?: (summary: BankImportSummary) => void }) {
  const [text, setText] = React.useState('');
  const [bankAccount, setBankAccount] = React.useState('');

  const oversizedBytes = new TextEncoder().encode(text).length > MAX_TEXT_BYTES;

  const parsed = React.useMemo(() => {
    if (!text.trim() || oversizedBytes) return { preview: [] as PreviewRow[], headerError: null as string | null };
    const table = parseCsv(text).filter((r) => !(r.length === 1 && r[0].trim() === ''));
    if (table.length < 2) {
      return { preview: [], headerError: 'Add a header row plus at least one transaction' };
    }
    const headers = table[0].map((h) => h.trim().toLowerCase());
    const preview: PreviewRow[] = table.slice(1).map((cells, i) => {
      const raw: Record<string, string> = {};
      headers.forEach((h, col) => { raw[h] = (cells[col] ?? '').trim(); });
      const candidate = {
        statement_ref: raw.statement_ref ?? '',
        value_date: raw.value_date ?? '',
        amount: raw.amount ?? '',
        narration: raw.narration ?? '',
        bank_account: raw.bank_account ?? '',
      };
      const check = bankTransactionRowSchema.safeParse(candidate);
      return {
        rowNumber: i + 2,
        raw: candidate,
        parsed: check.success ? check.data : null,
        error: check.success ? null : check.error.issues.map((e) => e.message).join('; '),
      };
    });
    return { preview, headerError: null };
  }, [text, oversizedBytes]);

  const { preview, headerError } = parsed;
  const errorRows = preview.filter((r) => r.error);
  const tooManyRows = preview.length > MAX_ROWS;
  // Blocked, not "import N and skip M": a bank statement is reconciled
  // against real money, and a row silently left out is a row nobody
  // decided to leave out.
  const canImport = preview.length > 0 && errorRows.length === 0 && !tooManyRows && !oversizedBytes && !headerError;

  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const [summary, setSummary] = React.useState<BankImportSummary | null>(null);

  const importMut = useMutation({
    mutationFn: () => importBankTransactions(preview.map((r) => r.parsed!), bankAccount || undefined),
    onSuccess: (result) => {
      setSummary(result);
      setSubmitError(null);
      onImported?.(result);
    },
    onError: setSubmitError,
  });

  return (
    <Section title="Import a statement">
      <div className="space-y-3">
        <label className="block text-xs text-text-muted">
          Bank account (optional — applies to rows without their own)
          <input className="mt-1 w-64" maxLength={50} value={bankAccount} onChange={(e) => setBankAccount(e.target.value)} />
        </label>
        <label className="block text-xs text-text-muted">
          CSV — header row: statement_ref, value_date, amount, narration, bank_account
          <textarea
            rows={6}
            className="mt-1 w-full font-mono text-xs"
            placeholder={'statement_ref,value_date,amount,narration\nTXN001,2026-09-20,50000,NEFT credit'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>

        {oversizedBytes ? (
          <Notice tone="danger" title="This file is too large">
            A statement over {Math.round(MAX_TEXT_BYTES / (1024 * 1024))}MB cannot be imported in one go. Split it
            into smaller files.
          </Notice>
        ) : null}

        {headerError ? <Notice tone="warning" title="Could not read this as a statement">{headerError}</Notice> : null}

        {tooManyRows ? (
          <Notice tone="danger" title="Too many transactions">
            This statement has {preview.length} transactions; only {MAX_ROWS} can be imported at once. Split it into
            smaller files.
          </Notice>
        ) : null}

        {preview.length > 0 && !tooManyRows ? (
          <>
            {errorRows.length > 0 ? (
              <Notice tone="danger" title={`${errorRows.length} row${errorRows.length === 1 ? '' : 's'} cannot be imported`}>
                Fix every row below before importing — nothing is imported while any row is wrong, so a bad row never
                gets silently left out of the reconciliation.
              </Notice>
            ) : (
              <p className="text-xs text-text-muted">
                {preview.length} transaction{preview.length === 1 ? '' : 's'} ready to import.
              </p>
            )}

            <TableWrap>
              <Table>
                <THead>
                  <TR>
                    <TH>Row</TH>
                    <TH>Reference</TH>
                    <TH>Value date</TH>
                    <TH className="text-right">Amount</TH>
                    <TH>Narration</TH>
                    <TH>Bank account</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {preview.map((r) => (
                    <TR key={r.rowNumber}>
                      <TD mono tone="muted">{r.rowNumber}</TD>
                      <TD mono>{r.raw.statement_ref || '—'}</TD>
                      <TD tone="muted">{typedValueDate(r)}</TD>
                      <TD className="text-right tabular-nums">{r.raw.amount || '—'}</TD>
                      <TD tone="muted">{r.raw.narration || '—'}</TD>
                      <TD tone="muted">{r.raw.bank_account || '—'}</TD>
                      <TD>
                        {r.error ? (
                          <span title={r.error}>
                            <Badge tone="danger" size="sm">Error</Badge>
                            <span className="ml-1.5 text-2xs text-danger">{r.error}</span>
                          </span>
                        ) : (
                          <Badge tone="success" size="sm">OK</Badge>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          </>
        ) : null}

        {submitError ? <ErrorCard title="Could not import the statement" error={submitError} /> : null}

        {summary ? (
          <Notice tone="info" title="Import complete">
            {summary.created} created, {summary.applied} updated, {summary.skipped} already reconciled (skipped),{' '}
            {summary.exceptions} flagged as exceptions.
          </Notice>
        ) : null}

        <Button
          type="button"
          disabled={!canImport}
          loading={importMut.isPending}
          onClick={() => importMut.mutate()}
        >
          Import {preview.length || ''} transaction{preview.length === 1 ? '' : 's'}
        </Button>
      </div>
    </Section>
  );
}
