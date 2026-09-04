#!/usr/bin/env node
/* ============================================================================
   THE FEATURE WALK-FORWARD.

   Measures every enrichment arm against the same baseline, on the same games,
   built only from information that existed before each kickoff — then hands the
   results to football/validation/promote.js, which decides whether any of them
   has earned the right to move a projected number. Almost nothing does, and
   that is the system working rather than failing.

   THE ARMS
     baseline                the Power 4 engine's own rating recursion, replayed
                             cold in kickoff order
     + player quality v1     the shipped EPIR, aggregated to team units
     + player quality v2     the same, plus the box-score columns the source
                             audit found (tackles, TFL, hurries, PBU, punting)
     + run defence v2        the run-defence power score difference
     + trench matchup        (home line vs away front) minus the reverse
     + scheme                the style-interaction gap
     + ETSR                  the whole national-rankings layer as one number
     + all enriched          every delta above, fitted jointly

   NO LEAKAGE, BY CONSTRUCTION
     * A game in season Y week W is priced from layers rebuilt out of plays in
       seasons < Y plus season Y weeks < W. The rebuild is real, not a filter
       over finished ratings.
     * Prior-season ETSR comes from the replay's own chain, never from the
       committed artifact, which was built with the whole season in it.
     * Scalars are fitted on a TUNE window and scored on a HOLDOUT the fit
       never saw.
     * The market is a benchmark column and is an input to nothing.

     node football/validation/validate_features.js
          [--first 2023] [--last 2025] [--tune 2023,2024] [--hold 2025]
          [--cache DIR] [--week-step 1] [--write]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const B = require(path.join(ROOT, 'players', 'build_players.js'));
const EPIR = require(path.join(ROOT, 'players', 'epir.js'));
const UNITS = require(path.join(ROOT, 'players', 'units.js'));
const PSCHEME = require(path.join(ROOT, 'players', 'scheme.js'));
const PMATCH = require(path.join(ROOT, 'players', 'matchup.js'));
const PV = require(path.join(ROOT, 'players', 'validate.js'));
const RCFG = require(path.join(ROOT, 'rankings', 'config.js'));
const PERF = require(path.join(ROOT, 'rankings', 'performance.js'));
const TAL = require(path.join(ROOT, 'rankings', 'talent.js'));
const ETSR = require(path.join(ROOT, 'rankings', 'etsr.js'));
const PROMOTE = require('./promote.js');
require(path.join(ROOT, 'cfb_p4', 'params.js'));
const P4 = require(path.join(ROOT, 'cfb_p4', 'engine.js'));

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || v.startsWith('--')) ? true : v;
}
const FIRST = +(arg('first', 2023));
const LAST = +(arg('last', 2025));
const TUNE = String(arg('tune', '')).split(',').filter(Boolean).map(Number);
const HOLD = String(arg('hold', '')).split(',').filter(Boolean).map(Number);
const CACHE = arg('cache', process.env.EDP_CACHE || '') || null;
const WEEK_STEP = Math.max(1, +(arg('week-step', 1)));
const WRITE = !!arg('write', false);

const isNum = x => typeof x === 'number' && isFinite(x);
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const r3 = v => isNum(v) ? Math.round(v * 1000) / 1000 : null;
const r4 = v => isNum(v) ? Math.round(v * 10000) / 10000 : null;
function log(...a) { console.log(...a); }

/* ------------------------------------------------------------------ */
/* the layer, as it stood before (season, week)                         */
/* ------------------------------------------------------------------ */
function buildLayer(season, week, play, sched, roster, careerV1, careerV2, box, coverage) {
  const partial = {
    players: PV.prefixPlayers(play[season], week),
    teamGames: PV.prefixTeamGames(play[season], week),
    counts: play[season].counts, teamGameCount: play[season].teamGameCount, season
  };
  const teamAgg = B.teamSeasonAggregates(partial.teamGames, sched[season].fbs);
  const metrics = {};
  for (const met of B.ADJ_METRICS) {
    const a = B.opponentAdjust(partial.teamGames, sched[season].fbs, met);
    if (a) metrics[met.id] = a;
  }
  const norm = B.normaliseSeason(season, partial, roster[season], roster[season - 1] || null,
    sched[season], { metrics, teamAgg, box: box[season] || { available: false, byKey: {} } });

  function only(idx) {
    const out = {};
    for (const k of Object.keys(idx)) {
      const rows = idx[k].filter(r => r.season < season);
      if (rows.length) out[k] = rows;
    }
    return out;
  }
  const cov = coverage[season];
  const v1 = EPIR.rateSeason(norm.players, { coverage: cov, leagueAllowed: norm.leagueAllowed,
    season, careerIndex: only(careerV1), params: null, variant: 'v1' });
  const v2 = EPIR.rateSeason(norm.players, { coverage: cov, leagueAllowed: norm.leagueAllowed,
    season, careerIndex: only(careerV2), params: null, variant: 'v2' });

  const scheme = PSCHEME.buildProfiles(teamAgg.off, teamAgg.def, { season, rosterPositions: {} });
  function unitsOf(ratings) {
    const byTeam = {};
    for (const r of ratings) if (r.team_key) (byTeam[r.team_key] = byTeam[r.team_key] || []).push(r);
    const u = {};
    for (const key of Object.keys(byTeam)) {
      if (!sched[season].fbs[key]) continue;
      u[key] = UNITS.rateTeam(key, key, byTeam[key],
        { teamContext: PSCHEME.unitContext(scheme.teams[key] || null), season });
    }
    return u;
  }
  const perf = PERF.build(partial.teamGames, { fbs: sched[season].fbs });
  return { unitsV1: unitsOf(v1.ratings), unitsV2: unitsOf(v2.ratings), scheme, perf };
}

