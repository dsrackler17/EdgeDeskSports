#!/usr/bin/env node
/* ============================================================================
   THE WEEKLY NATIONAL RANKINGS BUILD.

   Runs in GitHub Actions, writes checked-in artifacts, and computes nothing in
   anybody's browser. There is no Edge Function anywhere in this path and there
   is no manual step.

     PLAYER ARTIFACTS (football/players/)      talent, units, scheme
     cfbfastR play attribution + schedules     performance, opponent adjustment
     the public closing-line archive           the market column, kept OUTSIDE
                                               every model number
                    |
                    v
     TALENT  +  OPPONENT-ADJUSTED PERFORMANCE  ->  ETSR  ->  RANKS  ->  SNAPSHOT

   WHERE EACH SEASON'S NUMBERS COME FROM, and why they differ:
     * THIS season's talent is read from the COMMITTED player artifact, so the
       rankings are demonstrably built on the same ratings the Players page
       shows rather than on a private recomputation.
     * EARLIER seasons are reconstructed here from the same modules, because
       the player artifact only publishes the current season and the prior-
       season ETSR chain needs the others. The reconstruction uses the same
       code, so the two agree by construction.

     node football/rankings/build_rankings.js [--season 2026] [--seasons 4]
          [--cache DIR] [--dry] [--quiet] [--allow-anomalies]

   Exit 0 = written or unchanged. Exit 1 = could not run, or a SEVERE anomaly
   was found and the build refused to publish it.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const B = require('../players/build_players.js');
const EPIR = require('../players/epir.js');
const UNITS = require('../players/units.js');
const PSCHEME = require('../players/scheme.js');
const CFG = require('./config.js');
const PERF = require('./performance.js');
const TAL = require('./talent.js');
const ETSR = require('./etsr.js');

const DIR = __dirname;
const PLAYERS_DIR = path.join(DIR, '..', 'players');
const OUT_CUR = path.join(DIR, 'current.json');
const OUT_SNAP = path.join(DIR, 'snapshots');
const OUT_PARAMS = path.join(DIR, 'params.js');
const OVERRIDES = path.join(DIR, 'overrides.json');

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || v.startsWith('--')) ? true : v;
}
const QUIET = !!arg('quiet', false);
const DRY = !!arg('dry', false);
const ALLOW_ANOM = !!arg('allow-anomalies', false);
const CACHE = arg('cache', process.env.EDP_CACHE || '') || null;
function log(...a) { if (!QUIET) console.log(...a); }
function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }
const SEASON = +(arg('season', defaultSeason()));
const SEASONS_BACK = +(arg('seasons', 4));

const r1 = v => (v == null || !isFinite(v)) ? null : Math.round(v * 10) / 10;
const r2 = v => (v == null || !isFinite(v)) ? null : Math.round(v * 100) / 100;
const r3 = v => (v == null || !isFinite(v)) ? null : Math.round(v * 1000) / 1000;
const isNum = x => typeof x === 'number' && isFinite(x);
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } }
function digestOf(o) { return crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 16); }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }

/* --------------------------------------------------------------------------
   WEEK RESOLUTION (§25)
   Calendar weeks are useless here: the postseason restarts its own numbering,
   and a bye is not a week of football. Everything downstream orders on the
   ORDINAL below, and the label is what a human reads.
   -------------------------------------------------------------------------- */
const POSTSEASON_OFFSET = 20;
function weekOrdinal(seasonType, week) {
  const w = week == null ? 0 : +week;
  return /post/i.test(String(seasonType || '')) ? POSTSEASON_OFFSET + w : w;
}
function weekLabel(seasonType, week, notes) {
  if (/post/i.test(String(seasonType || ''))) {
    const n = String(notes || '');
    if (/playoff/i.test(n)) return 'Playoff';
    if (/national championship/i.test(n)) return 'National championship';
    return 'Bowls';
  }
  if (week === 0) return 'Week 0';
  return 'Week ' + week;
}
/* The point in the season this build represents: the latest completed game. */
function resolveWeek(sched) {
  let best = null;
  for (const g of sched.games) {
    if (!g.completed || g.home_points == null) continue;
    const ord = weekOrdinal(g.season_type, g.week);
    if (best == null || ord > best.ordinal) {
      best = { ordinal: ord, week: g.week, season_type: g.season_type || 'regular',
        label: weekLabel(g.season_type, g.week, g.notes) };
    }
  }
  if (!best) return { ordinal: 0, week: 0, season_type: 'regular', label: 'Preseason',
    basis: 'no completed game in this season’s schedule yet, so this is a preseason board built on talent and last season' };
  best.basis = 'the latest completed game in the schedule feed. Ordinal ' + best.ordinal
    + ' (regular-season weeks keep their number; the postseason is offset by ' + POSTSEASON_OFFSET + ' so it sorts after them).';
  return best;
}

