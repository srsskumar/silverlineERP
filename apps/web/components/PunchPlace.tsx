'use client';

import * as React from 'react';
import { MapPin } from 'lucide-react';
import { formatUtm } from '@silverline/shared';
import type { AttendanceEvent } from '@/lib/attendance';
import { placeLabel, type PlaceStatus } from '@/lib/place';
import { cn } from '@/lib/cn';

/**
 * A punch's place, in a word: the village or town, or that it is still
 * being looked up. Muted while resolving, so a table of today's punches
 * reads as names with a few gaps, not as a column of italics.
 */
export function PlaceName({
  name, status, className,
}: { name?: string | null; status?: PlaceStatus; className?: string }) {
  const text = placeLabel(name, status);
  const pending = !name && status === 'resolving';
  return (
    <span
      className={cn(pending ? 'italic text-text-subtle' : undefined, className)}
      title={pending ? 'The place name is being looked up from the coordinates' : undefined}
    >
      {text}
    </span>
  );
}

const metres = (v: number | null | undefined, digits = 0) =>
  typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(digits)} m` : null;

/**
 * Everything a punch knows about where it was made, the way a surveyor
 * reads it: the place, the UTM grid reference with its datum, the
 * geographic coordinates and accuracy, and the heights with their
 * reference surfaces named -- a height with no datum is a number, not a
 * height.
 */
export function EventPosition({ event }: { event: AttendanceEvent }) {
  const positioned = typeof event.latitude === 'number' && typeof event.longitude === 'number';
  // Where the request came from, independent of whether the device also sent
  // a position (migration 088, owner request) -- muted and small, since it
  // is provenance rather than something a supervisor reads the punch by.
  const ipLine = event.ip_address ? (
    <p className="mt-1 text-xs text-text-muted">IP {event.ip_address}</p>
  ) : null;
  if (!positioned) {
    return (
      <>
        <p className="text-xs text-text-muted">No position was recorded with this punch.</p>
        {ipLine}
      </>
    );
  }
  const utm = typeof event.utm_zone === 'number' && typeof event.utm_easting === 'number'
    && typeof event.utm_northing === 'number' && event.utm_hemisphere
    ? formatUtm({
        zone: event.utm_zone, hemisphere: event.utm_hemisphere as 'N' | 'S',
        easting: event.utm_easting, northing: event.utm_northing,
      })
    : null;
  return (
    <>
      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
        <dt className="flex items-center gap-1 text-text-muted"><MapPin className="size-3.5" aria-hidden />Place</dt>
        <dd className="text-text"><PlaceName name={event.place_name} status={event.place_status} /></dd>
        <dt className="text-text-muted">UTM (WGS-1984)</dt>
        <dd className="font-mono text-text">{utm ?? '— (not yet computed)'}</dd>
        <dt className="text-text-muted">Lat / long</dt>
        <dd className="font-mono text-text">
          {event.latitude!.toFixed(6)}, {event.longitude!.toFixed(6)}
          {typeof event.gps_accuracy === 'number' ? ` · ±${Math.round(event.gps_accuracy)} m` : ''}
        </dd>
        {typeof event.altitude === 'number' ? (
          <>
            <dt className="text-text-muted">Altitude (WGS84 ellipsoid)</dt>
            <dd className="font-mono text-text">
              {metres(event.altitude, 1)}
              {typeof event.altitude_accuracy === 'number' ? ` · ±${Math.round(event.altitude_accuracy)} m` : ''}
            </dd>
          </>
        ) : null}
        {typeof event.height_egm96 === 'number' ? (
          <>
            <dt className="text-text-muted">Height (EGM96 geoid)</dt>
            <dd className="font-mono text-text">{metres(event.height_egm96, 2)}</dd>
          </>
        ) : null}
      </dl>
      {ipLine}
    </>
  );
}