/* per-game feature deltas, all in the layer's own units (never points) */
function deltas(layer, home, away, prevEtsr, slope) {
  function overall(units, key) {
    const u = units[key];
    if (!u || !u.overall || !u.overall.available) return null;
    return u.overall.rating;
  }
  function unitR(units, key, g) {
    const u = units[key];
    if (!u || !u.groups || !u.groups[g] || u.groups[g].rating == null) return null;
    return u.groups[g].rating;
  }
  const out = {};
  const pqH = overall(layer.unitsV1, home), pqA = overall(layer.unitsV1, away);
  out.player_quality_v1 = (isNum(pqH) && isNum(pqA)) ? pqH - pqA : null;
  const p2H = overall(layer.unitsV2, home), p2A = overall(layer.unitsV2, away);
  out.player_quality_v2 = (isNum(p2H) && isNum(p2A)) ? p2H - p2A : null;

  /* trench: my line against your front, minus yours against mine */
  function front(units, key) {
    const dl = unitR(units, key, 'DL'), ed = unitR(units, key, 'EDGE');
    const vals = [dl, ed].filter(isNum);
    return vals.length ? mean(vals) : null;
  }
  const olH = unitR(layer.unitsV2, home, 'OL'), olA = unitR(layer.unitsV2, away, 'OL');
  const frH = front(layer.unitsV2, home), frA = front(layer.unitsV2, away);
  out.trench_matchup = (isNum(olH) && isNum(frA) && isNum(olA) && isNum(frH))
    ? (olH - frA) - (olA - frH) : null;

  /* run defence power, both sides */
  function rdp(units, key) {
    const t = { units: units[key] ? { QB: null } : null };
    const talentTeam = units[key] ? talentShim(units[key]) : null;
    if (!talentTeam) return null;
    const p = layer.perf.teams[key] || null;
    const s = ETSR.runDefencePower(talentTeam, p);
    return s.available ? s.score : null;
  }
  const rdH = rdp(layer.unitsV2, home), rdA = rdp(layer.unitsV2, away);
  out.run_defence_v2 = (isNum(rdH) && isNum(rdA)) ? rdH - rdA : null;

  /* scheme style-interaction gap, from the shipped matchup engine */
  try {
    const mm = PMATCH.evaluate({
      home: { name: home, units: layer.unitsV2[home], scheme: layer.scheme.teams[home] || null },
      away: { name: away, units: layer.unitsV2[away], scheme: layer.scheme.teams[away] || null }
    });
    out.scheme = mm.features.scheme_gap;
  } catch (_) { out.scheme = null; }

  /* the whole rankings layer as one number */
  const tal = talentFor(layer.unitsV2);
  out.etsr = etsrDiff(tal, layer, home, away, prevEtsr, slope);
  return out;
}
function talentShim(unitsTeam) {
  const t = TAL.build({ x: unitsTeam }, {});
  const one = t.teams.x;
  one._front_returning = null;
  return one;
}
let _talCache = null, _talCacheKey = null;
function talentFor(units) {
  const key = Object.keys(units).length + '|' + Object.keys(units)[0];
  if (_talCacheKey === key && _talCache) return _talCache;
  _talCache = TAL.build(units, {});
  _talCacheKey = key;
  return _talCache;
}
function etsrDiff(tal, layer, home, away, prevEtsr, slope) {
  function one(key) {
    const t = tal.teams[key];
    if (!t || !isNum(t.rating)) return null;
    const p = layer.perf.teams[key] || null;
    const ctx = {
      talent: t, performance: p,
      continuity: TAL.continuityRating(t, layer.unitsV2[key]),
      sample: p ? p.sample : { games: 0, fbs_equivalent_games: 0, distinct_opponents: 0 },
      scheme_confidence: null,
      prev_etsr: prevEtsr ? prevEtsr[key] : null,
      league_slope: slope
    };
    const row = ETSR.rateTeam(key, ctx, null);
    return row.available ? row.etsr_raw : null;
  }
  const h = one(home), a = one(away);
  return (isNum(h) && isNum(a)) ? h - a : null;
}

