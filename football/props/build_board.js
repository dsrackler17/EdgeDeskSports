#!/usr/bin/env node
/* ============================================================================
   PLAYER PROPS — the board build (docs/player-props/DESIGN.md §2).

   dataset (sources/nfl.js | sources/cfb.js)
     + captured quotes (quotes.json) and movement (lines.json)
     + the backtest's distribution calibration (calibration.json)
     + the graded ledger's probability-source state (performance.json)
     → every upcoming game, every player with a role or a posted price, every
       market: projection → distribution → EDProps.evaluate (the SAME function
       the page runs) → hit rates, matchup, explanations, movement
     → football/props/<league>/board.json    the page's feed
       football/props/<league>/players.json  the drawer's player detail
       football/props/<league>/<season>/evaluations.jsonl
                                             write-once decision records:
                                             `qualified` (first BET/LEAN of a
                                             selection) and `final` (the last
                                             pregame evaluation of every priced
                                             prop — what grading and
                                             calibration read)

   A quote whose player name does not resolve to exactly one player on the
   two rosters is kept and shown, marked UNMAPPED, never priced. A game that
   has started drops out of the board and its pregame state is frozen.

     node football/props/build_board.js [--league nfl|cfb] [--offline] [--now <ISO>] [--days 7] [--write]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./config.js');
const M = require('./model.js');
const CAP = require('./capture.js');
global.window = global.window || global;
require(path.join(C.ROOT, 'lib', 'research_core.js'));
try { require(path.join(C.ROOT, 'lib', 'edgedesk_vocab.js')); require(path.join(C.ROOT, 'lib', 'edgedesk_market.js')); require(path.join(C.ROOT, 'lib', 'edgedesk_decision.js')); } catch (e) { /* optional */ }
const EDP = require(path.join(C.ROOT, 'lib', 'edgedesk_props.js'));

const BOARD_SCHEMA = 'edgedesk_player_props_board_v1';
const PLAYERS_SCHEMA = 'edgedesk_player_props_players_v1';
const LOG_COLS = ['date', 'season', 'week', 'opp', 'home', 'snp', 'snp_pct', 'att', 'cmp', 'pyd', 'ptd', 'int', 'sk', 'db', 'plng', 'car', 'ryd', 'rtd', 'rlng', 'rz', 'gl', 'scr', 'tgt', 'rec', 'yd', 'td', 'lng', 'ay', 'rzt', 'fgm', 'fga', 'xpm', 'tkl', 'ast', 'dsk', 'dint', 'st_td', 'prs'];
const MATCHUP = {
  rush: [['ypc', 'Yards per carry allowed', 2], ['rush_epa', 'Rush EPA allowed', 3], ['succ_rush', 'Rush success rate allowed', 3, true], ['expl_rush', 'Explosive rush rate allowed (10+)', 3, true], ['rtd_pg', 'Rushing TDs allowed / game', 2]],
  rec: [['ypt_POS', 'Yards per target allowed to POS', 2], ['ypdb', 'Net yards per dropback allowed', 2], ['pass_epa', 'Pass EPA allowed', 3], ['expl_pass', 'Explosive pass rate allowed (20+)', 3, true], ['ptd_pg', 'Passing TDs allowed / game', 2]],
  pass: [['ypdb', 'Net yards per dropback allowed', 2], ['pass_epa', 'Pass EPA allowed', 3], ['cmp_rate', 'Completion rate allowed', 3, true], ['pressure', 'Sack + QB-hit rate (pressure proxy)', 3, true], ['int_rate', 'Interception rate forced', 3, true], ['ptd_pg', 'Passing TDs allowed / game', 2]],
  td: [['pts_pg', 'Points allowed / game', 1], ['rtd_pg', 'Rushing TDs allowed / game', 2], ['ptd_pg', 'Passing TDs allowed / game', 2]],
  kick: [['pts_pg', 'Points allowed / game', 1]],
  def: [['plays', 'Opponent offensive plays / game', 1]]
};
function matchupKind(m) {
  const c = EDP.categoryOf(m);
  if (m === 'fg_made' || m === 'kicking_pts') return 'kick';
  if (['tackles_ast', 'solo_tackles', 'sacks', 'def_ints'].indexOf(m) >= 0) return 'def';
  if (c === 'touchdowns') return 'td';
  if (c === 'passing' || m === 'pass_rush_yds') return 'pass';
  if (c === 'receiving') return 'rec';
  return 'rush';
}
/* the metric the explanation sentence uses, and whether a HIGH rank (a weak
   defence) favours the over */
const LEAD = { rush: 'rush_epa', rec: 'ypt_POS', pass: 'pass_epa', td: 'pts_pg', kick: 'pts_pg', def: 'plays' };

const r2 = (x) => typeof x === 'number' && isFinite(x) ? Math.round(x * 100) / 100 : null;
const r4 = (x) => typeof x === 'number' && isFinite(x) ? Math.round(x * 10000) / 10000 : null;
function readJson(p) { try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; } catch (e) { return null; } }
function readJsonl(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean) : []; }

