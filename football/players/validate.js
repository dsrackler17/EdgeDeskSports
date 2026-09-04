#!/usr/bin/env node
/* ============================================================================
   WALK-FORWARD VALIDATION — does any of this actually help?

   THE POINT OF THIS FILE IS TO BE ALLOWED TO SAY NO.

   The purpose of the player layer is not "make yesterday's losing bets win".
   It is "identify structural football information the current engine does not
   represent, and test whether adding it improves OUT-OF-SAMPLE accuracy". A
   feature that explains history and fails walk-forward must not move a
   projection, and this repo has done exactly that before — travel and rivalry
   both ship in the Power 4 engine with `points_applied:false` because the data
   refused them. The player-quality and scheme scalars are held to the same bar
   and get the same flag.

   NO LEAKAGE, BY CONSTRUCTION
   * Every game in season Y week W is predicted from player ratings rebuilt out
     of plays in seasons < Y plus season Y weeks < W. Nothing from week W or
     later touches it. The rebuild is real, not a filter over finished ratings.
   * The baseline is the Power 4 engine's own rating recursion, replayed cold in
     kickoff order: each game predicted from a state holding only games already
     played, then absorbed. The same discipline cfb_p4/research uses.
   * The scalars are fitted on a TUNE window and scored on a HOLDOUT window the
     fit never saw.
   * The market is never an input to any model number. It is a benchmark.

   WHAT IT MEASURES
     spread MAE, score MAE, Brier score, win-probability calibration,
     cover calibration and the closing-line comparison where the public line
     archive covers the game.

   FOUR LADDERS, the comparison the spec asks for:
     baseline
     baseline + recruiting          (NOT RUN — no recruiting feed is wired in,
                                     and a placebo arm would be a lie)
     baseline + player quality
     baseline + player quality + scheme

     node football/players/validate.js [--first 2022] [--last 2025]
                                       [--tune 2022,2023] [--hold 2024,2025]
                                       [--cache DIR] [--write-params]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const B = require('./build_players.js');
const CFG = require('./config.js');
const EPIR = require('./epir.js');
const UNITS = require('./units.js');
const SCHEME = require('./scheme.js');
const MATCH = require('./matchup.js');

const DIR = __dirname;
const REPORT = path.join(DIR, 'report');
const P4 = require(path.join(DIR, '..', 'cfb_p4', 'engine.js'));
require(path.join(DIR, '..', 'cfb_p4', 'params.js'));

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || v.startsWith('--')) ? true : v;
}
const FIRST = +(arg('first', 2022));
const LAST = +(arg('last', 2025));
const TUNE = String(arg('tune', '')).split(',').filter(Boolean).map(Number);
const HOLD = String(arg('hold', '')).split(',').filter(Boolean).map(Number);
const WRITE_PARAMS = !!arg('write-params', false);
const LINE_ARCHIVE = 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/betting/csv/cfb_line_odds.csv.gz';

function log(...a) { console.log(...a); }
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const r3 = v => v == null ? null : Math.round(v * 1000) / 1000;
const r4 = v => v == null ? null : Math.round(v * 10000) / 10000;

/* ---------------------------------------------------------------------- */
/* the market benchmark: the public closing-line archive                    */
/* ---------------------------------------------------------------------- */
async function loadMarket(cacheDir) {
  /* The public closing-line archive: 1.18M rows, 2006-2025, multiple books.
     Two documented traps, both handled here rather than discovered later:
       * ~15.6% of rows are exact duplicates (established in cfb_p4/README.md)
         and are dropped before any consensus median is taken.
       * a spread row is stated FROM ONE TEAM'S SIDE and identified only by an
         abbreviation, so the home side has to be resolved through the teams
         file. A row that cannot be resolved is DROPPED, never guessed. */
  async function get(url, name) {
    const cached = cacheDir ? path.join(cacheDir, name) : null;
    if (cached && fs.existsSync(cached)) return fs.readFileSync(cached);
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + name);
    const buf = Buffer.from(await r.arrayBuffer());
    if (cached) { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(cached, buf); }
    return buf;
  }
  let text, abbrToId = {};
  try {
    const teams = (await get('https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/teams/teams_colors_logos.csv', 'teams_colors_logos.csv')).toString('utf8');
    for (const t of B.parseCsvObjects(teams)) {
      if (t.abbreviation && t.team_id) abbrToId[String(t.abbreviation).toUpperCase()] = String(t.team_id);
    }
  } catch (e) { return { byGame: {}, rows: 0, error: 'teams file: ' + e.message }; }
  try {
    text = zlib.gunzipSync(await get(LINE_ARCHIVE, 'cfb_line_odds.csv.gz')).toString('utf8');
  } catch (e) { return { byGame: {}, rows: 0, error: e.message }; }

  const nl = text.indexOf('\n');
  const ix = B.headerIndex(text.slice(0, nl));
  const need = ['game_id', 'market_type', 'abbr', 'lines', 'book', 'home_team_id', 'away_team_id'];
  for (const k of need) if (ix[k] == null) return { byGame: {}, rows: 0, error: 'line archive is missing column ' + k };
  const acc = {}, seen = new Set();
  let pos = nl + 1, rows = 0, dupes = 0, unresolved = 0;
  while (pos < text.length) {
    let end = text.indexOf('\n', pos); if (end < 0) end = text.length;
    const line = text.charCodeAt(end - 1) === 13 ? text.slice(pos, end - 1) : text.slice(pos, end);
    pos = end + 1;
    if (!line) continue;
    const r = B.splitLine(line);
    const gid = r[ix.game_id], mt = r[ix.market_type], val = +r[ix.lines];
    if (!gid || !isFinite(val)) continue;
    const sig = gid + '|' + mt + '|' + r[ix.abbr] + '|' + r[ix.book] + '|' + val;
    if (seen.has(sig)) { dupes++; continue; }
    seen.add(sig);
    const a = acc[gid] = acc[gid] || { sp: [], tot: [] };
    if (mt === 'spread') {
      const teamId = abbrToId[String(r[ix.abbr] || '').toUpperCase()];
      if (!teamId) { unresolved++; continue; }
      if (teamId === String(r[ix.home_team_id])) a.sp.push(val);
      else if (teamId === String(r[ix.away_team_id])) a.sp.push(-val);
      else { unresolved++; continue; }
      rows++;
    } else if (mt === 'total') {
      const side = String(r[ix.abbr] || '').toLowerCase();
      if (side !== 'over' && side !== 'under') continue;
      a.tot.push(val);
      rows++;
    }
  }
  const byGame = {};
  for (const gid of Object.keys(acc)) {
    if (!acc[gid].sp.length) continue;
    byGame[gid] = { home_handicap: median(acc[gid].sp), total: acc[gid].tot.length ? median(acc[gid].tot) : null,
      books: acc[gid].sp.length };
  }
  return { byGame, rows, dupes, unresolved, error: null };
}
function median(a) { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; }

