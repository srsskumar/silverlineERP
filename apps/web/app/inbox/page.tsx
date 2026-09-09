'use client';

import { AppShell } from '@/components/AppShell';
import { InboxList } from '@/components/InboxList';

export const dynamic = 'force-static';

export default function InboxPage() {
  return (
    <AppShell>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Inbox</h1>
          <p className="mt-1 text-sm text-slate-500">
            Mentions, assignments and status changes. Polls every 60s; the nav dot lights up while anything is unread.
          </p>
        </div>
      </div>
      <div className="mt-6">
        <InboxList />
      </div>
    </AppShell>
  );
}
