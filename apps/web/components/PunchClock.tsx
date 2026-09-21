'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogIn, LogOut, Loader2, MapPin, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { Skeleton } from './ui/Skeleton';
import { useToast } from './ui/Toast';
import { useAuth } from './AuthProvider';
import { hasPermission, PERMISSIONS } from '@/lib/permissions';
import { getMyEmployee } from '@/lib/employees';
import { listRecords, punchEvent, type PunchResult } from '@/lib/attendance';
import { clock, day, businessToday } from '@/lib/finance';

/**
 * §079 -- punching in, for the person doing it.
 *
 * There was a punch form already, and its own heading called it what it
 * was: "Manual punch (testing / admin)". It asks you to find an employee in
 * a picker and type a latitude. That is a tool for fixing somebody else's
 * day, not for starting your own -- so office staff had no way to mark
 * their attendance from the web at all, while the field app has had a
 * Check in button since the beginning.
 *
 * This is the other thing: one button, for you, that knows what time it is
 * and where you are.
 */

/**
 * Where we are, read afresh at the moment of each punch.
 *
 * The first version took one fix when the page loaded and sent it with
 * whatever was pressed afterwards. Punching in at nine and out at six from
 * the same open tab would have filed both from the morning's position --
 * which is worse than no location at all, because a wrong one looks
 * authoritative and would pass a geofence check it should have failed.
 *
 * So the mount-time read exists only to tell the user whether location is
 * available at all; the punch takes its own reading, with maximumAge zero
 * so the browser cannot hand back a cached one.
 */
function usePunchPosition() {
  const [position, setPosition] = React.useState<GeolocationCoordinates | null>(null);
  const [state, setState] = React.useState<'idle' | 'asking' | 'granted' | 'denied'>('idle');

  const read = React.useCallback(
    (maximumAge: number) => new Promise<GeolocationCoordinates | null>((resolve) => {
      if (typeof navigator === 'undefined' || !navigator.geolocation) {
        setState('denied');
        resolve(null);
        return;
      }
      setState('asking');
      navigator.geolocation.getCurrentPosition(
        (p) => { setPosition(p.coords); setState('granted'); resolve(p.coords); },
        /*
         * Refusing to share a location is not an error worth a red box. The
         * server decides whether a punch without one is acceptable -- it may
         * hold it for review, and that is the right place for the decision.
         */
        () => { setState('denied'); resolve(null); },
        { enableHighAccuracy: true, timeout: 8000, maximumAge },
      );
    }),
    [],
  );

  /** A fresh fix, for the punch about to be filed. Never a cached one. */
  const capture = React.useCallback(() => read(0), [read]);
  /** A cheap one on arrival, only so the screen can say whether this will work. */
  const ask = React.useCallback(() => { void read(30_000); }, [read]);

  React.useEffect(() => { ask(); }, [ask]);
  return { position, state, ask, capture };
}

function Outcome({ result }: { result: PunchResult }) {
  if (result.kind === 'review') {
    return (
      <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-xs text-warning">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        {/*
          * Saved, and held. Saying "sent for review" rather than "failed"
          * matters: the punch is recorded either way, and somebody who
          * believes it failed will punch again and again.
          */}
        <span>Recorded and sent for review. {result.message}</span>
      </p>
    );
  }
  const record = result.record;
  return (
    <p className="flex items-start gap-2 rounded-md border border-success/40 bg-success-subtle px-3 py-2 text-xs text-success">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        Saved{record.check_out_at ? ` — out at ${clock(record.check_out_at)}` : ` — in at ${clock(record.check_in_at)}`}.
        {result.kind === 'applied' ? ' (This punch was already recorded.)' : ''}
      </span>
    </p>
  );
}

