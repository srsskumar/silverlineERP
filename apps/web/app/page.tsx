'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Spinner } from '@/components/ui/Spinner';
import { useAuth } from '@/components/AuthProvider';
import { landingRoute } from '@/lib/landing';

export const dynamic = 'force-static';

/**
 * Root route: send the user to the first place they can actually open.
 *
 * This used to redirect unconditionally to /dashboard, which holds for an
 * admin and fails for several real roles: a bid manager and a sales executive
 * hold no `dashboard.read` at all, and an HR or payroll officer holds it but
 * not the `project.read` the board needs. All of them signed in and were sent
 * straight to a refusal.
 */
export default function RootPage() {
  const router = useRouter();
  const { session, status } = useAuth();

  useEffect(() => {
    if (status === 'loading') return;
    if (status === 'unauthenticated') { router.replace('/login'); return; }
    router.replace(landingRoute(session?.permissions));
  }, [router, session, status]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner size="lg" />
    </div>
  );
}
