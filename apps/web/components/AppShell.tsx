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
import { ThemeToggle } from './ui/ThemeToggle';
import { TooltipProvider } from './ui/Tooltip';
import { Sheet, SheetContent, SheetTitle } from './ui/Sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/DropdownMenu';
import { cn } from '@/lib/cn';
import {
  Activity, BarChart3, Boxes, Building2, CalendarDays, ClipboardList, Clock,
  FileSpreadsheet, FolderKanban, Inbox, LayoutDashboard, LogOut, MapPin, Menu,
  Package, PlaneTakeoff, Plus, Settings, Shield, Users, Wallet, Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface NavItem {
  href: string;
  label: string;
  permission?: string;
  icon: LucideIcon;
}

interface NavGroup {
  title?: string;
  items: NavItem[];
}

// S6 shell: dashboard + employees/org masters + attendance/geo + leave + projects/tasks + work/reports. Each item is permission-gated;
// groups render only when at least one child is visible.
const NAV_GROUPS: NavGroup[] = [
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
      { href: '/security', label: 'Security', icon: Shield },
    ],
  },
];

/** Primary create actions surfaced in the top bar rather than buried in nav. */
const QUICK_CREATE: NavItem[] = [
  { href: '/projects/new', label: 'New project', permission: PERMISSIONS.PROJECT_CREATE, icon: FolderKanban },
  { href: '/leave/new', label: 'New leave request', permission: PERMISSIONS.LEAVE_REQUEST, icon: PlaneTakeoff },
  { href: '/payroll/new', label: 'New payroll run', permission: PERMISSIONS.PAYROLL_GENERATE, icon: Wallet },
  { href: '/employees/import', label: 'Import employees', permission: PERMISSIONS.EMPLOYEE_IMPORT, icon: Users },
];

/** Unread dot for the Inbox nav item (probe limit=1&unread=true, 60s poll). */
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
    <span
      aria-label="unread notifications"
      title="Unread notifications"
      className="ml-auto size-1.5 shrink-0 rounded-full bg-primary"
    />
  );
}

/** Sidebar navigation, shared by the desktop rail and the mobile sheet. */
function NavList({
  groups,
  pathname,
  onNavigate,
}: {
  groups: NavGroup[];
  pathname: string | null;
  onNavigate?: () => void;
}) {
  return (
    <nav className="flex flex-1 flex-col gap-4 overflow-y-auto px-2 py-2">
      {groups.map((group, gi) => (
        <div key={group.title ?? `group-${gi}`} className="flex flex-col gap-0.5">
          {group.title && (
            <p className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wider text-text-subtle">
              {group.title}
            </p>
          )}
          {group.items.map((item) => {
            // Exact match, or a true path segment below it — so /attendance
            // does not light up while /attendance/exceptions is open.
            const active =
              pathname === item.href ||
              (pathname?.startsWith(item.href + '/') && item.href !== '/');
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-7 items-center gap-2 rounded px-2 text-sm font-medium transition-colors',
                  active
                    ? 'bg-primary-subtle text-primary'
                    : 'text-text-muted hover:bg-surface-sunken hover:text-text',
                )}
              >
                <Icon className={cn('size-4 shrink-0', active ? 'text-primary' : 'text-text-subtle')} />
                <span className="truncate">{item.label}</span>
                {item.href === '/inbox' ? <InboxDot /> : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
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

  if (status === 'loading' || status === 'unauthenticated') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas">
        <Spinner size={status === 'loading' ? 'lg' : 'md'} />
      </div>
    );
  }

  const username = session ? String(session.user.username) : '';
  const quickCreate = QUICK_CREATE.filter(
    (item) =>
      !item.permission ||
      (session && hasPermission({ permissions: session.permissions }, item.permission)),
  );

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex min-h-screen bg-canvas">
        {/* Desktop rail. The sidebar is its own scroll container so long nav
            never pushes the page, and the brand/footer stay pinned. */}
        <aside className="sticky top-0 hidden h-screen w-sidebar shrink-0 flex-col border-r border-border bg-surface md:flex">
          <div className="flex h-topbar shrink-0 items-center gap-2 border-b border-border px-3">
            <div className="flex size-5 items-center justify-center rounded bg-primary text-2xs font-bold text-primary-fg">
              S
            </div>
            <span className="text-sm font-semibold tracking-tight text-text">Silverline</span>
          </div>
          <NavList groups={groups} pathname={pathname} />
          <div className="shrink-0 border-t border-border px-3 py-2 text-2xs text-text-subtle">
            ERP v2
          </div>
        </aside>

        {/* Mobile navigation uses a real sheet: focus trap and Esc for free. */}
        <Sheet open={navOpen} onOpenChange={setNavOpen}>
          <SheetContent side="left" className="w-sidebar">
            <SheetTitle className="flex h-topbar shrink-0 items-center gap-2 border-b border-border px-3 text-sm font-semibold text-text">
              <div className="flex size-5 items-center justify-center rounded bg-primary text-2xs font-bold text-primary-fg">
                S
              </div>
              Silverline
            </SheetTitle>
            <NavList groups={groups} pathname={pathname} onNavigate={() => setNavOpen(false)} />
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-topbar shrink-0 items-center gap-2 border-b border-border bg-surface/85 px-3 backdrop-blur">
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-expanded={navOpen}
              aria-label="Open navigation"
              onClick={() => setNavOpen(true)}
            >
              <Menu />
            </Button>

            <div className="min-w-0 flex-1">
              <CommandPalette />
            </div>

            {quickCreate.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" className="hidden sm:inline-flex">
                    <Plus />
                    Create
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {quickCreate.map((item) => {
                    const Icon = item.icon;
                    return (
                      <DropdownMenuItem key={item.href} asChild>
                        <Link href={item.href}>
                          <Icon />
                          {item.label}
                        </Link>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <ThemeToggle />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Account menu for ${username}`}
                  className="rounded-full"
                >
                  <span className="flex size-6 items-center justify-center rounded-full bg-primary-subtle text-2xs font-semibold uppercase text-primary">
                    {username.slice(0, 2) || '··'}
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="normal-case tracking-normal text-text">
                  {username}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/security">
                    <Shield />
                    Account security
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={logout}>
                  <LogOut />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </header>

          <main className="min-w-0 flex-1 px-3 py-4 md:px-5 md:py-5">{children}</main>
        </div>
      </div>
    </TooltipProvider>
  );
}