/* ------------------------------------------------------------ identity */
function nameKeys(p) {
  const ks = new Set();
  const add = (s) => { const k = EDP.normName(s); if (k) ks.add(k); };
  add(p.name);
  if (p.first && p.last) { add(p.first + ' ' + p.last); add(p.first[0] + ' ' + p.last); }
  if (p.football_name && p.last) add(p.football_name + ' ' + p.last);
  const parts = EDP.normName(p.name).split(' ');
  if (parts.length >= 2) { add(parts[0][0] + ' ' + parts.slice(1).join(' ')); add(parts[0] + ' ' + parts[parts.length - 1]); }
  return Array.from(ks);
}
function nameIndex(players) {
  const ix = {};
  players.forEach((p) => nameKeys(p).forEach((k) => { (ix[k] = ix[k] || new Set()).add(p.id); }));
  return ix;
}
function resolveName(ix, name) {
  const k = EDP.normName(name);
  let hit = ix[k];
  if (!hit) { const parts = k.split(' '); if (parts.length >= 2) hit = ix[parts[0][0] + ' ' + parts.slice(1).join(' ')]; }
  if (!hit || hit.size !== 1) return { id: null, why: hit ? 'ambiguous: ' + hit.size + ' players share this name' : 'no player of this name on either roster' };
  return { id: Array.from(hit)[0] };
}

/* ------------------------------------------------------------ events → games */
function joinEvents(league, events, games, ds) {
  const out = {};
  if (league === 'nfl') {
    const code = {}; Object.keys(ds.team_names).forEach((c) => { code[EDP.normName(ds.team_names[c])] = c; });
    Object.keys(events).forEach((id) => {
      const e = events[id], h = code[EDP.normName(e.home_team)], a = code[EDP.normName(e.away_team)], t = Date.parse(e.commence_time);
      const g = games.find((x) => x.home === h && x.away === a && Math.abs(Date.parse(x.kickoff) - t) <= 18 * 3600e3);
      if (g) out[id] = g.game_id;
    });
    return out;
  }
  const INTEL = require(path.join(C.ROOT, 'supabase', 'functions', 'edgedesk_ai', '_intelligence.js'));
  const j = INTEL.joinSignalsToGames({ signals: Object.keys(events).map((id) => ({ provider_event_id: id, home_team: events[id].home_team, away_team: events[id].away_team, commence_time: events[id].commence_time })),
    games: games.map((g) => ({ game_id: g.game_id, home_team: g.home_name || g.home, away_team: g.away_name || g.away, home_id: g.home, away_id: g.away, kickoff: g.kickoff })) });
  Object.keys(j.by_game || {}).forEach((gid) => (j.by_game[gid] || []).forEach((s) => { out[s.provider_event_id] = gid; }));
  return out;
}

/* ------------------------------------------------------------ roles */
/* the markets a player's ROLE supports when no book has posted him: NFL is
   wide (books post nearly every role player); college is narrower (starters
   and main ball-carriers), and longest-play markets there wait for a book —
   their per-play shape is borrowed from the NFL */
function roleMarkets(pg, pr, league) {
  const v = pr.volume || {}, cfb = league === 'cfb';
  const out = [];
  if (pg === 'QB') return cfb ? ['pass_yds', 'pass_att', 'pass_cmp', 'pass_tds', 'pass_ints', 'rush_yds', 'anytime_td'] : M.defaultMarkets('QB');
  if (pg === 'RB') {
    if ((v.carries || 0) >= (cfb ? 8 : 5)) out.push('rush_yds', 'rush_att', 'anytime_td'); if (!cfb && (v.carries || 0) >= 5) out.push('rush_long');
    if ((v.receptions || 0) >= (cfb ? 2 : 1.5)) out.push('receptions', 'rec_yds'); if ((v.carries || 0) >= (cfb ? 8 : 5) && (v.receptions || 0) >= 1) out.push('rush_rec_yds'); return out;
  }
  if (pg === 'WR' || pg === 'TE') { if ((v.targets || 0) >= 3) { out.push('receptions', 'rec_yds', 'anytime_td'); if (!cfb) out.push('rec_long'); } return out; }
  if (pg === 'K') return ['fg_made', 'kicking_pts'];
  return out;
}

async function loadDataset(league, o) {
  const src = league === 'cfb' ? require('./sources/cfb.js') : require('./sources/nfl.js');
  return src.load(o);
}

function calibState(perf) {
  const c = perf && perf.calibration_state ? perf.calibration_state : null;
  return c ? { state: c.state, n: c.n, ece: c.ece } : { state: 'UNVALIDATED', n: 0, ece: null };
}

