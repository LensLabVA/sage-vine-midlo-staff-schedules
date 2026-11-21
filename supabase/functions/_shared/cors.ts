// Shared CORS headers for the edge functions.
// Callers are server-to-server (Make), so this is permissive by default.
// TODO: tighten `Access-Control-Allow-Origin` once the caller origin is known.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Returns a 204 response for CORS preflight, or null if not a preflight request.
export function handlePreflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return null;
}
