'use client';

import { useQuery } from '@tanstack/react-query';
import { listOrgUnits } from '@/lib/org';
import { queryKeys } from '@/lib/query-keys';

export interface LocationSelection {
  district_id?: string;
  mandal_id?: string;
  village_id?: string;
}

const selectClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-ring disabled:bg-surface-sunken';

/**
 * District → mandal → village chained selects. Queries are cached (10min
 * staleTime); changing a parent clears its descendants.
 */
export function CascadingLocationSelect({
  districtId,
  mandalId,
  villageId,
  onChange,
  disabled = false,
}: {
  districtId?: string;
  mandalId?: string;
  villageId?: string;
  onChange: (v: LocationSelection) => void;
  disabled?: boolean;
}) {
  const districtsQuery = useQuery({
    queryKey: queryKeys.orgUnits.list({ type: 'district', limit: 100 }),
    queryFn: () => listOrgUnits({ type: 'district', limit: 100 }),
    staleTime: 10 * 60_000,
  });
  const mandalsQuery = useQuery({
    queryKey: queryKeys.orgUnits.list({ type: 'mandal', parent_id: districtId ?? '', limit: 100 }),
    queryFn: () => listOrgUnits({ type: 'mandal', parent_id: districtId, limit: 100 }),
    enabled: !!districtId,
    staleTime: 10 * 60_000,
  });
  const villagesQuery = useQuery({
    queryKey: queryKeys.orgUnits.list({ type: 'village', parent_id: mandalId ?? '', limit: 100 }),
    queryFn: () => listOrgUnits({ type: 'village', parent_id: mandalId, limit: 100 }),
    enabled: !!mandalId,
    staleTime: 10 * 60_000,
  });

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="loc-district" className="text-sm font-medium text-text-muted">
          District
        </label>
        <select
          id="loc-district"
          className={selectClass}
          disabled={disabled}
          value={districtId ?? ''}
          onChange={(e) =>
            onChange({ district_id: e.target.value || undefined, mandal_id: undefined, village_id: undefined })
          }
        >
          <option value="">Select district</option>
          {(districtsQuery.data?.data ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        {districtsQuery.isLoading && <p className="text-xs text-text-subtle">Loading districts…</p>}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="loc-mandal" className="text-sm font-medium text-text-muted">
          Mandal
        </label>
        <select
          id="loc-mandal"
          className={selectClass}
          disabled={disabled || !districtId}
          value={mandalId ?? ''}
          onChange={(e) =>
            onChange({ district_id: districtId, mandal_id: e.target.value || undefined, village_id: undefined })
          }
        >
          <option value="">{districtId ? 'Select mandal' : 'Pick a district first'}</option>
          {(mandalsQuery.data?.data ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        {mandalsQuery.isFetching && districtId && <p className="text-xs text-text-subtle">Loading mandals…</p>}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="loc-village" className="text-sm font-medium text-text-muted">
          Village
        </label>
        <select
          id="loc-village"
          className={selectClass}
          disabled={disabled || !mandalId}
          value={villageId ?? ''}
          onChange={(e) => onChange({ district_id: districtId, mandal_id: mandalId, village_id: e.target.value || undefined })}
        >
          <option value="">{mandalId ? 'Select village' : 'Pick a mandal first'}</option>
          {(villagesQuery.data?.data ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        {villagesQuery.isFetching && mandalId && <p className="text-xs text-text-subtle">Loading villages…</p>}
      </div>
    </div>
  );
}
