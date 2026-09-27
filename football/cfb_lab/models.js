/* ============================================================================
   CFB Model Lab — model adapters.

   Each tracked model is read from what it PUBLISHES, never re-fitted:

     V1      edgedesk_cfb_p4_v1.0.0   football/fbs/slate.json (the board's own
             build), through the football record's projectionFromSlate() so the
             lab accepts and refuses exactly the V1 numbers the public record
             does. V1 publishes no market decision; the lab applies the record's
             lean rule (lab_core.v1Decision) and says so in decision_source.
     V2.1    edgedesk_cfb_v2.1.0      football/cfb_v2/current.json through the
             production engine (engine.pure / engine.decide) with its params.
     V2      edgedesk_cfb_v2.0.0      candidate 001, frozen; its projection rides
             in current.json's shadow block and is turned into a distribution by
             the candidate's own hash-locked params in an isolated engine.

   An adapter returns, per game, the pure projection, the model state and a
   decide(market, now) function. It never reads a sportsbook number for the
   pure projection.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const L = require('./lab_core.js');
const G = require('./ledger.js');
const REC = require(path.join(G.REPO, 'tools', 'record', 'football_record_core.js'));

const U = L.util;
const V2DIR = path.join(G.REPO, 'football', 'cfb_v2');

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function hashFile(p) { try { return sha(fs.readFileSync(p)); } catch (e) { return null; } }
function hashObj(o) { return sha(G.canonical(o)); }
function ageH(asOf, now) { const a = U.ms(asOf), b = U.ms(now); return (a === null || b === null) ? null : (b - a) / 3600000; }

/* An engine instance with its OWN params (candidate 001 must not see v2.1.0's). */
function loadEngine(paramsFile) {
  const ctx = { console, Math, Date, JSON, isFinite, Number, Object, Array, String, parseFloat };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(paramsFile, 'utf8'), ctx, { filename: paramsFile });
  vm.runInContext(fs.readFileSync(path.join(V2DIR, 'engine.js'), 'utf8'), ctx, { filename: 'engine.js' });
  return { engine: ctx.EDCfbV2, params: ctx.EDCfbV2Params };
}

/* ------------------------------------------------ the board's evidence */
function contract(g, field, side) { return (g && g.input_contract || []).find((c) => c.field === field && (side === undefined || c.side === side)) || null; }
function qbCertainty(g) {
  if (!g) return null;
  const one = (side) => {
    const st = g[side + '_starter'];
    const av = contract(g, 'qb_availability', side);
    if (st && (st.confirmed === true || /CONFIRMED|ANNOUNCED/i.test(String(st.status || '')))) return 100;
    if (av && av.state === 'USABLE' && /report that he is available/i.test(String(av.detail || ''))) return 100;
    if (st && /PREVIOUS_GAME/i.test(String(st.status || ''))) return 70;
    if (st && /UNSETTLED|CONTESTED|QUESTIONABLE/i.test(String(st.status || ''))) return 40;
    return 20;
  };
  return Math.min(one('home'), one('away'));
}
function injuryCertainty(g, now) {
  if (!g) return null;
  const one = (side) => {
    const c = contract(g, 'availability', side);
    if (!c) return 30;
    if (c.state === 'USABLE' && c.as_of && ageH(c.as_of, now) <= 72) return 100;
    if (c.state === 'NOT_REQUIRED' || c.state === 'USABLE') return 60;
    return 30;
  };
  return Math.min(one('home'), one('away'));
}
function teamDataCoverage(g) {
  const rows = g && g.data_coverage && g.data_coverage.rows;
  const t = rows && rows.find((x) => x.key === 'team_data');
  return t && U.isNum(Number(t.value)) ? Number(t.value) / 100 : null;
}
function normName(s) { return String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, ''); }

/* Data-quality checks for one game (METRICS §14). `slateGame` is the board's
   row (evidence), `row` the model's own identity, `market` from marketAt. */