/* one player's compact detail for the drawer */
function playerDetail(ds, p, ctx, tm) {
  const logs = (p.logs || []).filter((l) => l.date < ctx.cutoff).slice(-17).map((l) => LOG_COLS.map((k) => {
    if (k === 'season') return l.s; if (k === 'week') return l.w; if (k === 'opp') return l.op; if (k === 'home') return l.h;
    const v = l[k]; return v == null ? null : (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
  }));
  return { id: p.id, name: p.name, pos: p.pos, pg: p.pg, team: tm, headshot: p.headshot || null, espn_id: p.espn_id || null, cols: LOG_COLS, logs };
}

async function build(opts) {
  opts = opts || {};
  const league = opts.league || 'nfl', now = opts.now != null ? opts.now : Date.now();
  const season = opts.season || C.seasonOf(now);
  const P = opts.paths || C.leaguePaths(league, season);
  const ds = opts.dataset || await loadDataset(league, { season, offline: !!opts.offline, now });
  if (!ds.ok) throw new Error('dataset unavailable: ' + ds.error);
  const calibFile = readJson(league === 'cfb' ? C.leaguePaths('nfl', season).calibration : P.calibration) || readJson(P.calibration);
  const perf = readJson(P.performance);
  const cal = calibState(perf);
  /* each market's stage from its evidence (EDProps.stageOf): the NFL backtest
     and the live record. College has no backtest of its own (it borrows the
     NFL's multipliers), so every college market stays EXPERIMENTAL. */
  const stages = EDP.stageTable(league === 'nfl' ? calibFile : null, perf);
  /* how props in one game move together (football/props/correlation.js);
     college borrows the NFL's. It caps the correlated stake across a game's
     BETs (EDProps.exposure) and drives the page's same-game Monte Carlo. */
  const corrFile = readJson(league === 'cfb' ? C.leaguePaths('nfl', season).correlation : P.correlation);
  const correlation = corrFile && corrFile.schema === 'edgedesk_player_props_correlation_v1'
    ? { seasons: corrFile.seasons, generated_at: corrFile.generated_at, n_games: corrFile.n_games, borrowed: league !== 'nfl', same_player: corrFile.same_player, teammate: corrFile.teammate, opponent: corrFile.opponent } : null;
  const quotesFeed = opts.quotes || readJson(P.quotes);
  const linesFeed = opts.lines || readJson(P.lines);
  const capState = readJson(P.capture_state);
  const days = opts.days || (league === 'nfl' ? 8 : 7);
  const horizon = now + days * 86400e3;
  /* the board's games: not yet kicked off, inside the horizon. A game that has
     started is closed for pregame props: it leaves the board (its last pregame
     evaluations are frozen below) instead of sitting on it as NO DECISION rows */
  let games = ds.schedule.filter((g) => g.season === season && g.kickoff && Date.parse(g.kickoff) > now && Date.parse(g.kickoff) <= horizon && g.status !== 'final');
  if (league === 'cfb') games = games.filter((g) => g.edgedesk || (g.home_division === 'fbs' && g.away_division === 'fbs'));
  /* NFL: EdgeDesk's own game numbers, QB starters and forecast from the slate */
  if (league === 'nfl' && ds.slate && ds.slate.games) {
    const sg = {}; ds.slate.games.forEach((g) => { sg[g.game_id] = g; });
    games.forEach((g) => {
      const s = sg[g.game_id]; if (!s) return;
      g.edgedesk = { home_margin: s.model_home_margin, total: s.model_fair_total, source: 'EdgeDesk NFL model (football/nfl/slate.json)' };
      g.forecast = s.forecast || null; g.venue = s.venue || g.stadium;
      g.starters = {};
      if (s.home_starter && s.home_starter.player_id) g.starters[g.home] = { id: s.home_starter.player_id, name: s.home_starter.player_name, confirmed: /CONFIRMED|DEPTH_CHART/.test(String(s.home_starter.status || '')) || s.home_starter.status === 'SCHEDULE_FEED' };
      if (s.away_starter && s.away_starter.player_id) g.starters[g.away] = { id: s.away_starter.player_id, name: s.away_starter.player_name, confirmed: /CONFIRMED|DEPTH_CHART/.test(String(s.away_starter.status || '')) || s.away_starter.status === 'SCHEDULE_FEED' };
    });
  }
  /* quotes by game */
  const events = quotesFeed && quotesFeed.events ? quotesFeed.events : {};
  const ev2game = joinEvents(league, events, games, ds);
  const quotesByGame = {};
  Object.keys(events).forEach((eid) => {
    const gid = ev2game[eid]; if (!gid) return;
    const e = events[eid];
    (quotesByGame[gid] = quotesByGame[gid] || { event: e, rows: [] }).rows.push(...(e.quotes || []).map(CAP.unpackQuote));
  });
  const unjoined = Object.keys(events).filter((eid) => !ev2game[eid] && Date.parse(events[eid].commence_time) > now).map((eid) => ({ event_id: eid, home_team: events[eid].home_team, away_team: events[eid].away_team, commence_time: events[eid].commence_time }));

  const ctxByDay = {};
  const ctxFor = (day) => ctxByDay[day] || (ctxByDay[day] = M.prepare(ds, day, { calibration: calibFile }));
  const props = [], playersOut = {}, playersCtx = {}, gamesOut = [], unmapped = [], matchups = {};
  const league_implied = [];
  const shapesUsed = {};
  const finals = [];
  const ledger = readJsonl(P.evaluations);
  const qualifiedSeen = new Set(ledger.filter((x) => x.kind === 'qualified').map((x) => x.selection_key));
  const newRows = [];
  /* the decision records wait until every BET is on the board: the exposure
     caps across a game can lower a stake, and the record freezes the capped one */
  const pending = [];
  const resolved = [];
  /* timestamps are stored once and referenced by index */
  const times = [], timeIx = {};
  const T = (t) => { if (t == null) return -1; if (timeIx[t] == null) { timeIx[t] = times.length; times.push(t); } return timeIx[t]; };
  const packQ = (q) => [q.book, q.line, q.side === 'over' ? 'o' : 'u', q.american, T(q.quoted_at), T(q.captured_at), q.alt ? 1 : 0];

  games.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff) || a.game_id.localeCompare(b.game_id));
  for (const g of games) {
    const started = Date.parse(g.kickoff) <= now;
    const ctx = ctxFor(g.gameday || g.kickoff.slice(0, 10));
    const teamPl = [g.home, g.away].map((tm) => Object.values(ds.players).filter((p) => p.team === tm));
    const ix = nameIndex(teamPl[0].concat(teamPl[1]));
    const Q = quotesByGame[g.game_id];
    const byPlayer = {};
    (Q ? Q.rows : []).forEach((q) => {
      const r = resolveName(ix, q.player_name);
      const k = r.id || ('name:' + EDP.normName(q.player_name));
      if (!r.id) unmapped.push({ game_id: g.game_id, player_name: q.player_name, market: q.market, why: r.why });
      const B = byPlayer[k] || (byPlayer[k] = { id: r.id, name: q.player_name, markets: {} });
      (B.markets[q.market] = B.markets[q.market] || []).push(q);
      resolved.push({ sport: league, game_id: g.game_id, provider_event_id: Q.event.event_id, player_id: r.id || null, player_key: k, player_name: q.player_name, market: q.market,
        line: q.line, side: q.side, book: q.book, american: q.american, is_alternate: !!q.alt, quoted_at: q.quoted_at || null, captured_at: q.first_seen_at || q.captured_at, kickoff: g.kickoff });
    });
    /* the role players, whether or not a book has posted them */
    const cands = new Set(Object.keys(byPlayer).filter((k) => byPlayer[k].id).map((k) => byPlayer[k].id));
    [g.home, g.away].forEach((tm, i) => {
      const dep = (ds.depth || {})[tm];
      teamPl[i].forEach((p) => {
        if (['QB', 'RB', 'WR', 'TE', 'K'].indexOf(p.pg) < 0) return;
        const recent = p.logs.filter((l) => l.s === season && l.tm === tm && M.playedIn(l)).length;
        const onDepth = dep && dep[p.pg] && dep[p.pg].slice(0, p.pg === 'WR' ? 4 : p.pg === 'QB' || p.pg === 'K' ? 1 : 2).some((x) => x.id === p.id);
        if (recent >= 1 || onDepth) cands.add(p.id);
      });
    });
    /* each defence's ranks, once per board */
    [g.home, g.away].forEach((tm) => { if (!matchups[tm] && ctx.ranks[tm]) { const o = {}; Object.keys(ctx.ranks[tm]).forEach((k) => { const x = ctx.ranks[tm][k]; o[k] = [x.rank, x.of, r4(x.value)]; }); matchups[tm] = o; } });
    const env = M.environment(ctx, g, g.home);
    let nProps = 0, nPriced = 0;
    const gMarkets = {};
    for (const pid of cands) {
      const p = ds.players[pid], tm = p.team, quoted = byPlayer[pid] ? byPlayer[pid].markets : {};
      const qMarkets = Object.keys(quoted);
      const probe = M.projectPlayer(ctx, pid, g, [], { team: tm });
      if (!probe.ok && !qMarkets.length) continue;
      const want = Array.from(new Set(qMarkets.concat(probe.ok ? roleMarkets(p.pg, probe, league) : [])));
      if (!want.length) continue;
      const pr = probe.ok ? M.projectPlayer(ctx, pid, g, want, { team: tm, force: qMarkets.length > 0 }) : probe;
      const penv = pr.ok ? pr.env : null;
      const pctx = {
        id: pid, name: p.name, pos: p.pg, team: tm, opp: tm === g.home ? g.away : g.home, g: g.game_id, headshot: p.headshot || null,
        status: pr.ok ? pr.status : null, depth_rank: pr.ok ? pr.depth_rank : null, sample_games: pr.ok ? pr.sample_games : 0, prior_games: pr.ok ? pr.prior_games : 0,
        role_stability: pr.ok ? pr.role_stability : null, completeness: pr.ok ? pr.completeness : null,
        shares: pr.ok ? pr.shares : null, teammates_out: pr.ok ? pr.teammates_out : [], teammate_returned: pr.ok ? pr.teammate_returned : null,
        qb_change: pr.ok ? pr.qb_change : null, env: penv ? { margin: penv.margin, implied: penv.implied, opp_implied: penv.opp_implied, total: penv.total, script: penv.script, wind: penv.wind, dome: penv.dome, source: penv.source } : null,
        projection_error: pr.ok ? null : pr.reason
      };
      let any = false;
      for (const m of want) {
        const mq = quoted[m] || [];
        const proj = pr.ok ? pr.markets[m] : null;
        if (!proj && !mq.length) continue;
        if (proj && proj.dist.family === 'maxemp') shapesUsed[proj.dist.shape] = ctx.shapes[proj.dist.shape];
        const hist = p.logs.filter((l) => l.date < ctx.cutoff && M.playedIn(l)).slice(-10).map((l) => M.statOf(m, l)).filter((v) => v != null);
        const input = {
          id: league + '|' + g.game_id + '|' + pid + '|' + m, sport: league, game_id: g.game_id, player_id: pid, player_name: p.name, team: tm, opp: pctx.opp, pos: p.pg, market: m,
          kickoff: g.kickoff, game_status: started ? 'in_progress' : 'scheduled', mapped: true,
          player_status: pr.ok ? pr.status : null, report_on_file: pr.ok ? pr.status.on_file : null,
          projection: proj ? { dist: proj.dist, sample_games: pr.sample_games, prior_games: pr.prior_games, role_stability: pr.role_stability, completeness: pr.completeness,
            qb_change: !!pr.qb_change, qb_unconfirmed: !!pr.qb_unconfirmed, teammate_uncertain: !!pr.teammate_uncertain } : null,
          quotes: mq.map((q) => ({ book: q.book, line: q.line, side: q.side, american: q.american, quoted_at: q.quoted_at, captured_at: q.captured_at, alt: q.alt })),
          history: hist.length >= 3 ? { values: hist } : null
        };
        const ev = EDP.evaluate(input, { now, calibration: cal, stages });
        if (ev.anchor && input.projection) input.projection.anchor = ev.anchor;
        const kind = matchupKind(m);
        const line = ev.consensus.line != null ? ev.consensus.line : (ev.informed ? Math.floor(ev.informed.median) + 0.5 : null);
        const side = ev.candidate ? ev.candidate.side : (ev.at_consensus && ev.at_consensus.over >= ev.at_consensus.under ? 'over' : (ev.informed && line != null && ev.informed.mean > line ? 'over' : 'under'));
        /* movement from lines.json, consensus open → current */
        let mv = null;
        if (Q && linesFeed && linesFeed.events && linesFeed.events[Q.event.event_id]) {
          const le = linesFeed.events[Q.event.event_id].props[EDP.normName(byPlayer[pid] ? byPlayer[pid].name : p.name) + '|' + m];
          if (le) mv = movementOf(le);
        }
        const rec = {
          g: g.game_id, p: pid, m, s: side, k: kind,
          x: { st: input.game_status, dist: proj ? proj.dist : null, sg: pr.ok ? pr.sample_games : 0, pg: pr.ok ? pr.prior_games : 0, rs: pr.ok ? pr.role_stability : null, cp: pr.ok ? pr.completeness : null,
            qc: pr.ok && pr.qb_change ? 1 : 0, qu: pr.ok && pr.qb_unconfirmed ? 1 : 0, tu: pr.ok && pr.teammate_uncertain ? 1 : 0, an: input.projection ? input.projection.anchor || null : null, mr: proj ? proj.mean_raw : null,
            h: input.history ? input.history.values : null },
          q: input.quotes.map(packQ),
          e: compactEval(ev), mv,
          fl: [ctx.caps.targets === false && EDP.categoryOf(m) === 'receiving' ? 'NO_TARGETS_IN_FEED' : null, ds.shapes_borrowed && proj && /long/.test(m) ? 'NFL_PLAY_SHAPE' : null, calibFile && league === 'cfb' ? 'NFL_CALIBRATION' : null].filter(Boolean)
        };
        if (!rec.fl.length) delete rec.fl;
        if (!rec.mv) delete rec.mv;
        props.push(rec);
        any = true; nProps++; if (input.quotes.length) nPriced++;
        gMarkets[m] = (gMarkets[m] || 0) + 1;
        if (input.quotes.length) pending.push({ input, ev, g, p, rec, started });
      }
      if (any) {
        playersCtx[pid + '@' + g.game_id] = pctx;
        playersOut[pid] = Object.assign(playerDetail(ds, p, ctx, tm), { steps: pr.ok ? pr.steps : null,
          role: pr.ok ? { volume: pr.volume, efficiency: pr.efficiency, tds: pr.tds, qb: pr.qb } : null });
      }
    }
    /* unmapped quoted names stay visible */
    Object.keys(byPlayer).filter((k) => !byPlayer[k].id).forEach((k) => {
      const B = byPlayer[k];
      Object.keys(B.markets).forEach((m) => {
        const input = { id: league + '|' + g.game_id + '|' + k + '|' + m, market: m, kickoff: g.kickoff, game_status: started ? 'in_progress' : 'scheduled', mapped: false, projection: null,
          quotes: B.markets[m].map((q) => ({ book: q.book, line: q.line, side: q.side, american: q.american, quoted_at: q.quoted_at, captured_at: q.captured_at, alt: q.alt })) };
        const ev = EDP.evaluate(input, { now, calibration: cal, stages });
        props.push({ id: input.id, g: g.game_id, p: null, name: B.name, m, s: null, k: matchupKind(m), x: { st: input.game_status, mp: 0, dist: null }, q: input.quotes.map(packQ), e: compactEval(ev), fl: ['UNMAPPED'] });
        nProps++; nPriced++;
      });
    });
    league_implied.push(env.implied, env.opp_implied);
    gamesOut.push({ game_id: g.game_id, season: g.season, week: g.week, kickoff: g.kickoff, status: started ? 'in_progress' : 'scheduled', home: g.home, away: g.away,
      home_name: (ds.team_names && ds.team_names[g.home]) || g.home_name || g.home, away_name: (ds.team_names && ds.team_names[g.away]) || g.away_name || g.away,
      venue: g.venue || g.stadium || null, roof: g.roof || null, surface: g.surface || null, neutral: !!g.neutral,
      market: { home_margin: env.home_margin, total: env.total, home_implied: env.implied, away_implied: env.opp_implied, source: env.source, home_ml: g.home_ml != null ? g.home_ml : null, away_ml: g.away_ml != null ? g.away_ml : null },
      edgedesk: g.edgedesk || null, weather: env.dome ? { dome: true } : (g.forecast ? { temp_f: g.forecast.temp_f, wind_mph: g.forecast.wind_mph, precip_in: g.forecast.precip_in, text: g.forecast.text || null, as_of: g.forecast.as_of || null, source: g.forecast.source || 'forecast' } : (env.wind != null || env.temp != null ? { temp_f: env.temp, wind_mph: env.wind, source: 'schedule feed' } : null)),
      script: { home: env.script, away: M.environment(ctx, g, g.away).script },
      pace: { home: ctx.team[g.home] ? r2(ctx.team[g.home].plays) : null, away: ctx.team[g.away] ? r2(ctx.team[g.away].plays) : null, league: r2(ctx.league.plays) },
      starters: g.starters || null, event_id: Q ? Q.event.event_id : null, quotes_observed_at: Q ? Q.event.observed_at : null,
      n_props: nProps, n_priced: nPriced, markets: Object.keys(gMarkets).sort() });
  }

  /* the exposure caps across every BET on the board, then the decision
     records from the capped evaluations */
  const expo = EDP.boardExposure({ league, props, players: playersCtx, correlation }, null);
  pending.forEach(({ input, ev: ev0, g, p, rec, started }) => {
    const adj = expo[input.id], ev = adj ? EDP.applyExposure(ev0, adj) : ev0;
    if (adj) rec.e = EDP.exposeCompact(rec.e, adj);
    if (ev.candidate && (ev.decision === 'BET' || ev.decision === 'LEAN')) {
      const sk = input.id + '|' + ev.candidate.side + '|' + ev.candidate.line + '|' + ev.decision;
      if (!qualifiedSeen.has(sk)) { qualifiedSeen.add(sk); newRows.push(ledgerRow('qualified', input, ev, g, p, sk)); }
    }
    if (!started && ev.at_consensus) finals.push(ledgerRow('final', input, ev, g, p, input.id));
  });

  /* the frozen pregame record: when a game starts, its last pregame evaluation of every priced prop is final */
  const pre = readJson(path.join(P.dir, 'pregame_state.json')) || { rows: {} };
  const keepPre = {};
  finals.forEach((r) => { keepPre[r.prop_id] = r; });
  const stillOpen = new Set(games.filter((g) => Date.parse(g.kickoff) > now).map((g) => g.game_id));
  Object.keys(pre.rows || {}).forEach((pid) => {
    const r = pre.rows[pid];
    if (!stillOpen.has(r.game_id) && Date.parse(r.kickoff) <= now && !keepPre[pid]) newRows.push(Object.assign({}, r, { kind: 'final', frozen_at: new Date(now).toISOString() }));
    else if (!keepPre[pid] && stillOpen.has(r.game_id)) keepPre[pid] = r;
  });

  const markets = {};
  props.forEach((x) => { markets[x.m] = (markets[x.m] || 0) + 1; });
  const board = {
    schema: BOARD_SCHEMA, league, season, generated_at: new Date(now).toISOString(), engine: EDP.VERSION, model_version: M.MODEL_VERSION, config: EDP.CONFIG.version,
    decision_config: EDP.decisionConfig().source,
    probability: EDP.calibrationOf(cal), market_weight: EDP.CONFIG.market_weight,
    stages: Object.keys(stages).reduce((o, k) => { if (props.some((x) => x.m === k)) o[k] = stages[k]; return o; }, {}),
    correlation, exposure: EDP.CONFIG.exposure,
    calibration: calibFile ? { mode: calibFile.mode, season_tested: calibFile.season_tested, generated_at: calibFile.generated_at, borrowed: league === 'cfb', n_scored: calibFile.n_scored,
      markets: Object.keys(calibFile.markets || {}).reduce((o, k) => { const c = calibFile.markets[k]; const oos = calibFile.out_of_sample && calibFile.out_of_sample.before ? calibFile.out_of_sample : null; o[k] = { f: c.f, mean_mult: c.mean_mult, n: c.n, adopted: c.adopted !== false, cover50: oos && oos.after[k] ? (c.adopted === false ? oos.before[k].cover50 : oos.after[k].cover50) : null, ece: oos && oos.after[k] ? (c.adopted === false ? oos.before[k].calibration.ece : oos.after[k].calibration.ece) : null }; return o; }, {}) } : null,
    capture: capState ? { last_run: capState.last_run, last_attempt: capState.last_attempt, stopped: capState.stopped || null, requests_remaining: capState.requests_remaining, bookmakers: capState.bookmakers, events_polled: capState.events_polled }
      : { last_run: null, state: 'NOT_CAPTURED', why: 'The prop capture has not run: it needs the ODDS_API_KEY secret and the repository variable PROPS_CAPTURE=on (docs/runbooks/player-props.md).' },
    quotes: quotesFeed ? { generated_at: quotesFeed.generated_at, n_events: quotesFeed.n_events, n_quotes: quotesFeed.n_quotes, unjoined_events: unjoined } : null,
    sources: { dataset_built_at: ds.built_at, feeds: ds.feeds, injuries: ds.injuries ? { published: ds.injuries.published, retrieved_at: ds.injuries.retrieved_at || null, latest_week: ds.injuries.latest_week || null, note: ds.injuries.note || null } : null,
      caps: ds.caps || { targets: true, snaps: true, pbp: true, injuries: true, depth: true }, shapes_borrowed: !!ds.shapes_borrowed,
      not_in_feed: league === 'nfl' ? ['routes run', 'route participation', 'yards per route run', 'coverage tendencies'] : ['targets', 'snaps', 'red-zone usage', 'routes', 'official injury report', 'depth charts'] },
    league_implied: r2(league_implied.length ? league_implied.reduce((a, b) => a + b, 0) / league_implied.length : null),
    team_names: ds.team_names || null,
    shapes: shapesUsed, times, matchups, matchup_rows: MATCHUP, lead: LEAD,
    counts: { games: gamesOut.length, props: props.length, priced: props.filter((x) => x.q.length).length, unmapped: unmapped.length, markets },
    unmapped: unmapped.slice(0, 200),
    games: gamesOut, players: playersCtx, props
  };
  const playersFile = { schema: PLAYERS_SCHEMA, league, season, generated_at: board.generated_at, cols: LOG_COLS, players: playersOut };
  return { board, players: playersFile, ledger_rows: newRows, pregame: { schema: 'edgedesk_player_props_pregame_v1', rows: keepPre }, resolved_quotes: resolved,
    shapes: league === 'nfl' ? { schema: 'edgedesk_props_shapes_v1', league, season, generated_at: board.generated_at, why: 'league per-play yard shapes; the college board borrows them (no public college per-play feed is wired in)', fits: ds.event_fits } : null };
}

