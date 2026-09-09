'use client';

import * as React from 'react';
import {CommandPalette} from './CommandPalette';
import Link from '@/components/AppLink';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from './AuthProvider';
import { hasPermission } from '@/lib/permissions';
import { PERMISSIONS } from '@/lib/permissions';
import { hasUnreadDot, listInbox } from '@/lib/notifications';
import { queryKeys } from '@/lib/query-keys';
import { Button } from './ui/Button';
import { Spinner } from './ui/Spinner';

interface NavItem {
  href: string;
  label: string;
  permission?: string;
}

interface NavGroup {
  title?: string;
  items: NavItem[];
}

// S6 shell: dashboard + employees/org masters + attendance/geo + leave + projects/tasks + work/reports. Each item is permission-gated;
// groups render only when at least one child is visible.
const NAV_GROUPS: NavGroup[] = [
  {title:'Operations',items:[{href:'/inventory',label:'Inventory & vendors',permission:'inventory.read'},{href:'/assets',label:'Assets',permission:'asset.read'},{href:'/planning',label:'Planning',permission:'cycle.read'},{href:'/analytics',label:'Analytics & insights',permission:'analytics.read'},{href:'/automation',label:'Automation',permission:'automation.read'},{href:'/admin',label:'Administration',permission:'users.read'},{href:'/security',label:'Security'}]},
  {
    items: [{ href: '/dashboard', label: 'Dashboard' }],
  },
  {
    title: 'Employees',
    items: [
      { href: '/employees', label: 'Directory', permission: PERMISSIONS.EMPLOYEE_READ },
      { href: '/employees/import', label: 'Import', permission: PERMISSIONS.EMPLOYEE_IMPORT },
      { href: '/org/locations', label: 'Locations', permission: PERMISSIONS.ORG_UNITS_READ },
      { href: '/org/holidays', label: 'Holidays', permission: PERMISSIONS.HOLIDAY_READ },
    ],
  },
  {
    title: 'Attendance',
    items: [
      { href: '/attendance', label: 'Records', permission: PERMISSIONS.ATTENDANCE_READ },
      { href: '/attendance/exceptions', label: 'Exceptions', permission: PERMISSIONS.ATTENDANCE_READ },
      { href: '/geo-fences', label: 'Geo-fences', permission: PERMISSIONS.GEO_READ },
    ],
  },
  {
    title: 'Leave',
    items: [
      { href: '/leave', label: 'Requests', permission: PERMISSIONS.LEAVE_REQUEST },
      { href: '/leave/new', label: 'New Request', permission: PERMISSIONS.LEAVE_REQUEST },
      { href: '/leave/balances', label: 'Balances', permission: PERMISSIONS.LEAVE_REQUEST },
    ],
  },
  {
    title: 'Payroll',
    items: [
      { href: '/payroll', label: 'Runs', permission: PERMISSIONS.PAYROLL_READ },
      { href: '/payroll/new', label: 'New Run', permission: PERMISSIONS.PAYROLL_GENERATE },
      { href: '/my-payslip', label: 'My Payslip', permission: PERMISSIONS.PAYSLIP_READ },
    ],
  },
  {
    title: 'Projects',
    items: [
      { href: '/projects', label: 'All Projects', permission: PERMISSIONS.PROJECT_READ },
      { href: '/projects/new', label: 'New Project', permission: PERMISSIONS.PROJECT_CREATE },
    ],
  },
  {
    title: 'Work',
    // Auth-only (no permission): My Work lists the session's own tasks and
    // the inbox is per-user. Reports needs report.generate (per-type gates
    // live inside ReportForm). The shell renders these once a session exists.
    items: [
      { href: '/my-work', label: 'My Work' },
      { href: '/inbox', label: 'Inbox' },
      { href: '/reports', label: 'Reports', permission: PERMISSIONS.REPORT_GENERATE },
    ],
  },
];

/** Unread "•" dot for the Inbox nav item (probe limit=1&unread=true, 60s poll). */
function InboxDot() {
  const { session, status } = useAuth();
  const dotQuery = useQuery({
    queryKey: queryKeys.notifications.unreadDot(),
    queryFn: () => listInbox({ unread: true, limit: 1 }),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
    enabled: status === 'authenticated' && !!session,
  });
  const show = dotQuery.data ? hasUnreadDot(dotQuery.data) : false;
  if (!show) return null;
  return (
    <span aria-label="unread notifications" title="Unread notifications" className="ml-1 font-bold text-sky-300">
      •
    </span>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { session, status, logout } = useAuth();
  const pathname = usePathname();
  const [navOpen,setNavOpen]=React.useState(false);
  const router = useRouter();

  React.useEffect(() => {
    if (status === 'unauthenticated') router.replace('/login');
    if(session?.user.mfa_enrollment_required&&pathname!=='/security')router.replace('/security');
  }, [status, router, session, pathname]);

  const visibleGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) =>
        !item.permission || (session && hasPermission({ permissions: session.permissions }, item.permission)),
    ),
  })).filter((group) => group.items.length > 0);
  // Show nav even before permission-gated filtering resolves so the shell
  // renders deterministically during static prerender.
  const groups = session ? visibleGroups : NAV_GROUPS;

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (status === 'unauthenticated') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-slate-100">
      <aside className={`${navOpen ? 'flex fixed inset-y-0 left-0 z-40 overflow-y-auto shadow-xl' : 'hidden'} w-60 shrink-0 flex-col bg-slate-900 text-slate-100 md:flex`}>
        <button className="p-3 text-right md:hidden" onClick={()=>setNavOpen(false)} aria-label="Close navigation">Close ×</button>
        <div className="px-5 py-4 text-lg font-bold">Silverline ERP</div>
        <nav className="flex flex-1 flex-col gap-4 px-3">
          {groups.map((group, gi) => (
            <div key={group.title ?? `group-${gi}`} className="flex flex-col gap-1">
              {group.title && (
                <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  {group.title}
                </p>
              )}
              {group.items.map((item) => {
                const active = pathname === item.href || pathname?.startsWith(item.href + '/');
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`rounded-md px-3 py-2 text-sm font-medium ${
                      active ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    {item.label}
                    {item.href === '/inbox' ? <InboxDot /> : null}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="px-5 py-4 text-xs text-slate-400">Silverline ERP · v2</div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 py-3 md:px-6">
          <button className="text-sm font-semibold text-slate-900 md:hidden" aria-expanded={navOpen} aria-label="Open navigation" onClick={()=>setNavOpen(true)}>☰ Silverline ERP</button>
          <span className="hidden text-sm text-slate-500 md:block">
            <CommandPalette/>
          </span>
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-600 md:hidden">
              {session ? String(session.user.username) : ''}
            </span>
            <Button variant="secondary" onClick={logout}>
              Sign out
            </Button>
          </div>
        </header>
        <main className="min-w-0 flex-1 px-4 py-6 md:px-6">{children}</main>
      </div>
    </div>
  );
}
