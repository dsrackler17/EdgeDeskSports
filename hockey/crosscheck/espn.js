#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL — a second source against the first, over a full season.

     node hockey/crosscheck/espn.js            (writes the report and the crosswalks)
     node hockey/crosscheck/espn.js --check    (the committed report still holds)

   My NHL history comes from the NHL's own feeds (via sportsdataverse). The
   NHL data pack (datapack/nhl_v1, verified by tools/datapack/verify_nhl.js)
   carries an independent ESPN retrieval of the whole 2024-25 season: games,
   448k play events, 167k shot attempts, every player and goalie box. This job
   maps ESPN ids to NHL ids and reconciles what both sources record:

     games       every ESPN club game matched by both clubs and a start within
                 6 h; finals; how each was decided (regulation / OT / shootout);
                 regulation goals per team; neutral sites
     events      every non-shootout shot attempt matched to an NHL event by
                 period, elapsed second (±1) and shooter. From the matches:
                   - which team shot a BLOCKED attempt (the NHL feed's event team
                     is the blocker; hockey/ingest/game.js turns it around);
                   - the frame of ESPN's x/y (unverified in the pack) against
                     the NHL's raw rink coordinates;
                   - ESPN's strength LABEL against my exact on-ice manpower
                     ("Even Strength" is not 5v5);
                   - ESPN's description-extracted shot type against the NHL's;
                   - shots on goal faced per goalie
                 This section reads the cached NHL play-by-play
                 (.cache/nhl_src); without it the committed section is kept and
                 says it was not recomputed.
     attempts    unblocked attempts per team-game, all situations
     goalies     every ESPN goalie row: the goalie with the most TOI against my
                 starter, goals against per goalie
     skaters     every team-game: skaters dressed, and each skater's TOI
     players     an ESPN↔NHL player id crosswalk, from matched events (id pairs)
                 or, for players with no attempt, the name within the team-game
     officials   the referees and linesmen ESPN lists, keyed to NHL game ids

   Writes hockey/validation/nhl_crosscheck_espn.json and
   hockey/data/crosswalk/espn_nhl_2025.csv (games),
   hockey/data/crosswalk/espn_nhl_players_2025.csv (players),
   hockey/data/officials/2025.csv (officials: research only — ESPN records no
   assignment time). Disagreements are reported with examples; nothing is
   "corrected" from the other source.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const { readCsv, toCsv } = require('../../engine/csv');
const TG = require('../ingest/team_games');
const { loadLineups, toiSeconds } = require('../ingest/lineups');
const { shooterView, stateFor } = require('../ingest/game');

const PACK = path.join(C.ROOT, 'datapack', 'nhl_v1', 'data');
const SEASON = 2025; /* 2024-25: the season the pack retrieved */
const OUT = path.join(C.PATHS.validation, 'nhl_crosscheck_espn.json');
const XWALK = path.join(C.HOCKEY, 'data', 'crosswalk', 'espn_nhl_' + SEASON + '.csv');
const PXWALK = path.join(C.HOCKEY, 'data', 'crosswalk', 'espn_nhl_players_' + SEASON + '.csv');
const OFFICIALS = path.join(C.HOCKEY, 'data', 'officials', SEASON + '.csv');
const PBP = path.join(C.PATHS.cacheSrc, 'play_by_play_lite_' + SEASON + '.parquet');

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const lastName = (s) => { const p = String(s || '').trim().split(/\s+/); return fold(p[p.length - 1]); };
const r4 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 10000) / 10000);
const share = (a, b) => (b ? r4(a / b) : null);
const inc = (o, k, n) => { o[k] = (o[k] || 0) + (n == null ? 1 : n); return o; };
const sorted = (m) => Object.fromEntries(Object.keys(m).sort().map((k) => [k, m[k]]));
const elapsed = (c) => { const m = /^(\d+):(\d\d)$/.exec(c || ''); return m ? +m[1] * 60 + +m[2] : null; };
const TYPE = { Shot: 'SHOT', Missed: 'MISSED_SHOT', Blocked: 'BLOCKED_SHOT', Goal: 'GOAL' };
const EXTRACTED = { 'Wrist Shot': 'wrist', 'Snap Shot': 'snap', 'Slap Shot': 'slap', Backhand: 'backhand', 'Tip-In': 'tip-in', Deflected: 'deflected', 'Wrap-around': 'wrap-around' };

function clubIndex() {
  const t = require('../data/teams.json').teams; const idx = new Map();
  for (const [abbr, v] of Object.entries(t)) for (const n of [v.name].concat(v.aliases || [])) idx.set(fold(n), abbr);
  return idx;
}

