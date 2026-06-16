// ============================================================
//  FILE:    supabase/functions/_shared/db.ts
//  TYPE:    Shared library - imported by functions, NOT deployed on its own
//  DEPLOY:  (none - do not deploy _shared files)
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Service-role client (bypasses RLS) — cron jobs run trusted, server-side only.
export const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// Cron jobs are deployed with --no-verify-jwt and protected by a shared secret.
export function authorized(req: Request): boolean {
  const secret = Deno.env.get("CRON_SECRET") ?? "";
  return secret !== "" && req.headers.get("x-cron-secret") === secret;
}

export const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
