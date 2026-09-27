#!/usr/bin/env node
/* ============================================================================
   CFB production — the golden-game set (brief §101; docs/cfb-production/CANONICAL.md §7).

   Eight difficult scenarios, each built on a REAL 2026 row (copied into
   golden/games.json so a later current.json cannot move them), run through the
   production pathway: the canonical service (input contract, the engine,
   numeric checks, modes, fallback), the stage-8 research rule, the governed
   decision policy (decision.js with the pinned artifacts) and the Model Lab's
   settlement rule. The invariant outputs are stored in golden/expected.json;
   canonical.test.js recomputes every case and requires the same answer.

     road favourite     401858250 North Carolina (home) vs Notre Dame, -22.98
     neutral site       401856766 TCU vs North Carolina, week 1 (v2.0.0 replay row,
                        run by its own engine: a neutral flag never flips a sign)
     QB change          401858245 Virginia Tech vs Pittsburgh, home QB reported OUT
     FCS                401856706 LSU vs McNeese: projected, never priced
     huge favourite     401862790 Florida Atlantic vs Texas Southern (FCS, +33) and
                        401858250's mirror as a 60-point synthetic extreme check
     stale market       401871050 Delaware vs Liberty with a 5-hour-old quote
     postponed          401858476 Northwestern vs Penn State: POSTPONED result
     multiple injuries  401856707 Mississippi State vs Alabama, four starters OUT

   Only invariant parts are stored: numbers the engine produces, statuses,
   modes, reason codes. A PATCH version must reproduce every one (VERSIONING.md).

     node football/cfb_production/golden.js            compare (exit 1 on any difference)
     node football/cfb_production/golden.js --write    (re)write golden/expected.json
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const CANON = require('./canonical.js');
const COMPAT = require('./compat.js');
const REPO = path.resolve(__dirname, '..', '..');
const D = require(path.join(REPO, 'football', 'cfb_decision', 'decision.js'));
const L = require(path.join(REPO, 'football', 'cfb_lab', 'lab_core.js'));
const I = require(path.join(REPO, 'football', 'cfb_lab', 'integrity.js'));

const DIR = path.join(__dirname, 'golden');
const AS_OF = '2026-09-28T12:00:00.000Z';
const ROUND = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : x);

function load() { return JSON.parse(fs.readFileSync(path.join(DIR, 'games.json'), 'utf8')); }

function pureOut(s) {
  if (!s || s.status !== 'PREDICTED') return { status: s && s.status, reason: s && s.reason };
  const p = s.projection;
  return { status: s.status, projected_margin: p.projected_margin, fair_spread_home_line: p.fair_spread_home_line, fair_spread_display: p.fair_spread_display,
    home_win_prob: p.home_win_prob, away_win_prob: p.away_win_prob, sigma: p.sigma, p80: p.intervals.p80, confidence: p.football_prediction_confidence,
    modes: s.degraded.modes, fallback_level: s.fallback_level, contract_ok: s.contract.ok, show_confidence_score: s.display.show_confidence_score };
}
function decideOut(d) {
  if (!d) return null;
  return { status: d.status, side: d.side || null, cover_probability_raw: ROUND(d.cover_probability_raw), cover_probability: ROUND(d.cover_probability),
    stale: !!d.stale, reasons: (d.reasons || []).map((x) => x.replace(/\d+ min old/, 'N min old')) };
}
function policyOut(d) {
  if (!d) return null;
  return { status: d.status, side: d.side || null, reason_codes: d.reason_codes, pure_cover_probability: ROUND(d.pure_cover_probability),
    decision_cover_probability: ROUND(d.decision_cover_probability) };
}

/* one scenario -> its invariant outputs */
function run(c, G) {
  const row = G.rows[String(c.game_id)];
  const eng = c.engine === 'candidate_001' ? CANON.loadEngine(path.join(REPO, 'football', 'cfb_v2', 'candidates', 'cfb_v2_candidate_001', 'params.js')) : CANON.loadEngine();
  const rowX = Object.assign({}, row, c.row_patch || {});
  const snap = CANON.snapshot(rowX, { as_of_ts: AS_OF, engine: eng.engine, params: eng.params, overlays: c.overlays, row_model_version: c.row_model_version,
    context: c.context || {} });
  const out = { scenario: c.scenario, game_id: String(c.game_id), model_version: snap.model_version, pure: pureOut(snap), resolved: CANON.resolve(snap, c.v1 || null) };
  delete out.resolved.source;
  if (c.market) {
    const p = eng.engine.pure(rowX, c.overlays || {});
    /* three books quoting the same number at the same moment: a consensus, so the governed
       policy's own gates (not a missing book) decide the case */
    const qs = ['a', 'b', 'c'].map((b) => Object.assign({ book: 'golden_' + b, quote_id: 'golden_' + c.game_id + '_' + b, game_id: String(c.game_id),
      market_type: 'spread', source: 'book', is_pregame: true }, c.market));
    const q = qs[0];
    const now = c.decide_now || AS_OF;
    out.stage8_research = decideOut(eng.engine.decide(p, { current: { home_line: q.home_line, ts: q.observed_at }, price_home: q.price_home, price_away: q.price_away }, { row: rowX, now }));
    const art = COMPAT.decisionArtifacts();
    const integrity = I.assessMarket(qs, now, { kickoff: rowX.kickoff });
    out.market_integrity = { status: integrity.status, actionable_status: integrity.actionable_status };
    out.governed = snap.status === 'PREDICTED' ? policyOut(D.decideQuote(p, q, { policy: art.policy, artifact: art.calibration, now: Date.parse(now),
      market: { books: qs.length, dispersion_iqr: 0, quotes: qs, integrity }, row: rowX, expected_model_version: p.model_version })) : { status: 'NO_BET', reason: 'no pure projection' };
  }
  if (c.result) {
    /* the Model Lab's settlement of a snapshot of this game (never a loss for a game not played) */
    const pred = { prediction_id: 'golden', game_id: String(c.game_id), model_version: snap.model_version, checkpoint_type: 'T24', origin: 'LIVE',
      pure_home_margin: snap.projection && snap.projection.projected_margin, home_win_probability: snap.projection && snap.projection.home_win_prob,
      side: 'HOME', recommended_line: c.market ? c.market.home_line : -3.5, decision_class: 'LEAN', kickoff_ts: rowX.kickoff };
    const e = L.evaluate(pred, Object.assign({ result_id: 'golden_r', game_id: String(c.game_id) }, c.result), {});
    out.settlement = { result_status: e.result_status, ats_result: e.ats_result, void: !!e.void, abs_margin_error: e.abs_margin_error == null ? null : ROUND(e.abs_margin_error) };
  }
  return out;
}

