/**
 * Navigation configuration for the application shell.
 *
 * Kept as data in its own module rather than inside AppShell so the
 * permission gating can be asserted without mounting the React tree — the
 * question "can this role see this destination?" is a business rule, not a
 * rendering detail.
 */

import {
  Activity, BarChart3, Boxes, Building2, CalendarDays, ClipboardList, Clock,
  FileSpreadsheet, FolderKanban, Inbox, LayoutDashboard,
  Package, PlaneTakeoff, Settings, Shield, Users, Wallet, Workflow,
  Briefcase, Contact, Gavel, Receipt, ShoppingCart, CheckSquare, IndianRupee, Download,
  ArrowDownToLine,
  ArrowUpFromLine,
  FileCheck,
  Compass, ScrollText, ArrowLeftRight, Banknote, Landmark, CalendarClock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PERMISSIONS } from './permissions';

export interface NavItem {
  href: string;
  label: string;
  /** The permission that names this destination. */
  permission?: string;
  /**
   * Everything the page actually needs to render, where that is more than the
   * one permission it is named after.
   *
   * The dashboard is the case this exists for: it is gated on `dashboard.read`
   * but reads projects and boards, so an HR or payroll officer held the naming
   * permission, was shown the link, and got a page that could not load. A
   * destination has to declare what it needs, not what it is called.
   */
  requires?: string[];
  /**
   * Other permissions that, on their own, make the destination worth
   * opening.
   *
   * The attendance page is the case: it is named after `attendance.read`,
   * the register a supervisor reads, but it is also where a person marks
   * their own day, which needs only `attendance.punch`. Gated on the read
   * grant alone, the one role the punch clock was built for -- EMPLOYEE --
   * never saw the page it was on.
   */
  anyOf?: string[];
  icon: LucideIcon;
}

export interface NavGroup {
  title?: string;
  items: NavItem[];
}

