# Project Notes — Sage & Vine – Midlothian — Staff Schedule Automation

> **Shared whiteboard.** This file is the single source of truth for shared
> context across all agents and the human team. Read it before starting work.
> See **Conventions for agents** near the bottom before editing.

## Project Overview

**Project:** Sage & Vine – Midlothian — Staff Schedule Automation

**Goal:** Rebuild, on a clean slate, the staff-schedule two-way sync automation
for a **NEW** branch: **"Sage & Vine – Midlothian"** (a salon/spa under the
**Lens Lab VA** group).

- The automation was **originally built by a developer named Omer**, and has
  **since been modified by the client, Daniel**.
- The original was built for a **different branch**; this is a **fresh replica**
  for the Midlothian location.

## The Original Stack Being Replicated

| Component | Role / Notes |
|-----------|--------------|
| **Boulevard** | Salon booking software; source of staff schedules. Could **NOT** two-way sync to Google Calendar directly — this is the core problem the automation solves. |
| **Make.com** | Scenario named `sa-csv-upload` that ingests a CSV of staff availability/schedules. Public link: https://us2.make.com/public/shared-scenario/0OQdrBfKtpS/sa-csv-upload |
| **Go High Level (GHL) / Hexona** | Hexona is a white-label GHL. Workflow id `dcc7383e-2672-4b24-a0c2-483466cb1461`, location `LVR0IH44rusBRb9E9L1Y`. Link: https://app.hexonasystems.com/v2/location/LVR0IH44rusBRb9E9L1Y/automation/workflow/dcc7383e-2672-4b24-a0c2-483466cb1461 |
| **Zapier** | Possibly involved — **unconfirmed**. |
| **Supabase** | The datastore (**NOT** GitHub, per Daniel's correction). |
| **Google Calendar** | The sync target. |

## Key Decision from Client (Daniel)

- Build **EVERYTHING** in the Supabase project `ifiurgmzizyhnhrbvpho.supabase.co`
  (the **NEW** target), unless something is genuinely easier kept where it
  already is.
- The **OLD/existing** Supabase is `chhhhfoljntqzeixnpzv.supabase.co` — read it to
  **copy the existing schema**.

## Code Repo

- **Repo:** `LensLabVA/sage-vine-midlo-staff-schedules`
- **Branch:** `claude/slack-session-g39sag`
- **State:** Confirmed a **clean slate** — no commits/files yet.

## Current Status (as of 2026-11-20)

- Repo: clean slate, ready to build.
- **Access held:** GitHub repo only.
- **Access NEEDED** (requested from Daniel, not yet received):
  1. **NEW Supabase** `ifiurgmzizyhnhrbvpho` — service-role key + DB connection string.
  2. **OLD Supabase** `chhhhfoljntqzeixnpzv` — read access to copy schema.
  3. **Make** `sa-csv-upload` blueprint (attempting public link; may need blueprint JSON export).
  4. **GHL/Hexona** workflow export or screenshots.
  5. **Zapier** Zaps (if any).
  6. **Google Calendar** target details + auth method.
  7. **Boulevard** — how schedules currently leave it (manual CSV export vs API).
  8. **Staff list** for Midlothian branch.
  9. The **context PDF** + **2 Fathom call transcripts**.

## Open Questions / Unknowns

- Exact Make scenario module sequence (being reverse-engineered).
- Supabase schema of the existing build.
- Whether Zapier is actually used or was replaced by Make.
- Google Calendar auth model (service account vs OAuth).

## Conventions for Agents Reading This File

- This file is the **single source of truth** for shared context.
- Update the **Current Status** and **Open Questions** sections as facts are
  confirmed.
- **Append dated entries** under the **Log** section at the bottom rather than
  rewriting history.
- Treat any **credentials/secrets as private** — never write service-role keys or
  API secrets into this file or any committed file; reference **where they're
  stored** instead.

## Log

- **2026-11-20** — Project initialized. Repo confirmed clean slate. Awaiting
  access provisioning. Reverse-engineering Make scenario from public link.