function evaluateAll(G) { G = G || load(); return G.cases.map((c) => run(c, G)); }

function compare() {
  const want = JSON.parse(fs.readFileSync(path.join(DIR, 'expected.json'), 'utf8')).cases;
  const have = evaluateAll();
  const diffs = [];
  have.forEach((h, i) => { const w = want[i]; if (JSON.stringify(h) !== JSON.stringify(w)) diffs.push({ scenario: h.scenario, want: w, have: h }); });
  if (want.length !== have.length) diffs.push({ scenario: 'count', want: want.length, have: have.length });
  return diffs;
}

module.exports = { load, run, evaluateAll, compare, AS_OF, DIR };

if (require.main === module) {
  if (process.argv.includes('--write')) {
    const cases = evaluateAll();
    fs.writeFileSync(path.join(DIR, 'expected.json'), JSON.stringify({ schema: 'cfb_golden_expected_v1', as_of_ts: AS_OF,
      note: 'invariant outputs of the production pathway for the golden games; regenerate only with a new model version (a PATCH must reproduce them)', cases }, null, 1) + '\n');
    console.log('[golden] wrote ' + cases.length + ' cases');
  } else {
    const d = compare();
    d.forEach((x) => console.log('DIFF ' + x.scenario + '\n  want ' + JSON.stringify(x.want) + '\n  have ' + JSON.stringify(x.have)));
    console.log(d.length ? 'GOLDEN FAILED: ' + d.length + ' case(s) differ' : 'GOLDEN OK: every case reproduces');
    process.exit(d.length ? 1 : 0);
  }
}
