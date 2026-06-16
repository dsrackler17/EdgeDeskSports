// EdgeDesk frontend config — these values are PUBLIC-SAFE.
// The Supabase anon key is designed to be exposed (Row-Level Security protects data).
// Your ODDS API key is NOT here — it lives only in the Edge Function secret.
window.EDGEDESK_CONFIG = {
  // From Supabase → Project Settings → API
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-PUBLIC-KEY",
  // The deployed Edge Function URL (Supabase → Edge Functions → odds)
  ODDS_FUNCTION_URL: "https://YOUR-PROJECT.supabase.co/functions/v1/odds",
  // The sharp book to anchor fair lines (case-insensitive contains match)
  SHARP_BOOK: "pinnacle",
};
