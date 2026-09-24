/**
 * The date a form defaults to: today, in India (fix round 1, item 4).
 *
 * new Date().toISOString().slice(0, 10) is the UTC day, which is yesterday
 * until 05:30 IST, so a claim entered at 1 a.m. was dated the day before.
 */
import { businessDay } from "@silverline/shared";

export function formToday(at: Date = new Date()): string {
  return businessDay(at);
}
