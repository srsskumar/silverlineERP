/**
 * §079 -- punching in, for the person doing it.
 *
 * The page already had a punch form; its own heading called it "Manual
 * punch (testing / admin)", it wanted an employee picked from a list and a
 * latitude typed in, and office staff consequently had no way to mark their
 * own attendance from the web at all.
 *
 * What is asserted here is the difference: it knows who you are, it knows
 * which way round the punch goes, it saves without a location, and it never
 * tells somebody a recorded punch failed.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const getMyEmployee = vi.fn(async () => ({ id: 'e1', emp_no: 'EMP1' }) as unknown);
const listRecords = vi.fn(async (_p: unknown) => ({ data: [] as unknown[] }));
const punchEvent = vi.fn(async (_i: {
  employee_id: string; event_type: string;
  latitude?: number; longitude?: number; gps_accuracy?: number;
}) => ({
  kind: 'accepted' as const,
  event: {}, record: { check_in_at: '2026-09-21T03:44:00.000Z', check_out_at: null },
}));

vi.mock('@/lib/employees', () => ({ getMyEmployee: () => getMyEmployee() }));
vi.mock('@/lib/attendance', () => ({
  listRecords: (p: unknown) => listRecords(p),
  punchEvent: (i: Parameters<typeof punchEvent>[0]) => punchEvent(i),
}));
vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({ session: { permissions: ['attendance.punch'], user: { username: 'r.kumar' } } }),
}));

const { PunchClock } = await import('@/components/PunchClock');

/*
 * The button stays disabled until today's record has loaded -- otherwise you
 * could punch in while already in, which is the bug the disable exists to
 * stop. Every test that presses it has to wait for that.
 */
async function ready(name: RegExp): Promise<HTMLButtonElement> {
  const button = await screen.findByRole('button', { name }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
}

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

/** Every getCurrentPosition call, so a test can see when one was taken. */
const reads: Array<{ maximumAge: number | undefined }> = [];
let here = { latitude: 15.83, longitude: 78.04, accuracy: 12 };

function geolocation(mode: 'granted' | 'denied') {
  reads.length = 0;
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (
        ok: PositionCallback, fail: PositionErrorCallback, opts?: PositionOptions,
      ) => {
        reads.push({ maximumAge: opts?.maximumAge });
        return mode === 'granted'
          ? ok({ coords: { ...here } } as GeolocationPosition)
          : fail({ code: 1, message: 'denied' } as GeolocationPositionError);
      },
    },
  });
}

beforeEach(() => {
  getMyEmployee.mockReset().mockResolvedValue({ id: 'e1', emp_no: 'EMP1' });
  listRecords.mockReset().mockResolvedValue({ data: [] });
  punchEvent.mockClear();
  here = { latitude: 15.83, longitude: 78.04, accuracy: 12 };
  geolocation('granted');
});

