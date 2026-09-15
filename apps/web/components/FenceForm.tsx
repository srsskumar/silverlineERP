'use client';

import * as React from 'react';
import Link from './AppLink';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  fenceSchema,
  ORG_UNIT_TYPES,
  parsePolygonTextarea,
  type FenceFormInput,
} from '@/lib/validation';
import { searchPlaces, type FenceGeometry, type GeometryType, type PlaceSearchResult } from '@/lib/geo';
import { listOrgUnits } from '@/lib/org';
import { listEmployees, type EmployeeListItem } from '@/lib/employees';
import { queryKeys } from '@/lib/query-keys';
import { Button } from './ui/Button';
import { FormField } from './ui/FormField';
import { FenceMap } from './map/FenceMap';
import { Input } from './ui/Input';

const inputClass =
  'w-full rounded-md border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 border-border';

const LOCATION_PATH: Record<(typeof ORG_UNIT_TYPES)[number], string> = {
  district: 'District',
  division: 'District → Division',
  // A mandal may sit under a division or straight under the district, so the
  // division is shown as the optional tier it is.
  mandal: 'District → (Division) → Mandal',
  village: 'District → (Division) → Mandal → Village',
  site: 'District → (Division) → Mandal → Village → Site',
};

export interface FencePayload {
  name: string;
  scope_type: string;
  scope_id: string;
  geometry_type: GeometryType;
  geometry: FenceGeometry;
  employee_ids?: string[];
  tolerance_meters?: number;
  accuracy_threshold_meters?: number;
}

/**
 * Create form for geo-fences. Circle uses lat/lng/radius fields; polygon
 * uses a "lat,lng per line" textarea parsed by parsePolygonTextarea
 * (≥3 points). Tolerance/accuracy default to 50/100m.
 */
