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
| Taylor Cesena | yes | no | f698ecd6-8378-4d78-b88b-b853dd93ba34 |
| Nikki Gooding | no | yes | 8b713e6f-f97f-4bd1-8d7a-05652830cb55 |
| Moriah Sedlak | no | yes | e6edc150-40a7-4dc2-af8a-4d669604afcf |

## Midlothian location (from Daniel, 2026-11-22)
- Boulevard Location External ID: **SV00002** (use as `location_id`).
- Store hours: Sun 9AM-5PM · Mon-Thu 9AM-8PM · Fri 9:30AM-8PM · Sat 9AM-5PM. Ignore holiday hours (launch is after Thanksgiving week).
- Same Boulevard staff IDs as Mechanicsville (confirmed). Taylor: still waiting on Cesena vs Earley.
- GHL calendars don't exist yet: duplicate the Mechanicsville ones, named "<name> at Midlothian location".
- Still needed: a separate Google calendar per practitioner for Midlothian.

## Claude: current task (round 3, from Viktor 2026-11-23)
Round 2 reviewed: fixes 1-8 look right. Merge-ready once these small fixes are in. Work on `claude/slack-session-55vs2f`, same PR.
1. **Taylor = Taylor Cesena** (`f698ecd6-8378-4d78-b88b-b853dd93ba34`). Regular Skin Diagnostic only. Fill her Boulevard ID in the seed and drop the TODO.
2. **CSV parser hardening.** `col()` uses substring matching, so `"to"` matches "S**to**re"/"**To**tal" and `"day"` and `"name"` can hit the wrong column. Match exact header names first, then fall back to fuzzy matching, and never let two fields resolve to the same column. Add a small test that uses a fake Boulevard export with "Store", "Total Hours" and "Location" columns. The real sample CSV is still coming from Daniel.
3. **Make blueprint (new scenario, importable).** Add `make/midlothian-schedule-upload.blueprint.json` and `make/README.md` (import steps):
   Tally watch (new Midlothian form) → HTTP download file → toString → JSON body `{csv, cutoff_date, uploaded_by_name, uploaded_by_email, location_id:"SV00002"}` → HTTP POST `process-schedule` (180s timeout, URL/key as placeholders) → Iterator `employees[]` → Iterator `events_to_create` → Google Calendar Create Event (calendar = `{{google_calendar_id}}`, summary "<employee_name> OOO", busy) → Sleep 1s → aggregate → Iterator `events_to_delete` → Delete Event → Sleep 1s → aggregate → POST `record-results`. **No per-staff router.** Write the README so it says to turn on "Store incomplete executions" and that one Google connection needs edit access to all 4 calendars.
4. **Tally form spec** in `make/README.md`: duplicate of form ja9Dk9 with the same 4 fields (file, cutoff date, name, email), titled "Midlothian schedule upload". Build it after testing.
5. **GHL → Zapier spec** in `docs/ghl-zapier-midlothian.md`. This is a NEW workflow, not an edit of the Mechanicsville one:
   - Trigger: appointment status on the 2 new calendars "Regular Skin Diagnostic at Midlothian location" and "Comprehensive Skin Diagnostic at Midlothian location".
   - Branch on Staff Name: Cara Frey, Taylor Cesena, Nikki Gooding, Moriah Sedlak, else internal notification.
   - Webhook to a NEW Zap (a copy of the live Zap).
   - In the Zap, the Boulevard Create Client / Create Timeblock steps must use the **Midlothian** Boulevard location and the staff member's Boulevard ID.
   - List every field that has to change from the Mechanicsville copy.
6. Log in HANDOFF.md and tell Daniel in Slack. Still no deploys.

## Log
### 2026-11-23 (Viktor)
- Reviewed fixes 1-8 on 55vs2f: good. Taylor = Cesena. Round 3 = parser hardening, Make blueprint, Tally spec, GHL/Zap spec. HighLevel API connection is down, so Viktor will clone the GHL calendars once it is reconnected.
### 2026-11-22 (Viktor)
- Added Midlothian store ID, store hours, GHL calendar naming. Added task 8.
### 2026-11-21 (Viktor, 2)
- Pulled the old Make scenario and wrote it to docs/old-make-scenario.md. Found a live bug: the Moriah branch has no condition (other staff's blocks may land on Moriah's calendar). Added task 7.
### 2026-11-21 (Viktor)
- Reviewed PR #1 (PLAN, migration, 2 edge functions). The structure is good, but it has 4 logic bugs (listed above). Added the Midlothian practitioner list.
### 2026-11-20 — Viktor
- Created this file. Claude: your first task is in the Slack thread (PLAN.md, migrations, the 2 edge functions). Write your progress, questions and blockers below.