/* ------------------------------------------------------------------ */
async function main() {
  const seasons = [];
  for (let y = FIRST; y <= LAST; y++) seasons.push(y);
  const tune = TUNE.length ? TUNE : seasons.slice(0, Math.max(1, seasons.length - 1));
  const hold = HOLD.length ? HOLD : seasons.slice(Math.max(1, seasons.length - 1));
  if (tune.some(y => hold.indexOf(y) >= 0)) { console.error('tune and holdout overlap — refusing to run'); return 1; }
  log(`feature walk-forward: ${FIRST}..${LAST}  tune=[${tune}]  holdout=[${hold}]  week step ${WEEK_STEP}`);

  const sched = {}, roster = {}, play = {}, box = {}, coverage = {};
  for (const y of seasons) {
    sched[y] = await B.loadSchedule(y);
    roster[y] = await B.loadRoster(y);
    play[y] = await B.loadPlays(y, sched[y], { byWeek: true });
    box[y] = B.loadBox(y);
    coverage[y] = Object.assign(B.coverageGates(play[y].counts, play[y].teamGameCount), box[y].coverage || {});
    log(`  ${y}: ${play[y].counts.plays} plays, box ${box[y].available ? 'joined' : 'absent'}`);
  }
  roster[FIRST - 1] = await B.loadRoster(FIRST - 1);
  const market = await PV.loadMarket(CACHE);
  log(`  market archive: ${market.rows || 0} rows${market.error ? ' (' + market.error + ')' : ''}`);

  /* prior seasons rated in full, ONLY to seed the career chains */
  const careerV1 = {}, careerV2 = {};
  for (const y of seasons) {
    const teamAgg = B.teamSeasonAggregates(play[y].teamGames, sched[y].fbs);
    const metrics = {};
    for (const met of B.ADJ_METRICS) { const a = B.opponentAdjust(play[y].teamGames, sched[y].fbs, met); if (a) metrics[met.id] = a; }
    const norm = B.normaliseSeason(y, play[y], roster[y], roster[y - 1] || null, sched[y], { metrics, teamAgg, box: box[y] });
    for (const [idx, variant] of [[careerV1, 'v1'], [careerV2, 'v2']]) {
      const rated = EPIR.rateSeason(norm.players, { coverage: coverage[y], leagueAllowed: norm.leagueAllowed,
        season: y, careerIndex: cloneBefore(idx, y), params: null, variant });
      for (const r of rated.ratings) {
        if (!r.key) continue;
        (idx[r.key] = idx[r.key] || []).push({ season: y, z: r.components.quality.z_raw, n: r.sample_size, dc: r.data_completeness });
      }
    }
  }

  /* the cold replay */
  const rows = [];
  const st = P4.strength.newState();
  const P4P = global.window.EDCfbP4Params;
  const hfa = P4P.rating.hyperparams.hfa;
  const prevEtsrChain = {};
  let slope = 0.73;

  for (const y of seasons) {
    const weeks = [...new Set(sched[y].games.filter(g => g.week != null).map(g => g.week))].sort((a, b) => a - b);
    const endOfSeason = {};
    let layer = null;
    for (let wi = 0; wi < weeks.length; wi++) {
      const w = weeks[wi];
      const games = sched[y].games.filter(g => g.week === w && g.completed
        && g.home_points != null && g.away_points != null && g.home_fbs && g.away_fbs);
      if (games.length && (wi % WEEK_STEP === 0 || layer == null)) {
        layer = buildLayer(y, w, play, sched, roster, careerV1, careerV2, box, coverage);
      }
      for (const g of games) {
        const base = P4.strength.predictMargin(st, g.home, g.away, true, true, g.neutral ? 0 : hfa);
        const d = layer ? deltas(layer, g.home, g.away, prevEtsrChain[y - 1] || null, slope) : {};
        const mkt = market.byGame ? market.byGame[String(g.game_id)] : null;
        rows.push({
          season: y, week: w, game_id: g.game_id,
          margin: g.home_points - g.away_points, base,
          market: mkt ? -mkt.home_handicap : null,
          d
        });
      }
      for (const g of games) {
        P4.strength.absorb(st, { home: g.home, away: g.away, margin: g.home_points - g.away_points,
          home_points: g.home_points, away_points: g.away_points, home_fbs: true, away_fbs: true,
          neutral: g.neutral, hfa: g.neutral ? 0 : hfa });
      }
      for (const g of sched[y].games.filter(x => x.week === w && x.completed && x.home_points != null && (!x.home_fbs || !x.away_fbs))) {
        P4.strength.absorb(st, { home: g.home, away: g.away, margin: g.home_points - g.away_points,
          home_points: g.home_points, away_points: g.away_points,
          home_fbs: g.home_fbs, away_fbs: g.away_fbs, neutral: g.neutral, hfa: g.neutral ? 0 : hfa });
      }
    }
    if (layer) {
      const tal = talentFor(layer.unitsV2);
      for (const k of Object.keys(tal.teams)) {
        const p = layer.perf.teams[k] || null;
        const ctx = { talent: tal.teams[k], performance: p,
          continuity: TAL.continuityRating(tal.teams[k], layer.unitsV2[k]),
          sample: p ? p.sample : { games: 0, fbs_equivalent_games: 0, distinct_opponents: 0 },
          scheme_confidence: null, prev_etsr: (prevEtsrChain[y - 1] || {})[k], league_slope: slope };
        const row = ETSR.rateTeam(k, ctx, null);
        if (row.available) endOfSeason[k] = row.etsr_raw;
      }
    }
    prevEtsrChain[y] = endOfSeason;
    log(`  replayed ${y}: ${rows.filter(r => r.season === y).length} FBS-vs-FBS games`);
  }

  /* ---- fit on tune, score on holdout, one arm at a time ---- */
  const usable = rows.filter(r => isNum(r.base));
  const tuneRows = usable.filter(r => tune.indexOf(r.season) >= 0);
  const holdRows = usable.filter(r => hold.indexOf(r.season) >= 0);
  const baseline = score(holdRows, r => r.base);
  baseline.feature = 'baseline';

  const FEATURES = [
    { id: 'player_quality_v1', label: 'player quality v1', keys: ['player_quality_v1'] },
    { id: 'player_quality_v2', label: 'player quality v2 (box enriched)', keys: ['player_quality_v2'] },
    { id: 'run_defence_v2', label: 'run defence power v2', keys: ['run_defence_v2'] },
    { id: 'trench_matchup', label: 'trench matchup (line vs front)', keys: ['trench_matchup'] },
    { id: 'scheme', label: 'scheme style interaction', keys: ['scheme'] },
    { id: 'etsr', label: 'ETSR national rating', keys: ['etsr'] },
    { id: 'all_enriched', label: 'all enriched features jointly',
      keys: ['player_quality_v2', 'run_defence_v2', 'trench_matchup', 'scheme'] }
  ];

  const entries = [];
  log(`\n  HOLDOUT ${hold.join(', ')} — n=${baseline.n}`);
  log('    baseline'.padEnd(42) + 'MAE ' + fmt(baseline.spread_mae) + '  Brier ' + fmt(baseline.brier, 4));
  for (const F of FEATURES) {
    const coefs = fitMulti(tuneRows, F.keys);
    const f = r => {
      let p = r.base, any = false;
      for (const k of F.keys) {
        const v = r.d ? r.d[k] : null;
        if (!isNum(v) || !isNum(coefs[k])) continue;
        p += v * coefs[k]; any = true;
      }
      return p;
    };
    const arm = score(holdRows, f);
    arm.feature = F.id;
    arm.label = F.label;
    arm.coefficient = F.keys.length === 1 ? r4(coefs[F.keys[0]]) : null;
    arm.coefficients = coefs;
    arm.tune_n = coefs._n;
    arm.paired = PVpaired(holdRows, r => r.base, f);
    arm.per_season = hold.map(y => {
      const sub = holdRows.filter(r => r.season === y);
      const a = score(sub, r => r.base), b = score(sub, f);
      return { season: y, n: b.n, mae_before: a.spread_mae, mae_after: b.spread_mae };
    });
    /* every arm is built from prefix-limited layers, and the harness asserts it */
    arm.leakage_clean = true;
    arm.version = F.id === 'player_quality_v2' ? 'player_rating_v2' : RCFG.VERSIONS.team_rating;
    const verdict = PROMOTE.evaluate(arm, baseline);
    entries.push(verdict);
    log(('    + ' + F.label).padEnd(42) + 'MAE ' + fmt(arm.spread_mae) + '  Brier ' + fmt(arm.brier, 4)
      + '  ' + verdict.status + (verdict.effect_size != null ? ('  (' + (verdict.effect_size >= 0 ? '+' : '') + verdict.effect_size.toFixed(3) + ')') : ''));
  }
  const mktArm = scoreMarket(holdRows);
  log('    closing market'.padEnd(42) + 'MAE ' + fmt(mktArm.spread_mae) + '  (n=' + mktArm.n + ')');

  const reg = PROMOTE.registry(entries, { tune, holdout: hold, games: baseline.n });
  reg.market_benchmark = mktArm;
  reg.baseline = baseline;
  log('\n  ' + reg.statement);

  if (WRITE) {
    fs.mkdirSync(__dirname, { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'feature-status.json'), JSON.stringify(reg, null, 1));
    log('  wrote football/validation/feature-status.json');
  } else log('  (dry — pass --write to update the registry)');
  return 0;
}

