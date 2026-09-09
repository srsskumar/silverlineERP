'use client';

import Link from '@/components/AppLink';
import { Button } from './ui/Button';

/** 403 panel rendered by RequirePermission and the /403 route. */
export function Forbidden({ required }: { required?: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center">
      <p className="text-5xl font-bold text-slate-300">403</p>
      <h1 className="text-lg font-semibold text-slate-900">Access denied</h1>
      <p className="text-sm text-slate-500">
        You don&apos;t have permission to view this page.
        {required && (
          <>
            {' '}
            Required permission: <code className="rounded bg-slate-100 px-1">{required}</code>
          </>
        )}
      </p>
      <Link href="/dashboard">
        <Button variant="secondary">Back to dashboard</Button>
      </Link>
    </div>
  );
}
