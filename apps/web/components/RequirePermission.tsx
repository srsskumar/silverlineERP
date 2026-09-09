'use client';

import * as React from 'react';
import { useAuth } from './AuthProvider';
import { hasPermission } from '@/lib/permissions';
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
