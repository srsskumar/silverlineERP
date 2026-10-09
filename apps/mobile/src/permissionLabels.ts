/**
 * Plain-English labels for permission codes, for "you don't have access"
 * empty states. A permission code like `employee.read` means something to
 * whoever wrote the RBAC seed, not to the person it just blocked.
 *
 * Only the codes mobile's own screens actually gate on are mapped here —
 * unlike web's lib/permissionLabels.ts, which composes a label for any of
 * the backend's 60+ codes (web's RequirePermission can gate any page).
 * Wording for codes both platforms share (employee.read, document.read,
 * approval.read, project.read) is kept identical to web's, so a user who
 * uses both doesn't read two different explanations for the same refusal.
 */
const LABELS: Record<string, string> = {
  'employee.read': 'view employee records',
  'document.read': 'view documents',
  'approval.read': 'view approvals',
  'analytics.read': 'view analytics',
  'project.read': 'view projects',
  'asset.read': 'view assets',
  'attendance.read': 'view attendance',
  'attendance.decide': 'decide attendance exceptions',
  'attendance.punch': 'record attendance punches',
  'automation.read': 'view automation rules',
  'client.read': 'view clients',
  'expense.read': 'view expense claims',
  'inventory.read': 'view inventory',
  'holiday.read': 'view the holiday calendar',
  'ap.read': 'view payables',
  'payroll.read': 'view payroll',
  'lead.read': 'view leads',
  'cycle.read': 'view cycles',
  'requisition.read': 'view requisitions',
  'po.read': 'view purchase orders',
  'rabill.read': 'view RA bills',
  'ar.read': 'view receivables',
  'tender.read': 'view tenders',
  'leave.decide': 'decide leave requests',
  'leave.admin': 'administer leave',
};

export function permissionLabel(code: string): string {
  return LABELS[code] ?? 'view this screen';
}
