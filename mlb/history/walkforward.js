#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk MLB — the walk-forward record (engine/lab/protocol.js).

     node mlb/history/walkforward.js [--tune] [--check]

     1. One chronological pass by game date: games on date D are predicted at
        09:00 UTC on D from a fit on games of earlier dates (all of which have
        ended by 08:00 UTC on D), then D is absorbed.
     2. Candidates, in order: `team` (offence / run prevention only, the
        incumbent), `team_park` (+ park factor), `team_park_sp` (+ starting
        pitcher). Baselines: Elo (tuned on SELECTION) and home rate.
     3. Negative-binomial size, the extra-inning home rate and a logistic
        recalibration of the win probability are fitted for season S on the
        three earlier seasons' out-of-sample predictions.
     4. Windows: burn-in 2010-11, SELECTION 2012-17, CONFIRMATION 2018-25.
        No LIVE window: the 2026 season is not in either source yet.
   2024 has no starting pitchers (ingest.js): `team_park_sp` prices 2024 with
   the starter term at 0, and the record reports 2024 separately.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const I = require('./ingest');
const { RunsModel, game, over, nbPmf, DEFAULTS } = require('./model');
const P = require('../../engine/lab/protocol');
const V = require('../../engine/validation');
const S = require('../../engine/stats');

const DIR = __dirname;
const OUT = path.join(DIR, 'validation', 'mlb_walkforward.json');
const LIVE = path.join(DIR, 'params', 'mlb_live.json');
const TUNING = path.join(DIR, 'params', 'mlb_tuning.json');
const W = { burn_in: [2010, 2011], selection: [2012, 2017], confirmation: [2018, 2025], live: null };
const CANDS = { team: { park: false, sp: false }, team_park: { park: true, sp: false }, team_park_sp: { park: true, sp: true } };
const ORDER = ['team', 'team_park', 'team_park_sp'];
const dayNum = (d) => Math.floor(Date.parse(d + 'T12:00:00Z') / 864e5);
const flag = (n) => process.argv.includes('--' + n);

function load() { const s = []; for (let y = I.FIRST; y <= I.LAST; y++) s.push(y); return I.loadGames(s).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.game_id < b.game_id ? -1 : 1)); }

class Elo {
  constructor(p) { this.p = Object.assign({ k: 4, hfa: 24, revert: 0.67 }, p || {}); this.r = new Map(); this.season = null; }
  get(t) { return this.r.has(t) ? this.r.get(t) : 1500; }
  start(s) { if (this.season === s) return; if (this.season != null) for (const [t, v] of this.r) this.r.set(t, 1500 + (v - 1500) * this.p.revert); this.season = s; }
  prob(h, a) { return 1 / (1 + Math.pow(10, -(this.get(h) - this.get(a) + this.p.hfa) / 400)); }
  absorb(g) { const e = this.prob(g.home, g.away); const y = g.hs > g.as ? 1 : 0; const mov = Math.abs(g.hs - g.as); const d = this.p.k * Math.log(mov + 1) * (y - e); this.r.set(g.home, this.get(g.home) + d); this.r.set(g.away, this.get(g.away) - d); }
}

/** one pass of one candidate: raw means per game */
function pass(games, params, use, upTo) {
  const m = new RunsModel(params, use);
  const byDay = new Map(); for (const g of games) { if (upTo != null && g.season > upTo) continue; if (!byDay.has(g.date)) byDay.set(g.date, []); byDay.get(g.date).push(g); }
  const out = new Map(); let maxKnown = null;
  for (const date of [...byDay.keys()].sort()) {
    const day = byDay.get(date);
    m.startSeason(day[0].season); m.fit(dayNum(date));
    for (const g of day) { const l = m.lambdas(g.home, g.away, g.sp_home || null, g.sp_away || null, g.home); out.set(g.game_id, { lh: l.lh, la: l.la, known: maxKnown }); }
    m.absorb(dayNum(date), day);
    for (const g of day) { const k = Date.parse(g.assumed_available_at); if (maxKnown == null || k > maxKnown) maxKnown = k; }
  }
  return { raw: out, model: m };
}

