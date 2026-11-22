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
  // Optional descriptive fields from the Boulevard export. The exact column is
  // unknown, so any of these may carry the "Unavailable" day-off marker (Fix 2).
  label?: string;
  type?: string;
  service?: string;
  notes?: string;
}

interface RequestBody {
  batch_id: string;
  shifts: ShiftRow[];
  // Optional Tally "cutoff date" (YYYY-MM-DD). When present it is preferred over
  // the CSV's last shift date as the upper bound of the planning window (Fix 1).
  cutoff_date?: string;
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
    const { batch_id, shifts, cutoff_date }: RequestBody = await req.json();
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

    // Index shifts by employee+date. Fix 3: a staff member can have MULTIPLE rows
    // on one day (split shifts), so each key maps to an ARRAY of rows — no more
    // last-write-wins. Matching is on full_name or boulevard_staff_id.
    const shiftKey = (staffMatch: string, date: string) =>
      `${staffMatch.trim().toLowerCase()}::${date}`;
    const shiftsByKey = new Map<string, ShiftRow[]>();
    for (const s of shifts ?? []) {
      const key = shiftKey(s.staff, s.date);
      const arr = shiftsByKey.get(key);
      if (arr) arr.push(s);
      else shiftsByKey.set(key, [s]);
    }

    // Fix 1: compute the CSV's OWN date range. The "no row = off" full-day block
    // is only applied to dates inside this range; dates outside it (e.g. past the
    // last CSV day) are left completely alone.
    let csvMinDate: string | null = null; // lexicographic min works for YYYY-MM-DD
    let csvMaxDate: string | null = null;
    for (const s of shifts ?? []) {
      if (!s.date) continue;
      if (csvMinDate === null || s.date < csvMinDate) csvMinDate = s.date;
      if (csvMaxDate === null || s.date > csvMaxDate) csvMaxDate = s.date;
    }
    // Upper bound of the planning window: prefer the Tally cutoff date when the
    // payload carries one, otherwise the CSV's last shift date.
    const planningUpperBound =
      cutoff_date && cutoff_date.trim() ? cutoff_date.trim() : csvMaxDate;

    // Planning window: today .. today + PLANNING_DAYS (capped at MAX_DAYS_AHEAD).
    const today = new Date();
    const windowDays = Math.min(PLANNING_DAYS, MAX_DAYS_AHEAD);
    const dates = datesInWindow(today, windowDays);
    const todayStr = dates[0]; // first element is today's date (UTC YYYY-MM-DD)

    // --- Compute OOO blocks ---------------------------------------------------
    const blocks: OooBlock[] = [];
    let skipped = 0;

    for (const emp of (employees ?? []) as Employee[]) {
      for (const date of dates) {
        // Fix 1: only act on dates the CSV actually covers. The "no row = off"
        // rule must NEVER block days outside the uploaded schedule's own range.
        // Lower bound = CSV's earliest shift date; upper bound = the Tally cutoff
        // date when supplied, else the CSV's latest shift date. Dates outside
        // [csvMinDate, planningUpperBound] are left completely alone (no OOO).
        if (
          !csvMinDate || date < csvMinDate ||
          (planningUpperBound && date > planningUpperBound)
        ) {
          continue;
        }

        const dow = dayOfWeek(date);
        const hours = hoursByDow.get(dow);

        // Store closed that day (or no hours configured) -> nothing to block.
        if (!hours || hours.closed) continue;

        const openMin = timeToMinutes(hours.open_time);
        const closeMin = timeToMinutes(hours.close_time);
        if (openMin === null || closeMin === null || closeMin <= openMin) {
          continue;
        }

        // Block the whole working window (used for off / unavailable / malformed).
        const pushOffDay = () => {
          blocks.push({
            employee_id: emp.id,
            google_calendar_id: emp.google_calendar_id,
            event_date: date,
            start_time: minutesToTime(openMin),
            end_time: minutesToTime(closeMin),
            all_day: false,
          });
        };

        // All CSV rows for this employee on this date (split shifts -> many).
        // Match on name or Boulevard id so the CSV identifier can be either.
        const dayShifts =
          shiftsByKey.get(shiftKey(emp.full_name, date)) ??
          (emp.boulevard_staff_id
            ? shiftsByKey.get(shiftKey(emp.boulevard_staff_id, date))
            : undefined) ??
          [];

        // Fix 2: drop "Unavailable" rows. Boulevard exports a day off as a single
        // 12:00AM-11:59PM "Unavailable" shift; those are NOT working time.
        const workingShifts = dayShifts.filter((s) => !isUnavailableShift(s));

        // Off day: no CSV row at all, OR every row was an "Unavailable" marker ->
        // block the entire working window.
        if (workingShifts.length === 0) {
          pushOffDay();
          continue;
        }

        // Parse + sort the working shifts by start time. A malformed / inverted
        // time is treated conservatively as "off the whole day" (old behavior).
        const parsed: Array<{ start: number; end: number }> = [];
        let malformed = false;
        for (const s of workingShifts) {
          const st = timeToMinutes(s.start);
          const en = timeToMinutes(s.end);
          if (st === null || en === null || en <= st) {
            malformed = true;
            break;
          }
          parsed.push({ start: st, end: en });
        }
        if (malformed) {
          pushOffDay();
          continue;
        }
        parsed.sort((a, b) => a.start - b.start);

        // Merge overlapping / adjacent shifts so gaps are computed on the TRUE
        // worked coverage. Without this, a nested row (e.g. 09:00-17:00 plus
        // 12:00-14:00) would produce a bogus gap. Real split shifts don't overlap,
        // but this keeps the gap math correct regardless.
        const merged: Array<{ start: number; end: number }> = [];
        for (const p of parsed) {
          const last = merged[merged.length - 1];
          if (last && p.start <= last.end) {
            last.end = Math.max(last.end, p.end);
          } else {
            merged.push({ start: p.start, end: p.end });
          }
        }

        // Fix 3: block every non-working gap inside the store window:
        //   (a) store open        -> first shift start
        //   (b) end of shift N     -> start of shift N+1   (for each gap)
        //   (c) last shift end     -> store close
        // Each candidate is clamped to [open, close] and only kept if it meets
        // the 15-minute threshold (meetsThreshold).
        const pushGap = (startMin: number, endMin: number) => {
          const s = Math.max(startMin, openMin);
          const e = Math.min(endMin, closeMin);
          if (e <= s) return;
          if (!meetsThreshold(s, e)) {
            skipped++; // under the 15-min threshold
            return;
          }
          blocks.push({
            employee_id: emp.id,
            google_calendar_id: emp.google_calendar_id,
            event_date: date,
            start_time: minutesToTime(s),
            end_time: minutesToTime(e),
            all_day: false,
          });
        };

        // (a) before the first shift
        pushGap(openMin, merged[0].start);
        // (b) gaps between consecutive shifts
        for (let k = 0; k < merged.length - 1; k++) {
          pushGap(merged[k].end, merged[k + 1].start);
        }
        // (c) after the last shift
        pushGap(merged[merged.length - 1].end, closeMin);
      }
    }