/* ---------------------------------------------------------------------- */
/* rebuild the player layer as it stood BEFORE a given (season, week)       */
/* ---------------------------------------------------------------------- */
function prefixPlayers(play, maxWeekExclusive) {
  /* one player-season accumulator per athlete, holding only weeks < cutoff */
  const out = new Map();
  for (const [id, p] of play.players) {
    if (!p.byWeek) throw new Error('validate needs loadPlays({byWeek:true})');
    let any = false;
    const stat = {}, weeks = new Set();
    let first = null, last = null;
    for (const wk of Object.keys(p.byWeek)) {
      const w = +wk;
      if (!(w < maxWeekExclusive)) continue;
      any = true; weeks.add(w);
      if (first == null || w < first) first = w;
      if (last == null || w > last) last = w;
      const b = p.byWeek[wk];
      for (const k of Object.keys(b)) stat[k] = (stat[k] || 0) + b[k];
    }
    if (!any) continue;
    out.set(id, { athlete_id: id, name: p.name, team: p.team, first_week: first, last_week: last,
      weeks, stat, oppAcc: p.oppAcc, teams: p.teams, byWeek: null });
  }
  return out;
}
function prefixTeamGames(play, maxWeekExclusive) {
  const out = new Map();
  for (const [k, tg] of play.teamGames) {
    if (tg.week != null && tg.week >= maxWeekExclusive) continue;
    out.set(k, tg);
  }
  return out;
}