function fitSeason(prior) {
  /* NB size by likelihood on the team-run counts; extra-inning home rate; logistic recalibration */
  let best = null;
  for (const r of [3, 4, 5, 6, 8, 10, 14, 20, 30, 60]) {
    let ll = 0; for (const x of prior) { ll += Math.log(Math.max(1e-12, nbPmf(x.lh, r, 30)[Math.min(30, x.hs)])) + Math.log(Math.max(1e-12, nbPmf(x.la, r, 30)[Math.min(30, x.as)])); }
    if (!best || ll > best.ll) best = { r, ll };
  }
  const xg = prior.filter((x) => x.outs && x.outs > 54);
  const xi = xg.length >= 50 ? xg.reduce((a, x) => a + (x.hs > x.as ? 1 : 0), 0) / xg.length : 0.52;
  return { r: best ? best.r : 8, xi, n: prior.length, extra_inning_games: xg.length };
}

function tune(games) {
  const sel = games.filter((g) => g.season <= W.selection[1]);
  let best = null; const grid = [];
  /* a first grid (4-16 starts, half-life 365-730) peaked at its edge; this one runs past it (selection window only) */
  for (const hl of [365, 548]) for (const ps of [16, 32, 64]) for (const pg of [20, 40]) {
    const rp = { half_life_days: hl, prior_starts: ps, prior_games: pg };
    const { raw } = pass(sel, rp, CANDS.team_park_sp);
    let ll = 0, n = 0;
    for (const g of sel) if (P.inWin(g.season, W.selection)) { const x = raw.get(g.game_id); const p = game(x.lh, x.la, 8, 0.52).p_home; ll += V.logLoss(p, g.hs > g.as ? 1 : 0); n++; }
    grid.push(Object.assign({ selection_ml_log_loss: +(ll / n).toFixed(5) }, rp));
    if (!best || ll / n < best.ll) best = { ll: ll / n, rp };
    console.log('[mlb tune] ' + JSON.stringify(rp) + ' ' + (ll / n).toFixed(5));
  }
  let bestElo = null;
  for (const k of [3, 4, 6]) for (const hfa of [15, 24, 35]) {
    const e = new Elo({ k, hfa }); let ll = 0, n = 0;
    for (const g of sel) { e.start(g.season); if (P.inWin(g.season, W.selection)) { ll += V.logLoss(e.prob(g.home, g.away), g.hs > g.as ? 1 : 0); n++; } e.absorb(g); }
    if (!bestElo || ll / n < bestElo.ll) bestElo = { k, hfa, revert: 0.67, ll: ll / n };
  }
  const out = { schema: 'edgedesk_mlb_tuning_v1', generated_at: new Date().toISOString(), rule: 'chosen by SELECTION-window (2012-2017) moneyline log loss of team_park_sp; no later season is read', chosen: Object.assign({}, DEFAULTS, best.rp), selection_ml_log_loss: +best.ll.toFixed(5), elo: bestElo, grid };
  fs.mkdirSync(path.dirname(TUNING), { recursive: true });
  fs.writeFileSync(TUNING, JSON.stringify(out, null, 1) + '\n');
  return out;
}

