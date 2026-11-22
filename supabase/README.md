# Supabase — Sage & Vine (Midlothian) scheduling

> **Nothing here is deployed.** These are scaffolds. Do not deploy functions or run
> migrations against any live project until Daniel says go. Target project is
> `ifiurgmzizyhnhrbvpho` (the old `chhhhfoljntqzeixnpzv` stays untouched).

## Layout

```
supabase/
  migrations/
    0001_init.sql            # employees, store_hours, upload_batches, ooo_events
    0002_service_mapping_and_seed.sql  # service cols + ooo_events.location_id + seed
  functions/
    _shared/
      cors.ts                # shared CORS headers + preflight helper
      time.ts                # timezone / threshold / planning-window helpers
    process-schedule/
      index.ts               # raw CSV -> OOO plan (events_to_create / events_to_delete)
    record-results/
      index.ts               # finalize upload_batches + reconcile ooo_events
```

## Local dev

Requires the [Supabase CLI](https://supabase.com/docs/guides/cli) and Deno.

```bash
# Start the local stack (Postgres, etc.)
supabase start

# Apply migrations to the LOCAL database only
supabase db reset

# Serve the edge functions locally
supabase functions serve process-schedule
supabase functions serve record-results
```

## Required env vars / secrets

Set locally in `supabase/.env` (git-ignored) and, when the time comes, as deployed
secrets via `supabase secrets set`. **Never paste secrets into Slack or commit them.**

| Variable | Used by | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | both functions | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | both functions | Service-role key for table writes |

> No Google credentials are needed by these functions. `process-schedule` only
> computes the OOO plan and returns it; **Make performs all Google Calendar
> create/delete calls** (see `docs/old-make-scenario.md` and the Make section of
> `PLAN.md`).

## Notes

- RLS policies are intentionally **deferred** until the auth model is decided (see the
  comment in `0001_init.sql`). Until then the functions rely on the service-role key.
- `process-schedule` parses the raw Boulevard CSV in-function. The exact column headers are
  a best guess — see the `// TODO: confirm exact Boulevard CSV column headers` comment and
  `PLAN.md` open questions.
- Google Calendar is written by **Make**, not these functions (task 7 / old Make contract),
  so no Google auth lives here.
