'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  fenceSchema,
  ORG_UNIT_TYPES,
  parsePolygonTextarea,
  type FenceFormInput,
} from '@/lib/validation';
import type { FenceGeometry, GeometryType } from '@/lib/geo';
import { Button } from './ui/Button';
import { FormField } from './ui/FormField';
import { Input } from './ui/Input';

const inputClass =
  'w-full rounded-md border bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1 border-slate-300';

export interface FencePayload {
  name: string;
  scope_type: string;
  scope_id: string;
  geometry_type: GeometryType;
  geometry: FenceGeometry;
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
  const polygonText = watch('polygon_text') ?? '';
  const polygonPreview = React.useMemo(() => parsePolygonTextarea(polygonText), [polygonText]);

  const submit = async (v: FenceFormInput) => {
    if (v.geometry_type === 'circle') {
      await onSubmit({
        name: v.name,
        scope_type: v.scope_type,
        scope_id: v.scope_id,
        geometry_type: 'circle',
        geometry: { lat: v.circle_lat!, lng: v.circle_lng!, radius_m: v.radius_m! },
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
      tolerance_meters: v.tolerance_meters,
      accuracy_threshold_meters: v.accuracy_threshold_meters,
    });
  };

  return (
    <form onSubmit={handleSubmit(submit)} className="flex flex-col gap-4" noValidate>
      <FormField label="Name *" htmlFor="fence-name" error={errors.name?.message}>
        <Input id="fence-name" invalid={!!errors.name} placeholder="Site gate perimeter" {...register('name')} />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Scope type *" htmlFor="fence-scope-type" error={errors.scope_type?.message}>
          <select id="fence-scope-type" className={inputClass} {...register('scope_type')}>
            {ORG_UNIT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Scope ID *" htmlFor="fence-scope-id" error={errors.scope_id?.message}>
          <Input id="fence-scope-id" invalid={!!errors.scope_id} placeholder="Org unit id…" {...register('scope_id')} />
        </FormField>
      </div>
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
                geometryType === t ? 'bg-slate-900 text-white ring-slate-900' : 'bg-white text-slate-700 ring-slate-300'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <input id="fence-geo-type-hidden" type="hidden" value={geometryType} {...register('geometry_type')} />
        {errors.geometry_type?.message && (
          <p role="alert" className="text-xs text-red-600">{errors.geometry_type.message}</p>
        )}
      </FormField>

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
          <p className="mt-1 text-xs text-slate-500">
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
