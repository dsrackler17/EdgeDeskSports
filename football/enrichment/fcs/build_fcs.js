#!/usr/bin/env node
/* ============================================================================
   BUILD THE FCS RATING LAYER — and test it against the floor it would replace.

     1  the base season (the previous one, whose schedule feed carries every
        division): FBS teams FIXED at EdgeDesk's end-of-season ratings
        (params.rating.seed_ratings, the table the engine carries into this
        season), FCS teams fitted through 700 FCS-vs-FCS and 126 cross-
        division games, hyperparameters estimated from the data
     2  this season: that fit carried forward with the engine's own season
        carry (0.75), then updated with every completed cross-division game
        — each FBS side anchored at the rating EdgeDesk ACTUALLY priced it
        at before that game (a replay of the engine, identical to the
        coverage build's) — and every FCS-vs-FCS result a provider supplies
     3  WALK-FORWARD: for every completed cross-division game this season,
        the FCS side is rated from only what was known before kickoff and the
        margin is predicted twice, once from the bridge and once from the
        shared floor the engine prices from. Nothing later is read.

   It writes football/enrichment/fcs_ratings.json (every FCS team: rating,
   sd, samples, completeness, confidence) and football/validation/
   fcs_bridge_cfb.json (the walk-forward). It moves no projection: the engine
   still prices every FCS side from the floor, and promoting the bridge into
   pricing is a decision for a person to make on this file's evidence.

   Usage
     node football/enrichment/fcs/build_fcs.js [--season 2026] [--offline] [--no-network-results]
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const P = global.EDCfbP4Params;
const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));
const BC = require(path.join(ROOT, 'football', 'fbs', 'build_coverage.js'));
const B = require('./bridge.js');
const C = require('../config.js');
const K = require('../core/cache.js');
const { http, Ledger } = require('../core/provider.js');

const OUT = path.join(ROOT, 'football', 'enrichment', 'fcs_ratings.json');
const VAL = path.join(ROOT, 'football', 'validation', 'fcs_bridge_cfb.json');
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } };
const r2 = (x) => x == null || !isFinite(x) ? null : Math.round(x * 100) / 100;

function args(argv) {
  const a = { season: null, offline: false, results: true, write: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--season') a.season = +argv[++i];
    else if (argv[i] === '--offline') a.offline = true;
    else if (argv[i] === '--no-network-results') a.results = false;
    else if (argv[i] === '--dry') a.write = false;
  }
  return a;
}

const DIV = (d) => {
  const s = String(d || '').toLowerCase();
  if (s === 'fbs') return 'fbs';
  if (s === 'fcs') return 'fcs';
  return 'other';
};

/* the season's completed games between FBS/FCS teams, in kickoff order */
function gamesOf(rows) {
  return rows.filter((r) => r.completed && r.home_points != null && r.away_points != null)
    .map((r) => ({ id: String(r.game_id), home: FBS.normKey(r.home_team), away: FBS.normKey(r.away_team),
      home_name: r.home_team, away_name: r.away_team, hdiv: DIV(r.home_division), adiv: DIV(r.away_division),
      home_conf: r.home_conference, away_conf: r.away_conference, neutral: !!r.neutral_site, week: r.week,
      home_points: r.home_points, away_points: r.away_points, kickoff: r.start_date }))
    .filter((g) => g.hdiv !== 'other' && g.adiv !== 'other' && !(g.hdiv === 'fbs' && g.adiv === 'fbs'))
    .sort((a, b) => String(a.kickoff).localeCompare(String(b.kickoff)) || a.id.localeCompare(b.id));
}

/* THE REPLAY, identical to football/fbs/build_coverage.js buildState, with
   one addition: the blended rating each FBS side carried into each cross-
   division game, read BEFORE that game is absorbed */
