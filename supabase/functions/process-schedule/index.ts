// process-schedule
//
// The "brain" of the shift half. Make POSTs the RAW Boulevard shift CSV here; the
// function parses it, computes out-of-office (OOO) blocks per staff member, writes
// them to the `ooo_events` ledger as pending, and returns a per-employee plan of
// Google Calendar events to CREATE and to DELETE. This function does NO Google
// Calendar calls — Make performs every create/delete and then calls record-results
// with the resulting google_event_ids. (This matches the old Make scenario
// contract documented in docs/old-make-scenario.md — task 7.)
//
// Request body:
//   { csv, cutoff_date?, uploaded_by_name?, uploaded_by_email?, location_id }
//     csv         : raw Boulevard CSV export text (parsed in-function, below)
//     cutoff_date : optional Tally "cutoff date" (YYYY-MM-DD); upper bound of the
//                   planning window (preferred over the CSV's last shift date)
//     location_id : scopes which employees / store_hours / ooo_events are used
//
// Response body:
//   { batch_id, employees: [ {
//       employee_name,
//       google_calendar_id,
//       events_to_create: [ { ooo_event_id, start_at, end_at } ],
//       events_to_delete: [ { ooo_event_id, google_event_id } ]
//   } ] }
//   (batch_id is returned so Make can pass it to record-results afterward.)
//
// Core scheduling rules (unchanged from fixes 1-3):
//   * Staff are READ FROM `employees` filtered by location_id — never hardcoded.
//   * A day with no CSV shift row for an employee = OFF = block the whole working
//     day (store open -> close). This only applies INSIDE the CSV's own date range
//     (optionally capped by cutoff_date) — never past it (Fix 1).
//   * A Boulevard 12:00AM-11:59PM "Unavailable" row is a day OFF, not working time
//     (Fix 2).
//   * Split shifts: block every non-working gap (open->first, between shifts,
//     last->close); overlapping intervals are merged first (Fix 3).
//   * Blocks shorter than MIN_THRESHOLD_MINUTES (15) are skipped.
//   * Planning window capped at MAX_DAYS_AHEAD (365). All math in America/New_York.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handlePreflight } from "../_shared/cors.ts";
import {
  datesInWindow,
  dayOfWeek,
  MAX_DAYS_AHEAD,
  meetsThreshold,
  minutesToTime,
  timeToMinutes,
  toZonedTimestamp,
} from "../_shared/time.ts";

// How many days ahead to plan. Capped by MAX_DAYS_AHEAD.
const PLANNING_DAYS = MAX_DAYS_AHEAD;

// --- Types -----------------------------------------------------------------

// One parsed CSV shift row. `staff` / `staff_id` are the two identifiers a row
// may carry; we index by both so an employee matches on name OR Boulevard id.
interface ShiftRow {
  staff: string; // staff display name (primary match key)
  staff_id?: string; // Boulevard staff id (more robust match key, when present)
  date: string; // YYYY-MM-DD
  start: string; // HH:MM:SS
  end: string; // HH:MM:SS
  label?: string; // any descriptive field that may carry "Unavailable"
}

interface RequestBody {
  csv: string;
  cutoff_date?: string;
  uploaded_by_name?: string;
  uploaded_by_email?: string;
  location_id: string;
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

// A computed OOO block before it is written to the ledger.
interface OooBlock {
  employee_id: string;
  event_date: string;
  start_time: string;
  end_time: string;
}

// Per-employee plan returned to Make.
interface EmployeePayload {
  employee_name: string;
  google_calendar_id: string | null;
  events_to_create: Array<{ ooo_event_id: string; start_at: string; end_at: string }>;
  events_to_delete: Array<{ ooo_event_id: string; google_event_id: string }>;
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
    const {
      csv,
      cutoff_date,
      uploaded_by_name,
      uploaded_by_email,
      location_id,
    }: RequestBody = await req.json();

