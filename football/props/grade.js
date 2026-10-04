#!/usr/bin/env node
/* ============================================================================
   PLAYER PROPS — settlement, CLV and the performance / calibration report
   (docs/player-props/DESIGN.md §8).

   READS   football/props/<league>/<season>/evaluations.jsonl   (write-once decision records)
             kind 'qualified'  the first time a selection reached BET or LEAN, at its price
             kind 'final'      the last pregame evaluation of every priced prop (the close)
           football/props/<league>/<season>/results.jsonl       (already settled — never re-graded)
           the league dataset (official box scores: nflverse / ESPN player box)
   WRITES  results.jsonl (append-only), football/props/<league>/performance.json
           and football/props/<league>/settlement.json (why each started,
           unsettled BET / LEAN is still pending — pendingStatus)

   SETTLEMENT (EDProps.settle)
     WIN / LOSS by the official statistic, overtime included; PUSH on a whole
     line landed exactly; VOID when the player did not play (no box line in a
     game whose box is published), when the game was cancelled, or when the
     statistic is not published for that market. A game whose box is not yet
     published stays PENDING — it is never voided for lateness.
   CORRECTIONS — a settled row is never edited and never graded a second
     time as if new. When the official statistic behind a settled grade
     changes (an NFL stat correction, a box score republished), correct()
     APPENDS a correction row for the same evaluation: `correction: true`,
     what it corrects (`corrects` = that grade's graded_at) and why. The
     latest row per evaluation is the settlement (latest()); the history
     stays on file. A correction never turns a graded bet into a VOID because
     a feed dropped a line, and only looks back CORRECTION_DAYS after kickoff.
   CLV (EDProps.clv) — entry vs the close:
     the close is the last pregame capture of the SAME prop ('final' row):
     line CLV always, price CLV and no-vig probability CLV only at the same
     number. No close on file → CLV unavailable, never invented.
   CALIBRATION — every priced prop's final pregame P(over) at the consensus
     line against the result, bucketed 50–55 … 70+ (folded), with Brier and
     ECE; it promotes the probability source only through
     EDProps.calibrationState (≥ 500 settled and ECE ≤ 0.03 → PARTIAL).

     node football/props/grade.js [--league nfl|cfb] [--season 2026] [--offline] [--write]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./config.js');
global.window = global.window || global;
require(path.join(C.ROOT, 'lib', 'research_core.js'));
const EDP = require(path.join(C.ROOT, 'lib', 'edgedesk_props.js'));

const PERF_SCHEMA = 'edgedesk_player_props_performance_v1';
function readJsonl(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean) : []; }
function r4(x) { return typeof x === 'number' && isFinite(x) ? Math.round(x * 10000) / 10000 : null; }

/* the dataset indexed once: games by id, box lines by player and game */
function indexOf(ds) {
  if (ds._gradeIx) return ds._gradeIx;
  const games = {}, published = new Set(), lines = {};
  (ds.schedule || []).forEach((g) => { games[String(g.game_id)] = g; });
  Object.values(ds.players).forEach((q) => q.logs.forEach((l) => { published.add(String(l.gid)); lines[q.id + '|' + l.gid] = l; }));
  ds._gradeIx = { games, published, lines };
  return ds._gradeIx;
}
/* the official line of one player in one game, from the dataset */
function resultOf(ds, row) {
  const ix = indexOf(ds);
  const g = ix.games[String(row.game_id)];
  if (!g) return { state: 'PENDING', reason: 'game not in the schedule feed' };
  if (g.status === 'cancelled' || g.status === 'postponed') return { state: 'VOID', reason: 'game ' + g.status };
  if (g.status !== 'final') return { state: 'PENDING', reason: 'game not final' };
  /* is this game's box published at all? (any player row for it) */
  if (!ix.published.has(String(row.game_id))) return { state: 'PENDING', reason: 'box score not published yet' };
  const log = ix.lines[row.player_id + '|' + row.game_id] || null;
  if (!log) return { state: 'SETTLE', played: false };
  const played = (log.snp != null ? log.snp > 0 : true);
  const v = EDP.statOf(row.market, log);
  if (v == null) return { state: 'VOID', reason: 'statistic not published for this market' };
  return { state: 'SETTLE', played, value: v, overtime: !!g.overtime };
}

/* the settlement of each evaluation: its latest result row (a correction
   row supersedes the grade it corrects; nothing is removed from the file) */
function latest(results) {
  const by = {}, order = [];
  (results || []).forEach((x) => {
    if (!x || !x.evaluation_id) return;
    const p = by[x.evaluation_id];
    if (!p) order.push(x.evaluation_id);
    if (!p || (Date.parse(x.graded_at) || 0) >= (Date.parse(p.graded_at) || 0)) by[x.evaluation_id] = x;
  });
  return order.map((k) => by[k]);
}

