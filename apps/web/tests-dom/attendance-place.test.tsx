/**
 * Coordinates and places on punches, and the picker on the on-behalf form.
 *
 * Three things the owner asked for on the attendance screens: the person
 * is picked by name rather than pasted as an id; a device clock ahead of
 * the server is explained as such, in the server's words; and every punch
 * says where it was made -- the village or town, and the grid reference a
 * surveyor reads.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiClientError } from '@/lib/apiClient';

const BALA = { id: 'e-bala', emp_no: 'EMP-007', first_name: 'Bala', last_name: 'Krishna', designation: 'Driver', status: 'ACTIVE', version: 1 };

const punchEvent = vi.fn(async (_i: Record<string, unknown>) => ({
  kind: 'accepted' as const,
  event: { id: 'ev1' }, record: { id: 'r1', work_date: '2026-09-23', check_in_at: '2026-09-23T03:44:00.000Z', check_out_at: null },
}));
const listEmployees = vi.fn(async (_p: unknown) => ({ data: [BALA], next_cursor: null, has_more: false }));
const getEmployee = vi.fn(async (_id: string) => BALA);
const getMyEmployee = vi.fn(async () => ({ id: 'e1', emp_no: 'EMP1' }) as unknown);
const listMyRecords = vi.fn(async (_p: unknown) => ({ data: [] as unknown[] }));

vi.mock('@/lib/employees', () => ({
  listEmployees: (p: unknown) => listEmployees(p),
  getEmployee: (id: string) => getEmployee(id),
  getMyEmployee: () => getMyEmployee(),
}));
vi.mock('@/lib/attendance', async () => {
  const real = await vi.importActual<typeof import('@/lib/attendance')>('@/lib/attendance');
  return {
    ...real,
    punchEvent: (i: Record<string, unknown>) => punchEvent(i),
    listMyRecords: (p: unknown) => listMyRecords(p),
  };
});
vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({ session: { permissions: ['attendance.punch', 'attendance.decide', 'employee.read'], user: { username: 'r.kumar' } } }),
}));

const { PunchPanel } = await import('@/components/PunchPanel');
const { PunchClock } = await import('@/components/PunchClock');
const { EventPosition, PlaceName } = await import('@/components/PunchPlace');

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

let here: Record<string, number | null> = { latitude: 17.4617, longitude: 78.3594, accuracy: 9, altitude: null, altitudeAccuracy: null };
Object.defineProperty(navigator, 'geolocation', {
  configurable: true,
  value: { getCurrentPosition: (ok: PositionCallback) => ok({ coords: { ...here } } as unknown as GeolocationPosition) },
});

beforeEach(() => {
  punchEvent.mockClear();
  listEmployees.mockClear();
  listMyRecords.mockReset().mockResolvedValue({ data: [] });
  here = { latitude: 17.4617, longitude: 78.3594, accuracy: 9, altitude: null, altitudeAccuracy: null };
});

describe('punching on behalf of somebody', () => {
  it('picks the employee by name and sends their id', async () => {
    wrap(<PunchPanel />);
    const box = await screen.findByRole('combobox');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'bala' } });
    fireEvent.click(await screen.findByRole('option', { name: /Bala Krishna/ }));
    fireEvent.click(screen.getByRole('button', { name: /punch in now/i }));
    await waitFor(() => expect(punchEvent).toHaveBeenCalledTimes(1));
    expect(punchEvent.mock.calls[0][0]).toMatchObject({ employee_id: 'e-bala', event_type: 'CHECK_IN' });
    // No box asks for an id any more.
    expect(screen.queryByPlaceholderText(/Employee ID/)).toBeNull();
  });

  it('says plainly that the device clock is ahead when the server refuses a future punch', async () => {
    punchEvent.mockRejectedValueOnce(new ApiClientError(422, {
      code: 'FUTURE_PUNCH',
      message: "This device's clock is ahead of the server by 8 minutes (up to 5 is allowed). Set the device's date and time to automatic, or correct it, and punch again.",
    } as never));
    wrap(<PunchPanel />);
    const box = await screen.findByRole('combobox');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'bala' } });
    fireEvent.click(await screen.findByRole('option', { name: /Bala Krishna/ }));
    fireEvent.click(screen.getByRole('button', { name: /punch in now/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Punch rejected: this device.s clock is ahead/);
    expect(alert.textContent).toMatch(/ahead of the server by 8 minutes/);
    expect(alert.textContent).toMatch(/date and time/);
  });
});

describe('the punch clock and where the last punch was made', () => {
  it('names the place the day was started from', async () => {
    listMyRecords.mockResolvedValue({ data: [{
      id: 'r1', check_in_at: '2026-09-23T03:44:00.000Z', check_out_at: null, total_hours: null,
      check_in_place_name: 'Kondapur, Hyderabad, Telangana', check_in_place_status: 'named',
    }] });
    wrap(<PunchClock />);
    const line = await screen.findByTestId('last-punch-place');
    expect(line.textContent).toBe('Punched in from Kondapur, Hyderabad, Telangana');
  });

  it('says the name is still being looked up rather than that there is none', async () => {
    listMyRecords.mockResolvedValue({ data: [{
      id: 'r1', check_in_at: '2026-09-23T03:44:00.000Z', check_out_at: '2026-09-23T12:10:00.000Z', total_hours: 8.4,
      check_in_place_name: 'Kondapur, Hyderabad, Telangana', check_in_place_status: 'named',
      check_out_place_name: null, check_out_place_status: 'resolving',
    }] });
    wrap(<PunchClock />);
    const line = await screen.findByTestId('last-punch-place');
    expect(line.textContent).toBe('Punched out from resolving…');
  });

  it('sends the altitude when the browser has one, and nothing when it has not', async () => {
    here = { latitude: 17.4617, longitude: 78.3594, accuracy: 9, altitude: 512.3, altitudeAccuracy: 30 };
    wrap(<PunchClock />);
    const button = await screen.findByRole('button', { name: /punch in/i });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(punchEvent).toHaveBeenCalledTimes(1));
    expect(punchEvent.mock.calls[0][0]).toMatchObject({ latitude: 17.4617, altitude: 512.3, altitude_accuracy: 30 });
  });
});

describe('what a punch says about where it was made', () => {
  it('prints the grid reference with its datum, the geographic position and both heights, labelled', () => {
    render(<EventPosition event={{
      id: 'ev', employee_id: 'e', event_type: 'CHECK_IN', client_timestamp: '2026-09-23T03:44:00.000Z',
      latitude: 17.385, longitude: 78.4867, gps_accuracy: 7.6,
      altitude: 600, altitude_accuracy: 20, height_egm96: 677.09,
      utm_zone: 44, utm_hemisphere: 'N', utm_easting: 232957.62, utm_northing: 1923897.27,
      place_name: 'Charminar, Hyderabad, Telangana', place_status: 'named',
    }} />);
    expect(screen.getByText('UTM 44N E 232,957.62 N 1,923,897.27')).toBeInTheDocument();
    expect(screen.getByText('UTM (WGS-1984)')).toBeInTheDocument();
    expect(screen.getByText(/17\.385000, 78\.486700 · ±8 m/)).toBeInTheDocument();
    expect(screen.getByText('Altitude (WGS84 ellipsoid)')).toBeInTheDocument();
    expect(screen.getByText(/600\.0 m · ±20 m/)).toBeInTheDocument();
    expect(screen.getByText('Height (EGM96 geoid)')).toBeInTheDocument();
    expect(screen.getByText('677.09 m')).toBeInTheDocument();
    expect(screen.getByText('Charminar, Hyderabad, Telangana')).toBeInTheDocument();
  });

  it('says so when the punch carried no position, and leaves out heights it does not have', () => {
    const { unmount } = render(<EventPosition event={{
      id: 'ev', employee_id: 'e', event_type: 'CHECK_IN', client_timestamp: '2026-09-23T03:44:00.000Z',
    }} />);
    expect(screen.getByText(/No position was recorded/)).toBeInTheDocument();
    unmount();
    render(<EventPosition event={{
      id: 'ev', employee_id: 'e', event_type: 'CHECK_IN', client_timestamp: '2026-09-23T03:44:00.000Z',
      latitude: 17.385, longitude: 78.4867, place_status: 'resolving',
    }} />);
    expect(screen.queryByText(/Altitude/)).toBeNull();
    expect(screen.queryByText(/EGM96/)).toBeNull();
    // Rows from before the migration have no UTM until the backfill has run.
    expect(screen.getByText(/not yet computed/)).toBeInTheDocument();
    expect(screen.getByText('resolving…')).toBeInTheDocument();
  });

  it('prints a place in a word', () => {
    const { rerender } = render(<PlaceName name="Kolluru, Nellore, Andhra Pradesh" status="named" />);
    expect(screen.getByText('Kolluru, Nellore, Andhra Pradesh')).toBeInTheDocument();
    rerender(<PlaceName name={null} status="unnamed" />);
    expect(screen.getByText('unnamed place')).toBeInTheDocument();
    rerender(<PlaceName name={null} status="none" />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
