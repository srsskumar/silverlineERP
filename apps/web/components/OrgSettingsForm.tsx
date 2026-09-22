'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { GST_STATE_CODES } from '@silverline/shared';
import { apiRequestRaw } from '@/lib/apiClient';
import { settingsBody, settingsInitial, type OrgSettingsRow } from '@/lib/admin-forms';
import { MutationForm } from '@/components/v2/Workbench';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorCard } from '@/components/ui/ErrorCard';

/* Code first, because the code is what the return asks for. */
const GST_STATE_OPTIONS = Object.entries(GST_STATE_CODES).map(([code, name]) => ({ value: code, label: `${code} — ${name}` }));

/**
 * The organisation's settings, starting from what they are.
 *
 * The form used to open with defaults written into the page -- 30 minutes,
 * 365 days, Asia/Kolkata -- whatever the organisation had actually set. So
 * an administrator who came to correct the name and pressed Save also put
 * the session timeout back to half an hour, without a field ever looking
 * wrong. A form that edits a record has to read the record first.
 *
 * The three-way match tolerance lives here too, because the API keeps it
 * here and until now nothing on screen could set it.
 */
export function OrgSettingsForm() {
  const settings = useQuery({
    queryKey: ['v2', 'admin/settings'],
    queryFn: async () => (await apiRequestRaw('/api/v1/admin/settings')).body as OrgSettingsRow,
  });

  if (settings.isLoading) return <Skeleton className="h-40" />;
  if (settings.isError) return <ErrorCard error={settings.error} onRetry={() => settings.refetch()} />;

  const row = settings.data ?? null;
  return (
    <MutationForm
      key={JSON.stringify(row)}
      path="admin/settings"
      method="PATCH"
      initial={settingsInitial(row)}
      transform={settingsBody}
      fields={[
        { key: 'name', label: 'Organization name' },
        { key: 'timezone', label: 'Timezone (blank means Asia/Kolkata)' },
        { key: 'locale', label: 'Locale' },
        { key: 'gst_state_code', label: 'Our GST state', type: 'select', options: GST_STATE_OPTIONS },
        { key: 'session_timeout_minutes', label: 'Sign out after this many idle minutes (5 to 1440; blank means a week)', type: 'number' },
        { key: 'retention_days', label: 'Keep records for this many days (30 or more)', type: 'number' },
        { key: 'match_quantity_pct', label: 'Three-way match: quantity tolerance (%)', type: 'number' },
        { key: 'match_rate_pct', label: 'Three-way match: rate tolerance (%)', type: 'number' },
        { key: 'match_value_absolute', label: 'Three-way match: value tolerance (₹)', type: 'number' },
      ]}
    />
  );
}
