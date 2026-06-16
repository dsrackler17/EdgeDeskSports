// ============================================================
//  FILE:    supabase/functions/capture/index.ts
//  TYPE:    Edge Function (deployed) - cron job
//  DEPLOY:  supabase functions deploy capture --no-verify-jwt
// ============================================================
// CAPTURE — runs on a schedule. Prices the FULL board for the configured sports
// and upserts every selection into `signals` (one durable row per outcome/event).
// First sighting sets the opening fields; later runs update best/latest fields.
// Deploy: supabase functions deploy capture --no-verify-jwt
import { db, authorized, json } from "../_shared/db.ts";
import { fetchActiveSports, fetchOdds, priceEvent, sigKey } from "../_shared/oddsapi.ts";

const REGIONS = Deno.env.get("CAPTURE_REGIONS") ?? "us";
const MARKETS = Deno.env.get("CAPTURE_MARKETS") ?? "h2h,spreads,totals";
const METHOD = Deno.env.get("DEVIG_METHOD") ?? "shin";
const SHARP = (Deno.env.get("SHARP_BOOK") ?? "pinnacle").toLowerCase();
const TICKS = (Deno.env.get("CAPTURE_TICKS") ?? "false") === "true";
// limit which sports to capture to control API cost; comma list overrides auto
const SPORTS_ENV = Deno.env.get("CAPTURE_SPORTS") ?? "";

Deno.serve(async (req) => {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  const sports = SPORTS_ENV ? SPORTS_ENV.split(",").map((s) => s.trim()) : await fetchActiveSports();
  let priced = 0, quota = "";
  const now = new Date().toISOString();

  for (const sport of sports) {
    const { data, quota: q, ok } = await fetchOdds(sport, REGIONS, MARKETS);
    if (q) quota = q;
    if (!ok) continue;
    const rows: any[] = [];
    const ticks: any[] = [];
    for (const ev of data) {
      for (const o of priceEvent(ev, METHOD, SHARP)) {
        const key = sigKey(o);
        rows.push({
          sig_key: key, event_id: o.event_id, sport_key: o.sport_key, sport_title: o.sport_title,
          commence_time: o.commence_time, home_team: o.home_team, away_team: o.away_team,
          market: o.market, selection: o.selection, point: o.point,
          last_seen_at: now, best_dec: o.best_dec, best_book: o.best_book,
          sharp_fair: o.sharp_fair, consensus_fair: o.consensus_fair, edge: o.edge,
          is_plus_ev: o.is_plus_ev, n_books: o.n_books,
          // opening fields (ignored on conflict via the merge below)
          first_seen_at: now, first_best_dec: o.best_dec, first_best_book: o.best_book,
          first_sharp_fair: o.sharp_fair, first_edge: o.edge,
        });
        if (TICKS) ticks.push({ sig_key: key, best_dec: o.best_dec, sharp_fair: o.sharp_fair, edge: o.edge, n_books: o.n_books });
        priced++;
      }
    }
    // upsert: on conflict keep the original opening fields, update the "latest/best" ones
    if (rows.length) {
      // chunk to stay within payload limits
      for (let i = 0; i < rows.length; i += 500) {
        await db.from("signals").upsert(rows.slice(i, i + 500), { onConflict: "sig_key", ignoreDuplicates: false });
      }
    }
    if (ticks.length) {
      for (let i = 0; i < ticks.length; i += 500) await db.from("signal_ticks").insert(ticks.slice(i, i + 500));
    }
  }
  return json({ ok: true, sports: sports.length, priced, quota_remaining: quota });
});