/* ---------- the NHL feed's 2024-25 attempts, from the cached play-by-play ---------- */
async function nhlAttempts() {
  if (!fs.existsSync(PBP)) return null;
  const io = require('../lib/io');
  const cols = ['game_id', 'season_type', 'event_type', 'secondary_type', 'event_team_type', 'event_team_abbr', 'home_abbr', 'away_abbr', 'period', 'period_type', 'period_seconds',
    'home_skaters', 'away_skaters', 'home_goalie_in', 'away_goalie_in', 'x', 'y', 'x_fixed', 'y_fixed', 'event_player_1_id', 'event_player_1_name', 'event_goalie_id', 'empty_net'];
  const byGP = new Map();
  for await (const r of io.parquetRows(PBP, cols)) {
    if (!['SHOT', 'MISSED_SHOT', 'BLOCKED_SHOT', 'GOAL'].includes(r.event_type)) continue;
    if (String(r.period_type || '').toUpperCase() === 'SHOOTOUT') continue;
    const k = String(r.game_id) + '|' + r.period;
    if (!byGP.has(k)) byGP.set(k, []);
    byGP.get(k).push(r);
  }
  return byGP;
}

async function reconcile(prev) {
  const clubs = clubIndex();
  const games = readCsv(path.join(PACK, 'games.csv')).rows;
  const measured = new Map(readCsv(path.join(PACK, 'team_game_measured_features.csv')).rows.map((r) => [r.game_id + '|' + r.team_id, r]));
  const mine = TG.loadTeamGames([SEASON]);
  const mineGames = new Map();
  for (const r of mine) { if (!mineGames.has(r.game_id)) mineGames.set(r.game_id, {}); mineGames.get(r.game_id)[r.home ? 'h' : 'a'] = r; }
  const byPair = new Map();
  for (const [id, g] of mineGames) {
    if (!g.h || !g.a) continue;
    const k = g.h.team + '|' + g.a.team;
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push({ id, g, t: Date.parse(g.h.start_utc) || Date.parse(g.h.date + 'T23:00:00Z') });
  }

  /* ---------- games ---------- */
  const espnTeam = new Map(); const xwalk = []; const unmatched = []; const usedMine = new Set();
  for (const e of games) { const h = clubs.get(fold(e.home_name)), a = clubs.get(fold(e.away_name)); if (h) espnTeam.set(e.home_id, h); if (a) espnTeam.set(e.away_id, a); }
  const res = { compared: 0, final_agree: 0, decided_agree: 0, regulation_goals_agree: 0, team_games: 0, disagreements: [] };
  const espnGoals = {};
  const shotRows = readCsv(path.join(PACK, 'shot_attempts.csv.gz')).rows;
  for (const s of shotRows) if (s.is_goal === 'True' && s.is_shootout_candidate !== 'True') inc(espnGoals, s.game_id + '|' + (+s.period >= 4 ? 'ot' : 'reg'));
  for (const e of games) {
    const h = espnTeam.get(e.home_id), a = espnTeam.get(e.away_id);
    if (!h || !a) { unmatched.push({ espn_game_id: e.game_id, reason: 'club not recognised (' + e.away_name + ' at ' + e.home_name + ')' }); continue; }
    const t = Date.parse(e.start_time.replace(/Z$/, ':00Z'));
    const cands = (byPair.get(h + '|' + a) || []).filter((x) => Math.abs(x.t - t) <= 6 * 3600e3 && !usedMine.has(x.id));
    if (cands.length !== 1) { unmatched.push({ espn_game_id: e.game_id, reason: cands.length ? 'ambiguous: ' + cands.length + ' candidates' : 'no NHL-feed game with these clubs within 6 h', home: h, away: a, start: e.start_time }); continue; }
    const m = cands[0]; usedMine.add(m.id);
    xwalk.push({ espn_game_id: e.game_id, nhl_game_id: m.id, home: h, away: a, espn_start: e.start_time, nhl_start: m.g.h.start_utc, minutes_apart: Math.round(Math.abs(m.t - t) / 60000), basis: 'both clubs; start within 6 h' });
    res.compared++;
    const eh = +e.home_final_score_native, ea = +e.away_final_score_native;
    const finalOk = eh === m.g.h.gf && ea === m.g.a.gf; if (finalOk) res.final_agree++;
    const so = eh + ea - (+e.home_nonshootout_goals_from_pbp + +e.away_nonshootout_goals_from_pbp) === 1;
    const espnDecided = so ? 'SO' : espnGoals[e.game_id + '|ot'] ? 'OT' : 'REG';
    if (espnDecided === m.g.h.decided) res.decided_agree++;
    for (const [side, tid] of [['h', e.home_id], ['a', e.away_id]]) {
      const ms = measured.get(e.game_id + '|' + tid); res.team_games++;
      if (ms && +ms.regulation_goals_for === m.g[side].gf_reg) res.regulation_goals_agree++;
    }
    if (!finalOk || espnDecided !== m.g.h.decided) res.disagreements.push({ espn_game_id: e.game_id, nhl_game_id: m.id, espn: eh + '-' + ea + ' ' + espnDecided, nhl_feed: m.g.h.gf + '-' + m.g.a.gf + ' ' + m.g.h.decided });
  }
  for (const [id, g] of mineGames) if (g.h && g.a && !usedMine.has(id)) unmatched.push({ nhl_game_id: id, reason: 'no ESPN game matched', home: g.h.team, away: g.a.team, date: g.h.date, type: g.h.type });
  const xmap = new Map(xwalk.map((x) => [String(x.espn_game_id), x]));
  const sideOf = (gid, tid) => { const x = xmap.get(String(gid)); if (!x) return null; const c = espnTeam.get(String(tid)); return c === x.home ? 'h' : c === x.away ? 'a' : null; };
  const mineSide = (gid, side) => mineGames.get(xmap.get(String(gid)).nhl_game_id)[side];
  const neutral = games.filter((g) => g.neutral_site === 'True').map((g) => ({ espn_game_id: g.game_id, nhl_game_id: (xmap.get(g.game_id) || {}).nhl_game_id || null, venue: g.venue_name + (g.venue_country ? ', ' + g.venue_country : ''), home: espnTeam.get(g.home_id), my_model_home_ice: mineGames.has((xmap.get(g.game_id) || {}).nhl_game_id) ? 'applied (no neutral-site flag in my feed)' : null }));

  /* ---------- unblocked attempts per team-game ---------- */
  const att = { team_games: 0, exact: 0, within_2: 0, mean_abs_diff: null, largest: [] };
  { let sum = 0; const diffs = [];
    for (const [k, ms] of measured) {
      const [gid, tid] = k.split('|'); const side = sideOf(gid, tid); if (!side) continue;
      const r = mineSide(gid, side);
      const mineN = ['ev5_ff', 'evo_ff', 'pp_ff', 'sh_ff', 'enf_ff', 'ena_ff'].reduce((a, c) => a + (r[c] || 0), 0);
      const d = +ms.all_unblocked_for - mineN; att.team_games++; if (d === 0) att.exact++; if (Math.abs(d) <= 2) att.within_2++; sum += Math.abs(d);
      diffs.push({ nhl_game_id: r.game_id, team: r.team, espn: +ms.all_unblocked_for, nhl_feed: mineN, diff: d });
    }
    att.mean_abs_diff = att.team_games ? r4(sum / att.team_games) : null;
    att.largest = diffs.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff) || x.nhl_game_id - y.nhl_game_id).slice(0, 5); }

  /* ---------- events ---------- */
  const espnNames = new Map(readCsv(path.join(PACK, 'player_game_boxscores.csv')).rows.map((p) => [p.game_id + '|' + p.player_id, p.player_name]));
  const byGP = await nhlAttempts();
  let events;
  const idPairs = new Map(); /* espn id -> Map(nhl id -> n) */
  const pair = (eid, nid, role) => { if (!eid || nid == null) return; const k = eid + '|' + role; if (!idPairs.has(k)) idPairs.set(k, new Map()); inc(idPairs.get(k), String(nid)); };
  const sogFaced = {}; /* nhl goalie id | nhl game id -> shots on goal faced (NHL feed) */
  if (!byGP) {
    events = Object.assign({}, (prev && prev.events) || {}, { recomputed_at_run: false, note: 'the cached NHL play-by-play (.cache/nhl_src) was not present: this section is the committed one' });
  } else {
    events = { recomputed_at_run: true, espn_attempts: 0, matched: 0, by_type: {}, clock: { elapsed: 0, remaining: 0 },
      coordinates: { compared: 0, within_1ft_of_nhl_raw: 0, within_1ft_of_mirrored: 0, by_type: {} },
      blocked: { matched: 0, espn_shooter_team_is_nhl_event_team: 0, espn_shooter_team_is_shooter_view_team: 0, frame: { compared: 0, feed_fixed_matches_period_frame: 0, shooter_view_matches_period_frame: 0 } },
      strength: { espn_label_by_my_state: {} }, shot_type: { compared: 0, agree: 0, matrix: {} } };
    /* shots on goal each goalie faced, from every NHL event (not only the matched ones) */
    for (const list of byGP.values()) for (const m of list) if ((m.event_type === 'SHOT' || m.event_type === 'GOAL') && m.event_goalie_id != null && !(m.empty_net === true || m.empty_net === 'true')) inc(sogFaced, m.event_goalie_id + '|' + m.game_id);
    /* the fixed frame of each game-period, read from its unblocked attempts: raw (x, y) -> (sx·x, sy·y) */
    const frame = new Map();
    for (const [k, list] of byGP) {
      const v = { sx: {}, sy: {} };
      for (const m of list) {
        if (m.event_type === 'BLOCKED_SHOT' || m.x == null || m.x_fixed == null || +m.x === 0 || +m.y === 0) continue;
        inc(v.sx, String(Math.sign(+m.x_fixed / +m.x))); inc(v.sy, String(Math.sign(+m.y_fixed / +m.y)));
      }
      const top = (o) => { const e = Object.entries(o).sort((a, b) => b[1] - a[1]); return e.length ? +e[0][0] : null; };
      frame.set(k, { sx: top(v.sx), sy: top(v.sy) });
    }
    for (const s of shotRows) {
      if (s.is_shootout_candidate === 'True') continue;
      const x = xmap.get(s.game_id); if (!x) continue;
      events.espn_attempts++;
      const bt = events.by_type[s.event_type] || (events.by_type[s.event_type] = { espn: 0, matched: 0 }); bt.espn++;
      const list = byGP.get(x.nhl_game_id + '|' + s.period) || [];
      const el = elapsed(s.clock_native); const len = +s.period <= 3 || String(x.nhl_game_id).slice(4, 6) === '03' ? 1200 : 300;
      const nm = lastName(espnNames.get(s.game_id + '|' + s.shooter_id));
      const find = (t) => list.find((r) => r.event_type === TYPE[s.event_type] && Math.abs(+r.period_seconds - t) <= 1 && lastName(r.event_player_1_name) === nm);
      let m = el == null ? null : find(el), how = 'elapsed';
      if (!m && el != null) { m = find(len - el); how = 'remaining'; }
      if (!m) continue;
      events.matched++; bt.matched++; events.clock[how]++;
      pair(s.shooter_id, m.event_player_1_id, 'skater');
      if (s.event_type === 'Shot' && s.goalie_id) pair(s.goalie_id, m.event_goalie_id, 'goalie');
      /* coordinates: ESPN x/y against the NHL's raw rink x/y */
      const ex = Number(s.x_native), ey = Number(s.y_native);
      if (s.x_native !== '' && m.x != null) {
        events.coordinates.compared++;
        const c = events.coordinates.by_type[s.event_type] || (events.coordinates.by_type[s.event_type] = { compared: 0, within_1ft: 0 }); c.compared++;
        if (Math.abs(ex - m.x) <= 1 && Math.abs(ey - m.y) <= 1) { events.coordinates.within_1ft_of_nhl_raw++; c.within_1ft++; }
        else if (Math.abs(ex + +m.x) <= 1 && Math.abs(ey + +m.y) <= 1) events.coordinates.within_1ft_of_mirrored++;
      }
      /* the shooting team, and its view */
      const view = shooterView(m);
      const espnShooter = espnTeam.get(s.shooting_team_id);
      const shooterSide = espnShooter === x.home ? 'home' : espnShooter === x.away ? 'away' : null;
      if (s.event_type === 'Blocked') {
        events.blocked.matched++;
        if (shooterSide && m.event_team_type === shooterSide) events.blocked.espn_shooter_team_is_nhl_event_team++;
        if (shooterSide && view.event_team_type === shooterSide) events.blocked.espn_shooter_team_is_shooter_view_team++;
        const f = frame.get(x.nhl_game_id + '|' + s.period);
        if (f && f.sx != null && f.sy != null && m.x != null && m.x_fixed != null) {
          const ex2 = f.sx * +m.x, ey2 = f.sy * +m.y; events.blocked.frame.compared++;
          if (Math.abs(+m.x_fixed - ex2) <= 1 && Math.abs(+m.y_fixed - ey2) <= 1) events.blocked.frame.feed_fixed_matches_period_frame++;
          if (Math.abs(+view.x_fixed - ex2) <= 1 && Math.abs(+view.y_fixed - ey2) <= 1) events.blocked.frame.shooter_view_matches_period_frame++;
        }
      }
      /* strength: ESPN's label against my exact manpower state */
      const num = (v) => (v == null || v === '' ? null : Number(v));
      const st = stateFor(view.event_team_type, num(m.home_skaters), num(m.away_skaters), m.home_goalie_in == null ? null : num(m.home_goalie_in), m.away_goalie_in == null ? null : num(m.away_goalie_in)) || 'unknown';
      const lab = events.strength.espn_label_by_my_state[s.strength_state || '(blank)'] || (events.strength.espn_label_by_my_state[s.strength_state || '(blank)'] = {}); inc(lab, st);
      /* shot type: ESPN description keyword against the NHL's coded type */
      if (s.event_type !== 'Blocked' && s.shot_type && m.secondary_type) {
        events.shot_type.compared++;
        const a = EXTRACTED[s.shot_type] || fold(s.shot_type), b = String(m.secondary_type).toLowerCase();
        if (a === b) events.shot_type.agree++;
        else inc(events.shot_type.matrix, s.shot_type + ' -> ' + b);
      }
    }
    events.match_rate = share(events.matched, events.espn_attempts);
    events.coordinates.share_within_1ft_of_nhl_raw = share(events.coordinates.within_1ft_of_nhl_raw, events.coordinates.compared);
    events.coordinates.reading = 'ESPN\'s x_native / y_native are the NHL\'s raw rink coordinates in feet (origin at centre ice, x along the length of the rink, x in ±100, y in ±42.5), not attack-normalised';
    events.blocked.reading = 'the NHL feed\'s event team on a BLOCKED_SHOT is the blocking team, and its fixed-frame x/y are rotated 180° from the frame of the period\'s other attempts; hockey/ingest/game.js shooterView() credits the attempt to the shooter and rotates the location back';
    const ES = events.strength.espn_label_by_my_state['Even Strength'] || {};
    const esN = Object.values(ES).reduce((a, b) => a + b, 0);
    events.strength.even_strength_is_5v5_share = share(ES.ev5 || 0, esN);
    events.strength.reading = 'ESPN\'s "Even Strength" also covers 4v4 and 3v3 (my "evo") and some goalie-pulled time: it is a label, not a manpower count';
    events.shot_type.agree_share = share(events.shot_type.agree, events.shot_type.compared);
    events.shot_type.matrix = Object.fromEntries(Object.entries(events.shot_type.matrix).sort((a, b) => b[1] - a[1]).slice(0, 10));
  }

  /* ---------- the player crosswalk ---------- */
  const lu = loadLineups([SEASON]);
  const goalieNames = JSON.parse(fs.readFileSync(C.PATHS.goalies, 'utf8'));
  const players = readCsv(path.join(PACK, 'player_game_boxscores.csv')).rows;
  const espnPlayer = new Map(); /* espn id -> { name, role, games } */
  for (const p of players) { const o = espnPlayer.get(p.player_id) || { name: p.player_name, role: p.group === 'goalies' ? 'goalie' : 'skater', games: 0 }; o.games++; espnPlayer.set(p.player_id, o); }
  const pmap = new Map(); /* espn id -> { nhl, basis } */
  if (byGP) {
    for (const [k, m] of idPairs) {
      const [eid, role] = k.split('|'); const best = Object.entries(m).sort((a, b) => b[1] - a[1]);
      if (!pmap.has(eid)) pmap.set(eid, { nhl: best[0][0], basis: role + ' events: ' + best[0][1] + (best.length > 1 ? ' (conflicting ids: ' + (best.length - 1) + ')' : ''), conflict: best.length > 1 });
    }
  } else if (fs.existsSync(PXWALK)) {
    for (const r of readCsv(PXWALK).rows) if (/events/.test(r.basis)) pmap.set(r.espn_player_id, { nhl: r.nhl_player_id, basis: r.basis, conflict: /conflicting/.test(r.basis) });
  }
  /* players with no matched attempt: the name within the team-game */
  for (const p of players) {
    if (pmap.has(p.player_id)) continue;
    const side = sideOf(p.game_id, p.team_id); if (!side) continue;
    const x = xmap.get(p.game_id);
    const cands = p.group === 'goalies'
      ? [1, 2].map((i) => mineSide(p.game_id, side)['g' + i + '_id']).filter(Boolean).map((id) => [String(id), goalieNames[String(id)]])
      : ((lu.map.get(Number(x.nhl_game_id)) || {})[side === 'h' ? 'home' : 'away'] || []).map((r) => [String(r[0]), lu.names[r[0]]]);
    const hit = cands.filter(([, n]) => n && lastName(n) === lastName(p.player_name));
    if (hit.length === 1) pmap.set(p.player_id, { nhl: hit[0][0], basis: 'name within the team-game', conflict: false });
  }
  const nhlName = (id) => lu.names[id] || goalieNames[id] || null;
  const pxRows = [...espnPlayer.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([eid, o]) => { const m = pmap.get(eid); return { espn_player_id: eid, nhl_player_id: m ? m.nhl : '', espn_name: o.name, nhl_name: m ? nhlName(m.nhl) || '' : '', role: o.role, espn_games: o.games, basis: m ? m.basis : 'UNMAPPED' }; });
  const nhlTaken = {}; for (const r of pxRows) if (r.nhl_player_id) inc(nhlTaken, r.nhl_player_id);
  const playersSec = {
    espn_players: pxRows.length, mapped: pxRows.filter((r) => r.nhl_player_id).length,
    by_basis: sorted(pxRows.reduce((o, r) => inc(o, /events/.test(r.basis) ? 'event id pairs' : r.basis), {})),
    conflicts: pxRows.filter((r) => /conflicting/.test(r.basis)).length,
    nhl_id_mapped_twice: Object.values(nhlTaken).filter((n) => n > 1).length,
    unmapped_examples: pxRows.filter((r) => !r.nhl_player_id).slice(0, 8).map((r) => r.espn_name + ' (' + r.role + ', ' + r.espn_games + ' g)'),
  };

  /* ---------- goalies ---------- */
  const gb = readCsv(path.join(PACK, 'goalie_game_boxscores.csv')).rows;
  const byTG = new Map(); for (const r of gb) { const k = r.game_id + '|' + r.team_id; if (!byTG.has(k)) byTG.set(k, []); byTG.get(k).push(r); }
  const goalies = { team_games: 0, most_toi_is_my_starter: 0, starter_disagreements: [], goalie_rows: 0, goals_against_agree: 0, goals_against_disagreements: [], shots_on_goal_compared: 0, shots_on_goal_agree: 0, shots_on_goal_disagreements: [] };
  for (const [k, rows] of byTG) {
    const [gid, tid] = k.split('|'); const side = sideOf(gid, tid); if (!side) continue;
    const mr = mineSide(gid, side); goalies.team_games++;
    const top = rows.slice().sort((a, b) => (+b.TOI_seconds || 0) - (+a.TOI_seconds || 0))[0];
    const mapped = (pmap.get(top.player_id) || {}).nhl;
    if (mapped ? String(mr.g_start) === mapped : lastName(goalieNames[String(mr.g_start)]) === lastName(top.player_name)) goalies.most_toi_is_my_starter++;
    else goalies.starter_disagreements.push({ nhl_game_id: mr.game_id, team: mr.team, espn_most_toi: top.player_name + ' (' + top.TOI + ')', my_starter: goalieNames[String(mr.g_start)] || null, note: rows.length > 1 ? 'two goalies played: a pulled starter is expected to differ' : null });
    for (const r of rows) {
      goalies.goalie_rows++;
      const nid = (pmap.get(r.player_id) || {}).nhl;
      const slot = [1, 2].find((i) => mr['g' + i + '_id'] && (nid ? String(mr['g' + i + '_id']) === nid : lastName(goalieNames[String(mr['g' + i + '_id'])]) === lastName(r.player_name)));
      if (!slot) { goalies.goals_against_disagreements.push({ nhl_game_id: mr.game_id, team: mr.team, espn_goalie: r.player_name, reason: 'not among my goalies for this game (faced no unblocked attempt in my feed)' }); continue; }
      if (+r.GA === mr['g' + slot + '_ga']) goalies.goals_against_agree++;
      else goalies.goals_against_disagreements.push({ nhl_game_id: mr.game_id, team: mr.team, goalie: r.player_name, espn_ga: +r.GA, my_ga: mr['g' + slot + '_ga'], espn_sa_minus_sv_minus_ga: +r.SA - +r.SV - +r.GA, note: +r.SA - +r.SV - +r.GA === -1 ? 'ESPN GA counts a goal its SA does not (a goal while the goalie was out); mine excludes empty-net goals' : null });
      if (byGP) {
        const f = sogFaced[mr['g' + slot + '_id'] + '|' + mr.game_id] || 0; goalies.shots_on_goal_compared++;
        if (f === +r.SA) goalies.shots_on_goal_agree++; else goalies.shots_on_goal_disagreements.push({ nhl_game_id: mr.game_id, goalie: r.player_name, espn_sa: +r.SA, nhl_feed_sog_faced: f });
      }
    }
  }
  if (!byGP && prev && prev.goalies) { goalies.shots_on_goal_compared = prev.goalies.shots_on_goal_compared; goalies.shots_on_goal_agree = prev.goalies.shots_on_goal_agree; goalies.shots_on_goal_disagreements = prev.goalies.shots_on_goal_disagreements || []; }
  const gaNotes = goalies.goals_against_disagreements.filter((d) => d.note).length;

  /* ---------- skaters ---------- */
  const sk = { available: lu.absent.indexOf(SEASON) < 0, team_games: 0, skaters_agree: 0, team_toi_within_60s: 0, player_rows: 0, player_rows_mapped: 0, player_toi_exact: 0, player_toi_within_5s: 0, disagreements: [] };
  if (sk.available) {
    const espnTG = new Map();
    for (const p of players) { if (p.group === 'goalies') continue; const k = p.game_id + '|' + p.team_id; if (!espnTG.has(k)) espnTG.set(k, []); espnTG.get(k).push(p); }
    for (const [k, rows] of espnTG) {
      const [gid, tid] = k.split('|'); const side = sideOf(gid, tid); if (!side) continue;
      const nid = xmap.get(gid).nhl_game_id; const g = lu.map.get(Number(nid));
      if (!g) { sk.disagreements.push({ nhl_game_id: nid, reason: 'no box score in my lineups' }); continue; }
      const mineL = g[side === 'h' ? 'home' : 'away']; const mineToi = new Map(mineL.map((r) => [String(r[0]), r[1]]));
      sk.team_games++;
      const espnToi = rows.reduce((a, r) => a + (+r.TOI_seconds || 0), 0), myToi = mineL.reduce((a, r) => a + (r[1] || 0), 0);
      if (mineL.length === rows.length) sk.skaters_agree++;
      if (Math.abs(espnToi - myToi) <= 60) sk.team_toi_within_60s++;
      if (mineL.length !== rows.length || Math.abs(espnToi - myToi) > 60) sk.disagreements.push({ nhl_game_id: nid, side, espn_skaters: rows.length, my_skaters: mineL.length, espn_toi_s: espnToi, my_toi_s: myToi });
      for (const r of rows) {
        sk.player_rows++;
        const m = pmap.get(r.player_id); if (!m || !mineToi.has(m.nhl)) continue;
        sk.player_rows_mapped++;
        const d = Math.abs(+r.TOI_seconds - (mineToi.get(m.nhl) || 0));
        if (d === 0) sk.player_toi_exact++; if (d <= 5) sk.player_toi_within_5s++;
      }
    }
  }

  /* the team-games where ESPN's box lists one skater fewer: their attempts are the ones the pack could not credit */
  { const short = new Set(sk.disagreements.filter((d) => d.espn_skaters < d.my_skaters).map((d) => String(d.nhl_game_id)));
    const unm = shotRows.filter((s2) => s2.is_shootout_candidate !== 'True' && !s2.shooting_team_id);
    sk.espn_box_short_one_skater = short.size;
    sk.unmapped_pack_attempts_in_those_games = unm.filter((s2) => xmap.get(s2.game_id) && short.has(String(xmap.get(s2.game_id).nhl_game_id))).length;
    sk.unmapped_pack_attempts = unm.length; }

  /* ---------- officials ---------- */
  const off = readCsv(path.join(PACK, 'officials.csv')).rows;
  const offG = new Map(); for (const o of off) { if (!offG.has(o.game_id)) offG.set(o.game_id, []); offG.get(o.game_id).push(o); }
  const offRows = xwalk.map((x) => {
    const list = offG.get(String(x.espn_game_id)) || [];
    const refs = list.filter((o) => o.position === 'Referee').map((o) => o.name), lines = list.filter((o) => o.position === 'Linesman').map((o) => o.name);
    return { nhl_game_id: x.nhl_game_id, espn_game_id: x.espn_game_id, date: (mineGames.get(x.nhl_game_id) || { h: {} }).h.date || '', home: x.home, away: x.away, referees: refs.join('; '), linesmen: lines.join('; '), referees_listed: list.length ? refs.length : '', known_at: '', assumed_available_at: '', pit: 'RETRO', src: 'datapack/nhl_v1/data/officials.csv' };
  }).sort((a, b) => Number(a.nhl_game_id) - Number(b.nhl_game_id));
  const officials = { games: offRows.length, with_officials: offRows.filter((r) => r.referees).length, without_officials: offRows.filter((r) => !r.referees).map((r) => r.nhl_game_id), three_referees_listed: offRows.filter((r) => r.referees_listed === 3).length, distinct_referees: new Set(offRows.flatMap((r) => r.referees ? r.referees.split('; ') : [])).size, file: path.relative(C.ROOT, OFFICIALS), use: 'research only: no assignment time is recorded (known_at and assumed_available_at blank)' };

  const report = {
    schema: 'edgedesk_nhl_crosscheck_v2', season: SEASON, season_label: '2024-25',
    sources: { primary: 'NHL game feeds via sportsdataverse fastRhockey (my history)', second: 'ESPN public responses, full season, as delivered in the NHL data pack (datapack/nhl_v1, verified by tools/datapack/verify_nhl.js)' },
    games: { espn_club_games: games.length, nhl_feed_games: mineGames.size, matched: xwalk.length, unmatched: unmatched.length, unmatched_by_reason: unmatched.reduce((o, u) => inc(o, u.reason.replace(/\(.*\)/, '').trim()), {}), unmatched_examples: unmatched.slice(0, 12), neutral_site: neutral },
    results: { compared: res.compared, final_agree: res.final_agree, decided_agree: res.decided_agree, team_games: res.team_games, regulation_goals_agree: res.regulation_goals_agree, shootouts_espn: games.filter((e) => +e.home_final_score_native + +e.away_final_score_native - (+e.home_nonshootout_goals_from_pbp + +e.away_nonshootout_goals_from_pbp) === 1).length, disagreements: res.disagreements.slice(0, 20) },
    events,
    unblocked_attempts: att,
    goalies: Object.assign({}, goalies, { goals_against_explained_by_espn_sa: gaNotes, starter_disagreements_total: goalies.starter_disagreements.length, starter_disagreements_in_one_goalie_games: goalies.starter_disagreements.filter((d) => !d.note).length, starter_disagreements: goalies.starter_disagreements.slice(0, 12), goals_against_disagreements: goalies.goals_against_disagreements.slice(0, 12), shots_on_goal_disagreements: goalies.shots_on_goal_disagreements.slice(0, 8) }),
    skaters: Object.assign({}, sk, { disagreements: sk.disagreements.slice(0, 12) }),
    players: playersSec,
    officials,
    reading: [
      'Matched games prove the game id map; matched attempts carry both sources\' player ids, so the player crosswalk rests on id pairs, not names, wherever a player had an attempt.',
      'ESPN supplies no starter flag (native_starter_flag is blank), so "starter" is checked as the goalie with the most time on ice; a pulled starter is expected to differ.',
      'Neither source is "corrected" from the other: a disagreement is listed with examples.',
      'This is a consistency check of retrospective data, not a point-in-time certification.',
    ],
  };
  xwalk.sort((a, b) => Number(a.espn_game_id) - Number(b.espn_game_id));
  return { report, xwalk, pxRows, offRows };
}

