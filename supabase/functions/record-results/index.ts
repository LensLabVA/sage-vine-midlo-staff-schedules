// record-results
//
// Records the outcome of a processing run. Make (or process-schedule) calls this
// to finalize an upload_batches row and, optionally, to reconcile individual
// ooo_events statuses.
//
// Request body:
//   {
//     batch_id: string,
//     status: 'completed' | 'failed' | 'processing',
//     row_count?: number,
//     error?: string,
//     events?: Array<{ id: string, status: 'created'|'failed'|'deleted',
//                      google_event_id?: string, error?: string }>
//   }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handlePreflight } from "../_shared/cors.ts";

interface EventResult {
  id: string;
  status: "created" | "failed" | "deleted";
  google_event_id?: string;
  error?: string;
}

interface RequestBody {
  batch_id: string;
  status: "completed" | "failed" | "processing";
  row_count?: number;
  error?: string;
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
    const { batch_id, status, row_count, error, events }: RequestBody =
      await req.json();
    if (!batch_id) return json({ error: "batch_id is required" }, 400);
    if (!status) return json({ error: "status is required" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Update the batch row. processed_at is stamped once the run is terminal.
    const batchUpdate: Record<string, unknown> = {
      status,
      row_count: row_count ?? null,
      error: error ?? null,
    };
    if (status === "completed" || status === "failed") {
      batchUpdate.processed_at = new Date().toISOString();
    }

    const { error: batchErr } = await supabase
      .from("upload_batches")
      .update(batchUpdate)
      .eq("id", batch_id);
    if (batchErr) throw batchErr;

    // Optionally reconcile per-event statuses (e.g. a retry pass that updated
    // some Google events outside process-schedule).
    let reconciled = 0;
    for (const ev of events ?? []) {
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

    return json({ batch_id, status, reconciled });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
