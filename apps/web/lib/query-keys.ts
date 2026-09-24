/**
 * TanStack Query key factory (S0). Masters default to a 10min staleTime,
 * queues/inbox to 30s — configured at the QueryClient / useQuery level.
 */

export const queryKeys = {
  session: {
    all: ['session'] as const,
    me: () => [...queryKeys.session.all, 'me'] as const,
  },
  dashboard: {
    all: ['dashboard'] as const,
    role: (role: string) => [...queryKeys.dashboard.all, 'role', role] as const,
    /** S6 alias for role dashboards (same cache family as `role`). */
    dashboardRole: (role: string) => [...queryKeys.dashboard.all, 'role', role] as const,
    /** S6 my-work summary (GET /dashboards/my-work). */
    myWork: () => [...queryKeys.dashboard.all, 'my-work'] as const,
  },
  reports: {
    all: ['reports'] as const,
    job: (id: string) => [...queryKeys.reports.all, 'job', id] as const,
  },
  employees: {
    all: ['employees'] as const,
    list: (filters?: Record<string, unknown>) =>
      [...queryKeys.employees.all, 'list', filters ?? {}] as const,
    detail: (id: string) => [...queryKeys.employees.all, 'detail', id] as const,
    me: () => [...queryKeys.employees.all, 'me'] as const,
  },
  employee: {
    all: ['employee'] as const,
    detail: (id: string) => [...queryKeys.employee.all, 'detail', id] as const,
  },
  attendance: {
    all: ['attendance'] as const,
    records: (filters?: Record<string, unknown>) =>
      [...queryKeys.attendance.all, 'records', filters ?? {}] as const,
    record: (id: string) => [...queryKeys.attendance.all, 'record', id] as const,
    map: (filters?: Record<string, unknown>) =>
      [...queryKeys.attendance.all, 'map', filters ?? {}] as const,
    // NOTE (S2 contract gap): there is no GET /attendance/exceptions list
    // endpoint, so this key only caches exception objects returned from
    // file/decide/punch-202 flows, keyed by known id. See lib/attendance.ts.
    exceptions: (filters?: Record<string, unknown>) =>
      [...queryKeys.attendance.all, 'exceptions', filters ?? {}] as const,
    exception: (id: string) => [...queryKeys.attendance.all, 'exception', id] as const,
  },
  projects: {
    all: ['projects'] as const,
    list: (filters?: Record<string, unknown>) =>
      [...queryKeys.projects.all, 'list', filters ?? {}] as const,
    detail: (id: string) => [...queryKeys.projects.all, 'detail', id] as const,
    /** Tasks scoped to a project (GET /tasks?project_id=…). */
    projectTasks: (id: string, filters?: Record<string, unknown>) =>
      [...queryKeys.projects.all, 'projectTasks', id, filters ?? {}] as const,
  },
  /** Single-project alias (same cache family as projects.detail). */
  project: {
    all: ['projects'] as const,
    detail: (id: string) => [...queryKeys.projects.all, 'detail', id] as const,
  },
  tasks: {
    all: ['tasks'] as const,
    list: (filters?: Record<string, unknown>) =>
      [...queryKeys.tasks.all, 'list', filters ?? {}] as const,
    detail: (id: string) => [...queryKeys.tasks.all, 'detail', id] as const,
  },
  /** Single-task alias (same cache family as tasks.detail). */
  task: {
    all: ['tasks'] as const,
    detail: (id: string) => [...queryKeys.tasks.all, 'detail', id] as const,
  },
  taskComments: {
    all: ['taskComments'] as const,
    list: (taskId: string) => [...queryKeys.taskComments.all, 'list', taskId] as const,
  },
  taskEvidence: {
    all: ['taskEvidence'] as const,
    list: (taskId: string) => [...queryKeys.taskEvidence.all, 'list', taskId] as const,
  },
  workspaces: {
    all: ['workspaces'] as const,
    list: (filters?: Record<string, unknown>) =>
      [...queryKeys.workspaces.all, 'list', filters ?? {}] as const,
    detail: (id: string) => [...queryKeys.workspaces.all, 'detail', id] as const,
  },
  projectTypes: {
    all: ['projectTypes'] as const,
    list: () => [...queryKeys.projectTypes.all, 'list'] as const,
  },
  notifications: {
    all: ['notifications'] as const,
    inbox: () => [...queryKeys.notifications.all, 'inbox'] as const,
    inboxList: (filters?: Record<string, unknown>) =>
      [...queryKeys.notifications.all, 'inbox', filters ?? {}] as const,
    unreadDot: () => [...queryKeys.notifications.all, 'unreadDot'] as const,
  },
  boards: {
    all: ['boards'] as const,
    list: (filters?: Record<string, unknown>) =>
      [...queryKeys.boards.all, 'list', filters ?? {}] as const,
    detail: (id: string) => [...queryKeys.boards.all, 'detail', id] as const,
  },
  /** Single-board alias (same cache family as boards.detail). */
  board: {
    all: ['boards'] as const,
    detail: (id: string) => [...queryKeys.boards.all, 'detail', id] as const,
  },
  labels: {
    all: ['labels'] as const,
    list: (filters?: Record<string, unknown>) =>
      [...queryKeys.labels.all, 'list', filters ?? {}] as const,
  },
  savedFilters: {
    all: ['savedFilters'] as const,
    list: (filters?: Record<string, unknown>) =>
      [...queryKeys.savedFilters.all, 'list', filters ?? {}] as const,
  },
  audit: {
    all: ['audit'] as const,
    list: (filters?: Record<string, unknown>) =>
      [...queryKeys.audit.all, 'list', filters ?? {}] as const,
  },
  orgUnits: {
    all: ['orgUnits'] as const,
    list: (filters?: Record<string, unknown>) =>
      [...queryKeys.orgUnits.all, 'list', filters ?? {}] as const,
    detail: (id: string) => [...queryKeys.orgUnits.all, 'detail', id] as const,
  },
  holidays: {
    all: ['holidays'] as const,
    list: (filters?: Record<string, unknown>) =>
      [...queryKeys.holidays.all, 'list', filters ?? {}] as const,
  },
  documents: {
    all: ['documents'] as const,
    list: (employeeId: string) => [...queryKeys.documents.all, 'list', employeeId] as const,
  },
  leave: {
    all: ['leave'] as const,
    types: () => [...queryKeys.leave.all, 'types'] as const,
    balances: (filters?: Record<string, unknown>) =>
      [...queryKeys.leave.all, 'balances', filters ?? {}] as const,
    requests: (filters?: Record<string, unknown>) =>
      [...queryKeys.leave.all, 'requests', filters ?? {}] as const,
    request: (id: string) => [...queryKeys.leave.all, 'request', id] as const,
    openYearPreview: (year: number) =>
      [...queryKeys.leave.all, 'open-year-preview', year] as const,
  },
  /**
   * P1 payroll (frozen contract). Lists/reports keep the default staleTime —
   * the 60s dashboard cadence does not apply here.
   */
  payroll: {
    all: ['payroll'] as const,
    /** GET/PATCH /payroll/policy. */
    policy: () => [...queryKeys.payroll.all, 'policy'] as const,
    /** GET /payroll/runs?status=. */
    runs: (filters?: Record<string, unknown>) =>
      [...queryKeys.payroll.all, 'runs', filters ?? {}] as const,
    /** GET /payroll/runs/:id (run + totals + warnings). */
    run: (id: string) => [...queryKeys.payroll.all, 'run', id] as const,
    /** GET /payroll/runs/:id/payslips (summary rows). */
    payslips: (runId: string) => [...queryKeys.payroll.all, 'payslips', runId] as const,
    /** GET /payroll/payslips/me?period_start=&period_end=. */
    myPayslip: (filters?: Record<string, unknown>) =>
      [...queryKeys.payroll.all, 'myPayslip', filters ?? {}] as const,
  },
} as const;
