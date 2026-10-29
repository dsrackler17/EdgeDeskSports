/* ============================================================================
   FSIE — the live season pipeline for one sport:

     ingest (incremental; skipped when the source fingerprint is unchanged)
       -> quality gates -> coverage
       -> tendencies (the state after every completed game)
       -> team projections for the upcoming window (correlated simulation)
       -> player projections (availability applied; college unverified)
       -> model-vs-market comparisons from the props pipeline's board

   Nothing here retrains: parameters come from research/params_<sport>.json,
   fitted once by `run.js fit` after the preregistered holdout. A missing
   parameter file makes the projection stage say so and stop; observed
   tendencies and coverage are still built.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const U = require(path.join(__dirname, 'util.js'));
const I = require(path.join(__dirname, 'ingest.js'));
const FT = require(path.join(__dirname, 'features.js'));
const C = require(path.join(__dirname, 'coverage.js'));
const VM = require(path.join(__dirname, 'volume_model.js'));
const PM = require(path.join(__dirname, 'player_model.js'));
const R = require(path.join(__dirname, 'research.js'));
const MK = require(path.join(__dirname, 'market.js'));

const DIR = path.join(__dirname, '..');
const ROOT = path.join(DIR, '..', '..');
const MODEL_KEYS = { nfl: { team: 'fsie_nfl_team_volume', player: 'fsie_nfl_player_volume' }, cfb: { team: 'fsie_cfb_team_volume', player: 'fsie_cfb_player_volume' } };

function params(sport) { return U.readJson(path.join(DIR, 'research', 'params_' + sport + '.json')); }
function nowIso(o) { return (o && o.now) || new Date().toISOString(); }

/* -------------------------------------------------- game lines for upcoming games */
function nflLines(d) {
  const out = {};
  (d.schedule || []).forEach((g) => { if (g.home_spread_margin != null) out[g.game_id] = { home_margin: g.home_spread_margin, total: g.total_line, source: 'nflverse schedule consensus (current)', at: null }; });
  return out;
}
function cfbLines() {
  const out = {};
  const t = U.readJson(path.join(ROOT, 'football', 'cfb_terminal', 'games.json'));
  const sl = U.readJson(path.join(ROOT, 'football', 'fbs', 'slate.json'));
  const model = {}; ((sl && sl.games) || []).forEach((g) => { model[String(g.game_id)] = { margin: g.model_home_margin, total: g.model_fair_total }; });
  Object.values((t && t.games) || {}).forEach((g) => {
    const m = g.market || {}; const md = model[String(g.game_id)] || {};
    out[String(g.game_id)] = {
      home_margin: U.isNum(m.consensus_home_line) ? -m.consensus_home_line : null,
      total: null, model_margin: U.isNum(md.margin) ? md.margin : null, model_total: U.isNum(md.total) ? md.total : null,
      source: U.isNum(m.consensus_home_line) ? 'cfb_terminal consensus spread (' + (m.sources || []).join('+') + ')' : null, at: m.as_of || null
    };
  });
  Object.keys(model).forEach((gid) => { if (!out[gid]) out[gid] = { home_margin: null, total: null, model_margin: model[gid].margin, model_total: model[gid].total, source: null, at: null }; });
  return out;
}

/* a panel-shaped row for an upcoming game, from the state after every completed game */
function upcomingRow(sport, g, team, opp, walk, line) {
  const fT = walk.final[team], fO = walk.final[opp];
  if (!fT || !fO) return null;
  const isHome = team === g.home; const homeSign = g.neutral_site ? 0 : (isHome ? 1 : -1);
  let m = null, total = null, mSrc = null, tSrc = null;
  if (line && U.isNum(line.home_margin)) { m = isHome ? line.home_margin : -line.home_margin; mSrc = 'line'; }
  else if (line && U.isNum(line.model_margin)) { m = isHome ? line.model_margin : -line.model_margin; mSrc = 'model_substitute'; }
  if (line && U.isNum(line.total)) { total = line.total; tSrc = 'market'; } else if (line && U.isNum(line.model_total)) { total = line.model_total; tSrc = 'edgedesk_model_substitute'; }
  const restDiff = g.home_rest != null && g.away_rest != null ? (isHome ? g.home_rest - g.away_rest : g.away_rest - g.home_rest) : 0;
  return { sport, season: g.season, week: g.week, game_id: g.game_id, team, opp, kickoff_at: g.kickoff_at, home: homeSign, rest_diff: U.clamp(restDiff || 0, -7, 7),
    m, total, m_source: mSrc, total_source: tSrc, line_source: line ? line.source : null, line_at: line ? line.at : null,
    T: { off: fT.off, def: fT.def, adj: fT.opp_adj, meta: fT.meta }, O: { off: fO.off, def: fO.def, adj: fO.opp_adj, meta: fO.meta }, league: fT.league || walk.league };
}

