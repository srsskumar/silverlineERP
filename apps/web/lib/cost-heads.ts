import { apiRequest, apiRequestRaw } from './apiClient';
import type { CostHeadFormInput, BudgetFormInput } from './validation';

export interface CostHead {
  id: string;
  code: string;
  name: string;
  kind: string;
  description: string | null;
  active: boolean;
  version: number;
  [key: string]: unknown;
}

export async function listCostHeads(params: { kind?: string; active?: boolean } = {}): Promise<CostHead[]> {
  const search = new URLSearchParams();
  if (params.kind) search.set('kind', params.kind);
  if (params.active !== undefined) search.set('active', String(params.active));
  const qs = search.toString();
  const res = await apiRequestRaw(`/api/v1/cost-heads${qs ? `?${qs}` : ''}`);
  const body = res.body as { data?: CostHead[] };
  return Array.isArray(body.data) ? body.data : [];
}

export async function createCostHead(input: CostHeadFormInput): Promise<CostHead> {
  const body = {
    code: input.code,
    name: input.name,
    kind: input.kind,
    active: input.active,
    ...(input.description ? { description: input.description } : {}),
  };
  const { data } = await apiRequest<CostHead>('/api/v1/cost-heads', { method: 'POST', body });
  return data;
}

export async function updateCostHead(
  id: string, version: number,
  input: Partial<Pick<CostHeadFormInput, 'name' | 'kind' | 'description' | 'active'>>,
): Promise<CostHead> {
  const { data } = await apiRequest<CostHead>(`/api/v1/cost-heads/${id}`, {
    method: 'PATCH',
    headers: { 'If-Match': String(version) },
    body: input,
  });
  return data;
}

export interface ProjectBudgetResult {
  id: string;
  revision: number;
  lines: Array<Record<string, unknown>>;
}

export async function getProjectBudget(projectId: string): Promise<Record<string, unknown>[]> {
  const { data } = await apiRequest<Record<string, unknown>[]>(`/api/v1/projects/${projectId}/budget`);
  return Array.isArray(data) ? data : [];
}

/** Replaces the whole budget for a project in one call (§15.6 revision). */
export async function setProjectBudget(projectId: string, input: BudgetFormInput): Promise<ProjectBudgetResult> {
  const body = {
    ...(input.revision_reason ? { revision_reason: input.revision_reason } : {}),
    lines: input.lines.map((l) => ({
      cost_head_id: l.cost_head_id,
      budgeted_amount: l.budgeted_amount,
      ...(l.notes ? { notes: l.notes } : {}),
    })),
  };
  const { data } = await apiRequest<ProjectBudgetResult>(`/api/v1/projects/${projectId}/budget`, {
    method: 'PUT', body,
  });
  return data;
}
