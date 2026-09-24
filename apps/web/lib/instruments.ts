import { apiRequest, apiRequestRaw } from './apiClient';
import type { InstrumentFormInput } from './validation';

export interface Instrument {
  id: string;
  instrument_type: string;
  issuing_bank: string;
  instrument_number: string;
  amount: number;
  issue_date: string;
  expiry_date: string;
  tender_id: string | null;
  project_id: string | null;
  instrument_status: 'ACTIVE' | 'RELEASED' | 'CLAIMED' | 'EXPIRED' | 'RENEWED';
  notes: string | null;
  version: number;
  [key: string]: unknown;
}

export async function listInstruments(params: { tender_id?: string; project_id?: string } = {}): Promise<Instrument[]> {
  const search = new URLSearchParams();
  if (params.tender_id) search.set('tender_id', params.tender_id);
  if (params.project_id) search.set('project_id', params.project_id);
  const qs = search.toString();
  const res = await apiRequestRaw(`/api/v1/instruments${qs ? `?${qs}` : ''}`);
  const body = res.body as { data?: Instrument[] };
  return Array.isArray(body.data) ? body.data : [];
}

export async function createInstrument(input: InstrumentFormInput): Promise<Instrument> {
  const body = {
    instrument_type: input.instrument_type,
    issuing_bank: input.issuing_bank,
    instrument_number: input.instrument_number,
    amount: input.amount,
    issue_date: input.issue_date,
    expiry_date: input.expiry_date,
    ...(input.tender_id ? { tender_id: input.tender_id } : {}),
    ...(input.project_id ? { project_id: input.project_id } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
  };
  const { data } = await apiRequest<Instrument>('/api/v1/instruments', { method: 'POST', body });
  return data;
}

export async function setInstrumentStatus(
  id: string, version: number, instrumentStatus: string, reason?: string,
): Promise<Instrument> {
  const { data } = await apiRequest<Instrument>(`/api/v1/instruments/${id}/status`, {
    method: 'POST',
    headers: { 'If-Match': String(version) },
    body: { instrument_status: instrumentStatus, ...(reason ? { reason } : {}) },
  });
  return data;
}