/* --------------------------------------------------------------- one sport */
async function buildSport(sport, opts) {
  opts = opts || {};
  const now = nowIso(opts); const season = opts.season;
  const timings = {}; const t0 = Date.now(); const stage = (k, t) => { timings[k] = Date.now() - t; };
  let t = Date.now();
  const st = I.readState(sport, opts).seasons[String(season)];
  const derivedFile = path.join(I.derivedDir(opts), `${sport}_${season}.json`);
  let ing;
  if (opts.offline) ing = { ok: !!I.loadDerived(sport, season, opts), data: I.loadDerived(sport, season, opts), reused: true };
  else ing = await I.ingestSeason(sport, season, Object.assign({ current_season: season, quiet: true }, opts));
  stage('ingest', t);
  if (!ing.ok || !ing.data) return { ok: false, sport, stage: 'ingest', error: ing.error || 'no derived season', timings };
  const d = ing.data;
  let prev = I.loadDerived(sport, season - 1, opts);
  /* last season seeds the priors; a fresh cache fetches it once (permanent thereafter) */
  if (!prev && !opts.offline) { await I.ingestSeason(sport, season - 1, Object.assign({}, opts, { current_season: season, quiet: true })); prev = I.loadDerived(sport, season - 1, opts); }
  t = Date.now(); const coverage = C.build(sport, d, { now }); stage('coverage', t);
  const P = opts.params || params(sport);
  t = Date.now();
  const coaches = sport === 'nfl' ? R.nflCoaches(d, prev) : (await R.cfbCoaches(season, opts)).by_team;
  const walk = FT.walkSeason(sport, d, prev, { K: P ? P.shrinkage_k : await R.shrinkK(sport, R.roles(sport).shrinkage_estimation, opts), coaches });
  stage('tendencies', t);
  const out = { ok: true, sport, season, built_at: now, coverage, walk, derived: d, prev, params_present: !!P, projections: [], player_projections: [], comparisons: [], rows: {}, upcoming: [], timings };
  /* upcoming window */
  const look = (opts.lookahead_days || 8) * 86400000; const nowMs = Date.parse(now);
  const upcoming = (d.schedule || []).filter((g) => !g.completed && g.kickoff_at && Date.parse(g.kickoff_at) > nowMs && Date.parse(g.kickoff_at) <= nowMs + look && (g.season_type === 'REG' || !g.season_type));
  if (!P) { out.upcoming = upcoming; out.projection_note = 'research/params_' + sport + '.json is missing: run `node football/situational/run.js fit --sport ' + sport + '` after the holdout'; stage('total', t0); return out; }
  t = Date.now();
  const lines = sport === 'nfl' ? nflLines(d) : cfbLines();
  const pstates = PM.playerStates(sport, d, prev, { append_next: true });
  const avail = sport === 'nfl' ? await R.nflAvailability(season, Object.assign({ current_season: season }, opts)) : null;
  const pv = P.primary_variant; const team = P.team; const kmul = P.player.kappa_multiplier || {};
  const board = U.readJson(path.join(ROOT, 'football', 'props', sport, 'board.json'));
  const boardIdx = indexBoard(board);
  for (const g of upcoming) {
    const lineFor = lines[g.game_id] || null;
    const a = upcomingRow(sport, g, g.home, g.away, walk, lineFor), b = upcomingRow(sport, g, g.away, g.home, walk, lineFor);
    out.upcoming.push(g);
    if (!a || !b) { out.projections.push({ game_id: g.game_id, skipped: true, reason: 'no tendency state for one team (no accepted game this season or last)', home: g.home, away: g.away }); continue; }
    out.rows[g.game_id] = { home: a, away: b };
    const sim = VM.simulateGame(team, a, b, { variant: pv, draws: opts.draws || 4000, keep_draws: true, seed: 'live|' + g.game_id + '|' + P.model_version, phi: team.phi });
    [[a, sim.a, b], [b, sim.b, a]].forEach(([row, s, other]) => {
      const missing = [];
      if (row.m_source !== 'line') missing.push(row.m_source === 'model_substitute' ? 'no market spread on file: EdgeDesk model spread used' : 'no game line: points-based expectation used');
      if (row.total_source !== 'market') missing.push(row.total_source === 'edgedesk_model_substitute' ? 'no market total on file: EdgeDesk model total used' : 'no total on file');
      if (!row.T.meta.games_off) missing.push('no accepted game this season: last season prior only');
      const proj = {
        sport, season, week: g.week, game_id: g.game_id, team: row.team, opp: row.opp, home: row.home, kickoff_at: g.kickoff_at, as_of: now,
        model_key: MODEL_KEYS[sport].team, model_version: P.model_version, variant: pv,
        point: s.point, mean: s.mean, p10: s.p10, p50: s.p50, p90: s.p90, script: s.script, plays_by_script: s.plays_by_script,
        inputs: { m: U.round(row.m, 2), total: U.round(row.total, 2), m_source: row.m_source, total_source: row.total_source, line_source: row.line_source, line_at: row.line_at, rest_diff: row.rest_diff },
        data_quality: missing.length ? 'degraded' : 'ok', missing_reasons: missing, experimental: true
      };
      proj.inputs_sha256 = U.sha256({ T: row.T, O: row.O, m: row.m, total: row.total, v: P.model_version }).slice(0, 24);
      out.projections.push(proj);
      /* players */
      const tq = (d.team_games.filter((x) => x.team === row.team).slice(-1)[0] || {}).quality || {};
      const stt = pstates.get('NEXT|' + row.team);
      if (!stt || !tq.player_ok) { out.player_projections.push({ game_id: g.game_id, team: row.team, skipped: true, reason: !stt ? 'no player history' : 'the team\'s latest game failed the player-attribution gate' }); return; }
      const tm = R.teamMeanForPlayers(team, pv, row, P.player.targeted_ratio, P.player.starter_share, P.player.rates);
      const players = PM.applyAvailability(sport, stt.players, avail ? (id) => avail.lookup(g.week, row.team, id) : null);
      const means = PM.projectMeans(tm, players, sport);
      const kap = { pass: PM.CFG.kappa.pass * (kmul.pass_att || 1), rush: PM.CFG.kappa.rush * (kmul.rush_att || 1), target: PM.CFG.kappa.target * (kmul.targets || 1) };
      const sims = PM.simulatePlayers(tm, s.draws, players, { kappa: kap, seed: 'livep|' + g.game_id + '|' + row.team, keep_draws: true });
      sims.forEach((ps, i) => {
        const mk = Object.keys(R.PLAYER_MARKETS).filter((k) => R.PLAYER_MARKETS[k](players[i], means[i]));
        if (!mk.length) return;
        const pp = { sport, game_id: g.game_id, team: row.team, player_id: ps.player_id, player_name: ps.name, role: ps.role, availability: ps.availability, as_of: now, kickoff_at: g.kickoff_at,
          model_key: MODEL_KEYS[sport].player, model_version: P.model_version, markets: {}, share: ps.share, experimental: true };
        mk.forEach((m) => { pp.markets[m] = ps[m]; });
        out.player_projections.push(pp);
        /* market comparison from the props board */
        MK.MARKETS.forEach((m) => {
          if (!pp.markets[m]) return;
          const q = boardIdx.get(g.game_id + '|' + ps.player_id + '|' + m);
          if (!q) return;
          const cons = q.consensus; if (!cons) return;
          out.comparisons.push(MK.compare(pp.markets[m], cons, { sport, game_id: g.game_id, event_id: q.event_id, player_id: ps.player_id, player_name: ps.name, market: m, model_version: P.model_version, model_as_of: now, draws: ps.draws ? ps.draws[m] : null }));
        });
        delete ps.draws;
      });
    });
    delete sim.a.draws; delete sim.b.draws;
  }
  out.board_state = boardState(board);
  stage('projections', t); stage('total', t0);
  return out;
}

