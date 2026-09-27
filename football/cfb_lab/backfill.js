/* ============================================================================
   CFB Model Lab — import the evidence that predates the lab, clearly labelled.

     GIT_RECONSTRUCTED  V1's own published numbers for 2026, as the football
                        record recovered them from the board's git history
                        (record/football/cfb_<season>.json: the first number
                        published and the last pregame number, each with the
                        time it was published and the commit it came from).
     REPLAY             candidate 001 (v2.0.0) run over weeks already played
                        (football/cfb_v2/snapshots/<season>/replay_to_date.json):
                        point-in-time features, but generated after the games.
     quotes (record)    the pregame ESPN line the record observed (entry) and
                        the ESPN line frozen at kickoff (declared close).

   None of these rows is ever OFFICIAL, none enters the public record and none
   enters a promotion evaluation (lab_core.familiesFor / isOfficial require
   origin LIVE; report.js keeps them in a separate `reconstructed` section).
   They exist so the settlement, grading and reports can be checked on real
   2026 outcomes before the first live week settles.

     node football/cfb_lab/backfill.js [--season 2026]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lab_core.js');
const G = require('./ledger.js');
const M = require('./models.js');
const MK = require('./market.js');
const CP = require('./checkpoint.js');
const GOV = require('./governance.js');

const U = L.util;

function v1Projection(g, mv) {
  return (at, point) => {
    const margin = L.conv.bookToMargin(point.home_line);
    const total = U.num(point.total), pHome = U.num(point.home_win_prob);
    return {
      model_version: point.model_version || mv, model_label: 'V1', engine_id: 'edgedesk_cfb_p4', source: 'record/football (git history of football/fbs/slate.json)',
      projection_computed_at: U.iso(at), feature_ts: U.iso(at), feature_version: null, calibration_version: point.model_version || mv, ensemble_version: point.model_version || mv, params_hash: null,
      game: { game_id: String(g.game_id), season: g.season, week: g.week, season_type: 'regular', home: g.home, away: g.away, home_id: null, away_id: null, neutral_site: !!g.neutral_site, kickoff: g.kickoff },
      pure: { margin, total, p_home: pHome, sigma: L.impliedSigma(margin, pHome), t_df: null, intervals: null,
        home_pts: U.isNum(total) ? (total + margin) / 2 : null, away_pts: U.isNum(total) ? (total - margin) / 2 : null, confidence_raw: null, ens_sd: null },
      components: null, state: { data_completeness: null, pbp_completeness: null },
      explain: { primary_edge: null, secondary_edge: null, primary_uncertainty: null, disagreement_summary: null },
      slateGame: null, inputs: { provenance: g.provenance || null, record_file: 'record/football/cfb_' + g.season + '.json' },
      decide(market) {
        const gap = market && U.isNum(market.current_spread) ? margin - L.conv.bookToMargin(market.current_spread) : null;
        const d = L.v1Decision(gap);
        return { status: d.status, side: d.side, decision_source: L.RULES.v1_decision, reason: d.reason, cover_probability: null, break_even_probability: null,
          estimated_ev: null, edge_quality: null, betting_reliability: null, threshold_distance: null, bet_enabled: false };
      },
    };
  };
}

function recordQuotes(g) {
  const out = [];
  const common = { game_id: String(g.game_id), provider_event_id: String(g.game_id), source: 'record', season: g.season, week: g.week, kickoff_ts: U.iso(g.kickoff), home_team: g.home, away_team: g.away };
  const em = g.entry && g.entry.market;
  if (em && U.isNum(U.num(em.home_line)) && em.at && U.ms(em.at) < U.ms(g.kickoff)) {
    out.push(MK.baseQuote(Object.assign({}, common, { book: MK.bookKey(em.book), market_type: 'spread', home_line: em.home_line, observed_at: U.iso(em.at), retrieved_at: U.iso(em.at) })));
    if (U.isNum(U.num(em.total))) out.push(MK.baseQuote(Object.assign({}, common, { book: MK.bookKey(em.book), market_type: 'total', total_points: em.total, observed_at: U.iso(em.at), retrieved_at: U.iso(em.at) })));
  }
  const c = g.close;
  if (c && U.isNum(U.num(c.home_line))) {
    const at = U.iso((g.final && g.final.at) || g.kickoff);
    out.push(MK.baseQuote(Object.assign({}, common, { book: MK.bookKey(c.book), market_type: 'spread', home_line: c.home_line, observed_at: at, retrieved_at: at, is_provider_close: true, is_pregame: false })));
    if (U.isNum(U.num(c.total))) out.push(MK.baseQuote(Object.assign({}, common, { book: MK.bookKey(c.book), market_type: 'total', total_points: c.total, observed_at: at, retrieved_at: at, is_provider_close: true, is_pregame: false })));
  }
  return out;
}

function run(opts) {
  opts = opts || {};
  const season = opts.season || 2026;
  const store = new G.Store(season, opts.storeOpts);
  const roles = GOV.currentRoles(store.gov('model_roles'));
  const log = { v1_rows: 0, replay_rows: 0, quotes: 0 };
  /* ---------------------------------------------------------- V1 + quotes */
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(opts.recordFile || path.join(G.REPO, 'record', 'football', 'cfb_' + season + '.json'), 'utf8')); } catch (e) { /* none */ }
  const quotes = [], rows = [];
  const existing = new Set(store.predictions().filter((r) => r.origin !== 'LIVE').map((r) => r.game_id + '|' + r.model_version + '|' + r.checkpoint_type));
  const firsts = new Set(store.predictions().filter((r) => r.origin !== 'LIVE').map((r) => r.game_id + '|' + r.model_version));
  /* only games that kicked off before the lab started: from then on the lab
     takes its own LIVE snapshots */
  const labStart = U.ms(opts.labStartedAt || JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).lab_started_at);
  Object.values((rec && rec.games) || {}).filter((g) => U.ms(g.kickoff) < labStart).forEach((g) => {
    quotes.push(...recordQuotes(g));
    const mk = v1Projection(g, (rec && rec.model && rec.model.version) || 'edgedesk_cfb_p4_v1.0.0');
    const pts = [];
    if (g.first && g.first.at && U.isNum(U.num(g.first.home_line))) pts.push(g.first);
    if (g.pick && g.pick.at && U.isNum(U.num(g.pick.home_line)) && (!g.first || g.pick.at !== g.first.at)) pts.push(g.pick);
    pts.forEach((pt) => {
      if (!(U.ms(pt.at) < U.ms(g.kickoff))) return;
      const h = L.hoursToKickoff(g.kickoff, pt.at);
      const ct = L.windowFor(h);
      if (!ct) return;
      const proj = mk(pt.at, pt);
      const key = proj.game.game_id + '|' + proj.model_version + '|' + ct;
      if (existing.has(key)) return;
      const em = g.entry && g.entry.market;
      const market = em && em.at && U.ms(em.at) <= U.ms(pt.at) ? { current_spread: U.num(em.home_line), consensus_spread: U.num(em.home_line), sportsbook_count: 1,
        market_as_of: U.iso(em.at), market_sources: ['record'], market_stale: false, opening_spread: null, opening_quality: 'MISSING', market_total: U.num(em.total), quote_ids: [], books: [] } : null;
      const dq = { status: 'YELLOW', checks: [{ check: 'reconstructed', status: 'YELLOW', detail: 'recovered from git history; the inputs at that time are not observable' }] };
      const isFirst = !firsts.has(proj.game.game_id + '|' + proj.model_version);
      const row = CP.buildRow(proj, ct, isFirst, market, proj.decide(market), dq, { now: pt.at, role: roleOf(roles, proj.model_version), origin: 'GIT_RECONSTRUCTED' });
      rows.push(row); existing.add(key); firsts.add(proj.game.game_id + '|' + proj.model_version);
    });
  });
  const sel = MK.selectNew(store.quotes(), quotes);
  log.quotes = store.appendQuotes(sel.rows).written;
  log.v1_rows = store.appendPredictions(rows).written;
  /* ------------------------------------------------------ candidate 001 replay */
  let rp = null;
  try { rp = JSON.parse(fs.readFileSync(opts.replayFile || path.join(G.REPO, 'football', 'cfb_v2', 'snapshots', String(season), 'replay_to_date.json'), 'utf8')); } catch (e) { /* none */ }
  if (rp && rp.rows && rp.rows.length) {
    const A = M.v2Adapter('candidate_001_direct', { current: { rows: rp.rows, generated_at: rp.generated_at }, slate: { games: [] } });
    const rrows = [];
    for (const r of rp.rows) {
      const p = A.projections.get(String(r.game_id));
      if (!p || !r.prediction_ts || !(U.ms(r.prediction_ts) < U.ms(r.kickoff))) continue;
      const key = p.game.game_id + '|' + A.model_version + '|WEEKLY_FREEZE';
      if (existing.has(key)) continue;
      p.projection_computed_at = U.iso(rp.generated_at);
      const dq = { status: 'YELLOW', checks: [{ check: 'replay', status: 'YELLOW', detail: rp.label }] };
      const row = CP.buildRow(p, 'WEEKLY_FREEZE', !firsts.has(p.game.game_id + '|' + A.model_version), null, p.decide(null, r.prediction_ts), dq,
        { now: r.prediction_ts, role: roleOf(roles, A.model_version), origin: 'REPLAY' });
      rrows.push(row); existing.add(key); firsts.add(p.game.game_id + '|' + A.model_version);
    }
    log.replay_rows = store.appendPredictions(rrows).written;
  }
  return log;
}
function roleOf(roles, mv) { return roles[mv] ? roles[mv].role : 'candidate'; }

module.exports = { run, recordQuotes };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  console.log(JSON.stringify(run({ season: Number(arg('--season', 2026)) })));
}
