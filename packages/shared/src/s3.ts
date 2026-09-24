import { z } from "zod";
import type { RoleCode } from "./rbac.js";
import { dateStringSchema } from "./s1.js";

/**
 * S3 contracts (Silverline ERP sprint S3): leave types, balances, requests
 * with a two-step approval chain.
 * ADDITIVE module — existing exports in other files are untouched.
 */

// ---------------------------------------------------------------------------
// Permission codes + role grants
// ---------------------------------------------------------------------------

export const S3_PERMISSIONS = {
  LEAVE_REQUEST: "leave.request",
  LEAVE_READ: "leave.read",
  LEAVE_DECIDE: "leave.decide",
  LEAVE_ADMIN: "leave.admin",
  /** Umbrella code for full leave administration (granted with `leave.*`). */
  LEAVE_MANAGE: "leave.manage",
} as const;

export type S3PermissionCode =
  (typeof S3_PERMISSIONS)[keyof typeof S3_PERMISSIONS];

export const S3_ALL_PERMISSIONS: string[] = Object.values(S3_PERMISSIONS);

/**
 * Additive S3 grants per system role. The seeder unions these with the
 * S0 (`ROLE_PERMISSIONS`) + S1 (`S1_ROLE_GRANTS`) + S2 (`S2_ROLE_GRANTS`)
 * maps (left unchanged).
 */
export const S3_ROLE_GRANTS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: [...S3_ALL_PERMISSIONS],
  ADMIN: [...S3_ALL_PERMISSIONS],
  // "leave.*" — every leave code.
  HR_MANAGER: [...S3_ALL_PERMISSIONS],
  PROJECT_MANAGER: [S3_PERMISSIONS.LEAVE_READ, S3_PERMISSIONS.LEAVE_DECIDE, S3_PERMISSIONS.LEAVE_REQUEST],
  TEAM_LEAD: [S3_PERMISSIONS.LEAVE_READ, S3_PERMISSIONS.LEAVE_DECIDE, S3_PERMISSIONS.LEAVE_REQUEST],
  /*
   * Read only, and only because payroll depends on it.
   *
   * Payroll computes loss of pay straight from the leave register, so the
   * officer signs off a deduction they could not otherwise see the basis
   * for -- an approval nobody can check, and an employee disputing a short
   * salary gets "the system says so" for an answer.
   *
   * Nothing here lets payroll approve, cancel or alter leave. That stays
   * with the leave approvers.
   */
  PAYROLL_OFFICER: [S3_PERMISSIONS.LEAVE_READ],
  INVENTORY_MANAGER: [],
  EMPLOYEE: [S3_PERMISSIONS.LEAVE_REQUEST],
  CLIENT_VIEWER: [],
  AUDITOR: [S3_PERMISSIONS.LEAVE_READ],
 SALES_BD_EXECUTIVE:[], BID_TENDER_MANAGER:[], GOVT_OBSERVER:[],
};

// ---------------------------------------------------------------------------
// Leave types
// ---------------------------------------------------------------------------

/** Seeded leave-type codes (CL/SL/EL paid, LOP unpaid). */
export const LEAVE_TYPE_CODES = ["CL", "SL", "EL", "LOP"] as const;

export type LeaveTypeCode = (typeof LEAVE_TYPE_CODES)[number];

// ---------------------------------------------------------------------------
// Approval chain
// ---------------------------------------------------------------------------

export const approvalChainStepStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
]);

export type ApprovalChainStepStatus = z.infer<
  typeof approvalChainStepStatusSchema
>;

/** One step of a leave request's approval chain (stored as JSONB). */
export const approvalChainStepSchema = z.object({
  step: z.number().int().min(1),
  approver_user_id: z.string().uuid(),
  status: approvalChainStepStatusSchema,
  decided_at: z.string().nullable(),
  note: z.string().nullable(),
});

export type ApprovalChainStep = z.infer<typeof approvalChainStepSchema>;

export interface AssembleChainInput {
  /**
   * Linked login of the requesting EMPLOYEE (null when they have none, e.g.
   * field staff or on-behalf filing). Self-approval skip compares against
   * this — never against the acting user.
   */
  requesterUserId: string | null;
  /** Step-1 candidate: linked user of the requester's `reports_to` manager. */
  step1UserId: string | null;
  /** Step-2 candidate: first HR/ADMIN/SUPER_ADMIN user by created_at. */
  step2UserId: string | null;
}

/**
 * Pure approval-chain assembler (no I/O, unit-testable). Applies the frozen
 * rules: skip any step whose approver is the requester (no self-approval),
 * dedupe a repeated approver, number the surviving steps from 1.
 * Returns null when the chain is empty (caller maps to 422 NO_APPROVER).
 */
export function assembleApprovalChain(
  input: AssembleChainInput,
): ApprovalChainStep[] | null {
  const steps: ApprovalChainStep[] = [];
  const seen = new Set<string>();
  for (const candidate of [input.step1UserId, input.step2UserId]) {
    if (!candidate) {
      continue;
    }
    if (candidate === input.requesterUserId) {
      continue;
    }
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    steps.push({
      step: steps.length + 1,
      approver_user_id: candidate,
      status: "PENDING",
      decided_at: null,
      note: null,
    });
  }
  return steps.length > 0 ? steps : null;
}