/* --------------------------------------------------------------------------
   THE MARKET-IMPLIED POWER COLUMN
   Solved from the public closing-line archive, entirely SEPARATELY, and never
   fed into ETSR. It exists so the two can be seen disagreeing.
   -------------------------------------------------------------------------- */
async function marketPower(season, sched, cacheDir) {
  const LINE = 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/betting/csv/cfb_line_odds.csv.gz';
  const TEAMS = 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/teams/teams_colors_logos.csv';
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
    const t = (await get(TEAMS, 'teams_colors_logos.csv')).toString('utf8');
    for (const row of B.parseCsvObjects(t)) if (row.abbreviation && row.team_id) abbrToId[String(row.abbreviation).toUpperCase()] = String(row.team_id);
    text = zlib.gunzipSync(await get(LINE, 'cfb_line_odds.csv.gz')).toString('utf8');
  } catch (e) {
    return { available: false, reason: 'the public closing-line archive did not load: ' + e.message };
  }
  const nl = text.indexOf('\n');
  const ix = B.headerIndex(text.slice(0, nl));
  for (const k of ['game_id', 'market_type', 'abbr', 'lines', 'book', 'home_team_id', 'away_team_id', 'season']) {
    if (ix[k] == null) return { available: false, reason: 'the line archive is missing column ' + k };
  }
  const byGame = {}, seen = new Set();
  let pos = nl + 1, dupes = 0;
  while (pos < text.length) {
    let end = text.indexOf('\n', pos); if (end < 0) end = text.length;
    const line = text.charCodeAt(end - 1) === 13 ? text.slice(pos, end - 1) : text.slice(pos, end);
    pos = end + 1;
    if (!line) continue;
    const r = B.splitLine(line);
    if (Math.floor(+r[ix.season]) !== season) continue;
    if (r[ix.market_type] !== 'spread') continue;
    const val = +r[ix.lines];
    if (!isFinite(val)) continue;
    const sig = r[ix.game_id] + '|' + r[ix.abbr] + '|' + r[ix.book] + '|' + val;
    if (seen.has(sig)) { dupes++; continue; }
    seen.add(sig);
    const teamId = abbrToId[String(r[ix.abbr] || '').toUpperCase()];
    if (!teamId) continue;
    let handicap = null;
    if (teamId === String(r[ix.home_team_id])) handicap = val;
    else if (teamId === String(r[ix.away_team_id])) handicap = -val;
    else continue;
    (byGame[r[ix.game_id]] = byGame[r[ix.game_id]] || []).push(handicap);
  }
  function median(a) { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; }

  /* one row per game: expected home margin = −handicap */
  const rows = [];
  for (const g of sched.games) {
    const h = byGame[String(g.game_id)];
    if (!h || !h.length) continue;
    if (!g.home_fbs || !g.away_fbs) continue;
    rows.push({ home: g.home, away: g.away, margin: -median(h), neutral: !!g.neutral });
  }
  if (rows.length < 60) {
    return { available: false, rows: rows.length,
      reason: 'only ' + rows.length + ' of this season’s FBS-vs-FBS games are in the public line archive — too few to solve a market power rating from' };
  }
  /* solve power[] and one home-field constant by alternating least squares */
  const P = {}, teams = new Set();
  for (const r of rows) { teams.add(r.home); teams.add(r.away); }
  for (const t of teams) P[t] = 0;
  let hfa = 2.5, it = 0, movement = Infinity;
  for (it = 0; it < 500 && movement > 1e-7; it++) {
    const acc = {}, cnt = {};
    for (const r of rows) {
      const h = r.neutral ? 0 : hfa;
      acc[r.home] = (acc[r.home] || 0) + (r.margin - h + P[r.away]); cnt[r.home] = (cnt[r.home] || 0) + 1;
      acc[r.away] = (acc[r.away] || 0) + (P[r.home] + h - r.margin); cnt[r.away] = (cnt[r.away] || 0) + 1;
    }
    movement = 0;
    for (const t of teams) {
      if (!cnt[t]) continue;
      const nv = acc[t] / cnt[t];
      movement = Math.max(movement, Math.abs(nv - P[t]));
      P[t] = nv;
    }
    let hs = 0, hn = 0;
    for (const r of rows) { if (r.neutral) continue; hs += r.margin - (P[r.home] - P[r.away]); hn++; }
    if (hn) hfa = hs / hn;
    /* re-centre so the market power scale means the same thing ETSR's does */
    const m = mean(Array.from(teams).map(t => P[t]));
    for (const t of teams) P[t] -= m;
  }
  return { available: true, power: P, home_field: r2(hfa), games: rows.length,
    duplicates_dropped: dupes, iterations: it, converged: movement <= 1e-7,
    basis: 'a least-squares power rating solved from the consensus closing spread of this season’s FBS-vs-FBS games, with one league home-field constant solved alongside it and the scale re-centred on zero. It is a SEPARATE measurement of the same teams and is an input to nothing.' };
}