function replayAnchors(rowsBySeason, season, efficiency) {
  const st = E.newState();
  const anchors = {};
  for (let y = P.trained_through_season + 1; y <= season; y++) {
    E.ingest.seasonBreak(st);
    const rows = rowsBySeason[y];
    if (!rows) continue;
    const ordered = rows.slice().sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)) || String(a.game_id).localeCompare(String(b.game_id)));
    for (const row of ordered) {
      if (!row.completed || row.home_points == null || row.away_points == null) continue;
      const hF = FBS.isFbsDivision(row.home_division, row.home_team, { knownFbs: P.rating.seed_ratings });
      const aF = FBS.isFbsDivision(row.away_division, row.away_team, { knownFbs: P.rating.seed_ratings });
      if (y === season && hF !== aF) {
        const fk = FBS.normKey(hF ? row.home_team : row.away_team);
        const b = E.strength.blendedRating(st, fk, true, row.week);
        if (b && b.value != null) anchors[String(row.game_id)] = { key: fk, value: b.value, games_played: b.games_played };
      }
      E.ingest.absorbGame(st, { home: row.home_team, away: row.away_team, home_fbs: hF, away_fbs: aF,
        neutral_site: row.neutral_site, home_points: row.home_points, away_points: row.away_points,
        team_stats: y === season ? BC.efficiencyForGame(efficiency, row, season) : null });
    }
  }
  return { st, anchors };
}

/* FCS-vs-FCS results this season, from ESPN's FCS scoreboard (groups=81).
   The schedule feed carries only games involving an FBS team in-season, so
   without this provider the in-season FCS field is ordered only through its
   cross-division games — and the ratings say so. Cached, so a run that cannot
   reach ESPN keeps what the last run saw. */
async function fcsResults(season, weeks, ledger, cache, now, live) {
  const out = [];
  const key = 'fcs_results:espn_fcs_scoreboard:' + season;
  if (live) {
    const got = [];
    let ok = 0;
    for (let w = 1; w <= weeks; w++) {
      const url = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=81&limit=300&seasontype=2&week=' + w + '&dates=' + season;
      const r = await http(url, { timeout_ms: 20000, accept: (t) => { try { return Array.isArray(JSON.parse(t).events) ? true : 'no events'; } catch (_) { return 'not JSON'; } } });
      ledger.record('espn_fcs_scoreboard', { outcome: r.outcome, status: r.status, detail: r.detail, at: r.at, url, via: 'live' });
      if (!r.ok) { if (w === 1 && r.outcome !== 'OK') break; continue; }
      ok++;
      (JSON.parse(r.text).events || []).forEach((ev) => {
        const c = ev.competitions && ev.competitions[0];
        if (!c || !c.status || !c.status.type || c.status.type.completed !== true) return;
        const h = (c.competitors || []).find((x) => x.homeAway === 'home'), a = (c.competitors || []).find((x) => x.homeAway === 'away');
        if (!h || !a) return;
        got.push({ id: String(ev.id), home_name: h.team.location || h.team.displayName, away_name: a.team.location || a.team.displayName,
          home_points: +h.score, away_points: +a.score, neutral: !!c.neutralSite, kickoff: ev.date, week: w });
      });
    }
    if (ok) K.put(cache, key, 'fcs_results', { value: got, source: 'ESPN FCS scoreboard', observed_at: now, retrieved_at: now }, now);
    else K.fail(cache, key, 'fcs_results', 'no week answered', now);
  } else {
    ledger.note('espn_fcs_scoreboard', { note: 'not requested this run (--no-network-results)' });
  }
  const back = K.recall(cache, key, now);
  if (back.found && Array.isArray(back.value)) back.value.forEach((g) => out.push(g));
  return { games: out, recall: back };
}

