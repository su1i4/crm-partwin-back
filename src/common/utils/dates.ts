import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

export const DEFAULT_TZ = 'Asia/Bishkek';

/** Начало «дня» в часовом поясе точки, в UTC (ТЗ 2.4.4). */
export function startOfLocalDay(date: Date, tz: string = DEFAULT_TZ): Date {
  return dayjs(date).tz(tz).startOf('day').toDate();
}

/** Дата (YYYY-MM-DD) в часовом поясе точки. */
export function localDateString(date: Date, tz: string = DEFAULT_TZ): string {
  return dayjs(date).tz(tz).format('YYYY-MM-DD');
}

export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export { dayjs };