async function write() {
  let prev = null; try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) {}
  if (prev && prev.schema !== 'edgedesk_nhl_crosscheck_v2') prev = null;
  const { report, xwalk, pxRows, offRows } = await reconcile(prev);
  fs.mkdirSync(path.dirname(XWALK), { recursive: true }); fs.mkdirSync(path.dirname(OFFICIALS), { recursive: true });
  fs.writeFileSync(XWALK, toCsv(['espn_game_id', 'nhl_game_id', 'home', 'away', 'espn_start', 'nhl_start', 'minutes_apart', 'basis'], xwalk));
  fs.writeFileSync(PXWALK, toCsv(['espn_player_id', 'nhl_player_id', 'espn_name', 'nhl_name', 'role', 'espn_games', 'basis'], pxRows));
  fs.writeFileSync(OFFICIALS, toCsv(['nhl_game_id', 'espn_game_id', 'date', 'home', 'away', 'referees', 'linesmen', 'referees_listed', 'known_at', 'assumed_available_at', 'pit', 'src'], offRows));
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
  const r = report;
  console.log('[nhl crosscheck espn] games matched ' + r.games.matched + '/' + r.games.espn_club_games + '; finals agree ' + r.results.final_agree + '; decided agree ' + r.results.decided_agree + '; regulation goals agree ' + r.results.regulation_goals_agree + '/' + r.results.team_games);
  console.log('  events: ' + (r.events.recomputed_at_run ? 'matched ' + r.events.matched + '/' + r.events.espn_attempts + '; coordinates within 1 ft of NHL raw ' + r.events.coordinates.share_within_1ft_of_nhl_raw + '; blocked shooter = shooter view ' + r.events.blocked.espn_shooter_team_is_shooter_view_team + '/' + r.events.blocked.matched + ' (= NHL event team ' + r.events.blocked.espn_shooter_team_is_nhl_event_team + '); ES is 5v5 ' + r.events.strength.even_strength_is_5v5_share + '; shot type agree ' + r.events.shot_type.agree_share : 'not recomputed (no cache)'));
  console.log('  unblocked attempts: exact ' + r.unblocked_attempts.exact + ', within 2 ' + r.unblocked_attempts.within_2 + ' of ' + r.unblocked_attempts.team_games);
  console.log('  goalies: most-TOI = my starter ' + r.goalies.most_toi_is_my_starter + '/' + r.goalies.team_games + '; GA agree ' + r.goalies.goals_against_agree + '/' + r.goalies.goalie_rows + '; SOG faced agree ' + r.goalies.shots_on_goal_agree + '/' + r.goalies.shots_on_goal_compared);
  console.log('  skaters: dressed agree ' + r.skaters.skaters_agree + '/' + r.skaters.team_games + '; player TOI exact ' + r.skaters.player_toi_exact + ', within 5 s ' + r.skaters.player_toi_within_5s + ' of ' + r.skaters.player_rows_mapped + ' mapped (' + r.skaters.player_rows + ' rows)');
  console.log('  players mapped ' + r.players.mapped + '/' + r.players.espn_players + ' ' + JSON.stringify(r.players.by_basis) + '; officials ' + r.officials.with_officials + '/' + r.officials.games + ' games');
  return r;
}

