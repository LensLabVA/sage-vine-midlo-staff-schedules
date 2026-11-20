// process-schedule
//
// Given an upload_batches row (batch_id) and the parsed shift CSV rows, this
// function computes out-of-office (OOO) blocks for every active staff member at
// the batch's location and pushes them to each person's Google Calendar.
//
// Core rules:
//   * Staff are READ FROM the `employees` table filtered by location_id — never
//     hardcoded.
//   * A day with no CSV shift row for an employee = that person is OFF that day =
//     block the whole working day (store open -> close) as OOO.
//   * On a day the employee works, block the store-open window BEFORE the shift
//     and AFTER the shift (the non-working portions of the day).
//   * Blocks shorter than MIN_THRESHOLD_MINUTES (15) are skipped.
//   * Planning window is capped at MAX_DAYS_AHEAD (365).
//   * All date/time math is in America/New_York.
//   * A delay (DELAY_MS) is inserted between Google Calendar calls to avoid rate
//     limiting.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handlePreflight } from "../_shared/cors.ts";
import {
  datesInWindow,
  dayOfWeek,
  MAX_DAYS_AHEAD,
  meetsThreshold,
  minutesToTime,
  sleep,
  timeToMinutes,
  toCalendarDateTime,
} from "../_shared/time.ts";

// Delay between Google Calendar API calls. The Calendar API enforces
// per-user/per-project quotas; spacing calls out keeps a large staff x 365-day
// run from tripping rate limits (429 / rateLimitExceeded).
const DELAY_MS = 250;

// How many days ahead to plan. Capped by MAX_DAYS_AHEAD.
const PLANNING_DAYS = MAX_DAYS_AHEAD;

// --- Types -----------------------------------------------------------------

interface ShiftRow {
  // Identifier used to match the CSV row to an employee. Could be a name or a
  // Boulevard staff id depending on the export — matched flexibly below.
  staff: string;
  date: string; // YYYY-MM-DD
  start: string; // HH:MM[:SS]
  end: string; // HH:MM[:SS]
}

interface RequestBody {
  batch_id: string;
  shifts: ShiftRow[];
}

interface Employee {
  id: string;
  location_id: string;
  full_name: string;
  google_calendar_id: string | null;
  boulevard_staff_id: string | null;
  active: boolean;
}

interface StoreHour {
  day_of_week: number;
  open_time: string | null;
  close_time: string | null;
  closed: boolean;
}

// A computed OOO block before it is written / pushed.
interface OooBlock {
  employee_id: string;
  google_calendar_id: string | null;
  event_date: string;
  start_time: string | null;
  end_time: string | null;
  all_day: boolean;
}

serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const { batch_id, shifts }: RequestBody = await req.json();
    if (!batch_id) return json({ error: "batch_id is required" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Mark the batch as processing.
    const { data: batch, error: batchErr } = await supabase
      .from("upload_batches")
      .update({ status: "processing" })
      .eq("id", batch_id)
      .select("id, location_id")
      .single();
    if (batchErr || !batch) {
      return json({ error: `batch not found: ${batchErr?.message}` }, 404);
    }
    const locationId = batch.location_id as string;

    // Load active employees for THIS location (never hardcoded).
    const { data: employees, error: empErr } = await supabase
      .from("employees")
      .select(
        "id, location_id, full_name, google_calendar_id, boulevard_staff_id, active",
      )
      .eq("location_id", locationId)
      .eq("active", true);
    if (empErr) throw empErr;

    // Load store hours for this location, keyed by day_of_week.
    const { data: hoursRows, error: hoursErr } = await supabase
      .from("store_hours")
      .select("day_of_week, open_time, close_time, closed")
      .eq("location_id", locationId);
    if (hoursErr) throw hoursErr;
    const hoursByDow = new Map<number, StoreHour>();
    for (const h of (hoursRows ?? []) as StoreHour[]) {
      hoursByDow.set(h.day_of_week, h);
    }

    // Index shifts by employee+date for O(1) lookup. An employee may have
    // multiple matching identifiers; we match on full_name or boulevard_staff_id.
    const shiftKey = (staffMatch: string, date: string) =>
      `${staffMatch.trim().toLowerCase()}::${date}`;
    const shiftsByKey = new Map<string, ShiftRow>();
    for (const s of shifts ?? []) {
      shiftsByKey.set(shiftKey(s.staff, s.date), s);
    }

    // Planning window: today .. today + PLANNING_DAYS (capped at MAX_DAYS_AHEAD).
    const today = new Date();
    const windowDays = Math.min(PLANNING_DAYS, MAX_DAYS_AHEAD);
    const dates = datesInWindow(today, windowDays);

    // --- Compute OOO blocks ---------------------------------------------------
    const blocks: OooBlock[] = [];
    let skipped = 0;

    for (const emp of (employees ?? []) as Employee[]) {
      for (const date of dates) {
        const dow = dayOfWeek(date);
        const hours = hoursByDow.get(dow);

        // Store closed that day (or no hours configured) -> nothing to block.
        if (!hours || hours.closed) continue;

        const openMin = timeToMinutes(hours.open_time);
        const closeMin = timeToMinutes(hours.close_time);
        if (openMin === null || closeMin === null || closeMin <= openMin) {
          continue;
        }

        // Find a shift for this employee on this date. Match on name or
        // Boulevard id so the CSV identifier can be either.
        const shift =
          shiftsByKey.get(shiftKey(emp.full_name, date)) ??
          (emp.boulevard_staff_id
            ? shiftsByKey.get(shiftKey(emp.boulevard_staff_id, date))
            : undefined);

        if (!shift) {
          // No CSV row = OFF that day = block the whole working day.
          blocks.push({
            employee_id: emp.id,
            google_calendar_id: emp.google_calendar_id,
            event_date: date,
            start_time: minutesToTime(openMin),
            end_time: minutesToTime(closeMin),
            all_day: false,
          });
          continue;
        }

        // Working day: block the store-open time BEFORE and AFTER the shift.
        const shiftStart = timeToMinutes(shift.start);
        const shiftEnd = timeToMinutes(shift.end);
        if (shiftStart === null || shiftEnd === null) {
          // Malformed shift time -> treat as off (whole working day blocked).
          blocks.push({
            employee_id: emp.id,
            google_calendar_id: emp.google_calendar_id,
            event_date: date,
            start_time: minutesToTime(openMin),
            end_time: minutesToTime(closeMin),
            all_day: false,
          });
          continue;
        }

        // Block before the shift: [open, shiftStart)
        const beforeStart = openMin;
        const beforeEnd = Math.min(shiftStart, closeMin);
        if (beforeEnd > beforeStart && meetsThreshold(beforeStart, beforeEnd)) {
          blocks.push({
            employee_id: emp.id,
            google_calendar_id: emp.google_calendar_id,
            event_date: date,
            start_time: minutesToTime(beforeStart),
            end_time: minutesToTime(beforeEnd),
            all_day: false,
          });
        } else if (beforeEnd > beforeStart) {
          skipped++; // under the 15-min threshold
        }

        // Block after the shift: [shiftEnd, close)
        const afterStart = Math.max(shiftEnd, openMin);
        const afterEnd = closeMin;
        if (afterEnd > afterStart && meetsThreshold(afterStart, afterEnd)) {
          blocks.push({
            employee_id: emp.id,
            google_calendar_id: emp.google_calendar_id,
            event_date: date,
            start_time: minutesToTime(afterStart),
            end_time: minutesToTime(afterEnd),
            all_day: false,
          });
        } else if (afterEnd > afterStart) {
          skipped++; // under the 15-min threshold
        }
      }
    }

    // --- Persist ooo_events as pending ---------------------------------------
    // TODO: decide a re-run strategy (clear existing future OOO for this
    // location/batch) so re-uploads don't create duplicate blocks.
    const { data: inserted, error: insErr } = await supabase
      .from("ooo_events")
      .insert(
        blocks.map((b) => ({
          employee_id: b.employee_id,
          batch_id,
          event_date: b.event_date,
          start_time: b.start_time,
          end_time: b.end_time,
          all_day: b.all_day,
          status: "pending",
        })),
      )
      .select("id");
    if (insErr) throw insErr;

    // --- Push each block to Google Calendar ----------------------------------
    let created = 0;
    let failed = 0;

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const row = inserted?.[i];
      if (!row) continue;

      try {
        const googleEventId = await createGoogleOOOEvent(block);
        await supabase
          .from("ooo_events")
          .update({ status: "created", google_event_id: googleEventId })
          .eq("id", row.id);
        created++;
      } catch (err) {
        await supabase
          .from("ooo_events")
          .update({ status: "failed", error: String(err) })
          .eq("id", row.id);
        failed++;
      }

      // Space out Google calls to avoid rate limiting (see DELAY_MS note above).
      await sleep(DELAY_MS);
    }

    return json({ batch_id, created, failed, skipped });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});

// Creates an out-of-office / busy event on the employee's Google Calendar and
// returns the created event id.
//
// TODO: wire Google service-account / OAuth token. The real implementation must
// obtain an access token (service account with domain-wide delegation, or stored
// per-user OAuth) and set `Authorization: Bearer <token>`. The auth model is
// still undecided (see PLAN.md open questions).
async function createGoogleOOOEvent(block: OooBlock): Promise<string> {
  if (!block.google_calendar_id) {
    throw new Error("employee has no google_calendar_id");
  }

  // TODO: replace with a real token fetch.
  const accessToken = Deno.env.get("GOOGLE_ACCESS_TOKEN");
  if (!accessToken) {
    throw new Error("GOOGLE_ACCESS_TOKEN not configured");
  }

  const calendarId = encodeURIComponent(block.google_calendar_id);
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`;

  // Pair local dateTime with the America/New_York time zone so Google resolves
  // the correct UTC instant across DST without us doing offset math.
  const start = toCalendarDateTime(block.event_date, block.start_time!);
  const end = toCalendarDateTime(block.event_date, block.end_time!);

  const body = {
    summary: "Out of office",
    // "outOfOffice" renders as an OOO block; it reads as busy to HighLevel.
    eventType: "outOfOffice",
    transparency: "opaque", // busy
    visibility: "private",
    start,
    end,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Calendar insert failed (${res.status}): ${text}`);
  }

  const created = await res.json();
  return created.id as string;
}
