# Supabase — Sage & Vine (Midlothian) scheduling

> **Nothing here is deployed.** These are scaffolds. Do not deploy functions or run
> migrations against any live project until Daniel says go. Target project is
> `ifiurgmzizyhnhrbvpho` (the old `chhhhfoljntqzeixnpzv` stays untouched).

## Layout

```
supabase/
  migrations/
    0001_init.sql            # employees, store_hours, upload_batches, ooo_events
  functions/
    _shared/
      cors.ts                # shared CORS headers + preflight helper
      time.ts                # timezone / threshold / planning-window helpers
    process-schedule/
      index.ts               # CSV shifts -> OOO blocks -> Google Calendar
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
| `GOOGLE_ACCESS_TOKEN` | process-schedule | **Placeholder** — see TODO in `process-schedule/index.ts`. Real build needs a service-account / OAuth token for the Google Calendar API |

## Notes

- RLS policies are intentionally **deferred** until the auth model is decided (see the
  comment in `0001_init.sql`). Until then the functions rely on the service-role key.
- Google Calendar auth is stubbed with a `// TODO` — the auth model (service account with
  domain-wide delegation vs. per-user OAuth) is an open question in `PLAN.md`.
