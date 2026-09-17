'use client';

import Link from '@/components/AppLink';
import { Button } from './ui/Button';

/**
 * 403 panel rendered by RequirePermission and the /403 route.
 *
 * Naming the permission is half the answer. Somebody who has just been told
 * they need "employee.read" still has to work out that permissions live on
 * roles, that they cannot grant themselves one, and who can — so the panel
 * says all three. It matches what the API says when it refuses the same
 * request, because hearing two different explanations for one refusal is
 * worse than hearing neither.
 */
export function Forbidden({ required }: { required?: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center">
      <p className="text-5xl font-bold text-text-subtle">403</p>
      <h1 className="text-lg font-semibold text-text">Access denied</h1>
      <p className="text-sm text-text-muted">
        {required ? (
          <>
            This page needs the{' '}
            <code className="rounded bg-surface-sunken px-1">{required}</code>{' '}
            permission, which your roles do not include.
          </>
        ) : (
          <>Your roles do not include permission to view this page.</>
        )}
      </p>
      <p className="text-xs text-text-subtle">
        Permissions are granted to roles rather than to people. An administrator can add
        this one to your role under Administration → Roles.
      </p>
      <Link href="/dashboard">
        <Button variant="secondary">Back to dashboard</Button>
      </Link>
    </div>
  );
}
