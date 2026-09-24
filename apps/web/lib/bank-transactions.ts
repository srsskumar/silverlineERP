import { apiRequest, apiRequestRaw } from './apiClient';
import type { BankTransactionRowInput } from './validation';

export interface BankTransaction {
  id: string;
  bank_account: string | null;
  statement_ref: string;
  value_date: string;
  amount: number;
  narration: string | null;
  reconciliation_status: 'UNMATCHED' | 'RECONCILED' | 'PARTIALLY_MATCHED' | 'EXCEPTION';
  exception_note: string | null;
  payment_id: string | null;
  version: number;
  [key: string]: unknown;
}

export function buildBankTransactionsQuery(params: { status?: string; bank_account?: string } = {}): string {
  const search = new URLSearchParams();
  if (params.status) search.set('status', params.status);
  if (params.bank_account) search.set('bank_account', params.bank_account);
  const qs = search.toString();
  return `/api/v1/bank-transactions${qs ? `?${qs}` : ''}`;
}

export async function listBankTransactions(params: { status?: string; bank_account?: string } = {}): Promise<BankTransaction[]> {
  const res = await apiRequestRaw(buildBankTransactionsQuery(params));
  const body = res.body as { data?: BankTransaction[] };
  return Array.isArray(body.data) ? body.data : [];
}

export interface BankImportSummary {
  applied: number;
  created: number;
  skipped: number;
  exceptions: number;
  flagged: Array<{ statement_ref: string; note: string }>;
}

export async function importBankTransactions(
  transactions: BankTransactionRowInput[],
  bankAccount?: string,
): Promise<BankImportSummary> {
  const body = {
    ...(bankAccount ? { bank_account: bankAccount } : {}),
    transactions: transactions.map((t) => ({
      statement_ref: t.statement_ref,
      value_date: t.value_date,
      amount: t.amount,
      ...(t.narration ? { narration: t.narration } : {}),
      ...(t.bank_account ? { bank_account: t.bank_account } : {}),
    })),
  };
  const { data } = await apiRequest<BankImportSummary>('/api/v1/bank-transactions/import', { method: 'POST', body });
  return data;
}

export async function reconcileBankTransaction(
  id: string, version: number, paymentId: string, note?: string,
): Promise<BankTransaction> {
  const { data } = await apiRequest<BankTransaction>(`/api/v1/bank-transactions/${id}/reconcile`, {
    method: 'POST',
    headers: { 'If-Match': String(version) },
    body: { payment_id: paymentId, ...(note ? { note } : {}) },
  });
  return data;
}
