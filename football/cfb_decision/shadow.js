#!/usr/bin/env node
/* ===========================================================================
   The decision engine in SHADOW, beside the current one (brief §68).

     node football/cfb_decision/shadow.js [--season 2026] [--now ISO]

   For every game with a LIVE frozen V2 projection (football/cfb_v2/snapshots/<season>/,
   write-once; replayed rows are never used: they were computed after the quotes) and every pregame spread quote the Model Lab captured for it
   (football/cfb_lab/ledger/<season>/quotes/, heartbeats skipped), decide twice
   at the moment the quote arrived:

     CURRENT     V2.1's engine.decide() — the frozen cfb_decision_baseline_001
     CHALLENGER  football/cfb_decision/decision.js with the newest calibration
                 artifact and policy (fail closed without them)

   Decisions are appended to football/cfb_decision/<season>/decisions.jsonl with
   deterministic ids (a re-run adds nothing). After the Lab settles a game, each
   decision is graded once into results.jsonl: the side's ATS result (for every
   status, so PASS quality can be measured), units only for a BET at a captured
   price, CLV against the Lab's consensus close, and a PROCESS grade (the price)
   kept apart from the OUTCOME grade (the result). Nothing is ever rewritten.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const L = require(path.join(REPO, 'football', 'cfb_lab', 'lab_core.js'));
global.window = global.window || global;
require(path.join(REPO, 'football', 'cfb_v2', 'params.js'));
const E = require(path.join(REPO, 'football', 'cfb_v2', 'engine.js'));
const D = require('./decision.js');
/* the one canonical pathway to a V2 projection: input contract, the engine, numeric checks */
const CANON = require(path.join(REPO, 'football', 'cfb_production', 'canonical.js'));
/* the market-integrity rules (consensus, freshness, outliers); absent, the engine's own gates still apply */
const INTEG = (() => { try { return require(path.join(REPO, 'football', 'cfb_lab', 'integrity.js')); } catch (e) { return null; } })();

const ART_DIR = path.join(REPO, 'football', 'cfb_v2', 'artifacts', 'decision');
const BASELINE_VERSION = 'cfb_decision_baseline_001';

function h(...parts) { return crypto.createHash('sha256').update(L.util.idParts(parts)).digest('hex').slice(0, 24); }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function readJsonl(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; }
function appendUnique(p, rows, idf) {
  const have = new Set(readJsonl(p).map((r) => r[idf]));
  const fresh = rows.filter((r) => !have.has(r[idf]) && have.add(r[idf]));
  if (fresh.length) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, fresh.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  return fresh.length;
}

/* the newest artifact / policy directories by name (v1 < v2 ...); none -> null (fail closed) */
function newest(prefix, file) {
  if (!fs.existsSync(ART_DIR)) return null;
  const dirs = fs.readdirSync(ART_DIR).filter((d) => d.startsWith(prefix) && fs.existsSync(path.join(ART_DIR, d, file))).sort();
  return dirs.length ? readJson(path.join(ART_DIR, dirs[dirs.length - 1], file)) : null;
}

function frozenRows(season) {
  const dir = path.join(REPO, 'football', 'cfb_v2', 'snapshots', String(season));
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const j = readJson(path.join(dir, f));
    if (!j || !Array.isArray(j.rows)) continue;
    const origin = /replay/i.test(f) || /replay/i.test(j.label || '') ? 'REPLAY' : 'LIVE';
    for (const x of j.rows) {
      const r = x.row || x;
      if (!r || r.game_id == null) continue;
      const k = String(r.game_id);
      /* a LIVE freeze always wins over a replayed row */
      if (!out[k] || (out[k].origin === 'REPLAY' && origin === 'LIVE')) out[k] = { row: r, origin, model_version: j.model_version };
    }
  }
  return out;
}

function quotes(season) {
  const dir = path.join(REPO, 'football', 'cfb_lab', 'ledger', String(season), 'quotes');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
    .flatMap((f) => readJsonl(path.join(dir, f)))
    .filter((q) => q.market_type === 'spread' && !q.is_heartbeat && typeof q.home_line === 'number' && q.observed_at);
}

