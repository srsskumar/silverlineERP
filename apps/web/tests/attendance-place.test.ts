import { describe, expect, it } from 'vitest';
import { normalizeRecordDetail, normalizeRecordsPage, placeLabel } from '../lib/attendance';

/*
 * A punch's place, in a word. The name once the worker has been; a note
 * that it is still being looked up while it has not, so the reader does
 * not take a gap for "nowhere"; a dash for a punch with no position.
 */
describe('placeLabel', () => {
  it('prefers the name whatever the status says', () => {
    expect(placeLabel('Kondapur, Hyderabad, Telangana', 'named')).toBe('Kondapur, Hyderabad, Telangana');
    expect(placeLabel('Kondapur, Hyderabad, Telangana', undefined)).toBe('Kondapur, Hyderabad, Telangana');
  });

  it('says a name is coming, or that none could be found, or that there was no position', () => {
    expect(placeLabel(null, 'resolving')).toBe('resolving…');
    expect(placeLabel(null, 'unnamed')).toBe('unnamed place');
    expect(placeLabel(null, 'none')).toBe('—');
    // A row from an older API, with no status at all, is simply blank.
    expect(placeLabel(undefined, undefined)).toBe('—');
  });
});

describe('records carry the person and the places through the normalizers', () => {
  it('keeps employee_name, emp_no and the place fields on a list row', () => {
    const page = normalizeRecordsPage({ data: [{
      id: 'r1', employee_id: 'e1', employee_name: 'Anita Rao', employee_emp_no: 'EMP-042', work_date: '2026-09-23',
      status: 'PARTIAL', version: 1, check_in_place_name: 'Kolluru, Nellore, Andhra Pradesh', check_in_place_status: 'named',
    }], has_more: false, next_cursor: null });
    expect(page.data[0]).toMatchObject({ employee_name: 'Anita Rao', employee_emp_no: 'EMP-042', check_in_place_status: 'named' });
  });

  it('keeps UTM, heights and the place on the detail events', () => {
    const detail = normalizeRecordDetail({
      id: 'r1', employee_id: 'e1', work_date: '2026-09-23', status: 'PARTIAL', version: 1,
      events: [{
        id: 'ev', employee_id: 'e1', event_type: 'CHECK_IN', client_timestamp: '2026-09-23T03:44:00.000Z',
        utm_zone: 44, utm_hemisphere: 'N', utm_easting: 232957.62, utm_northing: 1923897.27, height_egm96: 677.09,
        place_name: null, place_status: 'resolving',
      }],
    });
    expect(detail.events[0]).toMatchObject({ utm_zone: 44, utm_hemisphere: 'N', height_egm96: 677.09, place_status: 'resolving' });
  });
});
