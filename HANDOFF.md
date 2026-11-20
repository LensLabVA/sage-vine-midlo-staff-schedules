# HANDOFF — Viktor ⇄ Claude

Shared notes for the Sage & Vine **Midlothian** staff-schedule automation.
Rules: newest entry on top. Keep it short. After you update this file, post a one-line ping in the Slack thread with a tag ("updated HANDOFF.md"), because neither bot sees file changes on its own.
Never put keys or passwords in this file.

## Decisions
- Repo: `sage-vine-midlo-staff-schedules`. Supabase: new project `ifiurgmzizyhnhrbvpho` (old `chhhhfoljntqzeixnpzv` stays untouched).
- Fresh build: new Make scenario, new HighLevel workflow, new Supabase functions. Nothing is deployed until Daniel says go.
- Staff come from the `employees` table with a `location_id` column, not from hardcoded code.

## Claude: current task (from Viktor)
Do these on a branch, open a PR, and don't deploy anything:
1. `PLAN.md`: the architecture, with one table per piece (Supabase, Make, Tally, HighLevel, Zapier) showing what gets built and what's needed from Daniel.
   - Shift half: Boulevard shift CSV → Tally upload → Make scenario → Supabase edge functions → out-of-office blocks on each staff member's Google Calendar → HighLevel reads availability.
   - Booking half: HighLevel workflow (appointment status on Comprehensive SD and Regular SD) → webhook per staff member → Zapier → Boulevard client + time block.
   - Public copy of the old Make scenario: https://us2.make.com/public/shared-scenario/0OQdrBfKtpS/sa-csv-upload
2. `supabase/migrations/`: tables `employees`, `store_hours`, `upload_batches`, `ooo_events`, plus a `location_id` column so staff aren't hardcoded.
3. `supabase/functions/process-schedule` and `record-results`:
   - read staff from the table; a day with no CSV row = off;
   - time zone America/New_York, 15-minute threshold, max 365 days ahead;
   - add a delay between Google Calendar calls to avoid the rate limit.
4. Write your progress, questions and blockers in the Log below.

## Waiting on Daniel
- Midlothian Boulevard location ID, staff list, a Google calendar for each staff member, store hours, and which HighLevel calendars to use.
- Screenshots of the live Zap.
- Supabase access token, added as a secret (never pasted in Slack).

## Log
### 2026-11-20 — Claude
- Created `PLAN.md` (overview + data-flow diagram, one table per piece: Supabase, Make, Tally, HighLevel, Zapier, plus open questions/risks).
- Added `supabase/migrations/0001_init.sql`: 4 tables (`employees`, `store_hours`, `upload_batches`, `ooo_events`) with `location_id`, indexes, comments; RLS deferred.
- Scaffolded edge functions `process-schedule` and `record-results` (+ `_shared/time.ts`, `_shared/cors.ts`, `supabase/README.md`) implementing the rules as scaffold: staff read from table by `location_id`, no-CSV-row = OFF (block whole working day), America/New_York, 15-min threshold, 365-day cap, and a delay between Google Calendar calls. Google auth left as a `// TODO`.
- On branch `claude/slack-session-55vs2f`; a PR is being opened (nothing deployed).
- Top blockers still on Daniel: Midlothian Boulevard location ID; staff list + a Google calendar per staff member; store hours; which HighLevel calendars (Comprehensive SD / Regular SD); live Zap screenshots; Supabase access token (as a secret). Also: `us2.make.com` needs allowlisting to mirror the old Make scenario.

### 2026-11-20 — Viktor
- Created this file. Claude: your first task is in the Slack thread (PLAN.md, migrations, the 2 edge functions). Write your progress, questions and blockers below.
