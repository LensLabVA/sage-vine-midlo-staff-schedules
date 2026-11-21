# Old Make scenario "SA_csv_upload" (read by Viktor, 2026-11-21)
Source: public share https://us2.make.com/public/shared-scenario/0OQdrBfKtpS/sa-csv-upload (JSON at api/v2/public/scenarios-shared/0OQdrBfKtpS). Keys removed.

## Module flow
1. Tally `watchNewResponse` (form ja9Dk9)
2. HTTP `DownloadFile`: the CSV file field (`question_qBz9OG`)
3. Set variable `csvText` = toString(file)
4. Create JSON: `{csv, cutoff_date (question_2kzb1L), uploaded_by_name (question_G1bWYe), uploaded_by_email (question_OPEv8a)}`
5. HTTP POST `.../functions/v1/process-schedule`, using the anon key as a Bearer token, with a 180s timeout
6. Iterator over `data.employees[]`. Each item has `employee_name`, `google_calendar_id`, `events_to_create[] {ooo_event_id,start_at,end_at}` and `events_to_delete[] {ooo_event_id,google_event_id}`
7. If/else router with **one branch per staff name** (Cara, Lexi, Moriah, Nikki, Sydney, plus an empty else). Each branch:
   - Iterate the create list, then Google Calendar `createAnEvent`: summary "<name> OOO", busy (opaque), on a **hardcoded** calendar (e.g. cara.sageandvine@gmail.com). Then aggregate `{ooo_event_id, google_event_id, google_calendar_id}`.
   - Iterate the delete list, then `deleteAnEvent`, then aggregate `{ooo_event_id}`.
   - Create JSON `{created, deleted, batch_id}`, then POST `record-results`.

So the server already decides what to create and what to delete (that's re-upload handling), and the cutoff date already exists as a Tally field.

## Bugs found in the live scenario
- **Moriah branch has NO condition.** Make takes the first matching branch, so every employee that isn't Cara or Lexi (Nikki, Sydney) probably falls into Moriah's branch and gets written to **Moriah's calendar**.
- The 1-second sleep exists only in the Lexi and Nikki branches; the other branches have none, so they can still hit the rate limit.
- Calendars and staff names are hardcoded in the router, so adding a staff member means adding a new branch.
- The anon key is visible in the public share link.

## New build (Midlothian)
- **No per-staff router.** Use one create path and one delete path with `calendar = {{employee.google_calendar_id}}`. Each staff calendar gets shared (make changes) with the one Google account connected in Make.
- Add a 1s sleep after every create and every delete. Turn on "store incomplete executions".
- Keep the same contract: input `{csv, cutoff_date, uploaded_by_*, location_id}`, output `employees[]` with create and delete lists.