    // --- Fix 4: idempotent re-upload -----------------------------------------
    // Before inserting this upload's blocks, remove this LOCATION's existing
    // FUTURE OOO events that fall inside the CSV's date range — from BOTH Google
    // Calendar and the ooo_events table — so a re-upload cleanly REPLACES the old
    // blocks instead of duplicating them. Scope is strict: this location only,
    // event_date >= today, within [max(today, csvMin), planningUpperBound]. Past
    // events and other locations are never touched.
    let deleted = 0;
    if (csvMinDate) {
      const delLower = csvMinDate < todayStr ? todayStr : csvMinDate;
      const delUpper = planningUpperBound ?? csvMaxDate;

      // employee_id -> google_calendar_id, so we can delete the Google event.
      const calById = new Map<string, string | null>();
      for (const emp of (employees ?? []) as Employee[]) {
        calById.set(emp.id, emp.google_calendar_id);
      }

      let existingQuery = supabase
        .from("ooo_events")
        .select("id, employee_id, google_event_id, event_date")
        .eq("location_id", locationId)
        .gte("event_date", delLower);
      if (delUpper) existingQuery = existingQuery.lte("event_date", delUpper);
      const { data: existing, error: existErr } = await existingQuery;
      if (existErr) throw existErr;

      for (const row of existing ?? []) {
        // Remove the Google event first (best-effort: already-gone is fine).
        if (row.google_event_id) {
          const calId = calById.get(row.employee_id as string) ?? null;
          if (calId) {
            try {
              await deleteGoogleOOOEvent(calId, row.google_event_id as string);
            } catch (_err) {
              // Swallow: the DB row is removed regardless so the re-upload stays
              // clean. record-results' 'deleted' status can reconcile stragglers.
            }
            await sleep(DELAY_MS); // space out Google calls (see DELAY_MS note)
          }
        }
      }

      // Hard-delete the superseded rows in range (no duplicates on re-upload).
      const ids = (existing ?? []).map((r) => r.id as string);
      if (ids.length > 0) {
        const { error: delErr } = await supabase
          .from("ooo_events")
          .delete()
          .in("id", ids);
        if (delErr) throw delErr;
        deleted = ids.length;
      }
    }

    // --- Persist ooo_events as pending ---------------------------------------
    const { data: inserted, error: insErr } = await supabase
      .from("ooo_events")
      .insert(
        blocks.map((b) => ({
          employee_id: b.employee_id,
          location_id: locationId,
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

    return json({ batch_id, created, failed, skipped, deleted });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});

// Fix 2 — treat a CSV row as an OFF/unavailable day when it is explicitly labeled
// "Unavailable" (Boulevard's day-off marker) in any descriptive field, OR when it
// spans effectively the whole day (start at/near 00:00, end at/near 23:59).
function isUnavailableShift(s: ShiftRow): boolean {
  const text = [s.label, s.type, s.service, s.notes]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();
  if (text.includes("unavailable")) return true;

  const start = timeToMinutes(s.start);
  const end = timeToMinutes(s.end);
  const FULL_DAY_START_MAX = 5; // <= 00:05 counts as "near midnight" open
  const FULL_DAY_END_MIN = 23 * 60 + 54; // >= 23:54 counts as "near 11:59pm" close
  return (
    start !== null && end !== null &&
    start <= FULL_DAY_START_MAX && end >= FULL_DAY_END_MIN
  );
}

// Deletes a previously-created OOO event from an employee's Google Calendar
// (Fix 4). Treats 404/410 (already gone) as success so re-uploads stay
// idempotent. Shares the GOOGLE_ACCESS_TOKEN auth stub with createGoogleOOOEvent.
async function deleteGoogleOOOEvent(
  calendarId: string,
  eventId: string,
): Promise<void> {
  const accessToken = Deno.env.get("GOOGLE_ACCESS_TOKEN");
  if (!accessToken) {
    throw new Error("GOOGLE_ACCESS_TOKEN not configured");
  }
  const cal = encodeURIComponent(calendarId);
  const ev = encodeURIComponent(eventId);
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${cal}/events/${ev}`;

  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok && res.status !== 404 && res.status !== 410) {
    const text = await res.text();
    throw new Error(`Google Calendar delete failed (${res.status}): ${text}`);
  }
}

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
