// Time / timezone / threshold helpers shared by the edge functions.
//
// All scheduling math for this project happens in America/New_York. These
// helpers keep the timezone, threshold and planning-window rules in one place so
// the business logic reads cleanly.

export const TIME_ZONE = "America/New_York";

// Shift/gap differences shorter than this are ignored (no micro OOO blocks).
export const MIN_THRESHOLD_MINUTES = 15;

// Never schedule further than this into the future.
export const MAX_DAYS_AHEAD = 365;

// "HH:MM" or "HH:MM:SS" -> minutes since midnight. Returns null for empty input.
export function timeToMinutes(t: string | null | undefined): number | null {
  if (!t) return null;
  const [h, m] = t.split(":");
  const hours = Number(h);
  const mins = Number(m);
  if (Number.isNaN(hours) || Number.isNaN(mins)) return null;
  return hours * 60 + mins;
}

// Minutes since midnight -> "HH:MM:SS" (Postgres `time` friendly).
export function minutesToTime(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
}

// True if a block [startMin, endMin) is long enough to be worth creating.
export function meetsThreshold(startMin: number, endMin: number): boolean {
  return endMin - startMin >= MIN_THRESHOLD_MINUTES;
}

// The day-of-week (0=Sunday..6=Saturday) for a `YYYY-MM-DD` date string,
// interpreted at noon UTC to avoid off-by-one around midnight.
export function dayOfWeek(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

// Inclusive list of `YYYY-MM-DD` strings from `start` for `days` days.
// Capped by the caller at MAX_DAYS_AHEAD.
export function datesInWindow(start: Date, days: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Build an RFC3339 timestamp with an explicit IANA time zone for the Google
// Calendar events.insert payload. Google accepts a local dateTime plus a
// timeZone field; keeping them paired avoids UTC/DST drift.
export function toCalendarDateTime(
  dateStr: string,
  timeStr: string,
): { dateTime: string; timeZone: string } {
  // timeStr is "HH:MM:SS"; Google pairs the local dateTime with timeZone.
  return { dateTime: `${dateStr}T${timeStr}`, timeZone: TIME_ZONE };
}

// Simple delay used to space out Google Calendar API calls (rate limiting).
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
