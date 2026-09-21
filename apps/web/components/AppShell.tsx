'use client';

import * as React from 'react';
import {CommandPalette} from './CommandPalette';
import Link from '@/components/AppLink';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from './AuthProvider';
import { hasPermission } from '@/lib/permissions';
import { navItemVisible } from '@/lib/landing';
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
import { NAV_GROUPS, QUICK_CREATE, type NavGroup, type NavItem } from '@/lib/nav';
import { Eye, LogOut, Menu, Plus, Shield } from 'lucide-react';
import { ViewAsBanner, ViewAsDialog } from './ViewAs';

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
  const [viewAsOpen, setViewAsOpen] = React.useState(false);
  const router = useRouter();
  /*
   * §075. Hidden without the permission, and hidden again while already
   * viewing as somebody -- the server refuses to chain sessions, so
   * offering it would be an invitation to an error message.
   */
  const canViewAs = !!session && hasPermission({ permissions: session.permissions }, 'admin.impersonate');
  const impersonating = !!session?.impersonation;

  React.useEffect(() => {
    if (status === 'unauthenticated') router.replace('/login');
    if(session?.user.mfa_enrollment_required&&pathname!=='/security')router.replace('/security');
  }, [status, router, session, pathname]);

  const visibleGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => session && navItemVisible(session.permissions, item)),
  })).filter((group) => group.items.length > 0);
  // Fails closed. Without a session there are no permissions to check, so the
  // honest answer is an empty rail rather than the full one: showing every
  // destination and letting each refuse on arrival is how somebody learns the
  // shape of a system they have no access to. The spinner below covers the
  // loading and unauthenticated states, so an empty rail is never what a
  // signed-in user sees.
  const groups = session ? visibleGroups : [];

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
          <div className="flex h-topbar shrink-0 items-center border-b border-border px-3">
            {/* The mark, at the size it stays legible. The wordmark is part
                of the image, so no text is repeated beside it. */}
            {/* The source art was ink flattened onto white, so it rendered
                as a white panel on the dark sidebar. The file now carries
                real transparency; in dark mode the artwork is driven to a
                white silhouette, because the wordmark is near black and the
                swirl a light grey — neither survives on a dark ground, and
                inverting the colours would turn the teal an unrelated hue. */}
            <img
              src="/silverline-logo.png"
              alt="Silverline Techno Solutions"
              className="h-7 w-auto dark:brightness-0 dark:invert"
            />
          </div>
          <NavList groups={groups} pathname={pathname} />
          <div className="shrink-0 border-t border-border px-3 py-2 text-2xs text-text-subtle">
            ERP v2
          </div>
        </aside>

        {/* Mobile navigation uses a real sheet: focus trap and Esc for free. */}
        <Sheet open={navOpen} onOpenChange={setNavOpen}>
          <SheetContent side="left" className="w-sidebar">
            <SheetTitle className="flex h-topbar shrink-0 items-center border-b border-border px-3">
              <img
                src="/silverline-logo.png"
                alt="Silverline Techno Solutions"
                className="h-7 w-auto dark:brightness-0 dark:invert"
              />
            </SheetTitle>
            <NavList groups={groups} pathname={pathname} onNavigate={() => setNavOpen(false)} />
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Above the sticky header, so it scrolls away rather than eating
              a strip of every screen -- but it is the first thing on the
              page, which is where a warning belongs. */}
          <ViewAsBanner />
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
                {canViewAs && !impersonating ? (
                  <DropdownMenuItem onSelect={() => setViewAsOpen(true)}>
                    <Eye />
                    View as another user
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={logout}>
                  <LogOut />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </header>

          <main className="min-w-0 flex-1 px-3 py-4 md:px-5 md:py-5">{children}</main>
          {canViewAs ? <ViewAsDialog open={viewAsOpen} onOpenChange={setViewAsOpen} /> : null}
        </div>
      </div>
    </TooltipProvider>
  );
}