    if (!csv || typeof csv !== "string") {
      return json({ error: "csv (raw CSV text) is required" }, 400);
    }
    if (!location_id) return json({ error: "location_id is required" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Parse the raw Boulevard CSV into shift rows.
    const shifts = parseBoulevardCsv(csv);

    // Create the upload_batches row for this run (Make no longer pre-creates it;
    // the CSV now arrives here raw). record-results finalizes it afterward.
    const uploadedBy = [uploaded_by_name, uploaded_by_email]
      .filter((v) => v && String(v).trim())
      .join(" / ") || null;
    const { data: batch, error: batchErr } = await supabase
      .from("upload_batches")
      .insert({
        location_id,
        uploaded_by: uploadedBy,
        status: "processing",
        row_count: shifts.length,
      })
      .select("id")
      .single();
    if (batchErr || !batch) {
      return json({ error: `could not create batch: ${batchErr?.message}` }, 500);
    }
    const batch_id = batch.id as string;

    // Load active employees for THIS location (never hardcoded).
    const { data: employees, error: empErr } = await supabase
      .from("employees")
      .select(
        "id, location_id, full_name, google_calendar_id, boulevard_staff_id, active",
      )
      .eq("location_id", location_id)
      .eq("active", true);
    if (empErr) throw empErr;

    // Load store hours for this location, keyed by day_of_week.
    const { data: hoursRows, error: hoursErr } = await supabase
      .from("store_hours")
      .select("day_of_week, open_time, close_time, closed")
      .eq("location_id", location_id);
    if (hoursErr) throw hoursErr;
    const hoursByDow = new Map<number, StoreHour>();
    for (const h of (hoursRows ?? []) as StoreHour[]) {
      hoursByDow.set(h.day_of_week, h);
    }

    // Index shifts by employee+date. A staff member can have MULTIPLE rows on one
    // day (split shifts), so each key maps to an ARRAY (Fix 3). Each row is indexed
    // under BOTH its name and its Boulevard id so the employee match works either
    // way (name primary; boulevard_staff_id is the more robust key).
    const shiftKey = (match: string, date: string) =>
      `${match.trim().toLowerCase()}::${date}`;
    const shiftsByKey = new Map<string, ShiftRow[]>();
    const addToKey = (match: string | undefined, date: string, row: ShiftRow) => {
      if (!match) return;
      const key = shiftKey(match, date);
      const arr = shiftsByKey.get(key);
      if (arr) arr.push(row);
      else shiftsByKey.set(key, [row]);
    };
    for (const s of shifts) {
      addToKey(s.staff, s.date, s);
      addToKey(s.staff_id, s.date, s);
    }

    // Fix 1: compute the CSV's OWN date range. The "no row = off" full-day block
    // is only applied to dates inside this range; dates outside it are left alone.
    let csvMinDate: string | null = null; // lexicographic works for YYYY-MM-DD
    let csvMaxDate: string | null = null;
    for (const s of shifts) {
      if (!s.date) continue;
      if (csvMinDate === null || s.date < csvMinDate) csvMinDate = s.date;
      if (csvMaxDate === null || s.date > csvMaxDate) csvMaxDate = s.date;
    }
    // Upper bound of the planning window: prefer the Tally cutoff date, else the
    // CSV's last shift date.
    const planningUpperBound =
      cutoff_date && cutoff_date.trim() ? cutoff_date.trim() : csvMaxDate;

    // Planning window: today .. today + PLANNING_DAYS (capped at MAX_DAYS_AHEAD).
    const today = new Date();
    const windowDays = Math.min(PLANNING_DAYS, MAX_DAYS_AHEAD);
    const dates = datesInWindow(today, windowDays);
    const todayStr = dates[0];

    // --- Compute OOO blocks ---------------------------------------------------
    const blocks: OooBlock[] = [];

    for (const emp of (employees ?? []) as Employee[]) {
      for (const date of dates) {
        // Fix 1: only act on dates the CSV actually covers.
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

        // Block the whole working window (off / unavailable / malformed day).
        const pushOffDay = () => {
          blocks.push({
            employee_id: emp.id,
            event_date: date,
            start_time: minutesToTime(openMin),
            end_time: minutesToTime(closeMin),
          });
        };

        // All CSV rows for this employee on this date (split shifts -> many).
        const dayShifts =
          shiftsByKey.get(shiftKey(emp.full_name, date)) ??
          (emp.boulevard_staff_id
            ? shiftsByKey.get(shiftKey(emp.boulevard_staff_id, date))
            : undefined) ??
          [];

        // Fix 2: drop "Unavailable" rows (Boulevard's 12:00AM-11:59PM day-off).
        const workingShifts = dayShifts.filter((s) => !isUnavailableShift(s));

        // Off day: no CSV row, OR every row was "Unavailable" -> block whole day.
        if (workingShifts.length === 0) {
          pushOffDay();
          continue;
        }

        // Parse + validate the working shifts. A malformed/inverted time is
        // treated conservatively as "off the whole day".
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
        // worked coverage (Fix 3).
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
        //   (a) open -> first shift start
        //   (b) end of shift N -> start of shift N+1
        //   (c) last shift end -> close
        // Each candidate is clamped to [open, close] and kept only if it meets the
        // 15-minute threshold.
        const pushGap = (startMin: number, endMin: number) => {
          const s = Math.max(startMin, openMin);
          const e = Math.min(endMin, closeMin);
          if (e <= s) return;
          if (!meetsThreshold(s, e)) return; // under the 15-min threshold
          blocks.push({
            employee_id: emp.id,
            event_date: date,
            start_time: minutesToTime(s),
            end_time: minutesToTime(e),
          });
        };

        pushGap(openMin, merged[0].start); // (a)
        for (let k = 0; k < merged.length - 1; k++) { // (b)
          pushGap(merged[k].end, merged[k + 1].start);
        }
        pushGap(merged[merged.length - 1].end, closeMin); // (c)
      }
    }

    // --- Fix 4: idempotent re-upload — compute events_to_delete ----------------
    // Instead of deleting here, we RETURN this location's existing FUTURE OOO
    // events (status 'created', with a google_event_id) inside the planning window
    // so Make deletes them from Google and record-results then marks them deleted.
    // Scope is strict: this location only, event_date within
    // [max(today, csvMin), planningUpperBound]. Past events / other locations are
    // never touched. (No Google call happens in this function.)
    const deleteByEmp = new Map<string, Array<{ ooo_event_id: string; google_event_id: string }>>();
    if (csvMinDate) {
      const delLower = csvMinDate < todayStr ? todayStr : csvMinDate;
      const delUpper = planningUpperBound ?? csvMaxDate;

      let existingQuery = supabase
        .from("ooo_events")
        .select("id, employee_id, google_event_id, event_date")
        .eq("location_id", location_id)
        .eq("status", "created")
        .not("google_event_id", "is", null)
        .gte("event_date", delLower);
      if (delUpper) existingQuery = existingQuery.lte("event_date", delUpper);
      const { data: existing, error: existErr } = await existingQuery;
      if (existErr) throw existErr;

      for (const row of existing ?? []) {
        const empId = row.employee_id as string;
        const arr = deleteByEmp.get(empId) ?? [];
        arr.push({
          ooo_event_id: row.id as string,
          google_event_id: row.google_event_id as string,
        });
        deleteByEmp.set(empId, arr);
      }
    }

    // --- Persist the new blocks as pending ------------------------------------
    // Each inserted row's generated id IS its ooo_event_id (returned to Make).
    let insertedIds: string[] = [];
    if (blocks.length > 0) {
      const { data: inserted, error: insErr } = await supabase
        .from("ooo_events")
        .insert(
          blocks.map((b) => ({
            employee_id: b.employee_id,
            location_id,
            batch_id,
            event_date: b.event_date,
            start_time: b.start_time,
            end_time: b.end_time,
            all_day: false,
            status: "pending",
          })),
        )
        .select("id");
      if (insErr) throw insErr;
      insertedIds = (inserted ?? []).map((r) => r.id as string);
    }

    // --- Group the plan per employee ------------------------------------------
    const empById = new Map<string, Employee>();
    for (const emp of (employees ?? []) as Employee[]) empById.set(emp.id, emp);

    const payloadByEmp = new Map<string, EmployeePayload>();
    const ensurePayload = (empId: string): EmployeePayload | null => {
      const emp = empById.get(empId);
      // A delete row could reference an employee no longer in `employees`; we have
      // no calendar id for them, so Make can't action it — skip (rare edge case).
      if (!emp) return null;
      let p = payloadByEmp.get(empId);
      if (!p) {
        p = {
          employee_name: emp.full_name,
          google_calendar_id: emp.google_calendar_id,
          events_to_create: [],
          events_to_delete: [],
        };
        payloadByEmp.set(empId, p);
      }
      return p;
    };

    // creates (pair each block with its freshly-generated ooo_event_id)
    for (let i = 0; i < blocks.length; i++) {
      const id = insertedIds[i];
      if (!id) continue;
      const block = blocks[i];
      const p = ensurePayload(block.employee_id);
      if (!p) continue;
      p.events_to_create.push({
        ooo_event_id: id,
        start_at: toZonedTimestamp(block.event_date, block.start_time),
        end_at: toZonedTimestamp(block.event_date, block.end_time),
      });
    }

    // deletes
    for (const [empId, dels] of deleteByEmp) {
      const p = ensurePayload(empId);
      if (!p) continue;
      p.events_to_delete.push(...dels);
    }

    return json({ batch_id, employees: Array.from(payloadByEmp.values()) });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});

// --- CSV parsing -----------------------------------------------------------
//
// TODO: confirm exact Boulevard CSV column headers against a real export. We do
// not have a sample file, so this parser infers columns by fuzzy header name and
// normalizes common date/time formats. The shape assumed (from the fixes): one
// row per staff member per shift, carrying a staff name, a date, a start time and
// an end time, with a day OFF expressed as a 12:00AM-11:59PM "Unavailable" row.
// Rows that don't resolve to a date are dropped.

// Parse raw Boulevard CSV text into ShiftRow[].
function parseBoulevardCsv(csv: string): ShiftRow[] {
  const lines = csv.split(/\r\n|\r|\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];

  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) =>
    header.findIndex((h) => names.some((n) => h.includes(n)));