/* ---------------------------------------------------------------------- */
async function main() {
  const cache = arg('cache', process.env.EDP_CACHE || '') || null;
  const seasons = [];
  for (let y = FIRST; y <= LAST; y++) seasons.push(y);
  const tune = TUNE.length ? TUNE : seasons.slice(0, Math.max(1, seasons.length - 2));
  const hold = HOLD.length ? HOLD : seasons.slice(Math.max(1, seasons.length - 2));
  log(`walk-forward: seasons ${FIRST}..${LAST}  tune=[${tune}]  holdout=[${hold}]`);
  if (tune.some(y => hold.indexOf(y) >= 0)) { console.error('tune and holdout overlap — refusing to run'); return 1; }

  const sched = {}, roster = {}, play = {};
  for (const y of seasons) {
    sched[y] = await B.loadSchedule(y);
    roster[y] = await B.loadRoster(y);
    play[y] = await B.loadPlays(y, sched[y], { byWeek: true });
    log(`  ${y}: ${play[y].counts.plays} plays, ${roster[y].count} rostered`);
  }
  roster[FIRST - 1] = await B.loadRoster(FIRST - 1);
  const market = await loadMarket(cache);
  log(`  market archive: ${market.rows} rows${market.error ? ' (' + market.error + ')' : ''}${market.dupes ? ', ' + market.dupes + ' exact duplicates dropped' : ''}`);

  /* ---- prior seasons, rated once and frozen: they never change ---- */
  const careerBase = {};
  const seasonRatings = {};
  for (const y of seasons) {
    const teamAgg = B.teamSeasonAggregates(play[y].teamGames, sched[y].fbs);
    const metrics = {};
    for (const met of B.ADJ_METRICS) { const a = B.opponentAdjust(play[y].teamGames, sched[y].fbs, met); if (a) metrics[met.id] = a; }
    const norm = B.normaliseSeason(y, play[y], roster[y], roster[y - 1] || null, sched[y], { metrics, teamAgg });
    const rated = EPIR.rateSeason(norm.players, {
      coverage: B.coverageGates(play[y].counts, play[y].teamGameCount),
      leagueAllowed: norm.leagueAllowed, season: y, careerIndex: cloneCareer(careerBase), params: null
    });
    seasonRatings[y] = rated.ratings;
    for (const r of rated.ratings) {
      if (!r.key) continue;
      (careerBase[r.key] = careerBase[r.key] || []).push({ season: y, z: r.components.quality.z_raw, n: r.sample_size, dc: r.data_completeness });
    }
    log(`  ${y}: ${rated.ratings.length} full-season ratings (used only as PRIOR seasons, never for their own season)`);
  }

  /* ---- the cold replay ---- */
  const rows = [];
  const st = P4.strength.newState();
  const P4P = (typeof window !== 'undefined' && window.EDCfbP4Params) || global.window.EDCfbP4Params;
  const hfa = P4P.rating.hyperparams.hfa;

  for (const y of seasons) {
    const weeks = [...new Set(sched[y].games.filter(g => g.week != null).map(g => g.week))].sort((a, b) => a - b);
    for (const w of weeks) {
      /* the layer as it stood before this week */
      const layer = buildLayer(y, w, play, sched, roster, careerBase, seasons);
      const games = sched[y].games.filter(g => g.week === w && g.completed
        && g.home_points != null && g.away_points != null && g.home_fbs && g.away_fbs);
      for (const g of games) {
        const margin = g.home_points - g.away_points;
        const base = P4.strength.predictMargin(st, g.home, g.away, true, true, g.neutral ? 0 : hfa);
        const H = layer.teams[g.home], A = layer.teams[g.away];
        let pgap = null, sgap = null, mm = null;
        if (H && A) {
          mm = MATCH.evaluate({
            home: { name: g.home_name, units: H.units, scheme: H.scheme },
            away: { name: g.away_name, units: A.units, scheme: A.scheme }
          });
          pgap = mm.features.player_quality_gap;
          sgap = mm.features.scheme_gap;
        }
        const mkt = market.byGame[String(g.game_id)] || null;
        rows.push({
          season: y, week: w, game_id: g.game_id, home: g.home, away: g.away,
          margin, base: base == null ? null : base, pgap, sgap,
          /* the book states the home team's handicap (-3 = home favoured by
             three); the engine states the margin the home team is expected to
             win by. They are negatives of each other. */
          market: mkt ? -mkt.home_handicap : null,
          total: g.home_points + g.away_points, market_total: mkt ? mkt.total : null
        });
      }
      /* absorb the week, then move on — the state never sees a game before it
         has predicted it */
      for (const g of games) {
        P4.strength.absorb(st, { home: g.home, away: g.away, margin: g.home_points - g.away_points,
          home_points: g.home_points, away_points: g.away_points,
          home_fbs: true, away_fbs: true, neutral: g.neutral, hfa: g.neutral ? 0 : hfa });
      }
      /* non-FBS games still teach the pooled rating, exactly as the engine does */
      for (const g of sched[y].games.filter(x => x.week === w && x.completed && x.home_points != null && (!x.home_fbs || !x.away_fbs))) {
        P4.strength.absorb(st, { home: g.home, away: g.away, margin: g.home_points - g.away_points,
          home_points: g.home_points, away_points: g.away_points,
          home_fbs: g.home_fbs, away_fbs: g.away_fbs, neutral: g.neutral, hfa: g.neutral ? 0 : hfa });
      }
    }
    log(`  replayed ${y}: ${rows.filter(r => r.season === y).length} FBS-vs-FBS games with a baseline`);
  }

  /* ---- fit on tune, score on holdout ---- */
  const usable = rows.filter(r => r.base != null);
  const tuneRows = usable.filter(r => tune.indexOf(r.season) >= 0 && r.pgap != null);
  const holdRows = usable.filter(r => hold.indexOf(r.season) >= 0);

  const fitP = ols(tuneRows.map(r => r.pgap), tuneRows.map(r => r.margin - r.base));
  const tuneS = tuneRows.filter(r => r.sgap != null);
  const fitS = ols(tuneS.map(r => r.sgap), tuneS.map(r => r.margin - r.base - (fitP.slope || 0) * r.pgap));

  log(`  tune fit: player slope ${r4(fitP.slope)} pts per matchup point (n=${fitP.n}, r2=${r4(fitP.r2)})`);
  log(`  tune fit: scheme slope ${r4(fitS.slope)} (n=${fitS.n}, r2=${r4(fitS.r2)})`);

  const sigma = P4P.distribution && P4P.distribution.sigma ? null : null;
  const ladders = {
    baseline: r => r.base,
    player: r => r.base + (r.pgap == null ? 0 : (fitP.slope || 0) * r.pgap),
    player_scheme: r => r.base + (r.pgap == null ? 0 : (fitP.slope || 0) * r.pgap) + (r.sgap == null ? 0 : (fitS.slope || 0) * r.sgap)
  };
  const results = {};
  for (const name of Object.keys(ladders)) results[name] = score(holdRows, ladders[name]);
  results.market = scoreMarket(holdRows);
  const recruitingArm = {
    ran: false,
    reason: 'no recruiting feed is wired in (see recruiting_adapter.js). The "baseline + recruiting" arm the spec asks for cannot be run, and running it with fabricated or placebo pedigree would be worse than not running it.'
  };

  const baseMae = results.baseline.spread_mae;
  const playerMae = results.player.spread_mae;
  const schemeMae = results.player_scheme.spread_mae;

  /* AN IMPROVEMENT OF 0.02 POINTS IS NOT AN IMPROVEMENT.
     "Lower MAE on the holdout" is far too weak a bar to let a layer move a
     line: with sixteen hundred games, a coin-flip difference clears it about
     half the time. Three things must ALL hold before points_applied goes true:
       1  the holdout MAE is lower;
       2  a paired test over the per-game absolute errors says the difference
          is not noise (two-sided, p < 0.05);
       3  it is lower in EVERY holdout season separately, not just pooled.
     Anything less ships as research with points_applied:false. */
  const pairPlayer = pairedTest(holdRows, ladders.baseline, ladders.player);
  const pairScheme = pairedTest(holdRows, ladders.player, ladders.player_scheme);
  const perSeasonPlayer = bySeasonImprovement(holdRows, hold, ladders.baseline, ladders.player);
  const perSeasonScheme = bySeasonImprovement(holdRows, hold, ladders.player, ladders.player_scheme);
  const playerHelps = playerMae != null && baseMae != null && playerMae < baseMae
    && pairPlayer.p != null && pairPlayer.p < 0.05 && perSeasonPlayer.every(x => x.improves);
  const schemeHelps = playerHelps && schemeMae != null && schemeMae < playerMae
    && pairScheme.p != null && pairScheme.p < 0.05 && perSeasonScheme.every(x => x.improves);

  log('\n  HOLDOUT (' + hold.join(', ') + '), n=' + results.baseline.n);
  log('    baseline               spread MAE ' + fmt(baseMae) + '  Brier ' + fmt(results.baseline.brier, 4));
  log('    + player quality       spread MAE ' + fmt(playerMae) + '  Brier ' + fmt(results.player.brier, 4)
    + '   ' + (playerHelps ? 'IMPROVES by ' + fmt(baseMae - playerMae) : 'DOES NOT IMPROVE'));
  log('    + player + scheme      spread MAE ' + fmt(schemeMae) + '  Brier ' + fmt(results.player_scheme.brier, 4)
    + '   ' + (schemeHelps ? 'IMPROVES by ' + fmt(playerMae - schemeMae) : 'DOES NOT IMPROVE'));
  log('    closing market         spread MAE ' + fmt(results.market.spread_mae) + '  (n=' + results.market.n + ')');

  const calibration = {
    player_points_per_unit: {
      value: r4(fitP.slope), points_applied: !!playerHelps,
      tune_seasons: tune, holdout_seasons: hold,
      tune_n: fitP.n, tune_r2: r4(fitP.r2),
      holdout_mae_baseline: r3(baseMae), holdout_mae_with: r3(playerMae),
      paired_test: pairPlayer, per_season: perSeasonPlayer,
      basis: 'points of spread per matchup point of team player-quality gap, fitted by least squares on the tune window’s residual from the Power 4 rating core and scored on a holdout the fit never saw',
      bar: 'lower holdout MAE, a paired test at p < 0.05 over the per-game absolute errors, AND a lower MAE in every holdout season separately',
      reason: playerHelps ? null
        : 'the layer did not clear the bar (' + failWhy(playerMae, baseMae, pairPlayer, perSeasonPlayer) + '), so this scalar moves NO line. The gap is still published, because knowing which team is better on player quality is useful research even when it does not price the game better than the rating core already does.'
    },
    scheme_points_per_unit: {
      value: r4(fitS.slope), points_applied: !!(playerHelps && schemeHelps),
      tune_n: fitS.n, tune_r2: r4(fitS.r2),
      holdout_mae_with_player: r3(playerMae), holdout_mae_with_scheme: r3(schemeMae),
      paired_test: pairScheme, per_season: perSeasonScheme,
      basis: 'points of spread per matchup point of style-interaction gap, fitted on the residual left after the player scalar',
      bar: 'the same three-part bar as the player scalar, applied to the residual the player scalar leaves behind',
      reason: schemeHelps ? null
        : 'the scheme layer did not clear the bar (' + failWhy(schemeMae, playerMae, pairScheme, perSeasonScheme) + '), so it moves NO line and is published as research context only.'
    }
  };

  const report = {
    schema: 'edgedesk_player_validation_v1',
    generated_at: new Date().toISOString(),
    config_version: CFG.versions,
    seasons: seasons, tune_seasons: tune, holdout_seasons: hold,
    games_replayed: rows.length, games_scored: usable.length,
    leakage_controls: [
      'player ratings for a game in season Y week W are rebuilt from plays in seasons < Y plus season Y weeks < W, and the rebuild is real rather than a filter over finished ratings',
      'the baseline is the Power 4 rating recursion replayed cold in kickoff order: every game predicted before it is absorbed',
      'the scalars are fitted on a tune window and scored on a holdout window the fit never saw',
      'the market is never an input to any model number in this file; it is a benchmark column'
    ],
    arms: { baseline: results.baseline, recruiting: recruitingArm, player: results.player, player_scheme: results.player_scheme, market: results.market },
    fits: { player: fitP, scheme: fitS },
    paired_tests: { player: pairPlayer, scheme: pairScheme },
    per_season: { player: perSeasonPlayer, scheme: perSeasonScheme },
    bar: 'a layer moves a line only if it lowers holdout MAE, survives a paired test at p < 0.05, AND is better in every holdout season separately',
    calibration,
    verdict: {
      player_quality_improves_out_of_sample: !!playerHelps,
      scheme_improves_out_of_sample: !!schemeHelps,
      statement: playerHelps
        ? 'the player-quality layer improved holdout spread MAE and is allowed to move the line by the fitted scalar'
        : 'the player-quality layer did NOT improve holdout spread MAE. It ships with points_applied:false: it is published as research, it moves no projection, and the Football board’s existing numbers are unchanged by it.'
    }
  };
  fs.mkdirSync(REPORT, { recursive: true });
  fs.writeFileSync(path.join(REPORT, 'validation.json'), JSON.stringify(report, null, 1));
  fs.writeFileSync(path.join(REPORT, 'BACKTEST.md'), markdown(report));
  log('\n  wrote football/players/report/validation.json and BACKTEST.md');

  if (WRITE_PARAMS) {
    const pf = path.join(DIR, 'params.js');
    let cur = {};
    try { cur = require(pf); } catch (_) {}
    cur.calibration = calibration;
    cur.validation_summary = { holdout: hold, tune: tune, arms: {
      baseline: results.baseline, player: results.player, player_scheme: results.player_scheme, market: results.market },
      verdict: report.verdict };
    fs.writeFileSync(pf, `if(typeof window==='undefined'){globalThis.window=globalThis;}
/* EdgeDesk Player Quality — MEASURED constants (see run_build.js) plus the
   walk-forward calibration written by validate.js. GENERATED FILE.
   \`calibration.*.points_applied\` is allowed to be false and frequently is:
   a layer that does not improve out-of-sample accuracy moves no line here. */
window.EDPlayerParams = ${JSON.stringify(cur)};
if(typeof module!=='undefined'&&module.exports)module.exports=window.EDPlayerParams;
`);
    log('  calibration written into football/players/params.js');
  }
  return 0;
}