// S6 shell: dashboard + employees/org masters + attendance + leave + projects/tasks + work/reports. Each item is permission-gated;
// groups render only when at least one child is visible.
export const NAV_GROUPS: NavGroup[] = [
  {
    // Gated like every other destination. A role without dashboard.read is
    // sent to the first place it can actually open (lib/landing.ts) instead of
    // to a page that answers every request with a refusal.
    items: [{
      href: '/dashboard', label: 'Dashboard',
      permission: PERMISSIONS.DASHBOARD_READ,
      // The board reads projects and boards. Without both, the page has
      // nothing to show, so the link is not offered.
      requires: [PERMISSIONS.PROJECT_READ, PERMISSIONS.BOARD_READ],
      icon: LayoutDashboard,
    }],
  },
  {
    title: 'Work',
    // Auth-only (no permission): My Work lists the session's own tasks and
    // the inbox is per-user. Reports needs report.generate (per-type gates
    // live inside ReportForm). The shell renders these once a session exists.
    items: [
      { href: '/my-work', label: 'My work', permission: PERMISSIONS.TASK_READ, icon: ClipboardList },
      { href: '/inbox', label: 'Inbox', permission: 'notification.read', icon: Inbox },
      { href: '/projects', label: 'Projects', permission: PERMISSIONS.PROJECT_READ, icon: FolderKanban },
      // Every view starts from the project picker.
      { href: '/planning', label: 'Planning', permission: 'cycle.read', requires: [PERMISSIONS.PROJECT_READ], icon: CalendarDays },
      { href: '/reports', label: 'Reports', permission: PERMISSIONS.REPORT_GENERATE, icon: FileSpreadsheet },
    ],
  },
  {
    // Commercial spine (§7, §8): the pipeline that precedes a project.
    title: 'Commercial',
    items: [
      { href: '/leads', label: 'Pipeline', permission: 'lead.read', icon: Briefcase },
      { href: '/tenders', label: 'Tenders', permission: 'tender.read', icon: Gavel },
      { href: '/clients', label: 'Clients', permission: 'client.read', icon: Contact },
    ],
  },
  {
    // Finance and procurement (§13, §15, §16, §41). Grouped together because
    // they are one chain of custody over money: authority, what was bought,
    // what was spent, and what the client owes.
    title: 'Finance',
    items: [
      { href: '/approvals', label: 'Approvals', permission: 'approval.read', icon: CheckSquare },
      // The DoA ladders behind Approvals — who a document routes to, and at
      // what amount. Separate from Approvals itself: that screen decides
      // requests, this one configures who gets to decide them.
      { href: '/approvals/policies', label: 'Approval policies', permission: 'approval.configure', icon: Settings },
      { href: '/procurement', label: 'Procurement', permission: 'requisition.read', icon: ShoppingCart },
      { href: '/expenses', label: 'Expenses', permission: 'expense.read', icon: Receipt },
      // The bills hang off a project, chosen first.
      { href: '/billing', label: 'Project finance', permission: 'rabill.read', requires: [PERMISSIONS.PROJECT_READ], icon: IndianRupee },
      // The two ledgers (section 58). Separate entries rather than tabs under
      // project finance: collections and payment runs are different people's
      // jobs, and neither is scoped to one project.
      { href: '/receivables', label: 'Receivables', permission: 'ar.read', icon: ArrowDownToLine },
      { href: '/payables', label: 'Payables', permission: 'ap.read', icon: ArrowUpFromLine },
      // §45 financial control: money that actually moved, the bank's own
      // record of it, and the monthly calendar that locks both once closed.
      { href: '/payments', label: 'Payments', permission: 'payment.read', icon: Banknote },
      { href: '/bank-reconciliation', label: 'Bank reconciliation', permission: 'bank.read', icon: Landmark },
      { href: '/financial-periods', label: 'Financial periods', permission: 'period.read', icon: CalendarClock },
    ],
  },
  {
    title: 'People',
    items: [
      { href: '/employees', label: 'Directory', permission: PERMISSIONS.EMPLOYEE_READ, icon: Users },
      { href: '/attendance', label: 'Attendance', permission: PERMISSIONS.ATTENDANCE_READ, anyOf: [PERMISSIONS.ATTENDANCE_PUNCH], icon: Clock },
      { href: '/attendance/exceptions', label: 'Exceptions', permission: PERMISSIONS.ATTENDANCE_READ, icon: Activity },
      { href: '/leave', label: 'Leave', permission: PERMISSIONS.LEAVE_REQUEST, icon: PlaneTakeoff },
      { href: '/payroll', label: 'Payroll', permission: PERMISSIONS.PAYROLL_READ, icon: Wallet },
      { href: '/my-payslip', label: 'My payslip', permission: PERMISSIONS.PAYSLIP_READ, icon: Wallet },
    ],
  },
  {
    title: 'Operations',
    items: [
      { href: '/documents', label: 'Documents', permission: 'document.read', icon: FileCheck },
      // The land survey programme (§59). Under Operations because it is field
      // work, and the people who record it are the people on site.
      { href: '/survey', label: 'Land survey', permission: 'survey.read', icon: Compass },
      { href: '/inventory', label: 'Inventory', permission: 'inventory.read', icon: Package },
      { href: '/assets', label: 'Assets', permission: 'asset.read', icon: Boxes },
      // Kept apart from the audit trail on purpose: that answers "which row
      // changed", this answers "where has the equipment been", and they are
      // different questions asked by different people.
      { href: '/assets/movements', label: 'Asset movements', permission: 'asset.read', icon: ArrowLeftRight },
      // Measured per project, so the first thing it loads is the project list.
      { href: '/analytics', label: 'Analytics', permission: 'analytics.read', requires: [PERMISSIONS.PROJECT_READ], icon: BarChart3 },
      { href: '/automation', label: 'Automation', permission: 'automation.read', icon: Workflow },
    ],
  },
  {
    title: 'Organisation',
    items: [
      { href: '/org/locations', label: 'Locations', permission: PERMISSIONS.ORG_UNITS_READ, icon: Building2 },
      { href: '/org/holidays', label: 'Holidays', permission: PERMISSIONS.HOLIDAY_READ, icon: CalendarDays },
      { href: '/admin', label: 'Administration', permission: 'users.read', icon: Settings },
      { href: '/admin/import-templates', label: 'Upload & download', permission: 'users.read', icon: Download },
      // The trail was written from the beginning and readable only as an
      // export, which nobody hunting "who changed this" would think to open.
      { href: '/audit', label: 'Audit trail', permission: 'audit.read', icon: ScrollText },
      { href: '/security', label: 'Security', icon: Shield },
    ],
  },
];

/** Primary create actions surfaced in the top bar rather than buried in nav. */
export const QUICK_CREATE: NavItem[] = [
  // The form's client picker reads the client register.
  { href: '/leads/new', label: 'New lead', permission: 'lead.manage', requires: ['client.read'], icon: Briefcase },
  // Its pickers read the client register and the opportunity pipeline.
  { href: '/tenders/new', label: 'New tender', permission: 'tender.manage', requires: ['client.read', 'lead.read'], icon: Gavel },
  { href: '/projects/new', label: 'New project', permission: PERMISSIONS.PROJECT_CREATE, icon: FolderKanban },
  { href: '/expenses', label: 'New expense claim', permission: 'expense.manage', icon: Receipt },
  { href: '/leave/new', label: 'New leave request', permission: PERMISSIONS.LEAVE_REQUEST, icon: PlaneTakeoff },
  { href: '/payroll/new', label: 'New payroll run', permission: PERMISSIONS.PAYROLL_GENERATE, icon: Wallet },
  { href: '/employees/import', label: 'Import employees', permission: PERMISSIONS.EMPLOYEE_IMPORT, icon: Users },
  /*
   * The one thing a field crew does every single day, and it was two clicks
   * down inside the programme page. Everything else in this list is occasional
   * by comparison.
   */
  { href: '/survey/entry', label: "Record today's survey progress", permission: 'survey.enter', icon: Compass },
];

