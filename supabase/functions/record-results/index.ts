// record-results
//
// Records the outcome of a processing run. Make calls this AFTER it has created /
// deleted the Google Calendar events that process-schedule planned, to finalize
// the upload_batches row and reconcile each ooo_events row with its real Google
// event id. process-schedule itself does no Google calls, so this is where the
// 'pending' blocks become 'created' and the superseded blocks become 'deleted'.
//
// Request body (matches what the Make scenario now sends — see
// docs/old-make-scenario.md; `ooo_event_id` is the ooo_events row id returned by
// process-schedule):
//   {
//     batch_id: string,
//     status?: 'completed' | 'failed' | 'processing',   // default 'completed'
//     row_count?: number,
//     error?: string,
//     created?: Array<{ ooo_event_id: string, google_event_id: string }>,
//     deleted?: Array<{ ooo_event_id: string }>,
//     // back-compat: a generic events[] form is still accepted.
//     events?: Array<{ id: string, status: 'created'|'failed'|'deleted',
//                      google_event_id?: string, error?: string }>
//   }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handlePreflight } from "../_shared/cors.ts";

interface CreatedResult {
  ooo_event_id: string;
  google_event_id: string;
}

interface DeletedResult {
  ooo_event_id: string;
}

interface EventResult {
  id: string;
  status: "created" | "failed" | "deleted";
  google_event_id?: string;
  error?: string;
}

interface RequestBody {
  batch_id: string;
  status?: "completed" | "failed" | "processing";
  row_count?: number;
  error?: string;
  created?: CreatedResult[];
  deleted?: DeletedResult[];
  events?: EventResult[];
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
      batch_id,
      status,
      row_count,
      error,
      created,
      deleted,
      events,
    }: RequestBody = await req.json();
    if (!batch_id) return json({ error: "batch_id is required" }, 400);

    // Make's record-results JSON carries no explicit status; default to completed.
    const batchStatus = status ?? "completed";

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Update the batch row. processed_at is stamped once the run is terminal.
    const batchUpdate: Record<string, unknown> = {
      status: batchStatus,
      error: error ?? null,
    };
    if (row_count !== undefined) batchUpdate.row_count = row_count;
    if (batchStatus === "completed" || batchStatus === "failed") {
      batchUpdate.processed_at = new Date().toISOString();
    }

    const { error: batchErr } = await supabase
      .from("upload_batches")
      .update(batchUpdate)
      .eq("id", batch_id);
    if (batchErr) throw batchErr;

    let reconciled = 0;

    // Created events: pending -> created, with the Google event id Make returned.
    for (const ev of created ?? []) {
      if (!ev.ooo_event_id) continue;
      const { error: evErr } = await supabase
        .from("ooo_events")
        .update({ status: "created", google_event_id: ev.google_event_id ?? null })
        .eq("id", ev.ooo_event_id);
      if (!evErr) reconciled++;
    }

    // Deleted events: the superseded blocks Make removed from Google -> deleted.
    for (const ev of deleted ?? []) {
      if (!ev.ooo_event_id) continue;
      const { error: evErr } = await supabase
        .from("ooo_events")
        .update({ status: "deleted" })
        .eq("id", ev.ooo_event_id);
      if (!evErr) reconciled++;
    }

    // Back-compat: a generic events[] form (e.g. a manual retry/reconcile pass).
    for (const ev of events ?? []) {
      if (!ev.id) continue;
      const { error: evErr } = await supabase
        .from("ooo_events")
        .update({
          status: ev.status,
          google_event_id: ev.google_event_id ?? null,
          error: ev.error ?? null,
        })
        .eq("id", ev.id);
      if (!evErr) reconciled++;
    }

    return json({ batch_id, status: batchStatus, reconciled });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
