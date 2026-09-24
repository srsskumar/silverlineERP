import { apiRequest, apiRequestRaw } from './apiClient';
import type { PaymentFormInput, PaymentAllocationFormInput } from './validation';

export interface Payment {
  id: string;
  payment_no: string;
  direction: 'RECEIVABLE' | 'PAYABLE';
  paid_on: string;
  amount: number;
  mode: string;
  reference: string | null;
  party_type: string | null;
  party_id: string | null;
  project_id: string | null;
  project_code?: string | null;
  bank_account: string | null;
  notes: string | null;
  reversed_at: string | null;
  reversal_reason: string | null;
  unallocated_amount: number;
  version: number;
  [key: string]: unknown;
}

export function buildPaymentsQuery(params: {
  direction?: string; project_id?: string; unallocated?: boolean; limit?: number; offset?: number;
} = {}): string {
  const search = new URLSearchParams();
  if (params.direction) search.set('direction', params.direction);
  if (params.project_id) search.set('project_id', params.project_id);
  if (params.unallocated) search.set('unallocated', 'true');
  search.set('limit', String(params.limit ?? 50));
  if (params.offset) search.set('offset', String(params.offset));
  return `/api/v1/payments?${search.toString()}`;
}

export async function listPayments(params: Parameters<typeof buildPaymentsQuery>[0] = {}): Promise<Payment[]> {
  const res = await apiRequestRaw(buildPaymentsQuery(params));
  const body = res.body as { data?: Payment[] };
  return Array.isArray(body.data) ? body.data : [];
}

export async function getPayment(id: string): Promise<Payment & { allocations: Record<string, unknown>[] }> {
  const { data } = await apiRequest<Payment & { allocations: Record<string, unknown>[] }>(`/api/v1/payments/${id}`);
  return data;
}

export async function createPayment(input: PaymentFormInput): Promise<Payment> {
  const body = {
    direction: input.direction,
    payment_no: input.payment_no,
    paid_on: input.paid_on,
    amount: input.amount,
    mode: input.mode,
    ...(input.reference ? { reference: input.reference } : {}),
    ...(input.party_type ? { party_type: input.party_type } : {}),
    ...(input.party_id ? { party_id: input.party_id } : {}),
    ...(input.project_id ? { project_id: input.project_id } : {}),
    ...(input.bank_account ? { bank_account: input.bank_account } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
  };
  const { data } = await apiRequest<Payment>('/api/v1/payments', { method: 'POST', body });
  return data;
}

export async function reversePayment(id: string, version: number, reason: string): Promise<Payment> {
  const { data } = await apiRequest<Payment>(`/api/v1/payments/${id}/reverse`, {
    method: 'POST',
    headers: { 'If-Match': String(version) },
    body: { reason },
  });
  return data;
}

export async function allocatePayment(paymentId: string, input: PaymentAllocationFormInput): Promise<Record<string, unknown>> {
  const body = {
    document_type: input.document_type,
    document_id: input.document_id,
    amount: input.amount,
    ...(input.tds_amount ? { tds_amount: input.tds_amount } : {}),
    ...(input.retention_amount ? { retention_amount: input.retention_amount } : {}),
    ...(input.advance_adjusted ? { advance_adjusted: input.advance_adjusted } : {}),
    ...(input.other_deduction ? { other_deduction: input.other_deduction } : {}),
    ...(input.deduction_reason ? { deduction_reason: input.deduction_reason } : {}),
  };
  const { data } = await apiRequest<Record<string, unknown>>(`/api/v1/payments/${paymentId}/allocations`, {
    method: 'POST', body,
  });
  return data;
}
