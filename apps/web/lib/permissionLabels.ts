/**
 * Plain-English labels for permission codes, for user-facing "you don't have
 * access" messages (Forbidden.tsx). A permission code like `employee.read` is
 * meaningful to a developer reading the RBAC seed, not to the person it just
 * blocked -- this turns `employee.read` into "view employee records" instead
 * of printing the code verbatim.
 *
 * Composed from two small maps (domain noun + action verb) rather than one
 * flat list per code: permissions.ts has 60+ codes and the domain/action
 * pairs repeat constantly (every module has its own .read/.manage), so two
 * short maps cover the whole surface without duplicating "view"/"manage"
 * sixty times over. An unrecognised domain or action still produces a
 * readable (if plainer) phrase rather than nothing.
 */

const DOMAIN_LABELS: Record<string, string> = {
  auth: 'sign in',
  users: 'user accounts',
  roles: 'roles',
  audit: 'the audit log',
  admin: 'other users’ sessions',
  catalogue: 'the service catalogue',
  'org.units': 'organisation units',
  employee: 'employee records',
  document: 'documents',
  holiday: 'the holiday calendar',
  approval: 'approvals',
  payment: 'payments',
  bank: 'bank reconciliation',
  period: 'financial periods',
  costhead: 'cost heads',
  budget: 'budgets',
  roster: 'shift rosters',
  attendance: 'attendance',
  leave: 'leave requests',
  workspace: 'workspaces',
  project: 'projects',
  task: 'tasks',
  board: 'project boards',
  filter: 'saved filters',
  label: 'labels',
  dashboard: 'the dashboard',
  report: 'reports',
  payroll: 'payroll',
  payslip: 'payslips',
  match: 'three-way matches',
  'expense.policy': 'expense policies',
};

const ACTION_LABELS: Record<string, string> = {
  login: 'sign in',
  read: 'view',
  manage: 'manage',
  impersonate: 'view as another user',
  create: 'create',
  update: 'edit',
  exit: 'exit',
  reactivate: 'reactivate',
  import: 'import',
  upload: 'upload',
  delete: 'delete',
  configure: 'configure',
  delegate: 'delegate',
  allocate: 'allocate',
  reconcile: 'reconcile',
  punch: 'record a punch for',
  decide: 'decide',
  request: 'request',
  admin: 'administer',
  close: 'close',
  transition: 'change the status of',
  assign: 'assign',
  comment: 'comment on',
  reorder: 'reorder',
  generate: 'generate',
  approve: 'approve',
  lock: 'lock',
  act: 'act on',
  override: 'override',
};

/**
 * `employee.read` -> "view employee records". Falls back to a generic
 * phrase for an unmapped domain or action rather than throwing or printing
 * `undefined`, since a future permission code will reach this before the
 * maps above are updated for it.
 */
export function permissionLabel(code: string): string {
  const parts = String(code ?? '').split('.');
  if (parts.length < 2) return 'view this page';
  const action = parts.at(-1) ?? '';
  const domain = parts.slice(0, -1).join('.');
  const actionLabel = ACTION_LABELS[action] ?? action.replaceAll('_', ' ');
  const domainLabel = DOMAIN_LABELS[domain] ?? domain.replaceAll('_', ' ').replaceAll('.', ' ');
  return `${actionLabel} ${domainLabel}`;
}
