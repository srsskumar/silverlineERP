import { apiRequest } from './apiClient';
import type { FinancialPeriodFormInput } from './validation';

export interface FinancialPeriod {
  id: string;
  code: string;
  starts_on: string;
  ends_on: string;
  status: 'OPEN' | 'CLOSED';
  closed_at: string | null;
  closed_by_username?: string | null;
  reopened_at: string | null;
  reopened_by_username?: string | null;
  reopen_reason: string | null;
  version: number;
  [key: string]: unknown;
}

export async function listFinancialPeriods(): Promise<FinancialPeriod[]> {
  const { data } = await apiRequest<FinancialPeriod[]>('/api/v1/financial-periods');
  return Array.isArray(data) ? data : [];
}

export async function createFinancialPeriod(input: FinancialPeriodFormInput): Promise<FinancialPeriod> {
  const { data } = await apiRequest<FinancialPeriod>('/api/v1/financial-periods', {
    method: 'POST',
    body: { code: input.code, starts_on: input.starts_on, ends_on: input.ends_on },
  });
  return data;
}

/** Close or reopen a period. Reopening always needs a reason; closing never does. */
export async function setPeriodClosure(
  id: string, version: number, action: 'CLOSE' | 'REOPEN', reason?: string,
): Promise<FinancialPeriod> {
  const { data } = await apiRequest<FinancialPeriod>(`/api/v1/financial-periods/${id}/closure`, {
    method: 'POST',
    headers: { 'If-Match': String(version) },
    body: { action, ...(reason ? { reason } : {}) },
  });
  return data;
}
