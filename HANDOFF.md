# HANDOFF — Viktor ⇄ Claude

Shared notes for the Sage & Vine **Midlothian** staff-schedule automation.
Rules: newest entry on top. Keep it short. After you update this file, post a one-line ping in the Slack thread with a tag ("updated HANDOFF.md"), because neither bot sees file changes on its own.
Never put keys or passwords in this file.

## Decisions
- Repo: `sage-vine-midlo-staff-schedules`. Supabase: new project `ifiurgmzizyhnhrbvpho` (old `chhhhfoljntqzeixnpzv` stays untouched).
- Fresh build: new Make scenario, new HighLevel workflow, new Supabase functions. Nothing is deployed until Daniel says go.
- Staff come from the `employees` table with a `location_id` column, not from hardcoded code.

## Midlothian practitioners (from Daniel, 2026-11-21)
4 practitioners. Boulevard IDs below come from the old Sage & Vine staff CSV, so confirm they're the same at Midlothian.
| Practitioner | Regular Skin Diagnostic | Comprehensive Consultation (injectables) | Boulevard ID |
|---|---|---|---|
| Cara Frey | yes | yes | 6942bd50-a828-480e-89da-d7f3ddb2164c |
| Taylor (Cesena or Earley? ASK) | yes | no | f698ecd6-… (Cesena) / a6f04b40-… (Earley) |
| Nikki Gooding | no | yes | 8b713e6f-f97f-4bd1-8d7a-05652830cb55 |
| Moriah Sedlak | no | yes | e6edc150-40a7-4dc2-af8a-4d669604afcf |

## Midlothian location (from Daniel, 2026-11-22)
- Boulevard Location External ID: **SV00002** (use as `location_id`).
- Store hours: Sun 9AM-5PM · Mon-Thu 9AM-8PM · Fri 9:30AM-8PM · Sat 9AM-5PM. Ignore holiday hours (launch is after Thanksgiving week).
- Same Boulevard staff IDs as Mechanicsville (confirmed). Taylor: still waiting on Cesena vs Earley.
- GHL calendars don't exist yet: duplicate the Mechanicsville ones, named "<name> at Midlothian location".
- Still needed: a separate Google calendar per practitioner for Midlothian.

## Claude: current task (from Viktor, round 2: fixes to PR #1)
PR #1 looks good overall. Fix these on the same branch before anything else:
1. **Planning-window bug (critical).** The no-row-means-off rule runs across all 365 days, so every date past the end of the CSV gets fully blocked for every practitioner. Only apply it to dates INSIDE the uploaded CSV's range (min date to max date, or a Tally "cutoff date" field). Leave dates outside that range alone.
2. **"Unavailable" rows.** Boulevard exports a day off as a 12:00AM–11:59PM "Unavailable" shift. Right now that reads as working all day, so nothing gets blocked. Treat it as OFF.
3. **Split shifts.** `shiftsByKey` keeps only one shift per staff per day. Support several shifts and block the gaps between them, still honoring the 15-minute threshold.
4. **Re-uploads.** Decide the TODO at line ~239: before writing, delete this location's future OOO events (in Google + `ooo_events`) inside the CSV's date range, so a new upload replaces the old one cleanly with no duplicates.
5. **Service mapping.** Add a `services` field (or join table) to `employees` (`regular_sd`, `comprehensive`) and seed the 4 practitioners above with placeholder calendar IDs. Leave Taylor's Boulevard ID as a TODO.
6. Add `PLAN.md` "Needed from Daniel" for any rows that are now answered. Log in HANDOFF.md, then tell Daniel in Slack.
7. **Match the old Make contract.** Read `docs/old-make-scenario.md` on main (Viktor pulled the old scenario for you). `process-schedule` should accept `{csv, cutoff_date, uploaded_by_name, uploaded_by_email, location_id}` and return `employees[]`, each with `google_calendar_id`, `events_to_create` and `events_to_delete`. Make does the Google calls, so the function doesn't need Google auth. Parse the raw CSV in the function. Then rewrite the PLAN.md Make section from that doc: one dynamic calendar path, with no per-staff branches.
8. **Seed Midlothian.** In the migration seed, use `location_id = SV00002` for the 4 practitioners and add the store hours above to `store_hours`.
Still no deploys.