export function PunchClock() {
  const { session } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canPunch = hasPermission({ permissions: session?.permissions }, PERMISSIONS.ATTENDANCE_PUNCH);
  const { position, state: geoState, ask, capture } = usePunchPosition();
  const [result, setResult] = React.useState<PunchResult | null>(null);

  const me = useQuery({
    queryKey: ['employees', 'me'],
    queryFn: getMyEmployee,
    retry: false,
    enabled: canPunch,
  });
  const employeeId = me.data?.id ? String(me.data.id) : null;
  const today = businessToday();

  const todayQuery = useQuery({
    queryKey: ['attendance', 'today', employeeId, today],
    queryFn: () => listRecords({ employee_id: employeeId!, from: today, to: today, limit: 1 }),
    enabled: !!employeeId,
    staleTime: 15_000,
  });
  const record = todayQuery.data?.data?.[0] ?? null;
  const checkedIn = !!record?.check_in_at;
  const checkedOut = !!record?.check_out_at;
  const next: 'CHECK_IN' | 'CHECK_OUT' = checkedIn && !checkedOut ? 'CHECK_OUT' : 'CHECK_IN';

  const punch = useMutation({
    mutationFn: async () => {
      if (!employeeId) throw new Error('No employee record is linked to your account.');
      /*
       * Read the position now, for this punch. Both directions carry one:
       * where somebody finished the day answers as many questions as where
       * they started it, and a check-out with no location is exactly the
       * gap a geofence is meant to close.
       */
      const here = await capture();
      return punchEvent({
        employee_id: employeeId,
        event_type: next,
        client_timestamp: new Date().toISOString(),
        ...(here ? {
          latitude: here.latitude,
          longitude: here.longitude,
          gps_accuracy: here.accuracy,
        } : {}),
      });
    },
    onSuccess: async (r) => {
      setResult(r);
      toast.success(next === 'CHECK_IN' ? 'Punched in' : 'Punched out');
      await queryClient.invalidateQueries({ queryKey: ['attendance'] });
    },
    onError: (e) => toast.error('Could not save the punch',
      e instanceof Error ? e.message : undefined),
  });

  if (!canPunch) return null;
  if (me.isLoading) return <Skeleton className="h-28 w-full" />;

  /*
   * A login with no employee record behind it -- an integration account, or
   * somebody set up before the register existed. Said plainly, because the
   * alternative is a button that fails every time it is pressed.
   */
  if (me.isError || !employeeId) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4 text-xs text-text-muted">
        Your login is not linked to an employee record, so there is nothing to mark attendance
        against. An administrator can link it under Administration → Users.
      </div>
    );
  }

  return (
    <section aria-label="Punch clock"
      className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text">Your attendance today</h2>
          <p className="mt-0.5 text-xs text-text-muted">{day(today)}</p>
        </div>
        <div className="flex items-center gap-2">
          {checkedOut ? (
            <Badge tone="success">Done for the day</Badge>
          ) : checkedIn ? (
            <Badge tone="warning">In since {clock(record?.check_in_at)}</Badge>
          ) : (
            <Badge tone="neutral">Not punched in</Badge>
          )}
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-3 border-y border-border py-3 text-xs">
        <div>
          <dt className="text-text-muted">Punched in</dt>
          <dd className="mt-0.5 tabular-nums text-text">{clock(record?.check_in_at)}</dd>
        </div>
        <div>
          <dt className="text-text-muted">Punched out</dt>
          <dd className="mt-0.5 tabular-nums text-text">{clock(record?.check_out_at)}</dd>
        </div>
        <div>
          <dt className="text-text-muted">Hours</dt>
          <dd className="mt-0.5 tabular-nums text-text">
            {record?.total_hours != null ? Number(record.total_hours).toFixed(2) : '—'}
          </dd>
        </div>
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          onClick={() => punch.mutate()}
          disabled={punch.isPending || todayQuery.isLoading || (checkedIn && checkedOut)}
        >
          {punch.isPending ? <Loader2 className="animate-spin" />
            : next === 'CHECK_IN' ? <LogIn /> : <LogOut />}
          {checkedIn && checkedOut ? 'Already punched out'
            : next === 'CHECK_IN' ? 'Punch in' : 'Punch out'}
        </Button>

        <span className="flex items-center gap-1 text-2xs text-text-subtle">
          <MapPin className="size-3.5" aria-hidden />
          {geoState === 'granted'
            ? `Location on, to about ${Math.round(position?.accuracy ?? 0)} m — taken again when you punch`
            : geoState === 'asking' ? 'Finding your location…'
            : 'No location — the punch still saves, and may be held for review'}
          {geoState === 'denied' ? (
            <button type="button" onClick={ask} className="ml-1 underline">try again</button>
          ) : null}
        </span>
      </div>

      {result ? <div className="mt-3"><Outcome result={result} /></div> : null}
    </section>
  );
}
