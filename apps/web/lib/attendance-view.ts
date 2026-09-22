import { hasPermission, PERMISSIONS } from './permissions';

/**
 * What the attendance page is, for this session.
 *
 * Two things live at /attendance: the punch clock, which is yours and needs
 * only attendance.punch, and the register of everybody's days, which needs
 * attendance.read. The page used to be gated on the second alone, so an
 * EMPLOYEE -- the role the punch clock exists for -- was refused at the door
 * and had no way to mark the day from the web.
 */
export type AttendanceView = 'full' | 'punch' | 'none';

export function attendanceView(permissions: string[] | undefined): AttendanceView {
  const actor = { permissions };
  if (hasPermission(actor, PERMISSIONS.ATTENDANCE_READ)) return 'full';
  if (hasPermission(actor, PERMISSIONS.ATTENDANCE_PUNCH)) return 'punch';
  return 'none';
}