function decideAll(season, nowMs) {
  const rows = frozenRows(season);
  const artifact = newest('cfb_decision_calibration_', 'calibration.json');
  const policy = newest('cfb_decision_policy_', 'policy.json');
  const out = [];
  const qs = quotes(season).sort((a, b) => L.util.ms(a.observed_at) - L.util.ms(b.observed_at));
  /* market context at each quote: the other books' latest main lines before it */
  const latestByGameBook = {};
  for (const q of qs) {
    const g = rows[String(q.game_id)];
    const t = L.util.ms(q.observed_at), ko = L.util.ms(q.kickoff_ts || (g && g.row.kickoff));
    latestByGameBook[q.game_id] = latestByGameBook[q.game_id] || {};
    latestByGameBook[q.game_id][q.book] = q;
    if (!g || !(t < ko) || t > nowMs) continue;
    /* only a projection frozen BEFORE the quote can decide it: replayed rows were computed later (hindsight) */
    if (g.origin !== 'LIVE') continue;
    if (g.row.prediction_ts && t < L.util.ms(g.row.prediction_ts)) continue;          /* a quote before the freeze */
    const pure = CANON.pure(g.row, { engine: E, params: global.window.EDCfbV2Params, row_model_version: g.model_version });
    const books = Object.values(latestByGameBook[q.game_id]).map((x) => ({ home_line: x.home_line }));
    const xs = books.map((b) => b.home_line).sort((a, b) => a - b);
    const iqr = xs.length >= 2 ? xs[Math.ceil((xs.length - 1) * 0.75)] - xs[Math.floor((xs.length - 1) * 0.25)] : null;
    /* the consensus verdict over every book's latest main line at this instant (integrity.assessMarket):
       a BET needs it ACTIONABLE, exactly as decideGame does it for a whole slate */
    const latest = Object.values(latestByGameBook[q.game_id]).map((x) => ({ source: x.source || 'book', book: x.book,
      market_type: 'spread', home_line: x.home_line, price_home: x.price_home, price_away: x.price_away,
      observed_at: x.observed_at, provider_updated_at: x.provider_updated_at, is_pregame: true, quote_id: x.quote_id || null }));
    const integrity = INTEG ? INTEG.assessMarket(latest, q.observed_at, { kickoff: new Date(ko).toISOString(),
      maxAgeH: policy && typeof policy.stale_minutes === 'number' ? policy.stale_minutes / 60 : undefined }) : undefined;
    const market = { books: xs.length, dispersion_iqr: iqr, quotes: [q], integrity };
    const base = { game_id: String(q.game_id), season, week: q.week, book: q.book, quote_id: q.quote_id || null,
      observed_at: q.observed_at, decided_at: q.observed_at, kickoff_ts: new Date(ko).toISOString(),
      model_version: pure.model_version || g.model_version, origin: g.origin, official: true };
    /* CURRENT: the frozen baseline engine */
    const cur = E.decide(pure, { current: { home_line: q.home_line, ts: q.observed_at }, price_home: q.price_home, price_away: q.price_away,
      books }, { now: q.observed_at, row: g.row });
    const curSide = cur.side || null;
    out.push(Object.assign({}, base, {
      decision_id: 'cfbd_' + h('decision', q.game_id, q.book, q.observed_at, BASELINE_VERSION, 'baseline_rule'),
      engine_version: BASELINE_VERSION, engine_role: 'CURRENT', policy_version: 'baseline_rule', artifact_version: 'v2.1_cover_platt',
      status: cur.status === 'REVIEW' ? 'RESEARCH' : cur.status, timing: cur.status === 'BET' ? 'BET_NOW' : 'NONE', side: curSide,
      line_for_side: curSide ? (curSide === 'HOME' ? q.home_line : -q.home_line) : null,
      price: typeof cur.price_american === 'number' ? cur.price_american : null,
      pure_cover_probability: cur.cover_probability_raw, decision_cover_probability: cur.cover_probability,
      break_even_probability: cur.break_even_probability, theoretical_ev: cur.expected_value_per_unit,
      empirical_ev: cur.expected_value_per_unit,
      probability_edge: typeof cur.cover_probability === 'number' && typeof cur.break_even_probability === 'number'
        ? Math.round((cur.cover_probability - cur.break_even_probability) * 1e4) / 1e4 : null,
      stake_u: cur.status === 'BET' ? 1 : 0,
      reason_codes: (cur.reasons && cur.reasons.length ? cur.reasons : ['baseline: ' + cur.status]).map((x) => 'BASELINE: ' + x),
      payload: cur }));
    /* CHALLENGER: the new engine, fail closed without its artifact and policy */
    const dn = D.decideQuote(pure, q, { policy, artifact, now: L.util.ms(q.observed_at), market, row: g.row,
      expected_model_version: pure.model_version });
    out.push(Object.assign({}, base, {
      decision_id: 'cfbd_' + h('decision', q.game_id, q.book, q.observed_at, D.ENGINE_VERSION, policy ? policy.version : 'no_policy'),
      engine_version: D.ENGINE_VERSION, engine_role: 'CHALLENGER', policy_version: policy ? policy.version : null,
      artifact_version: artifact ? artifact.version : null, status: dn.status, timing: dn.timing, side: dn.side || null,
      line_for_side: dn.line_for_side != null ? dn.line_for_side : null, price: dn.price != null ? dn.price : null,
      pure_cover_probability: dn.pure_cover_probability, decision_cover_probability: dn.decision_cover_probability,
      break_even_probability: dn.break_even_probability, probability_edge: dn.probability_edge,
      theoretical_ev: dn.theoretical_ev, empirical_ev: dn.empirical_ev,
      p_positive_clv: dn.bet_confidence ? dn.bet_confidence.p_positive_clv : null, expected_clv_pts: dn.expected_clv_pts,
      football_confidence: dn.football_confidence ? dn.football_confidence.score : null,
      market_confidence: dn.market_confidence ? dn.market_confidence.score : null,
      bet_confidence: dn.bet_confidence ? dn.bet_confidence.score : null,
      bettable_to_line: dn.price_targets ? dn.price_targets.bettable_to_line : null,
      bettable_to_price: dn.price_targets ? dn.price_targets.bettable_to_price : null,
      stake_u: dn.stake_u || 0, reason_codes: dn.reason_codes.length ? dn.reason_codes : ['NO_BET_COMPUTATION'],
      payload: dn }));
  }
  return out;
}

