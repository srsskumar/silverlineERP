import { apiRequest, apiRequestRaw } from './apiClient';
import type { ApprovalPolicyFormInput } from './validation';

export interface ApprovalPolicyLevel {
  id?: string;
  sequence: number;
  min_amount: number;
  max_amount: number | null;
  approver_role: string | null;
  approver_user_id: string | null;
  sla_hours: number | null;
  [key: string]: unknown;
}

export interface ApprovalPolicy {
  id: string;
  document_type: string;
  name: string;
  mode: 'SINGLE' | 'CUMULATIVE';
  project_id: string | null;
  tolerance_pct: number;
  active: boolean;
  version: number;
  levels: ApprovalPolicyLevel[];
  [key: string]: unknown;
}

export function buildApprovalPoliciesQuery(params: { document_type?: string } = {}): string {
  const search = new URLSearchParams();
  if (params.document_type) search.set('document_type', params.document_type);
  const qs = search.toString();
  return `/api/v1/approval-policies${qs ? `?${qs}` : ''}`;
}

export async function listApprovalPolicies(params: { document_type?: string } = {}): Promise<ApprovalPolicy[]> {
  const res = await apiRequestRaw(buildApprovalPoliciesQuery(params));
  const body = res.body as { data?: ApprovalPolicy[] };
  return Array.isArray(body.data) ? body.data : [];
}

/**
 * Create (or replace) the active policy for a document type/project.
 *
 * There is no separate "edit" route: the API supersedes whichever policy was
 * active for the same (document_type, project_id) pair, which is how this
 * screen's "Edit" action works too — it opens the create form pre-filled.
 */
export async function createApprovalPolicy(input: ApprovalPolicyFormInput): Promise<ApprovalPolicy> {
  const body = {
    document_type: input.document_type,
    name: input.name,
    mode: input.mode,
    project_id: input.project_id ?? null,
    tolerance_pct: input.tolerance_pct,
    active: input.active,
    levels: input.levels.map((l) => ({
      sequence: l.sequence,
      min_amount: l.min_amount,
      max_amount: l.max_amount,
      approver_role: l.approver_role ?? null,
      approver_user_id: l.approver_user_id ?? null,
      sla_hours: l.sla_hours ?? null,
    })),
  };
  const { data } = await apiRequest<ApprovalPolicy>('/api/v1/approval-policies', { method: 'POST', body });
  return data;
}

export async function deactivateApprovalPolicy(id: string, version: number): Promise<ApprovalPolicy> {
  const { data } = await apiRequest<ApprovalPolicy>(`/api/v1/approval-policies/${id}/deactivate`, {
    method: 'POST',
    headers: { 'If-Match': String(version) },
  });
  return data;
}