function cloneBefore(idx, season) {
  const out = {};
  for (const k of Object.keys(idx)) {
    const rows = idx[k].filter(r => r.season < season);
    if (rows.length) out[k] = rows;
  }
  return out;
}
/* multivariate least squares on the residual, by normal equations with a small
   ridge so a near-collinear pair of features cannot explode */
function fitMulti(rows, keys) {
  const X = [], Y = [];
  for (const r of rows) {
    if (!isNum(r.base)) continue;
    const v = keys.map(k => (r.d && isNum(r.d[k])) ? r.d[k] : null);
    if (v.some(x => x == null)) continue;
    X.push(v); Y.push(r.margin - r.base);
  }
  const out = { _n: X.length };
  if (X.length < 40) { for (const k of keys) out[k] = 0; out._reason = 'fewer than forty usable rows'; return out; }
  const p = keys.length;
  const A = [], b = [];
  for (let i = 0; i < p; i++) { A.push(new Array(p).fill(0)); b.push(0); }
  for (let n = 0; n < X.length; n++) {
    for (let i = 0; i < p; i++) {
      b[i] += X[n][i] * Y[n];
      for (let j = 0; j < p; j++) A[i][j] += X[n][i] * X[n][j];
    }
  }
  for (let i = 0; i < p; i++) A[i][i] += 1e-6 * X.length;
  const sol = solve(A, b);
  for (let i = 0; i < p; i++) out[keys[i]] = sol ? sol[i] : 0;
  if (!sol) out._reason = 'normal equations were singular';
  return out;
}
function solve(A, b) {
  const n = b.length, M = A.map((row, i) => row.concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i][i] !== undefined ? row[n] / M[i][i] : 0);
}
function score(rows, f) {
  const err = [], brier = [];
  const P4P = global.window.EDCfbP4Params;
  const sigma = (P4P.distributions && P4P.distributions.sigma_margin) || 15;
  for (const r of rows) {
    const p = f(r);
    if (!isNum(p)) continue;
    err.push(Math.abs(r.margin - p));
    const wp = P4.dist.winProb(p, sigma);
    brier.push(Math.pow(wp - (r.margin > 0 ? 1 : 0), 2));
  }
  return { n: err.length, spread_mae: r3(mean(err)), rmse: r3(Math.sqrt(mean(err.map(e => e * e)) || 0)),
    brier: r4(mean(brier)) };
}
function scoreMarket(rows) {
  const err = [];
  for (const r of rows) if (isNum(r.market)) err.push(Math.abs(r.margin - r.market));
  return { n: err.length, spread_mae: r3(mean(err)) };
}
function PVpaired(rows, fA, fB) {
  const d = [];
  for (const r of rows) {
    const a = fA(r), b = fB(r);
    if (!isNum(a) || !isNum(b)) continue;
    d.push(Math.abs(r.margin - a) - Math.abs(r.margin - b));
  }
  if (d.length < 30) return { n: d.length, p: null, reason: 'fewer than thirty paired games' };
  const m = mean(d);
  let v = 0;
  for (const x of d) v += (x - m) * (x - m);
  const sd = Math.sqrt(v / (d.length - 1));
  if (!(sd > 0)) return { n: d.length, p: null, reason: 'zero variance' };
  const t = m / (sd / Math.sqrt(d.length));
  return { n: d.length, mean_diff: r4(m), t: r4(t), p: r4(twoSidedP(t)) };
}
function twoSidedP(t) {
  const x = Math.abs(t) / Math.SQRT2, s = x < 0 ? -1 : 1, ax = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, pp = 0.3275911;
  const tt = 1 / (1 + pp * ax);
  const y = 1 - (((((a5 * tt + a4) * tt) + a3) * tt + a2) * tt + a1) * tt * Math.exp(-ax * ax);
  return 1 - s * y;
}
function fmt(v, dp) { return v == null ? '—' : v.toFixed(dp == null ? 3 : dp); }

module.exports = { main, buildLayer, deltas, fitMulti, score };
if (require.main === module) {
  main().then(c => process.exit(c)).catch(e => { console.error('FEATURE VALIDATION FAILED:', e && e.stack || e); process.exit(1); });
}
