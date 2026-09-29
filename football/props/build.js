#!/usr/bin/env node
/* ===========================================================================
   PLAYER PROPS BUILD — project the upcoming slate and publish the board.
   docs/player-props/ARCHITECTURE.md · docs/runbooks/player-props.md

     node football/props/build.js [--league nfl|cfb|all] [--now ISO]
                                  [--sims N] [--offline] [--dry]
     node football/props/build.js --reprice [--league …] [--now ISO] [--dry]
                                  the committed model against the latest
                                  capture, without re-simulating (reprice())

   NFL  the games in football/nfl/slate.json (EdgeDesk's own game model:
        fair margin, fair total, its margin sigma, the starting QBs, the
        forecast) inside the window; the player layer from nflverse.
   CFB  football/props/cfb_build.js (same engine, same board, stricter
        reliability; see docs/player-props/CFB.md).

   WRITES (only when content changed; git history keeps every version,
   which is the immutable archive of every projection ever published)
     football/props/<league>/board.json         the evaluated board
     football/props/<league>/games/<id>.json     one research file per game
     football/props/<league>/players.json        the durable id registry
     football/props/<league>/player_logs.json    recent games for player pages
     football/props/current.json                 the index every surface reads
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('../../lib/edgedesk_props.js');
const { writeIfChanged } = require('../../tools/football/write_if_changed.js');
const D = require('./nfl_data.js');
const M = require('./model.js');
const PR = require('./priors.js');
const PJ = require('./project.js');
const A = require('./assemble.js');
const REG = require('./registry.js');

const ROOT = path.join(__dirname, '..', '..');
const OUT = __dirname;
const WINDOW_DAYS = 8;

function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : dflt; }
function flag(name) { return process.argv.includes('--' + name); }
function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return dflt; } }

/* the game environment: EdgeDesk's own NFL model first */
function nflEnv(sg, g, data, asOf, lg) {
  if (sg && sg.model_status === 'PREDICTED' && typeof sg.model_home_margin === 'number' && typeof sg.model_fair_total === 'number') {
    const T = sg.model_fair_total, Mg = sg.model_home_margin;
    return { source: 'edgedesk_model', model_version: sg.model_version || null, detail: 'EdgeDesk NFL game model (' + (sg.model_version || 'football/nfl/slate.json') + ')',
      margin: Mg, total: T, home_points: (T + Mg) / 2, away_points: (T - Mg) / 2, margin_sd: (sg.outcome_range && sg.outcome_range.sigma) || lg.env.margin_sd, total_sd: lg.env.total_sd };
  }
  if (sg && sg.reference_market && typeof sg.reference_market.home_line === 'number' && typeof sg.reference_market.total === 'number') {
    const T = sg.reference_market.total, Mg = -sg.reference_market.home_line;
    return { source: 'market_reference', detail: sg.reference_market.source || 'reference market', margin: Mg, total: T, home_points: (T + Mg) / 2, away_points: (T - Mg) / 2, margin_sd: lg.env.margin_sd, total_sd: lg.env.total_sd };
  }
  const e = M.leakFreeEnv(data, g, asOf, g.season, lg.hfa);
  return { source: 'points_history', detail: 'EdgeDesk points history (no game-model number for this game)', margin: e.margin, total: e.total, home_points: e.home_points, away_points: e.away_points, margin_sd: lg.env.margin_sd, total_sd: lg.env.total_sd };
}
/* weather enters the model only through the windy-game factor (wind ≥ 15
   mph); the forecast is reported, and bucketed so hourly refreshes of a
   calm forecast change nothing */
function nflWeather(sg, g) {
  const roof = (sg && sg.roof) || g.roof;
  const indoor = roof === 'dome' || roof === 'closed';
  const f = sg && sg.forecast;
  if (indoor) return { known: true, outdoor: false, roof, wind_mph: null, temp_f: null, source: 'roof' };
  if (f && typeof f.wind_mph === 'number') return { known: true, outdoor: true, roof, wind_mph: f.wind_mph >= 15 ? Math.round(f.wind_mph) : null, windy: f.wind_mph >= 15, source: f.source || 'forecast' };
  return { known: false, outdoor: true, roof, wind_mph: null, source: null };
}

