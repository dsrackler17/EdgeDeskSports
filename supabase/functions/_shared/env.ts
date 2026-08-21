// Shared environment access for Collective edge functions.
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_ANON_KEY are injected
// by the Supabase runtime. COLLECTIVE_BASE_URL is an optional secret that
// points at the public site root and defaults to production.

export const SB_URL: string = Deno.env.get("SUPABASE_URL") ?? "";
export const SERVICE_KEY: string = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
export const ANON_KEY: string = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
export const BASE_URL: string = Deno.env.get("COLLECTIVE_BASE_URL") ?? "https://edgedesksports.com";