/* --------------------------------------------------------------------------
   ONE SEASON'S PLAYER LAYER, reconstructed
   -------------------------------------------------------------------------- */
function seasonPlayerLayer(y, play, sched, roster, careerBase) {
  const teamAgg = B.teamSeasonAggregates(play.teamGames, sched.fbs);
  const metrics = {};
  for (const met of B.ADJ_METRICS) {
    const a = B.opponentAdjust(play.teamGames, sched.fbs, met);
    if (a) metrics[met.id] = a;
  }
  const norm = B.normaliseSeason(y, play, roster.cur, roster.prev, sched, { metrics, teamAgg });
  const rated = EPIR.rateSeason(norm.players, {
    coverage: B.coverageGates(play.counts, play.teamGameCount),
    leagueAllowed: norm.leagueAllowed, season: y,
    careerIndex: careerBase, params: null
  });
  const scheme = PSCHEME.buildProfiles(teamAgg.off, teamAgg.def, { season: y, rosterPositions: {} });
  const byTeam = {};
  for (const r of rated.ratings) if (r.team_key) (byTeam[r.team_key] = byTeam[r.team_key] || []).push(r);
  const prevByTeam = {};
  const units = {};
  for (const key of Object.keys(byTeam)) {
    if (!sched.fbs[key]) continue;
    const profile = scheme.teams[key] || null;
    units[key] = UNITS.rateTeam(key, sched.name[key] || key, byTeam[key],
      { teamContext: PSCHEME.unitContext(profile), season: y });
  }
  return { ratings: rated.ratings, units, scheme, byTeam };
}

/* attach returning value and transfers, which need the PREVIOUS season's
   ratings for the same team */
function attachContinuity(units, byTeam, prevByTeam, curKeys, prevSeason) {
  for (const key of Object.keys(units)) {
    const prev = prevByTeam[key] || [];
    const back = {};
    for (const r of (byTeam[key] || [])) if (r.key) back[r.key] = 1;
    units[key].returning = UNITS.returningValue(prev, back, { prior_season: prevSeason });
    const incoming = (byTeam[key] || []).filter(r => r.status === 'transfer');
    const outgoing = prev.filter(r => r.key && curKeys[r.key] && curKeys[r.key] !== key);
    units[key].transfers = UNITS.transferValue(incoming, outgoing, {});
  }
}

/* front-seven returning value, which the run-defence power score reads */
function frontReturning(unitsTeam) {
  const ret = unitsTeam && unitsTeam.returning;
  if (!ret || !ret.by_group) return null;
  const vals = [];
  for (const g of ['DL', 'EDGE', 'LB']) {
    const b = ret.by_group[g];
    if (b && b.value_returning != null) vals.push(b.value_returning);
  }
  return vals.length ? mean(vals) : null;
}

/* --------------------------------------------------------------------------
   ONE SEASON'S ETSR
   -------------------------------------------------------------------------- */
function seasonEtsr(y, unitsBySeason, perf, schemeHead, prevEtsr, leagueSlope, params) {
  const talentOut = TAL.build(unitsBySeason, {});
  const keys = Object.keys(talentOut.teams);
  const context = {};
  for (const k of keys) {
    const t = talentOut.teams[k];
    t._front_returning = frontReturning(unitsBySeason[k]);
    const p = perf.teams[k] || null;
    const cont = TAL.continuityRating(t, unitsBySeason[k]);
    const sch = schemeHead ? schemeHead[k] : null;
    context[k] = {
      talent: t, performance: p, continuity: cont,
      sample: p ? p.sample : { games: 0, fbs_equivalent_games: 0, distinct_opponents: 0 },
      scheme_confidence: sch ? (sch.confidence != null ? sch.confidence : (sch.confidence && sch.confidence.value)) : null,
      prev_etsr: prevEtsr ? prevEtsr[k] : null,
      league_slope: leagueSlope
    };
  }
  const built = ETSR.build({ keys, context, params });
  return { talent: talentOut, context, rows: built.rows, centre: built.centre, keys };
}

/* the league carryover slope, measured the way this repo already measures it:
   regress each season's ratings on the previous season's, across teams */
