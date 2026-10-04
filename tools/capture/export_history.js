#!/usr/bin/env node
/* ===========================================================================
   EXPORT THE SIGNAL HISTORY the backtest harness reads.

   `signals` is RLS-protected — the anon key every page ships reads [] from it
   by design — so this needs the SERVICE ROLE key and is a local/CI tool, never
   something a browser runs.

     export SUPABASE_URL=https://<project>.supabase.co
     export SUPABASE_SERVICE_ROLE_KEY=<service role key>
     node tools/capture/export_history.js > history.ndjson
     node tools/capture/backtest.js history.ndjson

   WHAT IT EXPORTS, AND WHY EXACTLY THIS
     One row per QUALIFIED signal — `flagged_at IS NOT NULL` — because that is
     the canonical definition of a thing EdgeDesk claimed, and a backtest of the
     qualification policy must be a backtest of what the policy actually
     admitted. Stored-but-refused rows are deliberately NOT here: they were
     never bets, and including them would measure a system nobody ran.

     Every decision field comes from a flagged_* or first_* column, which
     capture froze at decision time and the database trigger makes permanent.
     That is what makes this export leak-proof at the source: the entry price in
     it is the price EdgeDesk committed to, not the last price it saw.

   THE CLOSE
     `closing_sharp_fair` is written by the close pipeline. Where it is missing,
     the last signal_ticks row AT OR BEFORE commence_time is used and the row is
     marked `close_source: "tick"` so a report can separate the two rather than
     silently mixing a graded close with an inferred one. A tick AFTER kickoff
     is a live price and is never a close.

   --limit N        stop after N signals (default: everything)
   --since ISO      only signals flagged on or after this timestamp
   --policy NAME    only signals produced by one qualification policy
   --no-ticks       skip the tick fallback for the close (faster, fewer rows)
   =========================================================================== */
'use strict';

const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const COLS = [
  'sig_key', 'event_id', 'sport_key', 'sport_title', 'market', 'selection', 'point',
  'commence_time', 'flagged_at', 'graded_at',
  'flagged_best_dec', 'flagged_best_book', 'flagged_edge', 'flagged_sharp_fair',
  'flagged_has_sharp', 'flagged_corrob_n', 'flagged_tier', 'flagged_reference_type',
  'flagged_quality_score', 'flagged_fresh_books', 'flagged_policy', 'flagged_build',
  'first_seen_at', 'first_best_dec', 'first_edge', 'first_has_sharp', 'first_reference_type',
  'qual_tier', 'qual_reason', 'qual_streak', 'reference_type', 'reference_book',
  'quality_score', 'fresh_books', 'n_books', 'n_books_eff', 'dispersion',
  'ref_quote_age_s', 'best_quote_age_s', 'edge_floor', 'devig_method',
  'pin_dec', 'pin_opp_dec', 'is_fav', 'point_is_modal', 'modal_point',
  'sharp_fair', 'consensus_fair', 'closing_sharp_fair', 'edge', 'best_dec',
  'result', 'clv', 'beat_close', 'clv_excluded_reason',
].join(',');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const has = (name) => process.argv.indexOf(name) >= 0;

async function get(path) {
  const r = await fetch(`${SB_URL.replace(/\/+$/, '')}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Accept: 'application/json' },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${path.slice(0, 120)} — ${text.slice(0, 300)}`);
  return JSON.parse(text || '[]');
}

/**
 * The last tick at or before kickoff, per signal.
 *
 * This is the ONLY legitimate fallback for a missing close, and the "at or
 * before" is load-bearing: a tick written after the game started is a live
 * in-play price, and grading an entry against one would be scoring a bet
 * against a number that already knew the score.
 */
async function closesFromTicks(rows) {
  const out = new Map();
  for (let i = 0; i < rows.length; i += 40) {
    const batch = rows.slice(i, i + 40);
    const list = batch.map((r) => `"${String(r.sig_key).replace(/"/g, '')}"`).join(',');
    let ticks = [];
    try {
      ticks = await get(`signal_ticks?select=sig_key,created_at,sharp_fair,best_dec`
        + `&sig_key=in.(${encodeURIComponent(list)})&order=created_at.asc&limit=20000`);
    } catch (e) { process.stderr.write(`tick read failed for a batch: ${e.message}\n`); continue; }
    const kick = new Map(batch.map((r) => [r.sig_key, Date.parse(r.commence_time)]));
    for (const t of ticks) {
      const k = kick.get(t.sig_key);
      if (!Number.isFinite(k) || Date.parse(t.created_at) > k) continue;   // never a live price
      out.set(t.sig_key, t);   // ordered ascending, so the last one at or before kickoff wins
    }
  }
  return out;
}