async function buildNfl(now, opts) {
  const slate = readJson(path.join(ROOT, 'football', 'nfl', 'slate.json'), null);
  const season = slate && slate.season ? slate.season : new Date(now).getUTCFullYear();
  const data = await D.load({ seasons: [season - 1, season], offline: opts.offline });
  const lg = PR.priorsAsOf(data, now, season, D.poolsAsOf);
  const reg = REG.load('NFL');
  const nowIso = new Date(now).toISOString();
  /* the registry grows with everyone seen this season and last */
  const lastTeam = new Map();
  data.playerGames.filter((x) => x.season >= season - 1).sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff)).forEach((x) => lastTeam.set(x.gsis, { team: x.team, at: x.kickoff, pos: x.pos, name: x.name }));
  for (const [team, list] of data.depth) { const snap = D.depthAsOf(data.depth, team, now); if (snap) ['QB', 'RB', 'WR', 'TE'].forEach((p) => snap.ranks[p].forEach((e) => { const cur = lastTeam.get(e.g); if (!cur || Date.parse(cur.at) < snap.dt) lastTeam.set(e.g, { team, at: new Date(snap.dt).toISOString(), pos: p, name: cur ? cur.name : null }); })); }
  for (const [g, v] of lastTeam) {
    const pl = data.players.get(g) || {};
    REG.upsert(reg, 'NFL', g, { name: pl.name || v.name, position: pl.pos_group || v.pos, team: v.team, status: pl.status, headshot: pl.headshot, jersey: pl.jersey, college: pl.college, birth_date: pl.birth_date, rookie_season: pl.rookie_season,
      ids: { espn: pl.espn_id, pfr: pl.pfr_id, pff: pl.pff_id, nfl: pl.nfl_id, esb: pl.esb_id, smart: pl.smart_id, otc: pl.otc_id } }, v.at ? v.at.slice(0, 10) : null);
  }
  const idOf = (gsis) => reg.by_anchor[gsis] || REG.upsert(reg, 'NFL', gsis, { name: (data.players.get(gsis) || {}).name }, nowIso);
  /* the games inside the window, from EdgeDesk's own slate */
  const games = [];
  const sgames = (slate && slate.games) || [];
  sgames.forEach((sg) => {
    const ko = Date.parse(sg.kickoff);
    if (!(ko > now) || ko > now + WINDOW_DAYS * 864e5) return;
    const g = data.games.get(sg.game_id);
    if (g) games.push({ sg, g });
  });
  const starters = readJson(path.join(ROOT, 'football', 'starters', 'nfl_' + season + '.json'), null);
  /* the per-prop calibration fitted by the walk-forward validation (identity when absent) */
  const calibration = readJson(path.join(OUT, 'nfl', 'calibration.json'), null);
  const projected = [];
  for (const { sg, g } of games) {
    const env = quantise(nflEnv(sg, g, data, now, lg));
    const weather = nflWeather(sg, g);
    const st = { home: sg.home_starter && sg.home_starter.player_id || null, away: sg.away_starter && sg.away_starter.player_id || null };
    const qbUnres = {};
    ['home', 'away'].forEach((side) => {
      const team = g[side], id = st[side];
      if (!id) { qbUnres[side] = true; return; }
      const av = M.availability(data, g.season, g.week, team, id, lg, now);
      const sf = starters && starters.teams ? starters.teams[team.toLowerCase()] : null;
      qbUnres[side] = av.status !== 'ACTIVE' || !!(sf && sf.competition && sf.competition.contested);
    });
    const out = PJ.projectGame(data, { league: 'NFL', game: g, asOfMs: now, season: g.season, lg, env, weather, starters: st, qb_unresolved: qbUnres, sims: opts.sims, idOf, calibration });
    out.kickoff = g.kickoff;
    relevant(out, opts.market_keys);
    projected.push(out);
    console.log('  ' + g.game_id + ': ' + out.records.length + ' projections (' + out.sim_ms + ' ms, environment ' + env.source + ')');
  }
  return { league: 'NFL', season, week: games.length ? games[0].g.week : null, data, lg, reg, projected, sources: data.sources, gaps: data.gaps, player_logs: playerLogs(data, projected, reg, season) };
}

/* the environment rounded to a quarter point (sigma to a tenth): an
   upstream re-run that moves the game model by a few hundredths does not
   re-simulate — or rewrite — a single distribution */
function quantise(env) {
  const q = (x, u) => (typeof x === 'number' ? Math.round(x / u) * u : x);
  const o = Object.assign({}, env, { margin: q(env.margin, 0.25), total: q(env.total, 0.25), margin_sd: q(env.margin_sd, 0.1), total_sd: q(env.total_sd, 0.1) });
  o.home_points = (o.total + o.margin) / 2; o.away_points = (o.total - o.margin) / 2;
  return o;
}
/* the players a board publishes: the starting QB and every player with a
   real role (target share ≥ 6% or carry share ≥ 10%), plus anyone a
   sportsbook actually quotes. Everyone else is still simulated — the team's
   volume and the redistribution need them — but not listed. */