// ---------------------------------------------------------------------------
// Requests / balances / decisions
// ---------------------------------------------------------------------------

export const leaveRequestStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
]);

export type LeaveRequestStatus = z.infer<typeof leaveRequestStatusSchema>;

/**
 * POST /api/v1/leave/requests. `employee_id` is an additive escape hatch:
 * when present and different from the caller's linked employee it requires
 * `leave.admin` (lets an admin file on someone's behalf); otherwise the
 * request is always filed for the caller's own linked employee.
 */
export const leaveRequestCreateSchema = z.object({
  leave_type_id: z.string().uuid("leave_type_id must be a UUID"),
  from_date: dateStringSchema,
  to_date: dateStringSchema,
  reason: z.string().max(2000).optional(),
  employee_id: z.string().uuid("employee_id must be a UUID").optional(),
});

export type LeaveRequestCreateInput = z.infer<typeof leaveRequestCreateSchema>;

/** POST /api/v1/leave/balances — upserts the opening balance. */
export const leaveBalanceUpsertSchema = z.object({
  employee_id: z.string().uuid("employee_id must be a UUID"),
  leave_type_id: z.string().uuid("leave_type_id must be a UUID"),
  period_year: z.number().int().min(2000).max(2100),
  opening_balance: z.number().nonnegative(),
});

export type LeaveBalanceUpsertInput = z.infer<typeof leaveBalanceUpsertSchema>;

/**
 * POST /api/v1/leave-balances/open-year — bulk-opens next year's balances
 * (R5-008). Owner decision (2026-09-24): carry-forward = lapse. Every
 * matching employee x balance-requiring leave type gets a fresh row at that
 * type's standard annual entitlement and nothing else -- unused balance from
 * the year before is not brought forward, it simply lapses. Idempotent:
 * created only where a row does not already exist (ON CONFLICT DO NOTHING on
 * the same natural key `leave_balances` already enforces).
 */
export const leaveOpenYearSchema = z.object({
  /**
   * Optional (fix round 1, item 5): omit it and the server resolves "next
   * year" itself, in the organisation's own timezone, rather than the
   * caller guessing it from a browser clock that might be skewed or in a
   * different zone. The resolved year is echoed back in the response.
   */
  year: z.number().int().min(2000).max(2100).optional(),
  leave_type_ids: z.array(z.string().uuid("leave_type_ids must be UUIDs")).optional(),
  employee_ids: z.array(z.string().uuid("employee_ids must be UUIDs")).optional(),
});

export type LeaveOpenYearInput = z.infer<typeof leaveOpenYearSchema>;

/** POST /api/v1/leave/requests/:id/decision */
export const leaveDecisionSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  note: z.string().max(2000).optional(),
});

export type LeaveDecisionInput = z.infer<typeof leaveDecisionSchema>;

/** POST /api/v1/leave/requests/:id/cancel */
export const leaveCancelSchema = z.object({
  reason: z.string().max(2000).optional(),
});

export type LeaveCancelInput = z.infer<typeof leaveCancelSchema>;

// ---------------------------------------------------------------------------
// Rule-violation detail payloads (returned alongside the error envelope)
// ---------------------------------------------------------------------------

/** 422 INSUFFICIENT_BALANCE detail. */
export const insufficientBalanceDetailSchema = z.object({
  available: z.number(),
});

export type InsufficientBalanceDetail = z.infer<
  typeof insufficientBalanceDetailSchema
>;

/** 422 LEAVE_OVERLAP detail. */
export const leaveOverlapDetailSchema = z.object({
  conflicting_request_ids: z.array(z.string().uuid()),
});

export type LeaveOverlapDetail = z.infer<typeof leaveOverlapDetailSchema>;

/** 422 ATTENDANCE_CONFLICT detail. */
export const attendanceConflictDetailSchema = z.object({
  conflicting_dates: z.array(
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ),
});

export type AttendanceConflictDetail = z.infer<
  typeof attendanceConflictDetailSchema
>;

/** Machine-readable S3 rule codes returned as the error `code`. */
export const S3_RULE_CODES = {
  DATE_RANGE: "DATE_RANGE",
  REASON_REQUIRED: "REASON_REQUIRED",
  INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
  LEAVE_OVERLAP: "LEAVE_OVERLAP",
  ATTENDANCE_CONFLICT: "ATTENDANCE_CONFLICT",
  NO_APPROVER: "NO_APPROVER",
  NOT_APPROVER: "NOT_APPROVER",
  REQUEST_CLOSED: "REQUEST_CLOSED",
  NOTE_REQUIRED: "NOTE_REQUIRED",
  MISSING_IDEMPOTENCY_KEY: "MISSING_IDEMPOTENCY_KEY",
} as const;

export type S3RuleCode = (typeof S3_RULE_CODES)[keyof typeof S3_RULE_CODES];
