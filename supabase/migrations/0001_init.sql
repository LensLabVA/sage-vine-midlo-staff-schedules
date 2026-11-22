-- 0001_init.sql
-- Initial schema for the Sage & Vine (Midlothian) staff-schedule automation.
--
-- Design rules reflected here:
--   * Staff are read from `employees` filtered by `location_id` — never hardcoded.
--   * `store_hours` drives the per-day working window used to compute OOO blocks.
--   * `upload_batches` tracks each CSV upload / processing run.
--   * `ooo_events` is the ledger of out-of-office blocks pushed to Google Calendar.
--
-- RLS: Row-level security policies are intentionally DEFERRED until the auth model
-- (service-role vs. authenticated callers) is decided. Until then the edge functions
-- use the service-role key. Do not expose these tables to anon clients.

-- Needed for gen_random_uuid().
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- employees
--   One row per staff member. `location_id` scopes staff to a Boulevard
--   location so they are never hardcoded in application code. The external IDs
--   (google_calendar_id, boulevard_staff_id, highlevel_user_id) link a staff
--   member across the integrated systems.
-- ---------------------------------------------------------------------------
create table if not exists employees (
  id                 uuid primary key default gen_random_uuid(),
  location_id        text not null,
  full_name          text not null,
  email              text,
  google_calendar_id text,
  boulevard_staff_id text,
  highlevel_user_id  text,
  active             boolean not null default true,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

comment on table employees is
  'Staff members, scoped by location_id (never hardcoded). Holds the external IDs that link a staff member across Google Calendar, Boulevard and HighLevel.';

create index if not exists employees_location_id_idx on employees (location_id);
create index if not exists employees_location_active_idx on employees (location_id, active);

-- ---------------------------------------------------------------------------
-- store_hours
--   Open/close window per day-of-week for a location. Drives the "working day"
--   used when blocking non-working time as OOO. `closed` marks days the store is
--   shut (no blocks needed / full-day block as appropriate).
--   day_of_week: 0 = Sunday .. 6 = Saturday.
-- ---------------------------------------------------------------------------
create table if not exists store_hours (
  id          uuid primary key default gen_random_uuid(),
  location_id text not null,
  day_of_week int  not null check (day_of_week between 0 and 6),
  open_time   time,
  close_time  time,
  closed      boolean not null default false,
  unique (location_id, day_of_week)
);

comment on table store_hours is
  'Store open/close window per day-of-week (0=Sunday..6=Saturday) for a location. Defines the working day used to compute OOO blocks.';

create index if not exists store_hours_location_id_idx on store_hours (location_id);

-- ---------------------------------------------------------------------------
-- upload_batches
--   One row per shift-CSV upload / processing run. Make creates the row, the
--   edge functions move it through pending -> processing -> completed/failed.
-- ---------------------------------------------------------------------------
create table if not exists upload_batches (
  id              uuid primary key default gen_random_uuid(),
  location_id     text not null,
  source_filename text,
  uploaded_by     text,
  status          text not null default 'pending'
                    check (status in ('pending','processing','completed','failed')),
  row_count       int,
  error           text,
  created_at      timestamptz default now(),
  processed_at    timestamptz
);

comment on table upload_batches is
  'One row per shift-CSV upload / processing run. Tracks status (pending/processing/completed/failed), row count and any error.';

create index if not exists upload_batches_location_id_idx on upload_batches (location_id);
create index if not exists upload_batches_status_idx on upload_batches (status);

-- ---------------------------------------------------------------------------
-- ooo_events
--   Ledger of out-of-office blocks. Each row is one block for one employee on
--   one date, computed from the shift CSV + store hours, then pushed to that
--   employee's Google Calendar. `status` tracks the Google push lifecycle;
--   `google_event_id` stores the created calendar event id for later updates.
-- ---------------------------------------------------------------------------
create table if not exists ooo_events (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid references employees(id),
  batch_id        uuid references upload_batches(id),
  event_date      date not null,
  start_time      time,
  end_time        time,
  all_day         boolean not null default false,
  google_event_id text,
  status          text not null default 'pending'
                    check (status in ('pending','created','failed','deleted')),
  error           text,
  created_at      timestamptz default now()
);

comment on table ooo_events is
  'Ledger of out-of-office blocks pushed to Google Calendar. One row per employee per date per block; status tracks the Google push (pending/created/failed/deleted).';

create index if not exists ooo_events_employee_id_idx on ooo_events (employee_id);
create index if not exists ooo_events_event_date_idx on ooo_events (event_date);
create index if not exists ooo_events_batch_id_idx on ooo_events (batch_id);