const RELEVANT = { NFL: { tgt: 0.06, car: 0.10, longest: true }, CFB: { tgt: 0.10, car: 0.15, longest: false } };
function relevant(out, marketKeys) {
  const RL = RELEVANT[out.league] || RELEVANT.NFL;
  const keep = (p) => {
    const o = p.opportunity || {};
    if (marketKeys && marketKeys.has(p.game_id + '|' + p.player_id + '|' + p.prop_type)) return true;
    if (!RL.longest && /^longest_/.test(p.prop_type)) return false;
    if (p.position === 'QB') return true;
    if (p.status === 'PLAYER_OUT') return false;
    return (o.target_share || 0) >= RL.tgt || (o.carry_share || 0) >= RL.car;
  };
  /* an OUT player has no opportunity panel: keep him when he was a starter */
  out.records = out.records.filter((p) => keep(p) || (p.status === 'PLAYER_OUT' && (p.availability || {}).status === 'OUT' && isStarterOut(out, p)));
}
function isStarterOut(out, p) {
  const t = out.teams[p.home_away];
  return !!(t && t.redistribution || []).some((d) => d.status === 'OUT' && (d.player_id === (p.provider_ids && p.provider_ids.gsis)) && d.share >= 0.06);
}

/* recent games for the player pages (only players on the board) */
function playerLogs(data, projected, reg, season) {
  const ids = new Set();
  projected.forEach((g) => g.records.forEach((p) => { const a = p.provider_ids && (p.provider_ids.gsis || p.provider_ids.espn); if (a) ids.add(a); }));
  const ix = M.index(data);
  const out = {};
  ids.forEach((g) => {
    const rows = (ix.byPlayer.get(g) || []).filter((x) => x.season >= season - 1).slice(0, 12);
    const id = reg.by_anchor[g];
    if (!id) return;
    const cur = rows.filter((x) => x.season === season);
    const avg = (f) => (cur.length ? Math.round(cur.reduce((t, x) => t + f(x), 0) / cur.length * 10) / 10 : null);
    out[id] = { gsis: g, cols: ['season', 'week', 'team', 'opp', 'snap_pct', 'tgt', 'rec', 'rec_yds', 'rec_td', 'car', 'rush_yds', 'rush_td', 'att', 'cmp', 'pass_yds', 'pass_td', 'int', 'rz_tgt', 'rz_car', 'long_rec', 'long_rush'],
      games: rows.map((x) => [x.season, x.week, x.team, x.opp, x.snap_pct, x.tgt, x.rec, x.rec_yds, x.rec_td, x.car, x.rush_yds, x.rush_td, x.att, x.cmp, x.pass_yds, x.pass_td, x.int, x.rz_tgt, x.rz_car, x.long_rec, x.long_rush]),
      season_avg: { games: cur.length, tgt: avg((x) => x.tgt), rec: avg((x) => x.rec), rec_yds: avg((x) => x.rec_yds), car: avg((x) => x.car), rush_yds: avg((x) => x.rush_yds), att: avg((x) => x.att), cmp: avg((x) => x.cmp), pass_yds: avg((x) => x.pass_yds), snap_pct: avg((x) => x.snap_pct || 0) } };
  });
  return out;
}