function dataQuality(ctx) {
  const { slateGame: g, model, market, hours, now, dupPairs } = ctx;
  const out = [];
  const add = (check, status, detail) => out.push({ check, status, detail: detail || null });
  const kick = model.game.kickoff, home = model.game.home, away = model.game.away;
  add('schedule_integrity', kick && home && away ? 'GREEN' : 'RED', kick && home && away ? null : 'kickoff or a team is missing');
  if (g) {
    const sh = normName(g.home_team), sa = normName(g.away_team), mh = normName(home), ma = normName(away);
    if (sh === ma && sa === mh && sh !== sa) add('team_mapping', 'RED', 'the model has home and away swapped against the schedule');
    else if ((sh && mh && !(sh === mh || sh.includes(mh) || mh.includes(sh))) || (sa && ma && !(sa === ma || sa.includes(ma) || ma.includes(sa)))) add('team_mapping', 'RED', 'model teams ' + home + ' / ' + away + ' do not match the schedule ' + g.home_team + ' / ' + g.away_team);
    else add('team_mapping', 'GREEN');
  } else add('team_mapping', 'YELLOW', 'the game is not on the published board, so its teams could not be cross-checked');
  const pair = [normName(home), normName(away)].sort().join('|');
  add('duplicate_game', dupPairs && dupPairs.get(pair) > 1 ? 'RED' : 'GREEN', dupPairs && dupPairs.get(pair) > 1 ? 'the same pair appears twice this week' : null);
  add('model_input', U.isNum(model.pure.margin) && (U.isNum(model.pure.sigma) || U.isNum(model.pure.p_home)) ? 'GREEN' : 'RED',
    U.isNum(model.pure.margin) ? null : 'the model row has no projection');
  if (!market || !market.market_as_of) add('odds_freshness', 'YELLOW', 'no market quote captured yet');
  else {
    const a = ageH(market.market_as_of, now), lim = hours <= 48 ? 6 : 36;
    add('odds_freshness', a > lim ? 'YELLOW' : 'GREEN', a > lim ? 'newest quote ' + a.toFixed(1) + ' h old (limit ' + lim + ' h)' : null);
  }
  if (g) {
    const qbs = ['home', 'away'].map((s) => contract(g, 'qb_starter', s)).filter(Boolean);
    const qbOld = qbs.filter((c) => c.as_of && ageH(c.as_of, now) > 72);
    add('qb_status_freshness', qbs.length && !qbOld.length ? 'GREEN' : 'YELLOW', !qbs.length ? 'no QB evidence on the board' : (qbOld.length ? 'QB evidence older than 72 h' : null));
    const av = ['home', 'away'].map((s) => contract(g, 'availability', s)).filter(Boolean);
    const avOld = av.filter((c) => c.state === 'USABLE' && c.as_of && ageH(c.as_of, now) > 72 && hours <= 72);
    add('injury_freshness', avOld.length ? 'YELLOW' : 'GREEN', avOld.length ? 'availability report older than 72 h' : null);
    const wx = contract(g, 'weather');
    const wxOld = wx && wx.observed_at && hours <= 48 && ageH(wx.observed_at, now) > 12;
    add('weather_freshness', wxOld ? 'YELLOW' : 'GREEN', wxOld ? 'forecast older than 12 h' : null);
    const cov = teamDataCoverage(g);
    add('pbp_freshness', cov !== null && cov < 0.8 ? 'YELLOW' : 'GREEN', cov !== null && cov < 0.8 ? 'team play-by-play coverage ' + Math.round(cov * 100) + '%' : null);
  }
  return { status: L.dqStatus(out), checks: out };
}

/* ------------------------------------------------------------ V1 */
function v1Adapter(opts) {
  opts = opts || {};
  const slate = opts.slate || readJson(path.join(G.REPO, 'football', 'fbs', 'slate.json'));
  const pfile = path.join(G.REPO, 'football', 'cfb_p4', 'params.js');
  const ptxt = (() => { try { return fs.readFileSync(pfile, 'utf8'); } catch (e) { return ''; } })();
  const mv = (/"model_version":"([^"]+)"/.exec(ptxt) || [])[1] || 'edgedesk_cfb_p4_v1.0.0';
  const fv = (/"feature_version":"([^"]+)"/.exec(ptxt) || [])[1] || null;
  const meta = { sport: 'cfb', season: slate && slate.season, generated_at: slate && slate.generated_at, model_version: mv };
  const out = new Map();
  ((slate && slate.games) || []).forEach((g) => {
    const p = REC.projectionFromSlate('cfb', g, meta);
    if (!p) return;
    const margin = L.conv.bookToMargin(p.home_line);
    const total = U.num(p.total);
    const pHome = U.num(p.home_win_prob);
    const sigma = L.impliedSigma(margin, pHome);
    const rel = g.reliability && U.isNum(Number(g.reliability.score)) ? Number(g.reliability.score) : U.num(g.reliability_score);
    out.set(String(g.game_id), {
      model_version: mv, model_label: 'V1', engine_id: 'edgedesk_cfb_p4', source: 'football/fbs/slate.json',
      projection_computed_at: U.iso(slate.generated_at), feature_ts: U.iso(slate.generated_at), feature_version: fv,
      calibration_version: mv, ensemble_version: mv, params_hash: hashFile(pfile),
      game: { game_id: String(g.game_id), season: p.season, week: p.week, season_type: g.season_type || 'regular',
        home: g.home_team, away: g.away_team, home_id: g.home_team_id || null, away_id: g.away_team_id || null,
        neutral_site: !!g.neutral_site, kickoff: p.kickoff },
      pure: { margin, total, p_home: pHome, sigma, t_df: null, intervals: null,
        home_pts: U.isNum(total) ? (total + margin) / 2 : null, away_pts: U.isNum(total) ? (total - margin) / 2 : null,
        confidence_raw: rel, ens_sd: null },
      components: null,
      state: { data_completeness: U.num(g.data_completeness), pbp_completeness: teamDataCoverage(g) },
      explain: { primary_edge: null, secondary_edge: null,
        primary_uncertainty: g.reliability && g.reliability.main_deduction ? String(g.reliability.main_deduction).slice(0, 240) : null,
        disagreement_summary: g.projection_stability ? 'projection stability ' + g.projection_stability.tier + ' (SD ' + g.projection_stability.projection_stability_sd + ' pts across perturbations)' : null },
      slateGame: g,
      inputs: { slate_generated_at: slate.generated_at, slate_sha256: opts.slateHash || hashFile(path.join(G.REPO, 'football', 'fbs', 'slate.json')) },
      decide(market) {
        const gap = market && U.isNum(market.current_spread) ? margin - L.conv.bookToMargin(market.current_spread) : null;
        const d = L.v1Decision(gap);
        return { status: d.status, side: d.side, decision_source: L.RULES.v1_decision, reason: d.reason,
          cover_probability: null, break_even_probability: null, estimated_ev: null, edge_quality: null,
          betting_reliability: rel, threshold_distance: null, bet_enabled: false };
      },
    });
  });
  return { model_version: mv, label: 'V1', projections: out, generated_at: slate && slate.generated_at };
}