const CORRECTION_DAYS = 14;
/* re-read the official statistic behind every settled grade and append a
   correction row where it changed */
function correct(ds, rows, done, now) {
  const cur = {};
  latest(done).forEach((x) => { cur[x.evaluation_id] = x; });
  const out = [];
  rows.forEach((x) => {
    const g = cur[x.evaluation_id];
    if (!g) return;
    const k = Date.parse(x.kickoff);
    if (isFinite(k) && now - k > CORRECTION_DAYS * 86400000) return;
    const res = resultOf(ds, x);
    /* only a published statistic for a player who played can correct a grade */
    if (res.state !== 'SETTLE' || res.played === false || typeof res.value !== 'number') return;
    let line = x.line, side = x.side;
    if (x.kind === 'final') { const c = x.consensus || {}; if (c.line == null) return; line = c.line; side = 'over'; }
    const s = EDP.settle(x.market, line, side, { played: true, value: res.value });
    if (s.result === g.result && (g.value === res.value || (g.value == null && res.value == null))) return;
    const rec = Object.assign({}, g, { result: s.result, value: s.value != null ? s.value : null, graded_at: new Date(now).toISOString(),
      correction: true, corrects: g.graded_at || null,
      correction_reason: 'official statistic changed: ' + (g.value != null ? g.value : g.result) + ' → ' + res.value + ' (' + g.result + ' → ' + s.result + ')' });
    delete rec.reason;
    if (s.reason) rec.reason = s.reason;
    if (x.kind === 'qualified') {
      rec.units_won = EDP.unitsWon(rec.result, x.american, x.units > 0 ? x.units : 1);
      rec.flat_units_won = EDP.unitsWon(rec.result, x.american, 1);
    }
    out.push(rec);
  });
  return out;
}

function grade(ds, rows, done, now) {
  const seen = new Set(done.map((x) => x.evaluation_id));
  const finals = {};
  rows.filter((x) => x.kind === 'final').forEach((x) => { const k = x.prop_id; if (!finals[k] || x.evaluated_at > finals[k].evaluated_at) finals[k] = x; });
  const out = [];
  rows.forEach((x) => {
    if (seen.has(x.evaluation_id)) return;
    const res = resultOf(ds, x);
    if (res.state === 'PENDING') return;
    const rec = { schema: 'edgedesk_player_props_result_v1', evaluation_id: x.evaluation_id, kind: x.kind, prop_id: x.prop_id, league: x.league, season: x.season, game_id: x.game_id,
      player_id: x.player_id, market: x.market, position: x.position, decision: x.decision, graded_at: new Date(now).toISOString() };
    if (res.state === 'VOID') Object.assign(rec, { result: 'VOID', reason: res.reason });
    if (x.kind === 'qualified') {
      if (res.state === 'SETTLE') { const s = EDP.settle(x.market, x.line, x.side, { played: res.played, value: res.value }); rec.result = s.result; rec.value = s.value != null ? s.value : null; if (s.reason) rec.reason = s.reason; }
      rec.side = x.side; rec.line = x.line; rec.american = x.american; rec.book = x.book; rec.units = x.units; rec.ev = x.ev; rec.p_side = x.p_side; rec.confidence = x.confidence;
      rec.units_won = rec.result === 'VOID' ? 0 : EDP.unitsWon(rec.result, x.american, x.units > 0 ? x.units : 1);
      rec.flat_units_won = rec.result === 'VOID' ? 0 : EDP.unitsWon(rec.result, x.american, 1);
      const f = finals[x.prop_id];
      rec.clv = f && f.consensus && f.consensus.line != null && f.evaluated_at >= x.evaluated_at ? EDP.clv({ side: x.side, line: x.line, american: x.american }, { line: f.consensus.line, over: f.consensus.over, under: f.consensus.under }) : { available: false, reason: 'no pregame close captured for this prop' };
      if (rec.clv) rec.clv.close_at = f ? f.evaluated_at : null;
    } else {
      /* a final row: the over at the consensus line, for calibration */
      const c = x.consensus || {};
      if (res.state === 'SETTLE' && c.line != null) { const s = EDP.settle(x.market, c.line, 'over', { played: res.played, value: res.value }); rec.result = s.result; rec.value = s.value != null ? s.value : null; if (s.reason) rec.reason = s.reason; }
      else if (!rec.result) { rec.result = 'VOID'; rec.reason = 'no consensus line'; }
      rec.line = c.line; rec.p_over = x.model_over_at_consensus; rec.novig_over = c.novig_over;
    }
    out.push(rec);
  });
  return out;
}

/* WHY A STARTED PROP IS STILL PENDING. grade() leaves a prop it cannot settle
   off the results file; this keeps the reason instead of dropping it, so the
   Record can say what "pending" means (tools/record/pnl_ledger.js reads it).
   Only qualified rows whose game has kicked off and that have no settlement
   are listed; a prop before its kickoff is simply upcoming. */