/* publish one league */
function publish(res, now, opts) {
  const L = res.league.toLowerCase();
  const dir = path.join(OUT, L);
  const validation = readJson(path.join(dir, 'validation.json'), null);
  const record = readJson(path.join(ROOT, 'record', 'props', L + '_' + res.season + '.json'), null);
  const market = require('./capture.js').loadMarket(res.league, res.projected.map((g) => g.game_id));
  const stages = A.stageTable(validation, record && record.scorecards);
  const asm = A.assemble({ league: res.league, now, games: res.projected, market, stages, record: record && record.scorecards });
  const nowIso = new Date(now).toISOString();
  const written = [];
  const counts = { projections: asm.rows.length, projected: asm.rows.filter((x) => !x.status).length, with_market: asm.rows.filter((x) => x.mkt).length };
  ['BET', 'LEAN', 'WATCH', 'PASS', 'NO_DECISION'].forEach((k) => { counts[k] = asm.rows.filter((x) => (x.dec ? x.dec.cls : 'NO_DECISION') === k).length; });
  const board = { schema: 'edgedesk_props_board_v1', league: res.league, season: res.season, week: res.week, generated_at: nowIso, as_of: nowIso,
    model_version: PJ.MODEL_VERSION[res.league], feature_version: PJ.FEATURE_VERSION[res.league], props_version: P.VERSION, config_version: P.CONFIG_VERSION, sims: opts.sims,
    market_captured_at: market.captured_at || null, market_note: market.captured_at ? null : 'No sportsbook prop capture on file yet: projections, fair lines and fair odds are shown without prices (PROJECTION ONLY). EdgeDesk never invents a price.',
    counts, stages, cv_norm: asm.cvNorm, calibration: asm.calibration, gaps: res.gaps, sources: res.sources.map((s) => ({ url: s.url, bytes: s.bytes || null, error: s.error || null })), unmapped: (market.unmapped || []).slice(0, 200),
    priors: PR.publishable(res.lg),
    row_cols: { proj: ['mean', 'median', 'sd', 'p10', 'p25', 'p75', 'p90'], avail: ['status', 'p_active'], at_line: ['p_over', 'p_under', 'fair_over', 'fair_under', 'fair_minus_line'], bo: ['book', 'price', 'line'] },
    games: res.projected.map((g) => ({ game_id: g.game_id, kickoff: g.kickoff, home: g.teams.home.team, away: g.teams.away.team, home_name: g.teams.home.name || null, away_name: g.teams.away.name || null, environment: g.environment, props: g.records.length })),
    rows: asm.rows };
  if (!opts.dry) {
    written.push([path.join(dir, 'board.json'), writeIfChanged(path.join(dir, 'board.json'), board)]);
    asm.gameFiles.forEach((gf) => { const f = path.join(dir, 'games', gf.game_id + '.json'); written.push([f, writeIfChanged(f, gf)]); });
    written.push([REG.file(res.league), REG.save(res.reg, writeIfChanged)]);
    const onBoard = new Set(asm.rows.map((x) => x.pid));
    const idx = {};
    onBoard.forEach((id) => { const p = res.reg.players[id]; if (p) idx[id] = [p.name, p.slug, p.position, p.team, p.headshot || null, p.ids.espn || null, p.jersey || null]; });
    written.push([path.join(dir, 'players_index.json'), writeIfChanged(path.join(dir, 'players_index.json'), { schema: 'edgedesk_player_index_v1', league: res.league, generated_at: nowIso, cols: ['name', 'slug', 'position', 'team', 'headshot', 'espn_id', 'jersey'], players: idx })]);
    written.push([path.join(dir, 'player_logs.json'), writeIfChanged(path.join(dir, 'player_logs.json'), { schema: 'edgedesk_player_logs_v1', league: res.league, season: res.season, generated_at: nowIso, players: res.player_logs })]);
  }
  return { board, asm, written };
}

/* RE-PRICE WITHOUT RE-SIMULATING. The capture runs more often than the
   model needs to (every 45 minutes near kickoff); a moved price re-evaluates
   every EV, decision, freshness state and exposure cap against the committed
   game files — the same distributions, byte for byte — through the same
   assemble() the build runs. opts: { board, gameFiles: {gid: file}, market,
   record, dry } override what is read from disk (the tests pass them all). */