function check() {
  const r = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const fails = [];
  if (r.schema !== 'edgedesk_nhl_crosscheck_v2') fails.push('report schema is not v2');
  if (r.results.compared < 1300 || r.games.unmatched_by_reason['no NHL-feed game with these clubs within 6 h']) fails.push('an ESPN club game has no NHL-feed match');
  if (r.results.final_agree !== r.results.compared) fails.push((r.results.compared - r.results.final_agree) + ' finals disagree');
  if (r.results.decided_agree !== r.results.compared) fails.push((r.results.compared - r.results.decided_agree) + ' games decided differently');
  if (r.results.regulation_goals_agree !== r.results.team_games) fails.push('regulation goals disagree in ' + (r.results.team_games - r.results.regulation_goals_agree) + ' team-games');
  if (!(r.events.match_rate >= 0.99)) fails.push('fewer than 99% of ESPN attempts matched an NHL event');
  if (!(r.events.blocked.espn_shooter_team_is_shooter_view_team >= 0.99 * r.events.blocked.matched)) fails.push('blocked attempts are not credited to the shooter');
  if (!(r.events.blocked.frame.shooter_view_matches_period_frame >= 0.98 * r.events.blocked.frame.compared)) fails.push('blocked locations are not in the period frame');
  if (r.goalies.starter_disagreements_in_one_goalie_games !== 0) fails.push('a one-goalie team-game disagrees on the starter');
  if (!(r.events.coordinates.share_within_1ft_of_nhl_raw >= 0.98)) fails.push('ESPN coordinates no longer match the NHL raw frame');
  if (!(r.players.mapped >= 0.99 * r.players.espn_players) || r.players.nhl_id_mapped_twice) fails.push('the player crosswalk is incomplete or maps an NHL id twice');
  for (const f of [XWALK, PXWALK, OFFICIALS]) if (!fs.existsSync(f)) fails.push('missing ' + path.relative(C.ROOT, f));
  if (fails.length) { console.error('[nhl crosscheck --check] FAILED: ' + fails.join('; ')); process.exit(1); }
  console.log('[nhl crosscheck --check] ok: ' + r.results.compared + ' games, every final and decision agrees; ' + r.events.matched + ' attempts matched; blocked attempts credited to the shooter');
}

module.exports = { reconcile, fold, lastName };
if (require.main === module) { if (process.argv.includes('--check')) check(); else write().catch((e) => { console.error(e && e.stack || e); process.exit(1); }); }
