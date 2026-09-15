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
  FileSpreadsheet, FolderKanban, Inbox, LayoutDashboard, MapPin,
  Package, PlaneTakeoff, Settings, Shield, Users, Wallet, Workflow,
  Briefcase, Contact, Gavel, Receipt, ShoppingCart, CheckSquare, IndianRupee, Download,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PERMISSIONS } from './permissions';

export interface NavItem {
  href: string;
  label: string;
  permission?: string;
  icon: LucideIcon;
}

export interface NavGroup {
  title?: string;
  items: NavItem[];
}

// S6 shell: dashboard + employees/org masters + attendance/geo + leave + projects/tasks + work/reports. Each item is permission-gated;
// groups render only when at least one child is visible.
export const NAV_GROUPS: NavGroup[] = [
  {
    items: [{ href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard }],
  },
  {
    title: 'Work',
    // Auth-only (no permission): My Work lists the session's own tasks and
    // the inbox is per-user. Reports needs report.generate (per-type gates
    // live inside ReportForm). The shell renders these once a session exists.
    items: [
      { href: '/my-work', label: 'My work', icon: ClipboardList },
      { href: '/inbox', label: 'Inbox', icon: Inbox },
      { href: '/projects', label: 'Projects', permission: PERMISSIONS.PROJECT_READ, icon: FolderKanban },
      { href: '/planning', label: 'Planning', permission: 'cycle.read', icon: CalendarDays },
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
      { href: '/procurement', label: 'Procurement', permission: 'requisition.read', icon: ShoppingCart },
      { href: '/expenses', label: 'Expenses', permission: 'expense.read', icon: Receipt },
      { href: '/billing', label: 'Project finance', permission: 'rabill.read', icon: IndianRupee },
    ],
  },
  {
    title: 'People',
    items: [
      { href: '/employees', label: 'Directory', permission: PERMISSIONS.EMPLOYEE_READ, icon: Users },
      { href: '/attendance', label: 'Attendance', permission: PERMISSIONS.ATTENDANCE_READ, icon: Clock },
      { href: '/attendance/exceptions', label: 'Exceptions', permission: PERMISSIONS.ATTENDANCE_READ, icon: Activity },
      { href: '/leave', label: 'Leave', permission: PERMISSIONS.LEAVE_REQUEST, icon: PlaneTakeoff },
      { href: '/payroll', label: 'Payroll', permission: PERMISSIONS.PAYROLL_READ, icon: Wallet },
      { href: '/my-payslip', label: 'My payslip', permission: PERMISSIONS.PAYSLIP_READ, icon: Wallet },
    ],
  },
  {
    title: 'Operations',
    items: [
      { href: '/inventory', label: 'Inventory', permission: 'inventory.read', icon: Package },
      { href: '/assets', label: 'Assets', permission: 'asset.read', icon: Boxes },
      { href: '/geo-fences', label: 'Geo-fences', permission: PERMISSIONS.GEO_READ, icon: MapPin },
      { href: '/analytics', label: 'Analytics', permission: 'analytics.read', icon: BarChart3 },
      { href: '/automation', label: 'Automation', permission: 'automation.read', icon: Workflow },
    ],
  },
  {
    title: 'Organisation',
    items: [
      { href: '/org/locations', label: 'Locations', permission: PERMISSIONS.ORG_UNITS_READ, icon: Building2 },
      { href: '/org/holidays', label: 'Holidays', permission: PERMISSIONS.HOLIDAY_READ, icon: CalendarDays },
      { href: '/admin', label: 'Administration', permission: 'users.read', icon: Settings },
      { href: '/admin/import-templates', label: 'Upload formats', permission: 'users.read', icon: Download },
      { href: '/security', label: 'Security', icon: Shield },
    ],
  },
];

/** Primary create actions surfaced in the top bar rather than buried in nav. */
export const QUICK_CREATE: NavItem[] = [
  { href: '/leads/new', label: 'New lead', permission: 'lead.manage', icon: Briefcase },
  { href: '/tenders/new', label: 'New tender', permission: 'tender.manage', icon: Gavel },
  { href: '/projects/new', label: 'New project', permission: PERMISSIONS.PROJECT_CREATE, icon: FolderKanban },
  { href: '/expenses', label: 'New expense claim', permission: 'expense.manage', icon: Receipt },
  { href: '/leave/new', label: 'New leave request', permission: PERMISSIONS.LEAVE_REQUEST, icon: PlaneTakeoff },
  { href: '/payroll/new', label: 'New payroll run', permission: PERMISSIONS.PAYROLL_GENERATE, icon: Wallet },
  { href: '/employees/import', label: 'Import employees', permission: PERMISSIONS.EMPLOYEE_IMPORT, icon: Users },
];

