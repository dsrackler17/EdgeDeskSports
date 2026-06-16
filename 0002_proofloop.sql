// ============================================================
//  FILE:    supabase/functions/close/index.ts
//  TYPE:    Edge Function (deployed) - cron job
//  DEPLOY:  supabase functions deploy close --no-verify-jwt
// ============================================================
// CLOSE — snapshots the closing line just before kickoff and computes price CLV.
// Finds signals whose event starts soon and aren't closed yet, re-prices, stores
// the closing fair + CLV. Deploy: supabase functions deploy close --no-verify-jwt
import { db, authorized, json } from "../_shared/db.ts";
import { fetchOdds, priceEvent, sigKey } from "../_shared/oddsapi.ts";

const REGIONS = Deno.env.get("CAPTURE_REGIONS") ?? "us";
const MARKETS = Deno.env.get("CAPTURE_MARKETS") ?? "h2h,spreads,totals";
const METHOD = Deno.env.get("DEVIG_METHOD") ?? "shin";
const SHARP = (Deno.env.get("SHARP_BOOK") ?? "pinnacle").toLowerCase();
const WINDOW_MIN = Number(Deno.env.get("CLOSE_WINDOW_MIN") ?? "35"); // start grabbing close this many min before kickoff

Deno.serve(async (req) => {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  const now = Date.now();
  const horizon = new Date(now + WINDOW_MIN * 60000).toISOString();
  const nowIso = new Date(now).toISOString();

  const { data: pending } = await db.from("signals")
    .select("sig_key,sport_key,event_id,best_dec,sharp_fair")
    .is("closed_at", null).gte("commence_time", nowIso).lte("commence_time", horizon).limit(5000);
  if (!pending?.length) return json({ ok: true, closed: 0 });

  const sports = [...new Set(pending.map((p) => p.sport_key))];
  const fresh = new Map<string, any>();
  for (const sport of sports) {
    const { data, ok } = await fetchOdds(sport, REGIONS, MARKETS);
    if (!ok) continue;
    for (const ev of data) for (const o of priceEvent(ev, METHOD, SHARP)) fresh.set(sigKey(o), o);
  }

  let closed = 0;
  for (const p of pending) {
    const o = fresh.get(p.sig_key);
    const closeFair = o ? o.sharp_fair : p.sharp_fair;          // fallback to last seen if line pulled
    const closeDec = o ? o.best_dec : null;
    const clv = (p.best_dec ?? 0) * closeFair - 1;              // your price vs closing fair
    await db.from("signals").update({
      closing_dec: closeDec, closing_book: o?.best_book ?? null,
      closing_sharp_fair: closeFair, clv, closed_at: nowIso,
    }).eq("sig_key", p.sig_key);
    closed++;
  }
  return json({ ok: true, closed });
});