/* Paired two-sided test over per-game absolute errors. The normal
   approximation to the paired t is used because n is in the thousands; the
   statistic, the n and the mean difference all ship so the reader can check. */
function pairedTest(rows, fA, fB) {
  const d = [];
  for (const r of rows) {
    const a = fA(r), b = fB(r);
    if (a == null || b == null) continue;
    d.push(Math.abs(r.margin - a) - Math.abs(r.margin - b));   /* > 0 means B is better */
  }
  if (d.length < 30) return { n: d.length, mean_diff: null, t: null, p: null,
    reason: 'fewer than thirty paired games' };
  const m = mean(d);
  let v = 0;
  for (const x of d) v += (x - m) * (x - m);
  const sd = Math.sqrt(v / (d.length - 1));
  if (!(sd > 0)) return { n: d.length, mean_diff: r4(m), t: null, p: null, reason: 'zero variance in the paired differences' };
  const t = m / (sd / Math.sqrt(d.length));
  return { n: d.length, mean_diff: r4(m), sd: r4(sd), t: r4(t), p: r4(twoSidedP(t)),
    basis: 'paired difference of per-game absolute error, second arm minus first; positive mean_diff means the second arm is closer to the truth' };
}
function twoSidedP(t) {
  /* normal approximation: 2 * (1 - Phi(|t|)), Phi via A&S 7.1.26 erf */
  const x = Math.abs(t) / Math.SQRT2;
  const s = x < 0 ? -1 : 1, ax = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, pp = 0.3275911;
  const tt = 1 / (1 + pp * ax);
  const y = 1 - (((((a5 * tt + a4) * tt) + a3) * tt + a2) * tt + a1) * tt * Math.exp(-ax * ax);
  const erf = s * y;
  return 1 - erf;
}
function bySeasonImprovement(rows, seasons, fA, fB) {
  const out = [];
  for (const y of seasons) {
    const sub = rows.filter(r => r.season === y);
    const a = score(sub, fA), b = score(sub, fB);
    out.push({ season: y, n: b.n, mae_before: a.spread_mae, mae_after: b.spread_mae,
      improves: a.spread_mae != null && b.spread_mae != null && b.spread_mae < a.spread_mae });
  }
  return out;
}
function failWhy(after, before, pair, perSeason) {
  const bits = [];
  if (!(after != null && before != null && after < before)) bits.push('pooled holdout MAE did not fall');
  else bits.push('pooled MAE fell by only ' + (before - after).toFixed(3) + ' points');
  if (pair && pair.p != null) bits.push('paired p = ' + pair.p.toFixed(3));
  else if (pair && pair.reason) bits.push(pair.reason);
  const bad = (perSeason || []).filter(x => !x.improves).map(x => x.season);
  if (bad.length) bits.push('it is worse in ' + bad.join(' and '));
  return bits.join('; ');
}

