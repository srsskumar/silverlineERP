import { apiRequest } from './apiClient';
import type { ShiftFormInput } from './validation';

export interface Shift {
  id: string;
  code: string;
  name: string;
  starts_at: string;
  ends_at: string;
  break_minutes: number;
  rest_days: string[];
  daily_threshold_hours: number;
  overtime_multiplier: number;
  rest_day_multiplier: number | null;
  effective_from: string;
  effective_to: string | null;
  active: boolean;
  shift_hours: number;
  version: number;
  [key: string]: unknown;
}

export async function listShifts(): Promise<Shift[]> {
  const { data } = await apiRequest<Shift[]>('/api/v1/shifts');
  return Array.isArray(data) ? data : [];
}

export async function createShift(input: ShiftFormInput): Promise<Shift> {
  const body = {
    code: input.code,
    name: input.name,
    starts_at: input.starts_at,
    ends_at: input.ends_at,
    break_minutes: input.break_minutes,
    rest_days: input.rest_days,
    daily_threshold_hours: input.daily_threshold_hours,
    overtime_multiplier: input.overtime_multiplier,
    effective_from: input.effective_from,
    active: input.active,
    ...(input.effective_to ? { effective_to: input.effective_to } : {}),
  };
  const { data } = await apiRequest<Shift>('/api/v1/shifts', { method: 'POST', body });
  return data;
}

export async function updateShift(
  id: string, version: number,
  // effective_to is required (not optional) here on purpose: a PATCH that
  // omits a nullable field leaves it untouched (COALESCE, on the server
  // side), but an edit form's blank date box means "clear it," which needs
  // an explicit null on the wire, never a missing key. See ShiftForm.tsx.
  input: Pick<ShiftFormInput, 'name' | 'starts_at' | 'ends_at' | 'break_minutes' | 'rest_days' | 'daily_threshold_hours' | 'overtime_multiplier' | 'effective_from' | 'active'> & { effective_to: string | null },
): Promise<Shift> {
  const { data } = await apiRequest<Shift>(`/api/v1/shifts/${id}`, {
    method: 'PATCH',
    headers: { 'If-Match': String(version) },
    body: input,
  });
  return data;
}