export function FenceForm({
  onSubmit,
  submitLabel = 'Create fence',
}: {
  onSubmit: (payload: FencePayload) => Promise<void>;
  submitLabel?: string;
}) {
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    setError,
    clearErrors,
    formState: { errors, isSubmitting },
  } = useForm<FenceFormInput>({
    resolver: zodResolver(fenceSchema),
    defaultValues: {
      name: '',
      scope_type: 'site',
      scope_id: '',
      geometry_type: 'circle',
      circle_lat: undefined,
      circle_lng: undefined,
      radius_m: undefined,
      polygon_text: '',
      tolerance_meters: 50,
      accuracy_threshold_meters: 100,
    },
  });

  const geometryType = watch('geometry_type');
  const scopeType = watch('scope_type');
  const polygonText = watch('polygon_text') ?? '';
  const [placeQuery, setPlaceQuery] = React.useState('');
  const [placeResults, setPlaceResults] = React.useState<PlaceSearchResult[]>([]);
  const [mapCenter, setMapCenter] = React.useState<{ lat: number; lng: number } | null>(null);
  const [employeeQuery, setEmployeeQuery] = React.useState('');
  const [selectedEmployees, setSelectedEmployees] = React.useState<EmployeeListItem[]>([]);
  const polygonPreview = React.useMemo(() => parsePolygonTextarea(polygonText), [polygonText]);
  const unitsQuery = useQuery({
    queryKey: queryKeys.orgUnits.list({ type: scopeType, limit: 100 }),
    queryFn: () => listOrgUnits({ type: scopeType, limit: 100 }),
    enabled: !!scopeType,
    staleTime: 10 * 60_000,
  });
  const employeesQuery = useQuery({
    queryKey: ['employees', 'fence-assignment', employeeQuery.trim()],
    queryFn: () => listEmployees({ q: employeeQuery.trim(), status: 'ACTIVE', limit: 12 }),
    enabled: employeeQuery.trim().length >= 2,
    staleTime: 30_000,
  });
  const placeSearch = useMutation({
    mutationFn: (query: string) => searchPlaces(query),
    onSuccess: setPlaceResults,
  });
  const activeUnits = React.useMemo(
    () => (unitsQuery.data?.data ?? []).filter((unit) => unit.status === 'ACTIVE'),
    [unitsQuery.data?.data],
  );

  const choosePlace = (place: PlaceSearchResult) => {
    setMapCenter({ lat: place.lat, lng: place.lng });
    if (geometryType === 'circle') {
      setValue('circle_lat', place.lat as never, { shouldValidate: true });
      setValue('circle_lng', place.lng as never, { shouldValidate: true });
    }
  };

  const submit = async (v: FenceFormInput) => {
    if (v.geometry_type === 'circle') {
      await onSubmit({
        name: v.name,
        scope_type: v.scope_type,
        scope_id: v.scope_id,
        geometry_type: 'circle',
        geometry: { lat: v.circle_lat!, lng: v.circle_lng!, radius_m: v.radius_m! },
        employee_ids: selectedEmployees.map((employee) => employee.id),
        tolerance_meters: v.tolerance_meters,
        accuracy_threshold_meters: v.accuracy_threshold_meters,
      });
      return;
    }
    const parsed = parsePolygonTextarea(v.polygon_text ?? '');
    if (!parsed.ok) {
      setError('polygon_text', { message: parsed.error });
      return;
    }
    clearErrors('polygon_text');
    await onSubmit({
      name: v.name,
      scope_type: v.scope_type,
      scope_id: v.scope_id,
      geometry_type: 'polygon',
      // Backend contract: points are [lat, lng] tuples, not {lat,lng} objects.
      geometry: { points: parsed.points.map((p) => [p.lat, p.lng] as [number, number]) },
      employee_ids: selectedEmployees.map((employee) => employee.id),
      tolerance_meters: v.tolerance_meters,
      accuracy_threshold_meters: v.accuracy_threshold_meters,
    });
  };

  // Preview geometry derived from the live form values. Invalid or incomplete
  // input simply renders nothing rather than throwing inside the map.
  const lat = Number(watch('circle_lat'));
  const lng = Number(watch('circle_lng'));
  const radius = Number(watch('radius_m'));
  const previewCircle =
    geometryType === 'circle' && Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0
      ? {
          id: 'preview',
          name: watch('name') || 'New fence',
          lat,
          lng,
          radius_m: Number.isFinite(radius) && radius > 0 ? radius : 100,
        }
      : null;
  const previewPolygon =
    geometryType === 'polygon' && polygonPreview.ok && polygonPreview.points.length >= 3
      ? {
          id: 'preview',
          name: watch('name') || 'New fence',
          points: polygonPreview.points.map((p) => [p.lat, p.lng] as [number, number]),
        }
      : null;
  const selectedEmployeeIds = React.useMemo(
    () => new Set(selectedEmployees.map((employee) => employee.id)),
    [selectedEmployees],
  );
  const runPlaceSearch = () => {
    const query = placeQuery.trim();
    if (query.length < 2) return;
    setPlaceResults([]);
    placeSearch.mutate(query);
  };

  return (
    <form onSubmit={handleSubmit(submit)} className="flex flex-col gap-4" noValidate>
      <FormField label="Name *" htmlFor="fence-name" error={errors.name?.message}>
        <Input id="fence-name" invalid={!!errors.name} placeholder="Site gate perimeter" {...register('name')} />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Scope type *" htmlFor="fence-scope-type" error={errors.scope_type?.message}>
          <select
            id="fence-scope-type"
            className={inputClass}
            {...register('scope_type', {
              onChange: () => setValue('scope_id', '', { shouldValidate: false }),
            })}
          >
            {ORG_UNIT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Location / site *" htmlFor="fence-scope-id" error={errors.scope_id?.message}>
          <select
            id="fence-scope-id"
            className={inputClass}
            disabled={!scopeType || unitsQuery.isLoading || activeUnits.length === 0}
            aria-invalid={!!errors.scope_id}
            {...register('scope_id', { onChange: () => clearErrors('scope_id') })}
          >
            <option value="">
              {unitsQuery.isLoading
                ? 'Loading locations…'
                : activeUnits.length === 0
                  ? `No active ${scopeType}s available`
                  : `Select ${scopeType || 'location'}`}
            </option>
            {activeUnits.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.code})
              </option>
            ))}
          </select>
          {unitsQuery.isError ? (
            <div className="mt-2 rounded-md border border-danger/30 bg-danger/10 p-3 text-xs text-danger" role="alert">
              <p>Locations could not be loaded.</p>
              <Button type="button" size="sm" variant="secondary" className="mt-2" onClick={() => unitsQuery.refetch()}>
                Retry
              </Button>
            </div>
          ) : null}
          {!unitsQuery.isLoading && !unitsQuery.isError && scopeType && activeUnits.length === 0 ? (
            <div className="mt-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-xs text-text" role="status">
              <p>
                No active {scopeType}s exist. Create the {LOCATION_PATH[scopeType]} hierarchy, then refresh this list.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="secondary" onClick={() => unitsQuery.refetch()}>
                  Refresh locations
                </Button>
                <Button asChild size="sm">
                  <Link href="/org/locations" target="_blank" rel="noopener noreferrer">
                    Create locations
                  </Link>
                </Button>
              </div>
            </div>
          ) : null}
        </FormField>
      </div>

      <FormField label="Assign directly to employees (optional)" htmlFor="fence-employee-search">
        <Input
          id="fence-employee-search"
          value={employeeQuery}
          onChange={(event) => setEmployeeQuery(event.target.value)}
          placeholder="Search by employee number or name…"
        />
        <p className="mt-1 text-xs text-text-muted">
          A direct assignment takes priority over the employee&apos;s site fence and replaces any previous direct assignment.
        </p>
        {selectedEmployees.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2" aria-label="Selected employees">
            {selectedEmployees.map((employee) => (
              <button
                key={employee.id}
                type="button"
                className="rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary hover:bg-primary/20"
                onClick={() => setSelectedEmployees((current) => current.filter((item) => item.id !== employee.id))}
                aria-label={`Remove ${employee.first_name} ${employee.last_name ?? ''}`.trim()}
              >
                {employee.emp_no} · {employee.first_name} {employee.last_name ?? ''} ×
              </button>
            ))}
          </div>
        ) : null}
        {employeeQuery.trim().length >= 2 ? (
          <div className="mt-2 max-h-40 overflow-y-auto rounded-md border border-border bg-surface">
            {employeesQuery.isLoading ? <p className="px-3 py-2 text-xs text-text-muted">Searching employees…</p> : null}
            {(employeesQuery.data?.data ?? []).map((employee) => {
              const selected = selectedEmployeeIds.has(employee.id);
              return (
                <button
                  key={employee.id}
                  type="button"
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface-sunken"
                  onClick={() => setSelectedEmployees((current) => selected
                    ? current.filter((item) => item.id !== employee.id)
                    : [...current, employee])}
                >
                  <span>{employee.emp_no} · {employee.first_name} {employee.last_name ?? ''}</span>
                  <span className={selected ? 'text-success' : 'text-text-subtle'}>{selected ? 'Selected' : 'Select'}</span>
                </button>
              );
            })}
            {!employeesQuery.isLoading && employeesQuery.data?.data.length === 0 ? (
              <p className="px-3 py-2 text-xs text-text-muted">No active employees found.</p>
            ) : null}
          </div>
        ) : null}
      </FormField>

      <FormField label="Geometry *" htmlFor="fence-geo-type">
        <div className="flex gap-2" role="radiogroup" aria-label="Geometry type">
          {(['circle', 'polygon'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={geometryType === t}
              onClick={() => setValue('geometry_type', t, { shouldValidate: true })}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ring-1 ${
                geometryType === t ? 'bg-primary text-primary-fg ring-primary' : 'bg-surface text-text-muted ring-border'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <input id="fence-geo-type-hidden" type="hidden" value={geometryType} {...register('geometry_type')} />
        {errors.geometry_type?.message && (
          <p role="alert" className="text-xs text-danger">{errors.geometry_type.message}</p>
        )}
      </FormField>

      {/*
        Live map. Admins previously typed coordinates blind — a circle centre as
        two decimals, a polygon as a "lat,lng per line" textarea — with no way to
        see the shape before saving. Clicking the map fills the circle centre;
        the shape below redraws as the fields change, so a wrong digit is
        obvious instead of being discovered by a field user failing to punch.
      */}
      <FormField label="Find a place on the map" htmlFor="fence-place-search">
        <div className="flex gap-2">
          <Input
            id="fence-place-search"
            value={placeQuery}
            onChange={(event) => setPlaceQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                runPlaceSearch();
              }
            }}
            placeholder="Search village, office, landmark or address…"
          />
          <Button type="button" loading={placeSearch.isPending} disabled={placeQuery.trim().length < 2} onClick={runPlaceSearch}>
            Search
          </Button>
        </div>
        {placeSearch.isError ? (
          <p role="alert" className="mt-1 text-xs text-danger">
            {placeSearch.error instanceof Error ? placeSearch.error.message : 'Location search failed'}
          </p>
        ) : null}
        {placeResults.length > 0 ? (
          <div className="mt-2 max-h-44 overflow-y-auto rounded-md border border-border bg-surface">
            {placeResults.map((place) => (
              <button
                key={place.id}
                type="button"
                className="block w-full border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-surface-sunken"
                onClick={() => choosePlace(place)}
              >
                <span className="block text-text">{place.display_name}</span>
                <span className="text-xs text-text-subtle">{place.lat.toFixed(5)}, {place.lng.toFixed(5)}</span>
              </button>
            ))}
          </div>
        ) : null}
        <p className="mt-1 text-xs text-text-muted">Search results © OpenStreetMap contributors.</p>
      </FormField>
      <FenceMap
        height={320}
        circles={previewCircle ? [previewCircle] : []}
        polygons={previewPolygon ? [previewPolygon] : []}
        center={mapCenter ?? (previewCircle ? { lat: previewCircle.lat, lng: previewCircle.lng } : null)}
        onMapClick={
          geometryType === 'circle'
            ? (pos) => {
                setMapCenter(pos);
                setValue('circle_lat', pos.lat as never, { shouldValidate: true });
                setValue('circle_lng', pos.lng as never, { shouldValidate: true });
              }
            : (pos) => {
                // Append the clicked point to the polygon textarea.
                const current = (polygonText ?? '').trim();
                setValue('polygon_text', `${current ? `${current}\n` : ''}${pos.lat},${pos.lng}` as never, {
                  shouldValidate: true,
                });
              }
        }
      />
      <p className="-mt-2 text-xs text-text-muted">
        {geometryType === 'circle'
          ? 'Click the map to set the centre, then set a radius.'
          : 'Click the map to add each corner in order. At least three are needed.'}
      </p>

      {geometryType === 'circle' ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="Center lat *" htmlFor="fence-lat" error={errors.circle_lat?.message}>
            <Input id="fence-lat" inputMode="decimal" placeholder="17.44" {...register('circle_lat')} />
          </FormField>
          <FormField label="Center lng *" htmlFor="fence-lng" error={errors.circle_lng?.message}>
            <Input id="fence-lng" inputMode="decimal" placeholder="78.34" {...register('circle_lng')} />
          </FormField>
          <FormField label="Radius (m) *" htmlFor="fence-radius" error={errors.radius_m?.message}>
            <Input id="fence-radius" inputMode="decimal" placeholder="100" {...register('radius_m')} />
          </FormField>
        </div>
      ) : (
        <FormField label='Polygon points * ("lat,lng" per line, ≥3)' htmlFor="fence-polygon" error={errors.polygon_text?.message}>
          <textarea
            id="fence-polygon"
            rows={5}
            className={`${inputClass} font-mono`}
            placeholder={'17.44,78.34\n17.45,78.35\n17.43,78.36'}
            {...register('polygon_text')}
          />
          <p className="mt-1 text-xs text-text-muted">
            {polygonText.trim()
              ? polygonPreview.ok
                ? `${polygonPreview.points.length} points parsed — ready.`
                : polygonPreview.error
              : 'One "lat,lng" pair per line.'}
          </p>
        </FormField>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Tolerance (m)" htmlFor="fence-tol" error={errors.tolerance_meters?.message}>
          <Input id="fence-tol" inputMode="numeric" {...register('tolerance_meters')} />
        </FormField>
        <FormField label="Accuracy threshold (m)" htmlFor="fence-acc" error={errors.accuracy_threshold_meters?.message}>
          <Input id="fence-acc" inputMode="numeric" {...register('accuracy_threshold_meters')} />
        </FormField>
      </div>

      <div className="flex justify-end">
        <Button type="submit" loading={isSubmitting}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