/* ---------------------------------------------------------------- grading */
function grade(season, decisions) {
  const dir = path.join(REPO, 'football', 'cfb_lab', 'ledger', String(season));
  const results = {}, closes = {};
  for (const r of readJsonl(path.join(dir, 'results.jsonl'))) results[String(r.game_id)] = r;   /* the latest version wins */
  for (const l of readJsonl(path.join(dir, 'lines.jsonl'))) {
    if (l.kind === 'CLOSE' && l.book === 'CONSENSUS' && l.market_type === 'spread' && typeof l.home_line === 'number') closes[String(l.game_id)] = l;
  }
  const out = [];
  for (const d of decisions) {
    const res = results[d.game_id];
    if (!res || res.status !== 'FINAL' || typeof res.final_margin !== 'number' || !d.side || typeof d.line_for_side !== 'number') continue;
    const sideMargin = d.side === 'HOME' ? res.final_margin : -res.final_margin;
    const cover = sideMargin + d.line_for_side;
    const ats = cover > 0 ? 'W' : cover < 0 ? 'L' : 'P';
    const payout = D.americanToPayout(d.price);
    const units = d.status === 'BET' && payout != null ? (ats === 'W' ? payout * d.stake_u : ats === 'L' ? -d.stake_u : 0) : null;
    const c = closes[d.game_id];
    const closeSide = c ? (d.side === 'HOME' ? c.home_line : -c.home_line) : null;
    const clv = closeSide != null ? Math.round((d.line_for_side - closeSide) * 100) / 100 : null;
    out.push({
      result_id: 'cfbr_' + h('decision_result', d.decision_id), decision_id: d.decision_id, game_id: d.game_id,
      engine_version: d.engine_version, status: d.status, graded_at: res.recorded_at, final_margin: res.final_margin,
      ats_result: ats, units: units != null ? Math.round(units * 1000) / 1000 : null,
      closing_line_for_side: closeSide, closing_price: null, clv_pts: clv, positive_clv: clv != null ? clv > 0 : null,
      process_grade: clv == null ? 'NOT_GRADABLE' : clv > 0.5 ? 'GOOD_PRICE' : clv < -0.5 ? 'BAD_PRICE' : 'FAIR_PRICE',
      outcome_grade: ats === 'W' ? 'WIN' : ats === 'L' ? 'LOSS' : 'PUSH',
      hypothetical: d.status !== 'BET', payload: { note: d.status !== 'BET' ? 'hypothetical: graded to measure PASS/LEAN quality, never counted as a wager' : null } });
  }
  return out;
}

function run(season, nowMs, root) {
  const dir = path.join(root || __dirname, String(season));
  const decisions = decideAll(season, nowMs);
  const added = appendUnique(path.join(dir, 'decisions.jsonl'), decisions, 'decision_id');
  const all = readJsonl(path.join(dir, 'decisions.jsonl'));
  const graded = appendUnique(path.join(dir, 'results.jsonl'), grade(season, all), 'result_id');
  const counts = {};
  for (const d of all) { const k = d.engine_role + ':' + d.status; counts[k] = (counts[k] || 0) + 1; }
  return { season, decisions_added: added, results_added: graded, decisions_total: all.length, counts };
}

module.exports = { run, decideAll, grade, frozenRows, quotes };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const now = arg('--now', null) ? Date.parse(arg('--now')) : Date.now();
  const nd = new Date(now);
  const season = Number(arg('--season', nd.getUTCMonth() <= 1 ? nd.getUTCFullYear() - 1 : nd.getUTCFullYear()));
  console.log('[cfb_decision shadow]', JSON.stringify(run(season, now)));
}
