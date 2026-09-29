#!/usr/bin/env node
/* ============================================================================
   PLAYER PROPS — insert-only copy of the prop ledger into Supabase
   (supabase/player_props.sql). The committed JSON feeds stay the page's
   source; this is the durable, queryable ledger.

     player_prop_ledger_quotes       the quotes the latest board build resolved to a
                              game and a player (football/props/.cache/
                              <league>_resolved_quotes.json). captured_at is the
                              FIRST poll that saw each price, so re-sending an
                              unchanged price hits the identity and is ignored:
                              the ledger is change-only by construction.
     player_prop_evaluations  the write-once decision records (evaluations.jsonl)
     player_prop_projections  the projection + distribution each record priced
     player_prop_results      the settled rows (results.jsonl)

   Every write is insert-ignore on the table's own identity, so running twice
   writes nothing twice. Without SB_URL / SB_SERVICE_ROLE (EDGD_SB_URL /
   EDGD_SB_SERVICE) it logs and exits 0: the page never depends on this.

     node football/props/sync_supabase.js [--league nfl|cfb] [--season 2026] [--days 4]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./config.js');
const PGR = require(path.join(C.ROOT, 'tools', 'lib', 'pgrest.js'));

function sha(x) { return crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex').slice(0, 24); }
function readJsonl(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean) : []; }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }

function quoteRows(resolved) {
  return (resolved || []).map((q) => ({
    quote_id: 'ppq_' + sha([q.sport, q.game_id, q.player_key, q.market, q.line, q.side, q.book, q.captured_at]),
    sport: q.sport, game_id: String(q.game_id), provider_event_id: q.provider_event_id || null, player_id: q.player_id || null, player_key: q.player_id || q.player_key,
    player_name: q.player_name, market: q.market, line: q.line, side: q.side, book: q.book, american: q.american, is_alternate: !!q.is_alternate,
    quoted_at: q.quoted_at || null, captured_at: q.captured_at, kickoff: q.kickoff || null
  }));
}
function evaluationRows(rows) {
  return rows.map((x) => ({
    evaluation_id: x.evaluation_id, kind: x.kind, selection_key: x.selection_key, prop_id: x.prop_id, sport: x.league, season: x.season || null, week: x.week || null,
    game_id: String(x.game_id), kickoff: x.kickoff, player_id: x.player_id, player_name: x.player_name || null, team: x.team || null, opponent: x.opp || null, position: x.position || null,
    market: x.market, evaluated_at: x.evaluated_at, decision: x.decision, reason_code: x.code || null, units: x.units || 0, confidence: x.confidence != null ? Math.round(x.confidence) : null,
    probability_source: x.probability_source, side: x.side || null, line: x.line != null ? x.line : null, american: x.american != null ? x.american : null, book: x.book || null,
    p_side: x.p_side != null ? x.p_side : null, ev: x.ev != null ? x.ev : null, ev_raw: x.ev_raw != null ? x.ev_raw : null, edge_pp: x.edge_pp != null ? x.edge_pp : null,
    consensus: x.consensus || null, model_over_at_consensus: x.model_over_at_consensus != null ? x.model_over_at_consensus : null, model_mean: x.model_mean != null ? x.model_mean : null, raw_mean: x.raw_mean != null ? x.raw_mean : null
  }));
}
function projectionRows(rows) {
  return rows.filter((x) => x.distribution).map((x) => ({
    projection_id: 'ppp_' + sha([x.league, x.game_id, x.player_id, x.market, x.model_version, x.evaluated_at]),
    sport: x.league, game_id: String(x.game_id), player_id: x.player_id, market: x.market, model_version: x.model_version || 'unknown', built_at: x.evaluated_at,
    raw_mean: x.raw_mean != null ? x.raw_mean : null, informed_mean: x.model_mean != null ? x.model_mean : null, median: x.median != null ? x.median : null, p25: x.p25 != null ? x.p25 : null, p75: x.p75 != null ? x.p75 : null,
    distribution: x.distribution, inputs: null
  }));
}
function resultRows(rows) {
  return rows.map((x) => ({
    evaluation_id: x.evaluation_id, kind: x.kind, result: x.result, reason: x.reason || null, stat_value: x.value != null ? x.value : null, units: x.units != null ? x.units : null,
    units_won: x.units_won != null ? x.units_won : null, flat_units_won: x.flat_units_won != null ? x.flat_units_won : null,
    close_line: x.clv && x.clv.close_line != null ? x.clv.close_line : null, close_price: x.clv && x.clv.close_price != null ? x.clv.close_price : null,
    line_clv: x.clv && x.clv.line_clv != null ? x.clv.line_clv : null, price_clv_cents: x.clv && x.clv.price_clv_cents != null ? x.clv.price_clv_cents : null,
    prob_clv_pp: x.clv && x.clv.prob_clv_pp != null ? x.clv.prob_clv_pp : null, beat_close: x.clv && x.clv.beat_close != null ? x.clv.beat_close : null, graded_at: x.graded_at
  }));
}

async function sync(o) {
  const now = o.now || Date.now(), since = now - (o.days || 4) * 86400e3;
  const P = C.leaguePaths(o.league, o.season);
  const recent = (t) => { const v = Date.parse(t); return Number.isFinite(v) && v >= since; };
  const evals = (o.evaluations || readJsonl(P.evaluations)).filter((x) => recent(x.evaluated_at) || recent(x.frozen_at));
  const results = (o.results || readJsonl(P.results)).filter((x) => recent(x.graded_at));
  const resolved = o.resolved || readJson(path.join(C.CACHE, o.league + '_resolved_quotes.json'));
  const db = o.db;
  const out = { league: o.league, quotes: 0, evaluations: 0, projections: 0, results: 0 };
  const put = async (rel, rows, conflict) => { if (!rows.length) return 0; await db.upsert('public', rel, rows, conflict, { ignoreDuplicates: true, returning: false }); return rows.length; };
  out.quotes = await put('player_prop_ledger_quotes', quoteRows(resolved && resolved.rows), 'sport,game_id,player_key,market,line,side,book,captured_at');
  out.evaluations = await put('player_prop_evaluations', evaluationRows(evals.filter((x) => Date.parse(x.evaluated_at) < Date.parse(x.kickoff))), 'evaluation_id');
  out.projections = await put('player_prop_projections', projectionRows(evals), 'projection_id');
  out.results = await put('player_prop_results', resultRows(results), 'evaluation_id');
  return out;
}

async function main() {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const cfg = PGR.config();
  if (!cfg) { console.log('[props sync] SB_URL / SB_SERVICE_ROLE are not set: nothing written (the page reads the committed feeds)'); return 0; }
  const league = arg('league', 'nfl'), season = Number(arg('season', C.seasonOf()));
  try {
    const r = await sync({ league, season, days: Number(arg('days', 4)), db: PGR.client(cfg) });
    console.log('[props sync] ' + JSON.stringify(r));
  } catch (e) {
    console.log('[props sync] ' + (PGR.refused(e) ? 'refused by the database (apply supabase/player_props.sql?): ' : 'failed: ') + (e.message || e));
  }
  return 0;
}

module.exports = { sync, quoteRows, evaluationRows, projectionRows, resultRows };
if (require.main === module) main().then((c) => process.exit(c || 0));
