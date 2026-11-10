export const DEFAULT_SCHEDULE_TIMEZONE = 'Asia/Taipei';

/** Calendar date (YYYY-MM-DD) of a moment in the given timezone. */
export function localDate(time: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(time);
}
