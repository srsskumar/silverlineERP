'use client';

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { parseCsv } from '@/lib/csv';
import { importBankTransactions, type BankImportSummary } from '@/lib/bank-transactions';
import { bankTransactionRowSchema, type BankTransactionRowInput } from '@/lib/validation';
import { Button } from '@/components/ui/Button';
import { ErrorCard } from '@/components/ui/ErrorCard';
import { Notice, Section } from '@/components/finance/Primitives';

/**
 * Bank statement CSV import (§45.4).
 *
 * Header row: statement_ref, value_date, amount, narration (optional),
 * bank_account (optional) — the same field names bank-transactions.ts sends
 * on to POST /api/v1/bank-transactions/import. Reuses lib/csv.ts's generic
 * `parseCsv`, the same RFC-4180-ish parser the employee import already uses,
 * rather than writing a second one.
 */
export function BankImportForm({ onImported }: { onImported?: (summary: BankImportSummary) => void }) {
  const [text, setText] = React.useState('');
  const [bankAccount, setBankAccount] = React.useState('');
  const [rowErrors, setRowErrors] = React.useState<string[]>([]);
  const [rows, setRows] = React.useState<BankTransactionRowInput[]>([]);

  const parsed = React.useMemo(() => {
    if (!text.trim()) return { rows: [] as BankTransactionRowInput[], errors: [] as string[] };
    const table = parseCsv(text).filter((r) => !(r.length === 1 && r[0].trim() === ''));
    if (table.length < 2) return { rows: [], errors: ['Add a header row plus at least one transaction'] };
    const headers = table[0].map((h) => h.trim().toLowerCase());
    const errors: string[] = [];
    const out: BankTransactionRowInput[] = [];
    table.slice(1).forEach((cells, i) => {
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
      if (!check.success) {
        errors.push(`Row ${i + 2}: ${check.error.issues.map((e) => e.message).join('; ')}`);
      } else {
        out.push(check.data);
      }
    });
    return { rows: out, errors };
  }, [text]);

  React.useEffect(() => { setRows(parsed.rows); setRowErrors(parsed.errors); }, [parsed]);

  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const [summary, setSummary] = React.useState<BankImportSummary | null>(null);

  const importMut = useMutation({
    mutationFn: () => importBankTransactions(rows, bankAccount || undefined),
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

        {rowErrors.length > 0 ? (
          <Notice tone="warning" title={`${rowErrors.length} row${rowErrors.length === 1 ? '' : 's'} could not be read`}>
            {rowErrors.slice(0, 10).map((e, i) => <p key={i}>{e}</p>)}
          </Notice>
        ) : null}

        {rows.length > 0 ? (
          <p className="text-xs text-text-muted">{rows.length} transaction{rows.length === 1 ? '' : 's'} ready to import.</p>
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
          disabled={rows.length === 0}
          loading={importMut.isPending}
          onClick={() => importMut.mutate()}
        >
          Import {rows.length || ''} transaction{rows.length === 1 ? '' : 's'}
        </Button>
      </div>
    </Section>
  );
}