function main() {
  const games = load();
  const tuning = fs.existsSync(TUNING) && !flag('tune') ? JSON.parse(fs.readFileSync(TUNING, 'utf8')) : tune(games);
  const passes = {}; for (const c of ORDER) passes[c] = pass(games, tuning.chosen, CANDS[c]);
  const elo = new Elo(tuning.elo); const eloP = new Map();
  for (const g of games) { elo.start(g.season); eloP.set(g.game_id, elo.prob(g.home, g.away)); elo.absorb(g); }

  const rows = games.map((g) => ({ id: g.game_id, season: g.season, date: g.date, hs: g.hs, as: g.as, outs: Number(g.outs) || null, sp_known: !!(g.sp_home && g.sp_away),
    raw: Object.fromEntries(ORDER.map((c) => [c, passes[c].raw.get(g.game_id)])), elo: eloP.get(g.game_id),
    y: { hw: g.hs > g.as ? 1 : 0, total: g.hs + g.as, margin: g.hs - g.as },
    predicted_at: Date.parse(g.date + 'T09:00:00Z'), event_start: Date.parse(g.date + 'T09:30:00Z'), inputs_known_at: passes.team.raw.get(g.game_id).known }));
  const cal = {};
  for (let s = W.selection[0]; s <= W.confirmation[1]; s++) {
    const prior = rows.filter((r) => r.season >= s - 3 && r.season < s);
    cal[s] = {};
    for (const c of ORDER) {
      const pr = prior.map((r) => ({ lh: r.raw[c].lh, la: r.raw[c].la, hs: r.hs, as: r.as, outs: r.outs }));
      const f = fitSeason(pr);
      const ps = pr.map((x) => game(x.lh, x.la, f.r, f.xi).p_home);
      const lg = S.logistic(ps.map((p) => [1, Math.log(p / (1 - p))]), pr.map((x) => (x.hs > x.as ? 1 : 0)), { l2: 1e-6 });
      cal[s][c] = Object.assign(f, { recal: lg.beta });
    }
    const nn = prior.length; cal[s].home_rate = nn ? prior.reduce((a, r) => a + r.y.hw, 0) / nn : 0.54;
  }
  const sig = (z) => 1 / (1 + Math.exp(-z));
  const evalRows = rows.filter((r) => r.season >= W.selection[0]);
  for (const r of evalRows) {
    r.p = { elo: r.elo, const_home: cal[r.season].home_rate }; r.mk = {};
    for (const c of ORDER) {
      const k = cal[r.season][c]; const G = game(r.raw[c].lh, r.raw[c].la, k.r, k.xi);
      const z = Math.log(G.p_home / (1 - G.p_home)); r.p[c] = sig(k.recal[0] + k.recal[1] * z);
      r.mk[c] = { rl_home: G.home_rl, o75: over(G.totals, 7.5), o85: over(G.totals, 8.5), o95: over(G.totals, 9.5), exp_total: G.exp_total };
    }
  }
  const leak = V.leakageAudit(evalRows.map((r) => ({ id: r.id, predicted_at: r.predicted_at, event_start: r.event_start, inputs_known_at: r.inputs_known_at })));
  const ALL = ORDER.concat(['elo', 'const_home']);
  const bin = (sub, f) => { const m = V.binary(sub.map(f)); delete m.bins; return m; };
  const metrics = (sub) => {
    const o = { n: sub.length, seasons: [...new Set(sub.map((r) => r.season))].length, by_candidate: {} };
    for (const c of ALL) o.by_candidate[c] = { moneyline: bin(sub, (r) => ({ p: r.p[c], y: r.y.hw })) };
    for (const c of ORDER) Object.assign(o.by_candidate[c], { run_line_home_minus_1_5: bin(sub, (r) => ({ p: r.mk[c].rl_home, y: r.y.margin >= 2 ? 1 : 0 })), total_over_8_5: bin(sub, (r) => ({ p: r.mk[c].o85, y: r.y.total > 8.5 ? 1 : 0 })), total_bias: V.r(sub.reduce((a, r) => a + r.mk[c].exp_total - r.y.total, 0) / (sub.length || 1), 3) });
    return o;
  };
  const windows = {};
  for (const [name, w] of Object.entries({ selection: W.selection, confirmation: W.confirmation })) windows[name] = Object.assign({ seasons_range: w }, metrics(evalRows.filter((r) => P.inWin(r.season, w))));
  windows.season_2024_no_starters = Object.assign({ note: 'starting pitchers unknown for 2024; the starter term is 0' }, metrics(evalRows.filter((r) => r.season === 2024)));
  const selLL = Object.fromEntries(ALL.map((c) => [c, windows.selection.by_candidate[c].moneyline.log_loss]));
  const chosen = P.choose(selLL, ORDER);
  const conf = evalRows.filter((r) => P.inWin(r.season, W.confirmation));
  const cw = windows.confirmation;
  const bestBase = cw.by_candidate.elo.moneyline.log_loss <= cw.by_candidate.const_home.moneyline.log_loss ? 'elo' : 'const_home';
  const comparisons = {
    [chosen + '_vs_elo']: P.compare(conf, (r) => V.logLoss(r.p[chosen], r.y.hw), (r) => V.logLoss(r.p.elo, r.y.hw)),
    [chosen + '_vs_const_home']: P.compare(conf, (r) => V.logLoss(r.p[chosen], r.y.hw), (r) => V.logLoss(r.p.const_home, r.y.hw)),
    team_park_sp_vs_team_park: P.compare(conf.filter((r) => r.sp_known), (r) => V.logLoss(r.p.team_park_sp, r.y.hw), (r) => V.logLoss(r.p.team_park, r.y.hw)),
  };
  const cm = cw.by_candidate[chosen];
  const mk = (market, s, m) => Object.assign({ market, status: s.status, failed: s.failed, n: m.n, log_loss: m.log_loss, brier: m.brier, calibration_in_the_large: m.calibration_in_the_large, calibration_slope: m.calibration_slope }, P.MARKET_NOT_TESTED);
  const markets = {
    moneyline: mk('moneyline (incl. extra innings)', P.binaryStatus(cm.moneyline, cw.seasons, comparisons[chosen + '_vs_' + bestBase].a_better), cm.moneyline),
    run_line: mk('run line home -1.5', P.binaryStatus(cm.run_line_home_minus_1_5, cw.seasons, null), cm.run_line_home_minus_1_5),
    total: mk('total runs 8.5', P.binaryStatus(cm.total_over_8_5, cw.seasons, null), cm.total_over_8_5),
  };
  const fin = passes[chosen].model;
  fs.mkdirSync(path.dirname(LIVE), { recursive: true });
  fs.writeFileSync(LIVE, JSON.stringify({ schema: 'edgedesk_mlb_live_v1', generated_at: new Date().toISOString(), model: chosen, params: tuning.chosen, fit: fin.dump(), calibration: cal[W.confirmation[1]][chosen], last_game_date: games[games.length - 1].date, note: 'the 2026 season is not in the sources; these are end-of-2025 ratings' }) + '\n');
  const report = {
    schema: 'edgedesk_lab_walkforward_v1', sport: 'mlb', label: 'MLB', generated_at: new Date().toISOString(),
    protocol: { windows: W, rules: P.RULES, prediction_time: '09:00 UTC on the game date; inputs: games of earlier dates (ended by 08:00 UTC)', candidates: ORDER, baselines: { elo: 'Elo with a log-margin multiplier, tuned on the selection window ' + JSON.stringify(tuning.elo), const_home: 'home win rate of the three seasons before' } },
    data: { source: 'mlb/history/data (Retrosheet game logs; 2024 from the data pack\'s StatsAPI table)', license: I.LICENSE, seasons: [I.FIRST, I.LAST], games: games.length, games_scored: evalRows.length, starters_missing: games.filter((g) => !(g.sp_home && g.sp_away)).length,
      temporal: { point_in_time: 'RETROSPECTIVE', known_at: 'blank (never backdated)', assumed_available_at: '08:00 UTC the day after' } },
    leakage: Object.assign({ basis: 'inputs dated by assumed_available_at (08:00 UTC the next day); predictions at 09:00 UTC on the game date' }, leak),
    tuning: { chosen: tuning.chosen, elo: tuning.elo, rule: tuning.rule },
    selection: { rule: 'lowest selection-window moneyline log loss; a challenger must beat the incumbent by >= ' + P.RULES.challenger_margin, ll: selLL, chosen },
    comparisons, best_baseline: bestBase, markets, windows,
    calibration_by_season: Object.fromEntries(Object.entries(cal).map(([s, v]) => [s, { nb_size: v[chosen].r, extra_inning_home: V.r(v[chosen].xi), recal: v[chosen].recal.map((x) => V.r(x, 4)) }])),
    caveats: [
      'Retrospective, not point-in-time certified; a starter is treated as known before the game (probable starters are announced, but late changes happen and are not modelled).',
      'No lineup, bullpen-availability, platoon, weather or umpire input. The pack\'s Statcast-style pitch sample (30 games) is too small to model.',
      '2024 starters are unknown (Retrosheet\'s 2024 log is not reachable; the pack\'s table has none).',
      'Outcome validation only: no licensed archive of timestamped closing prices.',
    ],
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
  console.log('[mlb walkforward] ' + evalRows.length + ' scored, leakage ' + leak.violations + ', chosen ' + chosen + ' | conf n ' + cw.n);
  for (const c of ALL) console.log('   ' + c.padEnd(13) + ' sel LL ' + selLL[c] + ' | conf LL ' + cw.by_candidate[c].moneyline.log_loss + ' slope ' + cw.by_candidate[c].moneyline.calibration_slope + ' citl ' + cw.by_candidate[c].moneyline.calibration_in_the_large);
  console.log('   comparisons ' + JSON.stringify(comparisons));
  console.log('   markets ' + Object.entries(markets).map(([k, v]) => k + '=' + v.status + (v.failed.length ? ' (' + v.failed.join('; ') + ')' : '')).join(' | '));
}

function check() {
  const r = JSON.parse(fs.readFileSync(OUT, 'utf8')); const fails = [];
  if (!r.leakage || r.leakage.violations !== 0) fails.push('leakage');
  if (!r.data.temporal || r.data.temporal.point_in_time !== 'RETROSPECTIVE') fails.push('must say retrospective');
  for (const [k, m] of Object.entries(r.markets)) if (m.market_status !== 'NOT_TESTED') fails.push(k + ' claims a market test');
  if (fails.length) { console.error('[mlb --check] FAILED: ' + fails.join('; ')); process.exit(1); }
  console.log('[mlb --check] ok: ' + r.data.games_scored + ' games, moneyline ' + r.markets.moneyline.status);
}

if (require.main === module) { if (flag('check')) check(); else main(); }
module.exports = { pass, W };