function cloneCareer(c) { const o = {}; for (const k of Object.keys(c)) o[k] = c[k].slice(); return o; }

/* the player layer as it stood before (season, week) */
function buildLayer(season, week, play, sched, roster, careerBase, seasons) {
  const partial = {
    players: prefixPlayers(play[season], week),
    teamGames: prefixTeamGames(play[season], week),
    counts: play[season].counts, teamGameCount: play[season].teamGameCount, season
  };
  const teamAgg = B.teamSeasonAggregates(partial.teamGames, sched[season].fbs);
  const metrics = {};
  for (const met of B.ADJ_METRICS) { const a = B.opponentAdjust(partial.teamGames, sched[season].fbs, met); if (a) metrics[met.id] = a; }
  const norm = B.normaliseSeason(season, partial, roster[season], roster[season - 1] || null, sched[season], { metrics, teamAgg });
  /* the career index holds ONLY seasons strictly before this one */
  const career = {};
  for (const k of Object.keys(careerBase)) {
    const rowsK = careerBase[k].filter(r => r.season < season);
    if (rowsK.length) career[k] = rowsK;
  }
  const rated = EPIR.rateSeason(norm.players, {
    coverage: B.coverageGates(play[season].counts, play[season].teamGameCount),
    leagueAllowed: norm.leagueAllowed, season, careerIndex: career, params: null
  });
  const prevAgg = seasons.indexOf(season) > 0 ? null : null;
  const scheme = SCHEME.buildProfiles(teamAgg.off, teamAgg.def, { season, rosterPositions: {} });
  const byTeam = {};
  for (const r of rated.ratings) { if (r.team_key) (byTeam[r.team_key] = byTeam[r.team_key] || []).push(r); }
  const teams = {};
  for (const key of Object.keys(byTeam)) {
    if (!sched[season].fbs[key]) continue;
    const profile = scheme.teams[key] || null;
    teams[key] = { units: UNITS.rateTeam(key, key, byTeam[key], { teamContext: SCHEME.unitContext(profile), season }),
      scheme: profile };
  }
  return { teams, scheme };
}