async function main() {
  const a = args(process.argv.slice(2));
  const now = Date.now();
  const season = a.season || (() => { const d = new Date(now); return d.getMonth() <= 1 ? d.getFullYear() - 1 : d.getFullYear(); })();
  const base = season - 1;
  const ledger = new Ledger();
  const cache = K.open(path.join(ROOT, 'football', 'enrichment', 'cache', 'evidence_cache.json'));

  const rowsBySeason = {};
  for (const y of [base, season]) {
    const url = 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules/csv/cfb_schedules_' + y + '.csv';
    let t = null;
    try { t = await BC.loadSeason(y, a.offline); ledger.record('cfbfastr_schedules', { outcome: t ? 'OK' : 'NOT_FOUND', status: t ? 200 : 404, at: new Date().toISOString(), url }); }
    catch (e) { ledger.record('cfbfastr_schedules', { outcome: 'NETWORK', detail: String(e.message || e), at: new Date().toISOString(), url }); }
    if (t) rowsBySeason[y] = BC.normRows(BC.parseCsv(t));
  }
  if (!rowsBySeason[base] || !rowsBySeason[season]) {
    console.error('[fcs] the schedule feeds for ' + base + ' and ' + season + ' are both required; nothing written');
    return 2;
  }

  /* FCS conference membership, this season's first */
  const conf = {}, names = {};
  [base, season].forEach((y) => rowsBySeason[y].forEach((r) => {
    [['home', r.home_team, r.home_division, r.home_conference], ['away', r.away_team, r.away_division, r.away_conference]].forEach(([, n, d, c]) => {
      if (DIV(d) !== 'fcs') return;
      const k = FBS.normKey(n);
      names[k] = n;
      if (c && c !== 'NA') conf[k] = c;
    });
  }));

  /* ---- 1. the base season */
  const seeds = P.rating.seed_ratings || {};
  const hp = P.rating.hyperparams;
  const baseGames = gamesOf(rowsBySeason[base]).map((g) => ({ home: g.home, away: g.away, home_fbs: g.hdiv === 'fbs', away_fbs: g.adiv === 'fbs',
    neutral: g.neutral, home_points: g.home_points, away_points: g.away_points, kickoff: g.kickoff }))
    .filter((g) => (!g.home_fbs || seeds[g.home] != null) && (!g.away_fbs || seeds[g.away] != null));
  const fit0 = B.fit({ games: baseGames, anchors: seeds, conference: conf, estimate: true,
    hyper: { sigma: (P.distributions && P.distributions.sigma_margin) || 14.9, hfa: hp.hfa, cap: hp.cap, anchor_sd: 3 } });
  console.error('[fcs] ' + base + ': ' + Object.keys(fit0.teams).length + ' FCS teams from ' + fit0.n_bridge + ' cross-division and '
    + fit0.n_fcs + ' FCS-vs-FCS games; tau ' + r2(fit0.hyper.tau) + ' kappa ' + r2(fit0.hyper.kappa) + ' sigma ' + r2(fit0.hyper.sigma));

  /* ---- 2. this season */
  const eff = readJson(path.join(ROOT, 'football', 'rankings', 'engine_efficiency.json'), null);
  const effOk = eff && eff.schema === 'edgedesk_cfb_engine_efficiency_v1' && +eff.season === +season ? eff : null;
  const { anchors } = replayAnchors(rowsBySeason, season, effOk);
  const cur = gamesOf(rowsBySeason[season]);
  const bridgeGames = cur.filter((g) => anchors[g.id]).map((g) => ({ id: g.id, home: g.home, away: g.away, home_fbs: g.hdiv === 'fbs', away_fbs: g.adiv === 'fbs',
    neutral: g.neutral, home_points: g.home_points, away_points: g.away_points, kickoff: g.kickoff,
    home_anchor: g.hdiv === 'fbs' ? anchors[g.id].value : undefined, away_anchor: g.adiv === 'fbs' ? anchors[g.id].value : undefined,
    fbs_key: anchors[g.id].key, fcs_key: g.hdiv === 'fbs' ? g.away : g.home, week: g.week }));
  const weeks = Math.max(1, ...cur.map((g) => +g.week || 1));
  const res = await fcsResults(season, weeks, ledger, cache, now, !a.offline && a.results);
  const fcsGames = res.games.map((g) => ({ home: FBS.normKey(g.home_name), away: FBS.normKey(g.away_name), home_fbs: false, away_fbs: false,
    neutral: g.neutral, home_points: g.home_points, away_points: g.away_points, kickoff: g.kickoff }))
    .filter((g) => g.home in names && g.away in names || (conf[g.home] && conf[g.away]));
  const prior = B.carryPrior(fit0, hp.carry, fit0.hyper.tau);
  const hyper1 = { sigma: fit0.hyper.sigma, tau: fit0.hyper.tau, kappa: fit0.hyper.kappa, hfa: hp.hfa, cap: hp.cap, anchor_sd: 3 };
  const fitAt = (t) => B.fit({ games: bridgeGames.filter((g) => g.kickoff < t).concat(fcsGames.filter((g) => g.kickoff < t)),
    conference: conf, prior, hyper: hyper1 });

  /* ---- 3. walk-forward */
  const rows = [];
  const priorOnly = B.fit({ games: [], conference: conf, prior, hyper: hyper1 });
  bridgeGames.forEach((g) => {
    const f = fitAt(g.kickoff);
    const t = f.teams[g.fcs_key] || priorOnly.teams[g.fcs_key] || null;
    const p0 = priorOnly.teams[g.fcs_key] || null;
    const hfa = g.neutral ? 0 : hp.hfa;
    const anchor = g.home_fbs ? g.home_anchor : g.away_anchor;
    const pred = (fcs) => fcs == null ? null : (g.home_fbs ? anchor - fcs + hfa : fcs - anchor + hfa);
    const actual = g.home_points - g.away_points;
    rows.push({ game_id: g.id, week: g.week, fcs: g.fcs_key, fbs: g.fbs_key, actual,
      actual_capped: Math.max(-hp.cap, Math.min(hp.cap, actual)),
      floor: pred(hp.fcs_rating), bridge: t ? pred(t.rating) : null, bridge_sd: t ? t.sd : null, prior_only: p0 ? pred(p0.rating) : null });
  });
  function score(field, capped) {
    const xs = rows.filter((r) => r[field] != null);
    const e = xs.map((r) => r[field] - (capped ? r.actual_capped : r.actual));
    const n = e.length;
    if (!n) return { n: 0 };
    return { n, mae: r2(e.reduce((s, v) => s + Math.abs(v), 0) / n), rmse: r2(Math.sqrt(e.reduce((s, v) => s + v * v, 0) / n)),
      bias: r2(e.reduce((s, v) => s + v, 0) / n) };
  }
  const paired = rows.filter((r) => r.bridge != null).map((r) => Math.abs(r.floor - r.actual_capped) - Math.abs(r.bridge - r.actual_capped));
  const pm = paired.length ? paired.reduce((s, v) => s + v, 0) / paired.length : null;
  const psd = paired.length > 1 ? Math.sqrt(paired.reduce((s, v) => s + (v - pm) * (v - pm), 0) / (paired.length - 1)) : null;
  const se = psd != null ? psd / Math.sqrt(paired.length) : null;
  const wins = paired.filter((v) => v > 0).length;
  const validation = {
    method: 'walk-forward over every completed ' + season + ' FBS-vs-FCS game: the FCS side rated from the ' + base + ' fit carried forward and only the '
      + season + ' results before kickoff; the FBS side at the rating EdgeDesk priced it at before the game (engine replay). Errors are against the '
      + 'final margin, capped at the engine’s own ±' + hp.cap + ' (and uncapped beside it).',
    n: rows.length,
    capped: { floor: score('floor', true), bridge: score('bridge', true), prior_only: score('prior_only', true) },
    uncapped: { floor: score('floor', false), bridge: score('bridge', false), prior_only: score('prior_only', false) },
    paired_abs_error_reduction: { mean: r2(pm), se: r2(se), t: se ? r2(pm / se) : null, bridge_closer: wins, of: paired.length },
    floor_value: hp.fcs_rating,
    verdict: null
  };
  validation.verdict = (validation.paired_abs_error_reduction.t != null && validation.paired_abs_error_reduction.t >= 2 && rows.length >= 30)
    ? 'the bridge predicted FBS-vs-FCS margins better than the shared floor out of sample (mean absolute error ' + validation.capped.bridge.mae
      + ' vs ' + validation.capped.floor.mae + ', t = ' + validation.paired_abs_error_reduction.t + ', n = ' + rows.length + '). ELIGIBLE for a promotion review; not promoted by this build.'
    : 'NOT DEMONSTRATED: the walk-forward does not show the bridge beating the floor with t >= 2 on 30+ games (t = ' + validation.paired_abs_error_reduction.t + ', n = ' + rows.length + ').';
  validation.rows = rows.map((r) => ({ game_id: r.game_id, week: r.week, fcs: r.fcs, fbs: r.fbs, actual: r.actual, floor: r2(r.floor), bridge: r2(r.bridge), bridge_sd: r2(r.bridge_sd) }));

  /* ---- 4. the current ratings */
  const fitNow = B.fit({ games: bridgeGames.concat(fcsGames), conference: conf, prior, hyper: hyper1 });
  const games26 = {}, bridge26 = {};
  bridgeGames.forEach((g) => { games26[g.fcs_key] = (games26[g.fcs_key] || 0) + 1; bridge26[g.fcs_key] = (bridge26[g.fcs_key] || 0) + 1; });
  fcsGames.forEach((g) => { games26[g.home] = (games26[g.home] || 0) + 1; games26[g.away] = (games26[g.away] || 0) + 1; });
  const weeksElapsed = Math.max(1, weeks);
  const teams = {};
  Object.keys(fitNow.teams).sort().forEach((k) => {
    const t = fitNow.teams[k], b0 = fit0.teams[k] || null;
    const sample = (b0 ? b0.games : 0) + (games26[k] || 0);
    const bridgeN = (b0 ? b0.bridge_games : 0) + (bridge26[k] || 0);
    /* completeness: the share of this season's weeks the fit actually saw a
       result for (a bye a season is allowed for), times whether last season
       was seen at all. Without FCS-vs-FCS results for this season it is low,
       and it says why */
    const inSeason = Math.min(1, (games26[k] || 0) / Math.max(1, weeksElapsed - 1));
    const completeness = r2(0.5 * (b0 ? Math.min(1, b0.games / 10) : 0) + 0.5 * inSeason);
    let confidence = 'WEAK';
    if (t.sd <= C.FCS.strong_sd && sample >= C.FCS.strong_min_games && bridgeN >= C.FCS.strong_min_bridge) confidence = 'STRONG';
    else if (t.sd <= C.FCS.moderate_sd && sample >= C.FCS.min_team_games) confidence = 'MODERATE';
    if (!sample) confidence = 'NONE';
    teams[k] = {
      name: names[k] || k, conference: conf[k] || null,
      fcs_team_rating: r2(t.rating), rating_sd: r2(t.sd),
      fcs_rating_source: 'EdgeDesk FCS bridge (' + base + ' all-division fit carried at ' + hp.carry + ', updated with ' + season + ' results)',
      fcs_rating_confidence: confidence,
      fcs_games_sample: sample, fcs_fbs_bridge_sample: bridgeN,
      games_this_season: games26[k] || 0, bridge_games_this_season: bridge26[k] || 0,
      data_completeness: completeness,
      floor_gap: r2(hp.fcs_rating - t.rating),
      last_updated: new Date(now).toISOString()
    };
  });
  const artifact = {
    schema: 'edgedesk_fcs_ratings_v1', season, base_season: base, generated_at: new Date(now).toISOString(),
    scale: 'EdgeDesk engine rating points, neutral field: an FCS rating of -20 against an FBS rating of 5 is a 25-point FBS favourite before home field',
    status: 'SHADOW — research and reliability only; the engine still prices every FCS side from the shared floor (' + hp.fcs_rating + ')',
    promotion: { state: 'NOT_PROMOTED', eligible: /ELIGIBLE/.test(validation.verdict),
      why: 'pricing an FCS side from this rating changes the fair spread of every FBS-vs-FCS game; that is a promotion decision for a person, made on football/validation/fcs_bridge_cfb.json, not something an enrichment build does' },
    floor: hp.fcs_rating,
    hyper: { sigma: r2(fit0.hyper.sigma), tau: r2(fit0.hyper.tau), kappa: r2(fit0.hyper.kappa), hfa: hp.hfa, cap: hp.cap, carry: hp.carry, anchor_sd: 3,
      basis: 'sigma, tau and kappa estimated from the ' + base + ' all-division fit by expectation-maximisation; home field, cap and carry are the engine’s own' },
    bridge: {
      base_season: { fcs_teams: Object.keys(fit0.teams).length, cross_division_games: fit0.n_bridge, fcs_vs_fcs_games: fit0.n_fcs,
        residual_rms: { bridge: r2(fit0.residual_rms.bridge), fcs: r2(fit0.residual_rms.fcs) } },
      this_season: { cross_division_games: bridgeGames.length, fcs_vs_fcs_games: fcsGames.length,
        fcs_vs_fcs_source: res.recall.found ? 'ESPN FCS scoreboard' + (res.recall.stale ? ' (STALE: ' + res.recall.reason + ')' : '') : 'NONE — the schedule feed carries only FBS-involved games in-season and the ESPN FCS scoreboard was not reachable; the in-season FCS field is ordered only through its cross-division games',
        residual_rms: { bridge: r2(fitNow.residual_rms.bridge), fcs: r2(fitNow.residual_rms.fcs) } },
      fcs_level: { mean: r2(fitNow.g.mean), sd: r2(fitNow.g.sd), floor_minus_level: r2(hp.fcs_rating - fitNow.g.mean) },
      conferences: Object.keys(fitNow.confs).sort().map((c) => ({ conference: c, mean: r2(fitNow.confs[c].mean), sd: r2(fitNow.confs[c].sd), teams: fitNow.confs[c].teams }))
    },
    validation: { verdict: validation.verdict, n: validation.n, capped: validation.capped, uncapped: validation.uncapped,
      paired_abs_error_reduction: validation.paired_abs_error_reduction, detail: 'football/validation/fcs_bridge_cfb.json' },
    counts: { teams: Object.keys(teams).length, by_confidence: Object.values(teams).reduce((o, t) => { o[t.fcs_rating_confidence] = (o[t.fcs_rating_confidence] || 0) + 1; return o; }, {}) },
    provider_health: ledger.summary([
      { name: 'cfbfastr_schedules', label: 'cfbfastR-data schedules (GitHub)', kind: 'fcs_results', source_type: 'SECONDARY_STRUCTURED', configured: () => true },
      { name: 'espn_fcs_scoreboard', label: 'ESPN FCS scoreboard (FCS-vs-FCS results)', kind: 'fcs_results', source_type: 'SECONDARY_STRUCTURED', configured: () => true }
    ], new Date(now).toISOString()),
    teams
  };
  if (a.write) {
    fs.writeFileSync(OUT, JSON.stringify(artifact, null, 1) + '\n');
    fs.writeFileSync(VAL, JSON.stringify(Object.assign({ schema: 'edgedesk_fcs_bridge_validation_v1', season, generated_at: artifact.generated_at }, validation), null, 1) + '\n');
    K.save(cache, now);
  }
  console.error('[fcs] ' + season + ': ' + Object.keys(teams).length + ' FCS teams rated; ' + JSON.stringify(artifact.counts.by_confidence));
  console.error('[fcs] walk-forward (capped): floor MAE ' + validation.capped.floor.mae + ' bias ' + validation.capped.floor.bias
    + ' | bridge MAE ' + validation.capped.bridge.mae + ' bias ' + validation.capped.bridge.bias + ' | prior-only MAE ' + validation.capped.prior_only.mae);
  console.error('[fcs] ' + validation.verdict);
  return 0;
}

if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { console.error('[fcs] ' + (e && e.stack || e)); process.exit(2); });
module.exports = { gamesOf, replayAnchors };