async function main() {
  if (!SB_URL || !SB_KEY) {
    process.stderr.write(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.\n'
      + '`signals` is RLS-protected and the anon key reads [] from it by design, so an export needs the\n'
      + 'service role key. Do not put it in a browser, a committed file, or a public CI log.\n');
    process.exit(2);
  }

  const limit = Number(arg('--limit', '0')) || 0;
  const since = arg('--since', null);
  const policy = arg('--policy', null);

  let filter = 'flagged_at=not.is.null&flagged_best_dec=not.is.null';
  if (since) filter += `&flagged_at=gte.${encodeURIComponent(since)}`;
  if (policy) filter += `&flagged_policy=eq.${encodeURIComponent(policy)}`;

  const all = [];
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    const rows = await get(`signals?select=${COLS}&${filter}&order=flagged_at.asc&offset=${offset}&limit=${page}`);
    all.push(...rows);
    process.stderr.write(`fetched ${all.length}\r`);
    if (rows.length < page) break;
    if (limit && all.length >= limit) break;
  }
  const rows = limit ? all.slice(0, limit) : all;
  process.stderr.write(`\nfetched ${rows.length} qualified signals\n`);

  let tickCloses = new Map();
  const needTicks = rows.filter((r) => r.closing_sharp_fair == null && r.graded_at != null);
  if (!has('--no-ticks') && needTicks.length) {
    process.stderr.write(`${needTicks.length} graded signals have no closing fair; checking ticks\n`);
    tickCloses = await closesFromTicks(needTicks);
  }

  let withClose = 0, tickSourced = 0;
  for (const r of rows) {
    let closingFair = r.closing_sharp_fair, closingDec = null, closeSource = null;
    if (closingFair != null) { closeSource = 'close_pipeline'; }
    else {
      const t = tickCloses.get(r.sig_key);
      if (t && t.sharp_fair != null) { closingFair = t.sharp_fair; closingDec = t.best_dec; closeSource = 'tick'; tickSourced++; }
    }
    if (closingFair != null) withClose++;

    const hoursToStart = (Date.parse(r.commence_time) - Date.parse(r.flagged_at)) / 3600000;

    process.stdout.write(JSON.stringify({
      // identity
      sig_key: r.sig_key, event_id: r.event_id,
      sport_key: r.sport_key, sport_title: r.sport_title,
      market: r.market, selection: r.selection, point: r.point,
      commence_time: r.commence_time,

      // DECISION — every one of these is a frozen column, so none can drift
      decision_at: r.flagged_at,
      hours_to_start: Number.isFinite(hoursToStart) ? hoursToStart : null,
      entry_dec: r.flagged_best_dec,
      entry_book: r.flagged_best_book,
      fair_prob: r.flagged_sharp_fair,
      edge: r.flagged_edge,
      edge_floor: r.edge_floor,
      /* Pre-v9 rows have no frozen tier. They are labelled rather than guessed:
         a legacy flag is a legacy flag, and calling it Tier A because it happens
         to have has_sharp set would be inventing history. */
      tier: r.flagged_tier ?? (r.flagged_policy ? null : 'LEGACY'),
      reference_type: r.flagged_reference_type ?? (r.flagged_has_sharp ? 'sharp?' : 'unknown'),
      reference_book: r.reference_book,
      quality_score: r.flagged_quality_score,
      n_books: r.n_books, fresh_books: r.flagged_fresh_books ?? r.fresh_books,
      families: r.n_books_eff, dispersion: r.dispersion,
      ref_quote_age_s: r.ref_quote_age_s, best_quote_age_s: r.best_quote_age_s,
      qual_streak: r.qual_streak,
      pin_dec: r.pin_dec, pin_opp_dec: r.pin_opp_dec,
      is_fav: r.is_fav, devig_method: r.devig_method,
      point_is_modal: r.point_is_modal, modal_point: r.modal_point,
      flagged_policy: r.flagged_policy ?? 'pre-v9-legacy',
      flagged_build: r.flagged_build ?? 'pre-v9-unknown',

      // OUTCOME — never read by a policy; the harness's Proxy enforces that
      result: r.result, graded_at: r.graded_at,
      closing_fair: closingFair, closing_dec: closingDec,
      /* The closing POINT is not stored anywhere today. It is emitted as null
         rather than approximated, so line CLV reports "not measurable" instead
         of a number derived from the entry point standing in for the close.
         See REMAINING WEAKNESSES in supabase/functions/capture/README.md. */
      closing_point: null,
      close_source: closeSource,
      stored_clv: r.clv, stored_beat_close: r.beat_close,
      clv_excluded_reason: r.clv_excluded_reason,
    }) + '\n');
  }

  process.stderr.write(
    `\nexported ${rows.length} rows\n`
    + `  with a close: ${withClose} (${tickSourced} of them from a tick rather than the close pipeline)\n`
    + `  graded:       ${rows.filter((r) => r.graded_at != null).length}\n`
    + `  by policy:    ${JSON.stringify(rows.reduce((a, r) => {
      const k = r.flagged_policy || 'pre-v9-legacy'; a[k] = (a[k] || 0) + 1; return a;
    }, {}))}\n`
    + `\nA backtest over a mix of policies is the average of two systems. Use --policy to hold one fixed.\n`);
}

main().catch((e) => { process.stderr.write(String(e.stack || e) + '\n'); process.exit(1); });