describe('which way the punch goes', () => {
  it('offers to punch in when nothing has been recorded today', async () => {
    wrap(<PunchClock />);
    expect(await screen.findByRole('button', { name: /punch in/i })).toBeTruthy();
    expect(screen.getByText(/not punched in/i)).toBeTruthy();
  });

  it('offers to punch out once you are in, and says since when', async () => {
    listRecords.mockResolvedValue({ data: [{
      id: 'r1', check_in_at: '2026-09-21T03:44:00.000Z', check_out_at: null, total_hours: null,
    }] });
    wrap(<PunchClock />);
    expect(await screen.findByRole('button', { name: /punch out/i })).toBeTruthy();
    // 03:44 UTC is 09:14 in the only time zone this system uses.
    expect(screen.getByText(/in since 09:14/i)).toBeTruthy();
  });

  it('stops offering anything once the day is closed', async () => {
    listRecords.mockResolvedValue({ data: [{
      id: 'r1', check_in_at: '2026-09-21T03:44:00.000Z',
      check_out_at: '2026-09-21T12:32:00.000Z', total_hours: 8.8,
    }] });
    wrap(<PunchClock />);
    const button = await screen.findByRole('button', { name: /already punched out/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('8.80')).toBeTruthy();
  });
});

describe('saving', () => {
  it('sends the punch for whoever is signed in, with no picker', async () => {
    wrap(<PunchClock />);
    fireEvent.click(await ready(/punch in/i));
    await waitFor(() => expect(punchEvent).toHaveBeenCalledTimes(1));
    expect(punchEvent.mock.calls[0][0]).toMatchObject({
      employee_id: 'e1', event_type: 'CHECK_IN', latitude: 15.83,
    });
  });

  it('saves without a location rather than refusing to', async () => {
    /*
     * The server decides whether a punch with no position is acceptable --
     * it may hold it for review, which is the right place for that call.
     * Refusing here would just mean the day goes unmarked.
     */
    geolocation('denied');
    wrap(<PunchClock />);
    const button = await ready(/punch in/i);
    expect(screen.getByText(/the punch still saves/i)).toBeTruthy();

    fireEvent.click(button);
    await waitFor(() => expect(punchEvent).toHaveBeenCalledTimes(1));
    expect(punchEvent.mock.calls[0][0]).not.toHaveProperty('latitude');
  });

  it('never calls a recorded punch a failure', async () => {
    /*
     * A 202 means saved and held. Somebody told it failed punches again,
     * and again, and the exception queue fills with their attempts.
     */
    punchEvent.mockResolvedValue({
      kind: 'review', code: 'OUTSIDE_FENCE', exception_id: 'x1',
      message: 'You are not inside a work site.',
    } as never);
    wrap(<PunchClock />);
    fireEvent.click(await ready(/punch in/i));
    expect(await screen.findByText(/recorded and sent for review/i)).toBeTruthy();
  });
});

describe('an account with nobody behind it', () => {
  it('says so instead of offering a button that always fails', async () => {
    getMyEmployee.mockRejectedValue(new Error('404'));
    wrap(<PunchClock />);
    expect(await screen.findByText(/not linked to an employee record/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /punch/i })).toBeNull();
  });
});

describe('where the punch was made', () => {
  it('reads the position again at the punch, not the one from page load', async () => {
    /*
     * This is the bug the first version had: one fix taken when the page
     * opened, sent with whatever was pressed afterwards. Punch in at nine
     * and out at six from the same tab and both would have been filed from
     * the morning's position -- worse than no location, because a wrong one
     * looks authoritative and passes a geofence it should fail.
     */
    wrap(<PunchClock />);
    const button = await ready(/punch in/i);
    const atLoad = reads.length;

    // The crew has walked to the next village since the page opened.
    here = { latitude: 15.91, longitude: 78.17, accuracy: 8 };
    fireEvent.click(button);

    await waitFor(() => expect(punchEvent).toHaveBeenCalledTimes(1));
    expect(reads.length).toBeGreaterThan(atLoad);
    expect(punchEvent.mock.calls[0][0]).toMatchObject({ latitude: 15.91, gps_accuracy: 8 });
  });

  it('refuses a cached fix for the punch itself', async () => {
    wrap(<PunchClock />);
    fireEvent.click(await ready(/punch in/i));
    await waitFor(() => expect(punchEvent).toHaveBeenCalledTimes(1));
    // The last read is the punch's own, and it may not come from the cache.
    expect(reads[reads.length - 1].maximumAge).toBe(0);
  });

  it('carries a position on the way out as well as the way in', async () => {
    listRecords.mockResolvedValue({ data: [{
      id: 'r1', check_in_at: '2026-09-21T03:44:00.000Z', check_out_at: null, total_hours: null,
    }] });
    here = { latitude: 15.95, longitude: 78.22, accuracy: 15 };
    wrap(<PunchClock />);
    fireEvent.click(await ready(/punch out/i));
    await waitFor(() => expect(punchEvent).toHaveBeenCalledTimes(1));
    expect(punchEvent.mock.calls[0][0]).toMatchObject({
      event_type: 'CHECK_OUT', latitude: 15.95, longitude: 78.22, gps_accuracy: 15,
    });
  });

  it('still punches out when the location has stopped working since the morning', async () => {
    listRecords.mockResolvedValue({ data: [{
      id: 'r1', check_in_at: '2026-09-21T03:44:00.000Z', check_out_at: null, total_hours: null,
    }] });
    wrap(<PunchClock />);
    const button = await ready(/punch out/i);
    geolocation('denied');
    fireEvent.click(button);
    await waitFor(() => expect(punchEvent).toHaveBeenCalledTimes(1));
    expect(punchEvent.mock.calls[0][0]).not.toHaveProperty('latitude');
    expect(punchEvent.mock.calls[0][0]).toMatchObject({ event_type: 'CHECK_OUT' });
  });
});