/* props board -> map game|player|market -> consensus of the board's current quotes */
function indexBoard(board) {
  const idx = new Map(); if (!board || !Array.isArray(board.props)) return idx;
  const times = board.times || [];
  const ev = {}; (board.games || []).forEach((g) => { ev[g.game_id] = g.event_id || null; });
  board.props.forEach((p) => {
    if (MK.MARKETS.indexOf(p.m) < 0 || !Array.isArray(p.q) || !p.q.length) return;
    const books = {};
    p.q.forEach((q) => { if (q[6]) return; const bk = q[0]; const b = books[bk] || (books[bk] = { main: [[times[q[4]] || null, q[1], null, null]] }); const e = b.main[0]; if (q[2] === 'o') e[2] = q[3]; else e[3] = q[3]; });
    const cons = MK.consensusAt(books, null);
    idx.set(p.g + '|' + p.p + '|' + p.m, { consensus: cons, event_id: ev[p.g] });
  });
  return idx;
}
function boardState(board) {
  if (!board) return { present: false };
  const priced = (board.props || []).filter((p) => MK.MARKETS.indexOf(p.m) >= 0 && Array.isArray(p.q) && p.q.length).length;
  const total = (board.props || []).filter((p) => MK.MARKETS.indexOf(p.m) >= 0).length;
  return { present: true, generated_at: board.generated_at || null, volume_props: total, priced_volume_props: priced, capture: board.capture || null };
}

module.exports = { buildSport, upcomingRow, nflLines, cfbLines, indexBoard, boardState, MODEL_KEYS };