function ols(x, y) {
  const xs = [], ys = [];
  for (let i = 0; i < x.length; i++) if (x[i] != null && y[i] != null && isFinite(x[i]) && isFinite(y[i])) { xs.push(x[i]); ys.push(y[i]); }
  if (xs.length < 30) return { slope: 0, intercept: 0, n: xs.length, r2: null,
    reason: 'fewer than thirty usable rows — no slope is fitted and the scalar stays at zero' };
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (!(sxx > 0)) return { slope: 0, intercept: my, n: xs.length, r2: null, reason: 'no variance in the predictor' };
  const slope = sxy / sxx;
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : null;
  return { slope, intercept: my - slope * mx, n: xs.length, r2 };
}

function score(rows, f) {
  const err = [], errT = [], brier = [], cover = [];
  const P4P = global.window.EDCfbP4Params;
  const sigma = (P4P.distribution && P4P.distribution.sigma && P4P.distribution.sigma.base) || 16.5;
  for (const r of rows) {
    const p = f(r);
    if (p == null) continue;
    err.push(Math.abs(r.margin - p));
    const wp = P4.dist.winProb(p, sigma);
    brier.push(Math.pow(wp - (r.margin > 0 ? 1 : 0), 2));
    if (r.market != null) {
      const pickHome = p > r.market;
      const coveredHome = r.margin > r.market;
      if (r.margin !== r.market) cover.push(pickHome === coveredHome ? 1 : 0);
    }
  }
  return { n: err.length, spread_mae: r3(mean(err)), brier: r4(mean(brier)),
    ats_vs_close: cover.length ? r4(mean(cover)) : null, ats_n: cover.length };
}
function scoreMarket(rows) {
  const err = [];
  for (const r of rows) if (r.market != null) err.push(Math.abs(r.margin - r.market));
  return { n: err.length, spread_mae: r3(mean(err)), brier: null, ats_vs_close: null, ats_n: 0 };
}
function fmt(v, dp) { return v == null ? '—' : v.toFixed(dp == null ? 3 : dp); }