function measureSlope(chain) {
  const pairs = [];
  const seasons = Object.keys(chain).map(Number).sort((a, b) => a - b);
  for (let i = 1; i < seasons.length; i++) {
    const a = chain[seasons[i - 1]], b = chain[seasons[i]];
    if (!a || !b) continue;
    const xs = [], ys = [];
    for (const k of Object.keys(b)) {
      if (!isNum(a[k]) || !isNum(b[k])) continue;
      xs.push(a[k]); ys.push(b[k]);
    }
    if (xs.length < 20) { pairs.push({ from: seasons[i - 1], to: seasons[i], n: xs.length, slope: null, r2: null, reason: 'fewer than twenty teams rated in both seasons — refused rather than guessed' }); continue; }
    const mx = mean(xs), my = mean(ys);
    let sxy = 0, sxx = 0, syy = 0;
    for (let j = 0; j < xs.length; j++) { const dx = xs[j] - mx, dy = ys[j] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    if (!(sxx > 0)) { pairs.push({ from: seasons[i - 1], to: seasons[i], n: xs.length, slope: null, reason: 'no variance' }); continue; }
    pairs.push({ from: seasons[i - 1], to: seasons[i], n: xs.length,
      slope: r3(sxy / sxx), r2: r3(syy > 0 ? (sxy * sxy) / (sxx * syy) : null) });
  }
  const usable = pairs.filter(p => isNum(p.slope));
  const recent = usable.slice(-3);
  return { pairs, value: recent.length ? r3(mean(recent.map(p => p.slope))) : null,
    measured: recent.length > 0, used_pairs: recent.length,
    trend: usable.length >= 2 ? r3(usable[usable.length - 1].slope - usable[0].slope) : null,
    basis: 'each consecutive pair of seasons is regressed team-on-team and the mean of the most recent pairs is the league slope. When last season stops predicting this one, this number falls on its own — nobody edits a constant. It is the portal/NIL argument answered with arithmetic.' };
}

/* -------------------------------------------------------------------------- */
async function main() {
  const startedAt = new Date().toISOString();
  const seasons = [];
  for (let y = SEASON - SEASONS_BACK + 1; y <= SEASON; y++) seasons.push(y);
  log(`EdgeDesk national rankings build — seasons ${seasons[0]}..${SEASON}`);

  /* ---- the player artifact is the contract this build stands on ---- */
  const playersCur = readJson(path.join(PLAYERS_DIR, 'current.json'), null);
  if (!playersCur) { console.error('football/players/current.json is missing — run the player build first'); return 1; }
  if (playersCur.season !== SEASON) {
    console.error(`the committed player artifact is season ${playersCur.season} but this build is season ${SEASON}. Refusing to mix seasons.`);
    return 1;
  }
  log(`  player artifact: season ${playersCur.season} week ${playersCur.week}, ${playersCur.player_count} players, built ${String(playersCur.generated_at).slice(0, 10)}`);

  /* ---- load ---- */
  const sched = {}, roster = {}, play = {};
  for (const y of seasons) sched[y] = await B.loadSchedule(y);
  for (const y of seasons.concat([seasons[0] - 1])) roster[y] = await B.loadRoster(y);
  for (const y of seasons) {
    const t0 = Date.now();
    play[y] = await B.loadPlays(y, sched[y]);
    log(`  ${y}: ${play[y].counts.plays} plays, ${play[y].teamGameCount} team-games (${Date.now() - t0}ms)`);
  }

  /* ---- per-season player layer, walked forward so nothing sees its future -- */
  const careerBase = {};
  const layers = {}, perfBySeason = {};
  for (const y of seasons) {
    const career = {};
    for (const k of Object.keys(careerBase)) {
      const rowsK = careerBase[k].filter(r => r.season < y);
      if (rowsK.length) career[k] = rowsK;
    }
    layers[y] = seasonPlayerLayer(y, play[y], sched[y], { cur: roster[y], prev: roster[y - 1] || null }, career);
    for (const r of layers[y].ratings) {
      if (!r.key) continue;
      (careerBase[r.key] = careerBase[r.key] || []).push({ season: y, z: r.components.quality.z_raw, n: r.sample_size, dc: r.data_completeness });
    }
    perfBySeason[y] = PERF.build(play[y].teamGames, { fbs: sched[y].fbs });
    log(`  ${y}: ${Object.keys(layers[y].units).length} team unit records, performance converged: ${perfBySeason[y].diagnostics.all_converged}`);
  }
  /* continuity needs the previous season's ratings for the same team */
  for (let i = 0; i < seasons.length; i++) {
    const y = seasons[i], prevY = seasons[i - 1];
    const curKeys = {};
    for (const r of layers[y].ratings) if (r.key) curKeys[r.key] = r.team_key;
    attachContinuity(layers[y].units, layers[y].byTeam, prevY ? layers[prevY].byTeam : {}, curKeys, prevY || null);
  }

  /* ---- the ETSR chain, oldest season first ---- */
  const params = readJson(OUT_PARAMS.replace(/\.js$/, '.json'), null) || tryParams();
  const chain = {}, seasonBuilds = {};
  let slope = { value: null, measured: false, pairs: [], basis: 'not yet measured on the first pass' };
  for (const y of seasons) {
    const prev = chain[y - 1] || null;
    const built = seasonEtsr(y, layers[y].units, perfBySeason[y], null, prev, slope.value, params);
    seasonBuilds[y] = built;
    chain[y] = {};
    for (const k of built.keys) if (built.rows[k].available) chain[y][k] = built.rows[k].etsr;
    slope = measureSlope(chain);
  }
  /* a second pass, now that the slope has been measured from the chain itself */
  const finalSlope = measureSlope(chain);
  log(`  league carryover slope: ${finalSlope.value == null ? 'not measurable' : finalSlope.value} over ${finalSlope.used_pairs} recent season pairs`);
  for (const y of seasons) {
    const prev = chain[y - 1] || null;
    seasonBuilds[y] = seasonEtsr(y, layers[y].units, perfBySeason[y], null, prev, finalSlope.value, params);
    chain[y] = {};
    for (const k of seasonBuilds[y].keys) if (seasonBuilds[y].rows[k].available) chain[y][k] = seasonBuilds[y].rows[k].etsr;
  }

  /* ---- THIS season, using the COMMITTED player artifact for talent ---- */
  const cur = SEASON;
  const curUnits = {};
  for (const k of Object.keys(playersCur.teams)) curUnits[k] = playersCur.teams[k];
  const curTalent = TAL.build(curUnits, {});
  for (const k of Object.keys(curTalent.teams)) curTalent.teams[k]._front_returning = frontReturningFromSummary(playersCur.teams[k]);

  const perf = perfBySeason[cur];
  const schemeHead = playersCur.scheme || {};
  const context = {};
  for (const k of Object.keys(curTalent.teams)) {
    const t = curTalent.teams[k];
    const p = perf.teams[k] || null;
    const sh = schemeHead[k] || null;
    context[k] = {
      talent: t, performance: p,
      continuity: TAL.continuityRating(t, playersCur.teams[k]),
      sample: p ? p.sample : { games: 0, fbs_equivalent_games: 0, distinct_opponents: 0, non_fbs_share: null },
      scheme_confidence: sh ? sh.confidence : null,
      prev_etsr: chain[cur - 1] ? chain[cur - 1][k] : null,
      league_slope: finalSlope.value
    };
  }
  const built = ETSR.build({ keys: Object.keys(curTalent.teams), context, params });

  /* ---- assemble the team records ---- */
  const week = resolveWeek(sched[cur]);
  const market = await marketPower(cur, sched[cur], CACHE);
  const overrides = readJson(OVERRIDES, { overrides: [] });
  const teams = {};
  for (const k of Object.keys(built.rows)) {
    const row = built.rows[k], t = curTalent.teams[k], p = perf.teams[k] || null;
    const rdp = ETSR.runDefencePower(t, p);
    const cont = context[k].continuity;
    const align = TAL.alignment(t, schemeHead[k] ? { offense: schemeHead[k].offense, defense: schemeHead[k].defense } : null);
    const oppDeltas = [];
    if (p) for (const m of (p.offense.used || []).concat(p.defense.used || [])) if (isNum(m.delta)) oppDeltas.push(Math.abs(m.delta / (m.league || 1)));
    teams[k] = {
      key: k, team: (playersCur.teams[k] && playersCur.teams[k].team) || sched[cur].name[k] || k,
      conference: (playersCur.teams[k] && playersCur.teams[k].conference) || sched[cur].conf[k] || null,
      etsr: row.etsr, etsr_raw: row.etsr_raw, available: row.available,
      weights: row.weights, prior: row.prior,
      performance_points: row.performance_points, talent_points: row.talent_points,
      scalars: row.scalars, confidence: row.confidence, gates: row.gates,
      home_field: row.home_field,
      talent: {
        rating: t.rating, components: t.components, missing: t.missing,
        starter_quality: t.starter_quality, rotation_quality: t.rotation_quality,
        depth_quality: t.depth_quality, missing_units: t.missing_units,
        returning: t.returning, transfers: t.transfers, availability: t.availability,
        recruiting: t.recruiting, smoothing: t.smoothing,
        may_move: t.may_move, may_not_move: t.may_not_move
      },
      units: unitRatings(t),
      performance: p ? {
        rating: p.rating, net_z: r3(p.net_z),
        offense: p.offense.rating, defense: p.defense.rating,
        run_offense: p.sub_units.run_offense.rating, pass_offense: p.sub_units.pass_offense.rating,
        run_defense: p.sub_units.run_defense.rating, pass_defense: p.sub_units.pass_defense.rating,
        opponent_delta: r3(oppDeltas.length ? mean(oppDeltas) : null),
        offense_detail: { used: p.offense.used, missing: p.offense.missing, scored: p.offense.scored, contract: p.offense.contract },
        defense_detail: { used: p.defense.used, missing: p.defense.missing, scored: p.defense.scored, contract: p.defense.contract },
        sub_units: p.sub_units, sample: p.sample
      } : { rating: null, available: false, reason: 'this team has produced no attributed play this season' },
      depth: { rating: t.depth_quality, basis: 'position-value weighted depth quality behind the projected starters' },
      continuity: { rating: isNum(cont.value) ? r1(50 + 12 * ((cont.value - 0.5) / 0.18)) : null,
        raw: r3(cont.value), components: cont.components, missing: cont.missing, coordinator: cont.coordinator,
        basis: 'returning production VALUE, quarterback and line continuity, returning starters and transfer churn, on the same 0-100 scale as every other rating here' },
      scheme_fit: { rating: align.available ? r1(50 + 12 * clampZ(align.value)) : null,
        raw: r3(align.value), available: align.available, reason: align.reason,
        pairs: align.pairs, basis: align.basis },
      availability: { rating: t.availability.rating, out_share: t.availability.out_share,
        unknown_share: t.availability.unknown_share, records: t.availability.records,
        basis: t.availability.basis },
      run_defence_power: rdp,
      market: ETSR.marketCompare(row.etsr, market.available ? market.power[k] : null)
    };
  }
  function clampZ(v) { return Math.max(-3, Math.min(3, v == null ? 0 : v)); }

  /* ---- ranks ---- */
  const ranks = ETSR.rankAll(teams);
  for (const k of Object.keys(teams)) {
    teams[k].rank = ranks.overall.ranks[k] ? ranks.overall.ranks[k].rank : null;
    teams[k].ranks = {};
    for (const cat of Object.keys(ranks)) {
      const r = ranks[cat].ranks[k];
      teams[k].ranks[cat] = r ? { rank: r.rank, value: r.value, unranked: !!r.unranked, reason: r.reason || null } : null;
    }
    teams[k].achievement = ETSR.achievement(k, ranks);
    teams[k].why = ETSR.why(k, teams, ranks, { team_count: Object.keys(teams).length });
  }

  /* ---- movement against the last snapshot, and stability ---- */
  const prevSnap = latestSnapshotBefore(SEASON, week.ordinal);
  const prevTeams = prevSnap ? prevSnap.teams : null;
  for (const k of Object.keys(teams)) {
    teams[k].movement = ETSR.movement(teams[k], prevTeams ? prevTeams[k] : null);
  }
  const stab = ETSR.stability(teams, prevTeams);

  /* ---- anomalies. A SEVERE one refuses to publish. ---- */
  const expected = Object.keys(sched[cur].fbs);
  const anom = ETSR.anomalies(teams, prevTeams, {
    expected_teams: expected, stability: stab,
    missing_snapshot: missingSnapshotCheck(SEASON, week.ordinal, sched[cur])
  });
  log(`  anomalies: ${anom.severe} severe, ${anom.warn} warnings`);
  for (const a of anom.list.filter(x => x.severity === 'severe').slice(0, 12)) log(`    SEVERE ${a.id} ${a.team || ''} — ${a.detail}`);
  if (anom.severe > 0 && !ALLOW_ANOM) {
    console.error(`\nREFUSING TO PUBLISH: ${anom.severe} severe anomalies. Fix the input or pass --allow-anomalies deliberately.`);
    if (!DRY) return 1;
  }

  /* ---- write ---- */
  const manifest = {
    schema: 'edgedesk_national_rankings_v1',
    schema_version: CFG.SCHEMA_VERSION,
    versions: Object.assign({}, CFG.VERSIONS, {
      player_rating: playersCur.versions ? playersCur.versions.player_rating : null,
      scheme_matchup: playersCur.versions ? playersCur.versions.scheme_matchup : null,
      simulation: playersCur.versions ? playersCur.versions.simulation : null
    }),
    season: cur, week: week.week, week_ordinal: week.ordinal, week_label: week.label,
    season_type: week.season_type, week_basis: week.basis,
    data_as_of: startedAt, generated_at: startedAt,
    built_on: {
      player_artifact: { season: playersCur.season, week: playersCur.week,
        generated_at: playersCur.generated_at, digest: playersCur.digest,
        player_count: playersCur.player_count },
      seasons_read: seasons,
      note: 'this season’s talent is read from the committed player artifact; earlier seasons are reconstructed here from the same modules so the prior-season chain exists at all'
    },
    team_count: Object.keys(teams).length,
    carryover: finalSlope,
    centre: built.centre, centre_basis: built.centre_basis,
    market: market.available
      ? { available: true, games: market.games, home_field: market.home_field, iterations: market.iterations,
          converged: market.converged, duplicates_dropped: market.duplicates_dropped, basis: market.basis, is_input: false }
      : { available: false, reason: market.reason, is_input: false },
    performance_diagnostics: perf.diagnostics,
    stability: stab,
    anomalies: anom,
    overrides: { count: (overrides.overrides || []).length, policy: CFG.OVERRIDES,
      entries: (overrides.overrides || []) },
    ranks: rankSummary(ranks),
    teams: teams,
    notes: [
      'ETSR is a NEUTRAL-FIELD number in points against an average FBS team. Home field, travel, rest, injuries, the quarterback and the scheme matchup are applied by the matchup layer to produce a game line — none of them is in this rating.',
      'TALENT and PERFORMANCE are separate ratings and are ranked separately. The gap between them is one of the more useful things on this board and is never averaged away.',
      'The market is a column, never an input. No number in this file was derived from a betting line.',
      'No language model produced, adjusted, ranked or explained any rating here. Movement is differenced from component snapshots; "why" is assembled from component ranks.',
      'A missing input lowers CONFIDENCE and never silently moves a rating.'
    ]
  };
  manifest.digest = digestOf({ t: Object.keys(teams).map(k => [k, teams[k].etsr]), w: week.ordinal, s: cur });

  if (DRY) {
    log('\ndry run — nothing written');
    printTop(teams, 15);
    return anom.severe > 0 && !ALLOW_ANOM ? 1 : 0;
  }

  fs.mkdirSync(OUT_SNAP, { recursive: true });
  writeIfChanged(OUT_CUR, JSON.stringify(manifest));

  /* POINT-IN-TIME. The current week is refreshed as its games land; an earlier
     week is finished and is never rewritten. */
  const snapName = `${cur}-w${String(week.ordinal).padStart(2, '0')}.json`;
  const snapTeams = {};
  for (const k of Object.keys(teams)) {
    const t = teams[k];
    snapTeams[k] = {
      etsr: t.etsr, rank: t.rank, confidence: t.confidence.value,
      talent: { rating: t.talent.rating }, weights: { performance: t.weights.performance },
      performance: { rating: t.performance.rating, offense: t.performance.offense, defense: t.performance.defense,
        run_offense: t.performance.run_offense, pass_offense: t.performance.pass_offense,
        run_defense: t.performance.run_defense, pass_defense: t.performance.pass_defense,
        opponent_delta: t.performance.opponent_delta },
      run_defence_power: { score: t.run_defence_power.score },
      availability: { rating: t.availability.rating },
      ranks: t.ranks, gates: t.gates.map(g => g.id)
    };
  }
  fs.writeFileSync(path.join(OUT_SNAP, snapName), JSON.stringify({
    schema: 'edgedesk_rankings_snapshot_v1',
    season: cur, week: week.week, week_ordinal: week.ordinal, week_label: week.label,
    season_type: week.season_type,
    versions: manifest.versions, schema_version: CFG.SCHEMA_VERSION,
    data_as_of: startedAt, generated_at: startedAt, digest: manifest.digest,
    carryover: finalSlope, centre: built.centre,
    team_count: Object.keys(snapTeams).length,
    teams: snapTeams
  }));
  log(`  snapshot written: ${snapName}`);

  writeIfChanged(OUT_PARAMS, paramsFile(params, finalSlope, startedAt));
  printTop(teams, 15);
  log(`\ndone — ${Object.keys(teams).length} teams, season ${cur} ${week.label}`);
  return 0;
}

function frontReturningFromSummary(summary) {
  const ret = summary && summary.returning;
  if (!ret || !ret.by_group) return null;
  const vals = [];
  for (const g of ['DL', 'EDGE', 'LB']) {
    const b = ret.by_group[g];
    if (b && b.value_returning != null) vals.push(b.value_returning);
  }
  return vals.length ? mean(vals) : null;
}
function unitRatings(t) {
  const out = {};
  for (const name of Object.keys(t.units)) {
    const u = t.units[name];
    out[name] = u.available
      ? { rating: u.rating, confidence: u.confidence, starter_quality: u.starter_quality,
          depth_quality: u.depth_quality, continuity: u.continuity, experience: u.experience,
          roster_size: u.roster_size, spellings: u.spellings_found }
      : { rating: null, available: false, reason: u.reason };
  }
  return out;
}
function rankSummary(ranks) {
  const out = {};
  for (const k of Object.keys(ranks)) out[k] = { ranked: ranks[k].ranked, listed: ranks[k].listed };
  return out;
}
function latestSnapshotBefore(season, ordinal) {
  if (!fs.existsSync(OUT_SNAP)) return null;
  const files = fs.readdirSync(OUT_SNAP).filter(f => /^\d{4}-w\d{2}\.json$/.test(f));
  let best = null;
  for (const f of files) {
    const m = f.match(/^(\d{4})-w(\d{2})\.json$/);
    const s = +m[1], o = +m[2];
    if (s > season || (s === season && o >= ordinal)) continue;
    if (!best || s > best.s || (s === best.s && o > best.o)) best = { s, o, f };
  }
  return best ? readJson(path.join(OUT_SNAP, best.f), null) : null;
}
function missingSnapshotCheck(season, ordinal, sched) {
  if (!fs.existsSync(OUT_SNAP)) return null;
  const have = new Set(fs.readdirSync(OUT_SNAP)
    .map(f => f.match(/^(\d{4})-w(\d{2})\.json$/)).filter(Boolean)
    .filter(m => +m[1] === season).map(m => +m[2]));
  const completed = new Set();
  for (const g of sched.games) if (g.completed && g.home_points != null) completed.add(weekOrdinal(g.season_type, g.week));
  const gaps = [...completed].filter(o => o < ordinal && !have.has(o)).sort((a, b) => a - b);
  /* only weeks AFTER the first snapshot on file count as gaps: the system did
     not exist before then, and demanding history it never had is a false alarm */
  if (!have.size || !gaps.length) return null;
  const first = Math.min(...have);
  const real = gaps.filter(o => o > first);
  return real.length ? `no snapshot on file for completed week ordinal(s) ${real.join(', ')}` : null;
}
function printTop(teams, n) {
  const list = Object.values(teams).filter(t => isNum(t.etsr) && isNum(t.rank)).sort((a, b) => a.rank - b.rank);
  log('\n  ' + 'RK'.padStart(3) + '  ' + 'TEAM'.padEnd(22) + 'ETSR'.padStart(7) + '  TAL'.padStart(6) + '  PERF'.padStart(6) + '  CONF'.padStart(6) + '  RUN D');
  for (const t of list.slice(0, n)) {
    log('  ' + String(t.rank).padStart(3) + '  ' + String(t.team).slice(0, 21).padEnd(22)
      + (t.etsr > 0 ? '+' : '') + String(t.etsr).padStart(6)
      + String(t.talent.rating == null ? '—' : t.talent.rating).padStart(7)
      + String(t.performance.rating == null ? '—' : t.performance.rating).padStart(7)
      + String(Math.round(t.confidence.value * 100) + '%').padStart(7)
      + '  ' + String(t.run_defence_power.score == null ? '—' : t.run_defence_power.score));
  }
}
function tryParams() {
  try { return require(OUT_PARAMS); } catch (_) { return null; }
}
function paramsFile(prior, slope, at) {
  const cal = (prior && prior.calibration) || {
    measured: false,
    talent_points_per_z: { value: null, points_applied: false,
      reason: 'football/rankings/validate_rankings.js has not been run against this build, so no scalar is fitted and the declared fallback in config.js is used' },
    performance_points_per_z: { value: null, points_applied: false,
      reason: 'as above' },
    prior_ramp_k: { value: null, reason: 'as above' }
  };
  const val = (prior && prior.validation_summary) || { ran: false, reason: 'no walk-forward validation has been run against this build' };
  const out = {
    schema: 'edgedesk_rankings_params_v1',
    generated_at: at,
    versions: CFG.VERSIONS, schema_version: CFG.SCHEMA_VERSION,
    league_carryover: slope,
    calibration: cal,
    validation_summary: val
  };
  return `if(typeof window==='undefined'){globalThis.window=globalThis;}
/* EdgeDesk National Rankings — MEASURED constants.
   GENERATED FILE. The league carryover slope is re-measured on every build from
   the rating chain itself. The points-per-z scalars and the prior ramp are
   fitted ONLY by football/rankings/validate_rankings.js, and a build preserves
   whatever that wrote rather than quietly refitting on a schedule — which is
   how a research layer starts fitting the recent past without anyone deciding
   to. Weights and contracts live in config.js; nothing here is hand-edited. */
window.EDRankParams = ${JSON.stringify(out)};
if(typeof module!=='undefined'&&module.exports)module.exports=window.EDRankParams;
`;
}
function writeIfChanged(file, text) {
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch (_) {}
  const strip = s => String(s).replace(/"(generated_at|data_as_of)":"[^"]*"/g, '');
  if (old != null && strip(old) === strip(text)) return false;
  fs.writeFileSync(file, text);
  return true;
}

module.exports = { main, weekOrdinal, weekLabel, resolveWeek, measureSlope, marketPower,
  seasonPlayerLayer, seasonEtsr, attachContinuity, frontReturning, latestSnapshotBefore,
  missingSnapshotCheck, POSTSEASON_OFFSET };

if (require.main === module) {
  main().then(c => process.exit(c)).catch(e => { console.error('RANKINGS BUILD FAILED:', e && e.stack || e); process.exit(1); });
}
