'use client';

import { Download } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { useAuth } from '@/components/AuthProvider';
import { REPORT_TYPE_META } from '@/lib/reports';

/**
 * Downloading what is already in the system.
 *
 * Every one of these has been exportable since Reports existed. Nobody
 * looking for "how do I download my assets" thinks to look under Reports,
 * so the way out is named beside the way in, and each line links straight
 * to the screen that produces it.
 *
 * Only the exports this person can actually generate are listed. Offering a
 * download that comes back 403 is worse than not offering it.
 */
export function ExportPanel() {
  const { session } = useAuth();
  const mine = REPORT_TYPE_META.filter((t) => session?.permissions.includes(t.permission));

  if (mine.length === 0) return null;

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h2 className="text-sm font-semibold text-text">Download existing data</h2>
        <p className="mt-0.5 text-xs text-text-muted">
          Exports run on the Reports screen, as CSV, Excel or PDF, and respect what you are
          allowed to see. A large export is prepared in the background and appears there when
          it is ready.
        </p>
      </div>
      <ul className="flex flex-wrap gap-2">
        {mine.map((t) => (
          <li key={t.type}>
            <a
              href="/reports"
              className="inline-flex items-center gap-1.5 rounded-md border border-border
                bg-surface px-2.5 py-1.5 text-xs text-text hover:border-primary hover:text-primary"
            >
              <Download className="size-3.5" />
              {t.label}
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}
