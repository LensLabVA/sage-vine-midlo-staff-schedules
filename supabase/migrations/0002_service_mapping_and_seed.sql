-- 0002_service_mapping_and_seed.sql
-- Additive migration (do NOT edit 0001_init.sql; nothing is deployed yet but we
-- keep migration history append-only).
--
-- Adds:
--   (a) Fix 5  — service-mapping columns on `employees` (regular_sd, comprehensive)
--                and seeds the 4 Midlothian practitioners.
--   (b) Fix 4  — `location_id` on `ooo_events` so a re-upload can scope the delete
--                of existing future OOO events to a single location + date range.

-- ---------------------------------------------------------------------------
-- (a) Fix 5 — service mapping on employees
--     regular_sd      = offers the Regular Skin Diagnostic
--     comprehensive   = offers the Comprehensive Consultation
-- ---------------------------------------------------------------------------
alter table employees
  add column if not exists regular_sd    boolean not null default false,
  add column if not exists comprehensive boolean not null default false;

comment on column employees.regular_sd is
  'Service mapping: staff member offers the Regular Skin Diagnostic (SD).';
comment on column employees.comprehensive is
  'Service mapping: staff member offers the Comprehensive Consultation.';

-- ---------------------------------------------------------------------------
-- (b) Fix 4 — location_id on ooo_events
--     Lets process-schedule delete a LOCATION's existing future OOO events within
--     the CSV date range (idempotent re-uploads) without touching other locations.
-- ---------------------------------------------------------------------------
alter table ooo_events
  add column if not exists location_id text;

comment on column ooo_events.location_id is
  'Location this OOO block belongs to (copied from the batch). Scopes idempotent re-upload deletes to one location + date range (Fix 4).';

create index if not exists ooo_events_location_date_idx
  on ooo_events (location_id, event_date);

-- ---------------------------------------------------------------------------
-- (c) Fix 5 — seed the 4 Midlothian practitioners
--
-- NOTE: google_calendar_id values are PLACEHOLDERS — the real per-staff Google
-- calendar IDs must be supplied before deploy. `location_id` is the confirmed
-- Boulevard Location External ID for Midlothian: SV00002 (from Daniel, 2026-11-22).
--
-- NOTE: the boulevard_staff_id values below are CARRIED OVER from the old
-- Sage & Vine CSV and MUST be confirmed for Midlothian before go-live.
--
-- NAMING (Daniel's request): these 4 practitioners already exist as records for
-- the existing (other) branch. Daniel asked to DUPLICATE them for Midlothian with
-- the location appended to each name ("... at Midlothian location") so the
-- Midlothian rows are distinct from, and don't collide with, the existing
-- records of the same name. The SAME naming convention should carry through to
-- the Google calendars and the GHL (HighLevel) users he creates for Midlothian.
-- ---------------------------------------------------------------------------
insert into employees
  (location_id, full_name, google_calendar_id, boulevard_staff_id, regular_sd, comprehensive, active)
values
  ('SV00002', 'Cara Frey at Midlothian location',
   'PLACEHOLDER_CARA_CALENDAR_ID',   '6942bd50-a828-480e-89da-d7f3ddb2164c', true,  true,  true),
  -- TODO: confirm Taylor's Boulevard ID (Cesena f698ecd6-... vs Earley a6f04b40-...)
  ('SV00002', 'Taylor at Midlothian location',
   'PLACEHOLDER_TAYLOR_CALENDAR_ID', null,                                   true,  false, true),
  ('SV00002', 'Nikki Gooding at Midlothian location',
   'PLACEHOLDER_NIKKI_CALENDAR_ID',  '8b713e6f-f97f-4bd1-8d7a-05652830cb55', false, true,  true),
  ('SV00002', 'Moriah Sedlak at Midlothian location',
   'PLACEHOLDER_MORIAH_CALENDAR_ID', 'e6edc150-40a7-4dc2-af8a-4d669604afcf', false, true,  true);

-- ---------------------------------------------------------------------------
-- (d) Task 8 — seed Midlothian (SV00002) weekly store hours
--
-- Confirmed by Daniel (2026-11-22): Sun 9AM-5PM, Mon-Thu 9AM-8PM,
-- Fri 9:30AM-8PM, Sat 9AM-5PM. Plain weekly schedule — NO holiday/Thanksgiving
-- logic (launch is after Thanksgiving week). day_of_week: 0=Sunday..6=Saturday.
-- open_time/close_time are TIME values (per store_hours in 0001_init.sql).
-- Idempotent on the (location_id, day_of_week) unique key so re-running the
-- migration seed is a no-op.
-- ---------------------------------------------------------------------------
insert into store_hours
  (location_id, day_of_week, open_time, close_time, closed)
values
  ('SV00002', 0, '09:00', '17:00', false),  -- Sunday
  ('SV00002', 1, '09:00', '20:00', false),  -- Monday
  ('SV00002', 2, '09:00', '20:00', false),  -- Tuesday
  ('SV00002', 3, '09:00', '20:00', false),  -- Wednesday
  ('SV00002', 4, '09:00', '20:00', false),  -- Thursday
  ('SV00002', 5, '09:30', '20:00', false),  -- Friday
  ('SV00002', 6, '09:00', '17:00', false)   -- Saturday
on conflict (location_id, day_of_week) do nothing;