/* consensus movement for one (player, market) from lines.json */
function movementOf(le) {
  const series = Object.keys(le.books).map((b) => ({ book: b, main: le.books[b].main })).filter((x) => x.main && x.main.length);
  if (!series.length) return null;
  const opens = series.map((x) => x.main[0]), curs = series.map((x) => x.main[x.main.length - 1]);
  const med = (a) => { const s = a.filter((v) => v != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const mv = { open: { at: opens.map((o) => o[0]).sort()[0], line: med(opens.map((o) => o[1])), over: med(opens.map((o) => o[2])), under: med(opens.map((o) => o[3])) },
    current: { at: curs.map((o) => o[0]).sort().slice(-1)[0], line: med(curs.map((o) => o[1])), over: med(curs.map((o) => o[2])), under: med(curs.map((o) => o[3])) },
    books: series.map((x) => [x.book, x.main]) };
  mv.line_move = r2(mv.current.line - mv.open.line);
  mv.text = mv.line_move ? 'Line ' + (mv.line_move > 0 ? 'up ' : 'down ') + Math.abs(mv.line_move) + ' since open (' + mv.open.line + ' → ' + mv.current.line + ')' : (mv.open.over !== mv.current.over ? 'Same line; over ' + EDP.priceText(mv.open.over) + ' → ' + EDP.priceText(mv.current.over) : 'No movement since open');
  return mv;
}

/* the evaluation as the board carries it: EDProps.compact (one home, the page
   produces the same shape from a fresh evaluate) */
function compactEval(ev) { return EDP.compact(ev); }
function ledgerRow(kind, input, ev, g, p, key) {
  const c = ev.candidate, ac = ev.at_consensus;
  return {
    schema: 'edgedesk_player_props_evaluation_v1', kind, evaluation_id: 'ppe_' + EDP.hash([kind, key, c && c.american, c && c.book, ev.evaluated_at]), selection_key: key,
    prop_id: input.id, league: input.sport, season: g.season, week: g.week, game_id: g.game_id, kickoff: g.kickoff, player_id: input.player_id, player_name: input.player_name,
    team: input.team, opp: input.opp, position: p.pg, market: input.market, evaluated_at: ev.evaluated_at,
    decision: ev.decision, code: ev.code, units: ev.units, confidence: ev.confidence ? ev.confidence.score : null, probability_source: ev.probability_source, stage: ev.stage || null,
    exposure_cap: ev.exposure ? { code: ev.exposure.code, from_units: ev.exposure.from } : null,
    side: c ? c.side : null, line: c ? c.line : null, american: c ? c.american : null, book: c ? c.book : null, p_side: c ? r4(c.p_win / Math.max(1e-9, 1 - (c.p_push || 0))) : null, p_raw: c ? c.p_raw : null,
    ev: c ? c.ev : null, ev_raw: c ? c.ev_raw : null, edge_pp: c ? c.edge_pp : null,
    consensus: ev.consensus ? { line: ev.consensus.line, over: ev.consensus.over, under: ev.consensus.under, novig_over: ev.consensus.novig_over, n_books: ev.consensus.n_books } : null,
    model_over_at_consensus: ac ? r4(ac.over / Math.max(1e-9, ac.over + ac.under)) : null, model_mean: ev.informed ? ev.informed.mean : null, raw_mean: ev.raw ? ev.raw.mean : null,
    median: ev.informed ? ev.informed.median : null, p25: ev.informed ? ev.informed.p25 : null, p75: ev.informed ? ev.informed.p75 : null,
    model_version: M.MODEL_VERSION, distribution: input.projection ? input.projection.dist : null
  };
}

/* clock fields (when a feed was fetched, when this build ran) do not make a
   board new: only a changed number, price, decision or game does. Without
   this a quiet hourly build would commit every hour. */
const CLOCK_KEYS = { generated_at: 1, dataset_built_at: 1, retrieved_at: 1, built_at: 1, as_of: 1 };
function writeIfChanged(file, obj) {
  const strip = (f) => f ? JSON.stringify(f, (k, v) => (CLOCK_KEYS[k] ? null : v)) : null;
  let prev = null; try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { prev = null; }
  if (prev && strip(prev) === strip(obj)) return 'unchanged';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj) + '\n');
  return 'written';
}