const PENDING_CODE = {
  'game not in the schedule feed': 'MISSING_MAPPING',
  'game not final': 'GAME_NOT_FINAL',
  'box score not published yet': 'STAT_FEED_PENDING'
};
function pendingStatus(ds, rows, settled, now) {
  const done = new Set((settled || []).map((x) => x.evaluation_id));
  const out = {};
  (rows || []).forEach((x) => {
    if (x.kind !== 'qualified' || done.has(x.evaluation_id)) return;
    const k = Date.parse(x.kickoff);
    if (!Number.isFinite(k) || k > now) return;
    if (!ds || !ds.ok) { out[x.evaluation_id] = { code: 'DATASET_UNAVAILABLE', reason: 'the stat dataset could not be loaded' + (ds && ds.error ? ': ' + ds.error : ''), game_id: String(x.game_id), kickoff: x.kickoff }; return; }
    const res = resultOf(ds, x);
    if (res.state !== 'PENDING') return;   /* settles on this run (or a VOID): not pending */
    out[x.evaluation_id] = { code: PENDING_CODE[res.reason] || 'UNKNOWN', reason: res.reason || null, game_id: String(x.game_id), kickoff: x.kickoff };
  });
  return out;
}
function settlementFile(league, season, ds, pending, now) {
  const codes = {};
  Object.keys(pending).forEach((k) => { const c = pending[k].code; codes[c] = (codes[c] || 0) + 1; });
  return { schema: 'edgedesk_player_props_settlement_v1', league, season, checked_at: new Date(now).toISOString(),
    what: 'Every BET / LEAN whose game has kicked off and is not settled yet, with the reason the last grading run gave. Written by football/props/grade.js; read by tools/record/pnl_ledger.js.',
    dataset: ds && ds.ok ? { ok: true } : { ok: false, error: ds ? String(ds.error || 'unavailable') : 'not loaded' },
    counts: codes, pending };
}

function marketEvidence(results) {
  const out = {};
  const finals = results.filter((x) => x.kind === 'final');
  Array.from(new Set(finals.map((x) => x.market))).sort().forEach((m) => {
    const f = finals.filter((x) => x.market === m);
    const cal = EDP.calibration(f.map((x) => ({ p_side: x.p_over, result: x.result })));
    const both = f.filter((x) => x.novig_over != null);
    const mc = EDP.calibration(both.map((x) => ({ p_side: x.p_over, result: x.result }))), nv = EDP.calibration(both.map((x) => ({ p_side: x.novig_over, result: x.result })));
    const q = results.filter((x) => x.kind === 'qualified' && x.market === m && x.clv && typeof x.clv.prob_clv_pp === 'number');
    out[m] = { n: cal.n, ece: cal.ece, brier: both.length ? mc.brier : null, market_brier: both.length ? nv.brier : null, n_with_market: both.length,
      clv_pp: q.length ? +(q.reduce((a, x) => a + x.clv.prob_clv_pp, 0) / q.length).toFixed(2) : null, clv_n: q.length };
  });
  return out;
}
function report(league, season, rowsOnFile, evals, now) {
  /* one settlement per evaluation: the latest row (corrections supersede) */
  const results = latest(rowsOnFile);
  const bets = results.filter((x) => x.kind === 'qualified' && x.decision === 'BET');
  const leans = results.filter((x) => x.kind === 'qualified' && x.decision === 'LEAN');
  const cal = EDP.calibration(results.filter((x) => x.kind === 'final').map((x) => ({ p_side: x.p_over, result: x.result })));
  const mkt = EDP.calibration(results.filter((x) => x.kind === 'final' && x.novig_over != null).map((x) => ({ p_side: x.novig_over, result: x.result })));
  const summary = EDP.summarize(bets);
  const evB = (x) => EDP.bucketOf(x.ev, EDP.CONFIG.ev_buckets), cfB = (x) => EDP.bucketOf(x.confidence, EDP.CONFIG.conf_buckets);
  const MK = (x) => (EDP.MARKETS[x.market] || {}).label || x.market;
  const all = results.filter((x) => x.kind === 'qualified');
  return {
    schema: PERF_SCHEMA, league, season, generated_at: new Date(now).toISOString(),
    note: 'Bets are the first BET of each selection at its price, 1 row per selection, units as recommended. LEAN rows are graded at a flat 1U for information and never counted as bets.',
    summary, lean: EDP.summarize(leans.map((x) => Object.assign({}, x, { units: 1, units_won: x.flat_units_won }))),
    breakdown: {
      sport: EDP.breakdown(bets, (x) => (x.league || league).toUpperCase()), market: EDP.breakdown(bets, MK), position: EDP.breakdown(bets, (x) => x.position || '—'),
      ev_bucket: EDP.breakdown(bets, evB), confidence_bucket: EDP.breakdown(bets, cfB),
      decision: EDP.breakdown(all.map((x) => Object.assign({}, x, { units: x.decision === 'BET' ? x.units : 1, units_won: x.decision === 'BET' ? x.units_won : x.flat_units_won })), (x) => x.decision)
    },
    calibration: cal, market_calibration: mkt,
    /* per market, the live evidence EDProps.stageOf reads for RESEARCH GRADE
       and PRODUCTION: settled finals, their calibration against the no-vig
       market's, and mean probability CLV over every qualified evaluation */
    markets: marketEvidence(results),
    calibration_state: { state: EDP.calibrationState(cal, summary), n: cal.n, ece: cal.ece, rule: '≥ 500 settled and ECE ≤ 0.03 → PARTIAL; ≥ 1000, ECE ≤ 0.02 and positive CLV → CALIBRATED' },
    counts: { evaluations: evals.length, results: results.length, bets: bets.length, leans: leans.length, finals: results.filter((x) => x.kind === 'final').length,
      void: results.filter((x) => x.result === 'VOID').length, corrections: (rowsOnFile || []).filter((x) => x.correction).length }
  };
}

