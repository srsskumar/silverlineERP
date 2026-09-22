'use client';

import * as React from 'react';
import { useAuth } from './AuthProvider';
import { hasPermission } from '@/lib/permissions';
import { canOpen, firstMissingFor } from '@/lib/landing';
import { Forbidden } from './Forbidden';
import { Spinner } from './ui/Spinner';

/** Renders children only when the session holds `code`; otherwise a 403 panel. */
export function RequirePermission({
  code,
  children,
}: {
  code: string;
  children: React.ReactNode;
}) {
  const { session, isLoading } = useAuth();
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }
  if (!session || !hasPermission({ permissions: session.permissions }, code)) {
    return <Forbidden required={code} />;
  }
  return <>{children}</>;
}

/**
 * Renders children only when the session can open `href` by the same rule
 * the navigation uses; otherwise the 403 panel naming the first permission
 * it lacks.
 *
 * One rule, in one place. A page used to gate itself on the permission it
 * was named after while the data it loaded needed another, so a role saw
 * the link, opened the page, and watched its requests come back 403. With
 * the gate reading lib/nav.ts, the page and the sidebar cannot disagree.
 */
export function RequireDestination({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  const { session, isLoading } = useAuth();
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }
  if (!session || !canOpen(session.permissions, href)) {
    return <Forbidden required={firstMissingFor(session?.permissions, href) ?? undefined} />;
  }
  return <>{children}</>;
}