function markdown(rep) {
  const a = rep.arms;
  const row = (name, x) => `| ${name} | ${x.n || 0} | ${x.spread_mae == null ? '—' : x.spread_mae.toFixed(3)} | ${x.brier == null ? '—' : x.brier.toFixed(4)} | ${x.ats_vs_close == null ? '—' : (x.ats_vs_close * 100).toFixed(1) + '%'} |`;
  return `# EdgeDesk Player Quality + Scheme — walk-forward record

Generated ${rep.generated_at}.
Tune window: ${rep.tune_seasons.join(', ')}. **Holdout: ${rep.holdout_seasons.join(', ')}** — seasons no
scalar in this layer was fitted on.

${rep.games_scored} FBS-vs-FBS games replayed cold in kickoff order across
${rep.seasons[0]}-${rep.seasons[rep.seasons.length - 1]}. The table below scores the
**${a.baseline.n}** of them that fall in the holdout window; the market row covers the
${a.market.n} of those the public closing-line archive reaches.

## The result, first

${rep.verdict.statement}

| arm | n | spread MAE | Brier | ATS vs close |
|---|---|---|---|---|
${row('baseline (Power 4 rating core)', a.baseline)}
${row('+ player quality', a.player)}
${row('+ player quality + scheme', a.player_scheme)}
${row('closing market', a.market)}

**baseline + recruiting was NOT run.** ${a.recruiting.reason}

## Calibration

| scalar | value | applied? | why |
|---|---|---|---|
| player points per matchup point | ${rep.calibration.player_points_per_unit.value} | ${rep.calibration.player_points_per_unit.points_applied ? '**yes**' : '**no**'} | ${rep.calibration.player_points_per_unit.reason || 'improved holdout MAE'} |
| scheme points per matchup point | ${rep.calibration.scheme_points_per_unit.value} | ${rep.calibration.scheme_points_per_unit.points_applied ? '**yes**' : '**no**'} | ${rep.calibration.scheme_points_per_unit.reason || 'improved holdout MAE'} |

## How leakage is prevented

${rep.leakage_controls.map(s => '* ' + s).join('\n')}

## What "improves" has to mean here

A layer moves a line only if it clears all three of:

1. lower pooled holdout spread MAE, **and**
2. a paired test over the per-game absolute errors at **p < 0.05**, **and**
3. lower MAE in **every** holdout season separately.

With sixteen hundred games, "lower pooled MAE" alone is cleared by a coin flip
about half the time. Per-season detail:

| arm | ${rep.per_season.player.map(x => x.season).join(' | ')} |
|---|${rep.per_season.player.map(() => '---').join('|')}|
| baseline | ${rep.per_season.player.map(x => x.mae_before == null ? '—' : x.mae_before.toFixed(3)).join(' | ')} |
| + player quality | ${rep.per_season.player.map(x => (x.mae_after == null ? '—' : x.mae_after.toFixed(3)) + (x.improves ? ' ✓' : ' ✗')).join(' | ')} |

## Reproducing this

\`\`\`
node football/players/validate.js --first ${rep.seasons[0]} --last ${rep.seasons[rep.seasons.length - 1]} \\
     --tune ${rep.tune_seasons.join(',')} --hold ${rep.holdout_seasons.join(',')} --write-params
\`\`\`
`;
}

if (require.main === module) {
  main().then(c => process.exit(c)).catch(e => { console.error('VALIDATION FAILED:', e && e.stack || e); process.exit(1); });
}
module.exports = { main, ols, score, loadMarket, prefixPlayers, prefixTeamGames, buildLayer };