  // Fuzzy-match the columns we care about. -1 means "not present".
  const nameIdx = col("staff name", "employee name", "staff", "employee", "name", "provider");
  const idIdx = col("staff id", "boulevard id", "employee id", "staff_id");
  const dateIdx = col("date", "day");
  const startIdx = col("start time", "shift start", "start", "clock in", "from");
  const endIdx = col("end time", "shift end", "end", "clock out", "to");
  // The "Unavailable" day-off marker may live in any of these descriptive columns.
  const labelIdx = col("availability", "status", "type", "service", "label", "notes");

  const rows: ShiftRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const get = (idx: number) => (idx >= 0 && idx < cells.length ? cells[idx].trim() : "");

    const date = normalizeDate(get(dateIdx));
    if (!date) continue; // can't place a row without a date

    rows.push({
      staff: get(nameIdx),
      staff_id: get(idIdx) || undefined,
      date,
      start: normalizeTime(get(startIdx)),
      end: normalizeTime(get(endIdx)),
      label: get(labelIdx) || undefined,
    });
  }
  return rows;
}

// Split a single CSV line into fields, honoring double-quoted fields (which may
// contain commas and escaped "" quotes). Kept small and dependency-free.
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// Normalize a date cell to YYYY-MM-DD. Handles YYYY-MM-DD and M/D/YYYY (the two
// most likely Boulevard export shapes). Returns "" when it can't be parsed.
function normalizeDate(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  // Already ISO (optionally with a time component we discard).
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // US-style M/D/YYYY or M/D/YY.
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (us) {
    let [, mm, dd, yy] = us;
    if (yy.length === 2) yy = `20${yy}`;
    return `${yy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  return "";
}

// Normalize a time cell to HH:MM:SS (24h). Handles "9:00AM", "12:00 AM",
// "11:59 PM", "09:00", "9:00:00". Returns "" when empty / unparseable; the caller
// treats an empty/invalid time as a malformed shift (conservatively a day off).
function normalizeTime(raw: string): string {
  const s = raw.trim().toUpperCase();
  if (!s) return "";
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/);
  if (!m) return "";
  let h = Number(m[1]);
  const min = m[2];
  const sec = m[3] ?? "00";
  const ampm = m[4];
  if (ampm === "AM") {
    if (h === 12) h = 0;
  } else if (ampm === "PM") {
    if (h !== 12) h += 12;
  }
  if (h > 23 || Number(min) > 59) return "";
  return `${String(h).padStart(2, "0")}:${min}:${sec}`;
}

// Fix 2 — a CSV row is an OFF/unavailable day when it is explicitly labeled
// "Unavailable" (Boulevard's day-off marker), OR when it spans effectively the
// whole day (start at/near 00:00, end at/near 23:59).
function isUnavailableShift(s: ShiftRow): boolean {
  if ((s.label ?? "").toLowerCase().includes("unavailable")) return true;
  const start = timeToMinutes(s.start);
  const end = timeToMinutes(s.end);
  const FULL_DAY_START_MAX = 5; // <= 00:05 counts as "near midnight" open
  const FULL_DAY_END_MIN = 23 * 60 + 54; // >= 23:54 counts as "near 11:59pm" close
  return (
    start !== null && end !== null &&
    start <= FULL_DAY_START_MAX && end >= FULL_DAY_END_MIN
  );
}