async function main() {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const league = arg('league', 'nfl'), write = a.indexOf('--write') >= 0;
  const now = arg('now') ? Date.parse(arg('now')) : Date.now();
  const season = Number(arg('season', C.seasonOf(now)));
  const t0 = Date.now();
  const r = await build({ league, now, season, offline: a.indexOf('--offline') >= 0, days: arg('days') ? Number(arg('days')) : null });
  const B = r.board;
  console.log('[props board] ' + league + ' ' + season + ': ' + B.counts.games + ' games, ' + B.counts.props + ' props (' + B.counts.priced + ' priced, ' + B.counts.unmapped + ' unmapped names), ' + r.ledger_rows.length + ' new ledger rows — ' + (Date.now() - t0) + ' ms');
  const dec = {}; B.props.forEach((x) => { dec[x.e.d] = (dec[x.e.d] || 0) + 1; });
  console.log('[props board] decisions ' + JSON.stringify(dec) + ' · probability ' + B.probability.label + ' · capture ' + (B.capture.last_run || 'never'));
  if (!write) { console.log('[props board] dry run: nothing written (pass --write)'); return 0; }
  const P = C.leaguePaths(league, season);
  console.log('[props board] board ' + writeIfChanged(P.board, B) + ', players ' + writeIfChanged(P.players, r.players) + ', pregame state ' + writeIfChanged(path.join(P.dir, 'pregame_state.json'), r.pregame));
  if (r.ledger_rows.length) { fs.mkdirSync(P.season_dir, { recursive: true }); fs.appendFileSync(P.evaluations, r.ledger_rows.map((x) => JSON.stringify(x)).join('\n') + '\n'); }
  if (r.shapes) console.log('[props board] shapes ' + writeIfChanged(path.join(P.dir, 'shapes.json'), r.shapes));
  /* the resolved quotes the Supabase sync inserts (a working file, not committed) */
  fs.mkdirSync(C.CACHE, { recursive: true });
  fs.writeFileSync(path.join(C.CACHE, league + '_resolved_quotes.json'), JSON.stringify({ league, season, generated_at: B.generated_at, rows: r.resolved_quotes }) + '\n');
  return 0;
}

module.exports = { build, compactEval, ledgerRow, nameIndex, resolveName, joinEvents, roleMarkets, matchupKind, BOARD_SCHEMA, PLAYERS_SCHEMA, LOG_COLS };
if (require.main === module) main().then((c) => process.exit(c || 0)).catch((e) => { console.error('[props board] ' + (e.stack || e.message)); process.exit(1); });