async function main() {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const league = arg('league', 'nfl'), now = arg('now') ? Date.parse(arg('now')) : Date.now(), season = Number(arg('season', C.seasonOf(now))), write = a.indexOf('--write') >= 0;
  const P = C.leaguePaths(league, season);
  const evals = readJsonl(P.evaluations), done = readJsonl(P.results);
  let fresh = [];
  /* the pending diagnostics are written with or without a dataset: a run
     that could not load one says so, per prop, instead of going quiet */
  const writeSettlement = (ds, settled) => {
    if (!write || !evals.length) return;
    const doc = settlementFile(league, season, ds, pendingStatus(ds, evals, settled, now), now);
    const prevS = (() => { try { return JSON.parse(fs.readFileSync(P.settlement, 'utf8')); } catch (e) { return null; } })();
    const bare = (o) => JSON.stringify(Object.assign({}, o, { checked_at: null }));
    if (!prevS || bare(prevS) !== bare(doc)) { fs.mkdirSync(P.dir, { recursive: true }); fs.writeFileSync(P.settlement, JSON.stringify(doc, null, 1) + '\n'); console.log('[props grade] settlement status written: ' + Object.keys(doc.pending).length + ' started and unsettled'); }
  };
  if (evals.length) {
    const src = league === 'cfb' ? require('./sources/cfb.js') : require('./sources/nfl.js');
    const ds = await src.load({ season, offline: a.indexOf('--offline') >= 0, now, current_feeds: league === 'nfl' ? ['stats', 'pbp', 'snaps', 'roster'] : undefined, no_prior: true });
    if (!ds.ok) { console.log('[props grade] dataset unavailable: ' + ds.error + ' — nothing graded'); writeSettlement(ds, done); return 0; }
    fresh = grade(ds, evals, done, now).concat(correct(ds, evals, done, now));
    writeSettlement(ds, done.concat(fresh));
  }
  const results = done.concat(fresh);
  const perf = report(league, season, results, evals, now);
  const nCorr = fresh.filter((x) => x.correction).length;
  console.log('[props grade] ' + league + ' ' + season + ': ' + evals.length + ' evaluations, ' + (fresh.length - nCorr) + ' newly settled, ' + nCorr + ' corrected, ' + results.length + ' settled in all · bets ' + perf.summary.n + ' · calibration ' + perf.calibration_state.state + ' (n ' + perf.calibration.n + ')');
  if (!write) { console.log('[props grade] dry run: nothing written (pass --write)'); return 0; }
  if (fresh.length) { fs.mkdirSync(P.season_dir, { recursive: true }); fs.appendFileSync(P.results, fresh.map((x) => JSON.stringify(x)).join('\n') + '\n'); }
  const prev = (() => { try { return JSON.parse(fs.readFileSync(P.performance, 'utf8')); } catch (e) { return null; } })();
  const strip = (o) => JSON.stringify(Object.assign({}, o, { generated_at: null }));
  if (!prev || strip(prev) !== strip(perf)) { fs.mkdirSync(P.dir, { recursive: true }); fs.writeFileSync(P.performance, JSON.stringify(perf, null, 1) + '\n'); console.log('[props grade] performance written'); }
  return 0;
}

module.exports = { grade, correct, latest, report, resultOf, marketEvidence, pendingStatus, settlementFile, PENDING_CODE, CORRECTION_DAYS };
if (require.main === module) main().then((c) => process.exit(c || 0)).catch((e) => { console.error('[props grade] ' + (e.stack || e.message)); process.exit(1); });