function reprice(league, now, opts) {
  opts = opts || {};
  const L = league.toLowerCase(), dir = path.join(OUT, L);
  const prev = opts.board || readJson(path.join(dir, 'board.json'), null);
  if (!prev) throw new Error('no ' + L.toUpperCase() + ' board to re-price: run the build first');
  const games = (prev.games || []).map((bg) => {
    const gf = (opts.gameFiles && opts.gameFiles[bg.game_id]) || readJson(path.join(dir, 'games', bg.game_id + '.json'), null);
    if (!gf) return null;
    /* market-only rows are re-derived from the market every time */
    const records = P.projectionsOf(gf).filter((x) => !/^mkt_/.test(x.projection_id));
    return { league: gf.league, game_id: gf.game_id, kickoff: gf.kickoff, model_version: gf.model_version, as_of: gf.as_of, sims: gf.sims, seed: gf.seed, inputs_hash: gf.inputs_hash,
      environment: gf.environment, teams: gf.teams, correlations: gf.correlations, records };
  }).filter(Boolean);
  const market = opts.market || require('./capture.js').loadMarket(prev.league, games.map((g) => g.game_id));
  const validation = readJson(path.join(dir, 'validation.json'), null);
  const record = opts.record !== undefined ? opts.record : readJson(path.join(ROOT, 'record', 'props', L + '_' + prev.season + '.json'), null);
  const stages = opts.board && opts.board.stages ? opts.board.stages : A.stageTable(validation, record && record.scorecards);
  const asm = A.assemble({ league: prev.league, now, games, market, stages, record: record && record.scorecards });
  const nowIso = new Date(now).toISOString();
  const counts = { projections: asm.rows.length, projected: asm.rows.filter((x) => !x.status).length, with_market: asm.rows.filter((x) => x.mkt).length };
  ['BET', 'LEAN', 'WATCH', 'PASS', 'NO_DECISION'].forEach((k) => { counts[k] = asm.rows.filter((x) => (x.dec ? x.dec.cls : 'NO_DECISION') === k).length; });
  const board = Object.assign({}, prev, { generated_at: nowIso, as_of: nowIso, market_captured_at: market.captured_at || null,
    market_note: market.captured_at ? null : prev.market_note, counts, stages, cv_norm: asm.cvNorm, calibration: asm.calibration, unmapped: (market.unmapped || []).slice(0, 200), rows: asm.rows });
  delete board._games;
  const written = [];
  if (!opts.dry) {
    written.push([path.join(dir, 'board.json'), writeIfChanged(path.join(dir, 'board.json'), board)]);
    asm.gameFiles.forEach((gf) => { const f = path.join(dir, 'games', gf.game_id + '.json'); written.push([f, writeIfChanged(f, gf)]); });
  }
  return { board, asm, written };
}

async function main() {
  const now = arg('now') ? Date.parse(arg('now')) : Date.now();
  if (flag('reprice')) {
    const leagues0 = (arg('league', 'nfl') || 'nfl').toLowerCase() === 'all' ? ['nfl', 'cfb'] : [(arg('league', 'nfl') || 'nfl').toLowerCase()];
    let bad = 0;
    leagues0.forEach((L) => {
      try { const r0 = reprice(L, now, { dry: flag('dry') }); console.log(L.toUpperCase() + ' re-priced: ' + JSON.stringify(r0.board.counts)); r0.written.forEach(([f, st]) => { if (st === 'written') console.log('  wrote ' + path.relative(ROOT, f)); }); }
      catch (e) { bad++; console.error('  ' + L.toUpperCase() + ' re-price failed: ' + (e && e.message)); }
    });
    process.exit(bad === leagues0.length ? 1 : 0);
  }
  const league = (arg('league', 'nfl') || 'nfl').toLowerCase();
  const opts = { sims: Number(arg('sims', 10000)), offline: flag('offline'), dry: flag('dry') };
  /* the market keys already captured: a quoted prop is always published */
  const index = readJson(path.join(OUT, 'current.json'), { schema: 'edgedesk_props_index_v1', leagues: {} });
  const leagues = league === 'all' ? ['nfl', 'cfb'] : [league];
  let failed = 0;
  for (const L of leagues) {
    console.log('player props: building ' + L.toUpperCase() + ' as of ' + new Date(now).toISOString());
    try {
      const mk = require('./capture.js').loadMarket(L, null);
      opts.market_keys = new Set(Object.keys(mk.props || {}));
      const res = L === 'nfl' ? await buildNfl(now, opts) : await require('./cfb_build.js').buildCfb(now, opts);
      const pub = publish(res, now, opts);
      const b = pub.board;
      index.leagues[L] = { league: b.league, season: b.season, week: b.week, generated_at: b.generated_at, model_version: b.model_version, board: 'football/props/' + L + '/board.json', counts: b.counts,
        games: b.games.length, market_captured_at: b.market_captured_at, gaps: b.gaps.length };
      console.log('  board: ' + JSON.stringify(b.counts));
      pub.written.forEach(([f, s]) => { if (s === 'written') console.log('  wrote ' + path.relative(ROOT, f)); });
    } catch (e) {
      failed++;
      console.error('  ' + L.toUpperCase() + ' build failed: ' + (e && e.stack || e));
    }
  }
  index.generated_at = new Date(now).toISOString();
  index.product = 'EdgeDesk Player Props';
  index.doctrine = 'Research, not picks.';
  if (!opts.dry) writeIfChanged(path.join(OUT, 'current.json'), index);
  process.exit(failed && failed === leagues.length ? 1 : 0);
}
module.exports = { buildNfl, publish, reprice, nflEnv, nflWeather, relevant, playerLogs, quantise };
if (require.main === module) main();