/* ------------------------------------------------------------ V2.x */
function v2Adapter(which, opts) {
  opts = opts || {};
  const cur = opts.current || readJson(path.join(V2DIR, 'current.json'));
  const slate = opts.slate || readJson(path.join(G.REPO, 'football', 'fbs', 'slate.json'));
  const slateById = new Map(((slate && slate.games) || []).map((g) => [String(g.game_id), g]));
  /* which: 'current' (v2.1, current.json), 'candidate_001' (001 from the shadow
     block), or 'candidate_001_direct' (rows ARE 001's own, e.g. its replay) */
  const direct = which === 'candidate_001_direct';
  const cand = which === 'candidate_001';
  const pfile = (cand || direct) ? path.join(V2DIR, 'candidates', 'cfb_v2_candidate_001', 'params.js') : path.join(V2DIR, 'params.js');
  const E = loadEngine(pfile);
  const P = E.params;
  const mv = P.model_version;
  const label = (cand || direct) ? 'V2 · candidate 001' : 'V2.1 · hardened';
  const calV = mv + ':' + hashObj({ win: P.calibration && P.calibration.win, cover: P.cover }).slice(0, 12);
  const ensV = mv + ':' + hashObj(P.stack_weights || P.ensemble || {}).slice(0, 12);
  const out = new Map();
  ((cur && cur.rows) || []).forEach((row0) => {
    let row = row0;
    if (cand) {
      const c = row0.shadow && row0.shadow.candidate_001;
      if (!c || !U.isNum(c.ens_pred) || !U.isNum(c.sigma)) return;
      row = Object.assign({}, row0, { ens_pred: c.ens_pred, sigma: c.sigma, components: c.components || null, ens_sd: c.ens_sd != null ? c.ens_sd : null });
    }
    /* FBS-vs-FCS: projected (kept for accuracy), never priced (docs/cfb-v2/MODEL_CARD.md §8) */
    const notPriced = row.priced === false;
    const pure = E.engine.pure(row);
    if (!pure || pure.status !== 'PREDICTED') return;
    const g = slateById.get(String(row.game_id)) || null;
    const comps = row.components || null;
    const iv = pure.intervals || {};
    const why = (row.drivers || []).slice(0, 2).map((x) => (x.feature + ' ' + (x.points > 0 ? '+' : '') + x.points + ' pts (' + (x.points > 0 ? row.home : row.away) + ')'));
    const csd = comps ? U.sd(Object.values(comps).filter(U.isNum)) : null;
    out.set(String(row.game_id), {
      model_version: mv, model_label: label, engine_id: 'edgedesk_cfb_v2', source: cand ? 'football/cfb_v2/current.json (shadow.candidate_001)' : 'football/cfb_v2/current.json',
      projection_computed_at: U.iso(cur.generated_at), feature_ts: U.iso(row.feature_ts || row.prediction_ts), feature_version: P.feature_version,
      calibration_version: calV, ensemble_version: ensV, params_hash: hashFile(pfile),
      game: { game_id: String(row.game_id), season: row.season, week: row.week, season_type: 'regular', home: row.home, away: row.away,
        home_id: row.home_id != null ? String(row.home_id) : null, away_id: row.away_id != null ? String(row.away_id) : null,
        neutral_site: !!row.neutral_site, kickoff: U.iso(row.kickoff) },
      pure: { margin: pure.projected_margin, total: U.num(pure.fair_total), p_home: pure.home_win_prob, sigma: pure.sigma, t_df: pure.t_df,
        intervals: { 50: iv.p50, 80: iv.p80, 95: iv.p95 },
        home_pts: U.isNum(U.num(pure.fair_total)) ? (pure.fair_total + pure.projected_margin) / 2 : null,
        away_pts: U.isNum(U.num(pure.fair_total)) ? (pure.fair_total - pure.projected_margin) / 2 : null,
        confidence_raw: pure.football_prediction_confidence, ens_sd: U.isNum(row.ens_sd) ? row.ens_sd : (U.isNum(csd) ? csd : null) },
      components: comps,
      state: { data_completeness: g ? U.num(g.data_completeness) : null, pbp_completeness: g ? teamDataCoverage(g) : null },
      explain: { primary_edge: why[0] || null, secondary_edge: why[1] || null,
        primary_uncertainty: (row.uncertainty_drivers || [])[0] || null,
        disagreement_summary: comps ? Object.keys(comps).map((k) => k + ' ' + comps[k]).join(', ') + (U.isNum(csd) ? ' (SD ' + csd.toFixed(2) + ')' : '') : null },
      slateGame: g,
      inputs: { current_generated_at: cur.generated_at, current_sha256: opts.currentHash || hashFile(path.join(V2DIR, 'current.json')), row_prediction_ts: row.prediction_ts },
      decide(market, now) {
        if (notPriced) {
          return { status: 'NOT_PRICED', side: null, decision_source: 'engine:' + mv, reason: row.not_priced_reason || 'FBS-vs-FCS: not priced',
            cover_probability: null, break_even_probability: null, estimated_ev: null, edge_quality: null,
            betting_reliability: pure.football_prediction_confidence, threshold_distance: null, bet_enabled: !!(P.market && P.market.bet_enabled) };
        }
        if (!market || !U.isNum(market.current_spread)) {
          return { status: 'PASS', side: null, decision_source: 'engine:' + mv, reason: 'no market line captured',
            cover_probability: null, break_even_probability: null, estimated_ev: null, edge_quality: null,
            betting_reliability: pure.football_prediction_confidence, threshold_distance: null, bet_enabled: !!(P.market && P.market.bet_enabled) };
        }
        const mkt = { current: { home_line: market.current_spread, ts: market.market_as_of },
          open: U.isNum(market.opening_spread) ? { home_line: market.opening_spread } : null,
          books: (market.books || []).map((b) => ({ home_line: b.home_line })),
          price_home: market.consensus_price_home, price_away: market.consensus_price_away };
        const d = E.engine.decide(pure, mkt, { row, now: U.iso(now) });
        const R = P.market && P.market.rule;
        const gapAbs = U.isNum(d.raw_gap_pts) ? Math.abs(d.raw_gap_pts) : null;
        return { status: d.status, side: d.side || null, decision_source: 'engine:' + mv, reason: (d.reasons || []).join('; ') || null,
          cover_probability: U.num(d.cover_probability), break_even_probability: U.num(d.break_even_probability),
          estimated_ev: U.num(d.expected_value_per_unit), edge_quality: U.num(d.betting_edge_strength),
          betting_reliability: U.num(d.edge_reliability), threshold_distance: L.thresholdDistance(U.num(d.expected_value_per_unit), gapAbs, U.num(d.edge_reliability), R),
          bet_enabled: !!(P.market && P.market.bet_enabled), engine_price: U.num(d.price_american) };
      },
    });
  });
  return { model_version: mv, label, projections: out, generated_at: cur && cur.generated_at };
}

/* Submodel columns (METRICS §13 / SCHEMA): the V2 components by what they are. */
const SUBMODEL_MAP = { A_adj_eff: 'efficiency_margin', C_ridge: 'bayesian_margin', E_drive: 'drive_margin', B_elo: 'dynamic_rating_margin', D_gbm: 'matchup_ml_margin' };

function loadModels(which, opts) {
  const out = [];
  if (which.includes('v1')) out.push(v1Adapter(opts));
  if (which.includes('v2.1')) out.push(v2Adapter('current', opts));
  if (which.includes('c001')) out.push(v2Adapter('candidate_001', opts));
  return out;
}

module.exports = { loadEngine, v1Adapter, v2Adapter, loadModels, dataQuality, qbCertainty, injuryCertainty, teamDataCoverage, SUBMODEL_MAP, hashFile, hashObj, readJson };
