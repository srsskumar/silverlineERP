'use client';

import Link from '@/components/AppLink';
import { useAuth } from './AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';

/**
 * Jira-style project view switcher: Overview (list) | Board (kanban).
 * The Board tab hides when the user lacks board.read (the board route would
 * 403) — Overview stays for anyone with project.read.
 */
export function ProjectTabs({ projectId, active }: { projectId: string; active: 'overview' | 'board' }) {
  const { session } = useAuth();
  const holder = { permissions: session?.permissions };
  const canBoard = hasPermission(holder, PERMISSIONS.BOARD_READ);

  const tab = (label: string, href: string, isActive: boolean) => (
    <Link
      key={label}
      href={href}
      aria-current={isActive ? 'page' : undefined}
      className={`rounded-md px-3 py-1.5 text-sm font-medium ${
        isActive
          ? 'bg-primary text-primary-fg'
          : 'text-text-muted hover:bg-surface-sunken hover:text-text'
      }`}
    >
      {label}
    </Link>
  );

  return (
    <nav aria-label="Project views" className="flex items-center gap-1">
      {tab('Overview', `/projects/${projectId}`, active === 'overview')}
      {canBoard ? tab('Board', `/projects/${projectId}/board`, active === 'board') : null}
    </nav>
  );
}