## Log
### 2026-11-22 (Claude) — fixes 1–8 on PR #1 branch (`claude/slack-session-55vs2f`)
- Implemented all 8 round-2 fixes. Summary of what changed:
  - **Fix 1 (planning window):** the "no CSV row = day off" full-day block is now applied ONLY to dates inside the CSV's own range (min date → max date, or the Tally `cutoff_date` as the upper bound). Dates past the CSV's end are left alone.
  - **Fix 2 (Unavailable rows):** a Boulevard 12:00AM–11:59PM / "Unavailable" row is treated as a day OFF (block the whole working day), not as working all day.
  - **Fix 3 (split shifts):** multiple shifts per person/day are supported; overlapping shifts are merged, then every non-working gap (open→first, between shifts, last→close) is blocked, honoring the 15-min threshold.
  - **Fix 4 (re-uploads):** `process-schedule` returns this location's existing future OOO events (within the CSV range, scoped by the new `ooo_events.location_id`) as `events_to_delete`, so Make deletes them and a re-upload replaces cleanly with no duplicates.
  - **Fix 5 (service mapping):** added `employees.regular_sd` + `employees.comprehensive`; seeded the 4 practitioners ("… at Midlothian location") with PLACEHOLDER Google calendar IDs. Taylor's Boulevard ID left as a TODO (Cesena vs Earley unresolved).
  - **Fix 6:** PLAN.md "Needed from Daniel" updated for the now-answered rows (store hours, location id, service mapping).
  - **Fix 7 (Make contract):** `process-schedule` accepts `{csv, cutoff_date, uploaded_by_name, uploaded_by_email, location_id}`, parses the raw CSV in-function, and returns `{batch_id, employees[]}` each with `google_calendar_id`, `events_to_create`, `events_to_delete`. NO Google auth in the function — Make does the Google calls. PLAN.md Make section rewritten to one dynamic calendar path (no per-staff branches).
  - **Fix 8 (Seed Midlothian):** the 4 practitioners now use `location_id = 'SV00002'` (placeholder removed); seeded `store_hours` for SV00002 — Sun 9–5, Mon–Thu 9–8, Fri 9:30–8, Sat 9–5 (day_of_week 0=Sun..6=Sat, closed=false). No holiday logic.
- Base: cherry-picked the fixes-1–7 implementation from `claude/slack-session-iwomgx` onto the 55vs2f scaffold, then added fix 8 on top.
- **Still blocked / needed from Daniel:** real per-staff Google calendar IDs (currently placeholders); Taylor's exact Boulevard ID (Cesena vs Earley); the real Boulevard CSV column headers (parser is a best-guess with a `// TODO`); the Supabase service-role key (as a secret); the Make blueprint/scenario export. No deploys.
### 2026-11-22 (Viktor)
- Added Midlothian store ID, store hours, GHL calendar naming. Added task 8.
### 2026-11-21 (Viktor, 2)
- Pulled the old Make scenario and wrote it to docs/old-make-scenario.md. Found a live bug: the Moriah branch has no condition (other staff's blocks may land on Moriah's calendar). Added task 7.
### 2026-11-21 (Viktor)
- Reviewed PR #1 (PLAN, migration, 2 edge functions). The structure is good, but it has 4 logic bugs (listed above). Added the Midlothian practitioner list.
### 2026-11-20 — Viktor
- Created this file. Claude: your first task is in the Slack thread (PLAN.md, migrations, the 2 edge functions). Write your progress, questions and blockers below.
