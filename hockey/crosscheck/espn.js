#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL — a second source against the first.

     node hockey/crosscheck/espn.js            (writes the report and the crosswalk)
     node hockey/crosscheck/espn.js --check    (the committed report still holds)

   My NHL history comes from the NHL's own feeds (via sportsdataverse). The
   data pack (datapack/quant_v1) carries an independent ESPN retrieval of the
   2024-25 season and samples of its goalie, skater and shot records. This
   job maps ESPN ids to NHL ids and reconciles what both sources record:

     games      every ESPN game matched by both clubs and a start within 6 h;
                the unmatched on either side, each with its reason
     results    the official final, and whether the game went past regulation
     goalies    for each sampled team-game: the goalie who played the most per
                ESPN vs my recorded starter; goals against per goalie
     attempts   unblocked attempts (shots + misses + goals, shootouts out) per
                team-game, ESPN sample vs my play-by-play count
     lineups    skaters dressed and their total TOI per team-game, ESPN
                sample vs my skater box (hockey/ingest/lineups.js)

   Writes hockey/validation/nhl_crosscheck_espn.json and the id map
   hockey/data/crosswalk/espn_nhl_<season>.csv. Disagreements are reported
   with examples; nothing is "corrected" from the other source.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const { readCsv, toCsv } = require('../../engine/csv');
const TG = require('../ingest/team_games');
const { loadLineups, toiSeconds } = require('../ingest/lineups');

const PACK = path.join(C.ROOT, 'datapack', 'quant_v1', 'data', 'nhl');
const SEASON = 2025; /* 2024-25: the season the pack retrieved */
const OUT = path.join(C.PATHS.validation, 'nhl_crosscheck_espn.json');
const XWALK = path.join(C.HOCKEY, 'data', 'crosswalk', 'espn_nhl_' + SEASON + '.csv');

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const lastName = (s) => { const p = String(s || '').trim().split(/\s+/); return fold(p[p.length - 1]); };

function clubIndex() {
  const t = require('../data/teams.json').teams; const idx = new Map();
  for (const [abbr, v] of Object.entries(t)) for (const n of [v.name].concat(v.aliases || [])) idx.set(fold(n), abbr);
  return idx;
}

function reconcile() {
  const clubs = clubIndex();
  const espnGames = readCsv(path.join(PACK, 'games_historical.csv')).rows;
  const mine = TG.loadTeamGames([SEASON]);
  const byPair = new Map(); const mineGames = new Map();
  for (const r of mine) {
    if (!mineGames.has(r.game_id)) mineGames.set(r.game_id, {});
    mineGames.get(r.game_id)[r.home ? 'h' : 'a'] = r;
  }
  for (const [id, g] of mineGames) {
    if (!g.h || !g.a) continue;
    const k = g.h.team + '|' + g.a.team;
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push({ id, g, t: Date.parse(g.h.start_utc) || Date.parse(g.h.date + 'T23:00:00Z') });
  }

  /* ESPN's season type per game, from the raw scoreboards the pack recorded */
  const espnType = new Map();
  for (const f of fs.readdirSync(path.join(PACK, 'raw')).filter((x) => /^scoreboard_.*\.json\.gz$/.test(x))) {
    const j = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(path.join(PACK, 'raw', f))).toString('utf8'));
    for (const e of j.events || []) espnType.set(String(e.id), e.season && e.season.slug);
  }
  const xwalk = []; const unmatched = []; const usedMine = new Set();
  const results = { compared: 0, final_agree: 0, past_regulation_agree: 0, disagreements: [] };
  for (const e of espnGames) {
    const h = clubs.get(fold(e.home_name)), a = clubs.get(fold(e.away_name));
    if (!h || !a) { unmatched.push({ espn_game_id: e.game_id, side: 'espn', reason: 'not an NHL club game (' + e.away_name + ' at ' + e.home_name + ')', status: e.status }); continue; }
    if (e.status !== 'STATUS_FINAL') { unmatched.push({ espn_game_id: e.game_id, side: 'espn', reason: 'ESPN status ' + e.status + ' (no result to match)', status: e.status }); continue; }
    const t = Date.parse(e.start_time.replace(/Z$/, ':00Z'));
    const cands = (byPair.get(h + '|' + a) || []).filter((x) => Math.abs(x.t - t) <= 6 * 3600e3 && !usedMine.has(x.id));
    if (cands.length !== 1) {
      const pre = !cands.length && espnType.get(String(e.game_id)) === 'preseason';
      unmatched.push({ espn_game_id: e.game_id, side: 'espn', reason: cands.length ? 'ambiguous: ' + cands.length + ' candidates' : pre ? 'preseason (my history excludes preseason by design)' : 'no NHL-feed game with these clubs within 6 h', home: h, away: a, start: e.start_time });
      continue;
    }
    const m = cands[0]; usedMine.add(m.id);
    xwalk.push({ espn_game_id: e.game_id, nhl_game_id: m.id, home: h, away: a, espn_start: e.start_time, nhl_start: m.g.h.start_utc, basis: 'both clubs; start within 6 h', minutes_apart: Math.round(Math.abs(m.t - t) / 60000) });
    results.compared++;
    const eh = Number(e.home_score), ea = Number(e.away_score);
    const finalOk = eh === m.g.h.gf && ea === m.g.a.gf;
    if (finalOk) results.final_agree++;
    /* ESPN's games table has no period count; past regulation is implied when the regulation score was level */
    const mineOT = m.g.h.decided !== 'REG';
    const regTied = m.g.h.gf_reg === m.g.a.gf_reg;
    if (mineOT === regTied) results.past_regulation_agree++;
    if (!finalOk) results.disagreements.push({ espn_game_id: e.game_id, nhl_game_id: m.id, espn: eh + '-' + ea, nhl_feed: m.g.h.gf + '-' + m.g.a.gf, decided: m.g.h.decided });
  }
  for (const [id, g] of mineGames) if (g.h && g.a && !usedMine.has(id)) unmatched.push({ nhl_game_id: id, side: 'nhl_feed', reason: 'no ESPN game matched', home: g.h.team, away: g.a.team, date: g.h.date, type: g.h.type });
  const xmap = new Map(xwalk.map((x) => [String(x.espn_game_id), x]));

  /* ESPN team id -> club, from the games table */
  const espnTeam = new Map();
  for (const e of espnGames) { const h = clubs.get(fold(e.home_name)), a = clubs.get(fold(e.away_name)); if (h) espnTeam.set(e.home_id, h); if (a) espnTeam.set(e.away_id, a); }
  const sideOf = (espnGameId, espnTeamId) => { const x = xmap.get(String(espnGameId)); if (!x) return null; const club = espnTeam.get(String(espnTeamId)); return club === x.home ? 'h' : club === x.away ? 'a' : null; };

  /* goalies */
  const names = JSON.parse(fs.readFileSync(C.PATHS.goalies, 'utf8'));
  const gRows = readCsv(path.join(PACK, 'goalie_game_observed_sample.csv')).rows;
  const byTG = new Map();
  for (const r of gRows) { const k = r.game_id + '|' + r.team_id; if (!byTG.has(k)) byTG.set(k, []); byTG.get(k).push(r); }
  const goalies = { team_games: 0, matched: 0, most_toi_is_my_starter: 0, starter_disagreements: [], goalie_rows: 0, goals_against_agree: 0, goals_against_disagreements: [], starter_flag_blank_in_espn: gRows.every((r) => r.native_starter_flag === '') };
  for (const [k, rows] of byTG) {
    const [gid, tid] = k.split('|'); const side = sideOf(gid, tid);
    goalies.team_games++;
    if (!side) continue;
    const mineRow = mineGames.get(xmap.get(gid).nhl_game_id)[side];
    goalies.matched++;
    const top = rows.slice().sort((x, y) => (toiSeconds(y.toi_native) || 0) - (toiSeconds(x.toi_native) || 0))[0];
    const starterName = names[String(mineRow.g_start)] || null;
    if (starterName && lastName(starterName) === lastName(top.goalie_name)) goalies.most_toi_is_my_starter++;
    else goalies.starter_disagreements.push({ nhl_game_id: mineRow.game_id, team: mineRow.team, espn_most_toi: top.goalie_name + ' (' + top.toi_native + ')', my_starter: starterName, note: rows.length > 1 ? 'two goalies played: a pulled starter is expected to differ' : null });
    for (const r of rows) {
      goalies.goalie_rows++;
      const mine = [1, 2].map((i) => ({ id: mineRow['g' + i + '_id'], ga: mineRow['g' + i + '_ga'] })).find((x) => x.id && lastName(names[String(x.id)]) === lastName(r.goalie_name));
      if (!mine) { goalies.goals_against_disagreements.push({ nhl_game_id: mineRow.game_id, team: mineRow.team, espn_goalie: r.goalie_name, reason: 'not among my goalies for this game' }); continue; }
      /* mine counts non-empty-net goals while in net; ESPN's GA is the same thing (empty-net goals are charged to no goalie) */
      if (Number(r.goals_against) === mine.ga) goalies.goals_against_agree++;
      else goalies.goals_against_disagreements.push({ nhl_game_id: mineRow.game_id, team: mineRow.team, goalie: r.goalie_name, espn_ga: Number(r.goals_against), my_ga: mine.ga });
    }
  }

  /* unblocked attempts */
  const shots = readCsv(path.join(PACK, 'shot_attempts_sample.csv')).rows;
  const espnUnb = new Map();
  for (const s of shots) {
    if (s.is_blocked === 'True') continue;
    if (Number(s.period) >= 5 && s.season_type_native === '2') continue; /* regular-season shootout */
    const side = sideOf(s.game_id, s.team_id); if (!side) continue;
    const k = s.game_id + '|' + side; espnUnb.set(k, (espnUnb.get(k) || 0) + 1);
  }
  const att = { team_games: 0, exact: 0, within_2: 0, mean_abs_diff: null, largest: [] };
  let sumAbs = 0; const diffs = [];
  for (const [k, n] of espnUnb) {
    const [gid, side] = k.split('|');
    const r = mineGames.get(xmap.get(gid).nhl_game_id)[side];
    const mineN = ['ev5_ff', 'evo_ff', 'pp_ff', 'sh_ff', 'enf_ff', 'ena_ff'].reduce((a, c) => a + (r[c] || 0), 0);
    const d = n - mineN; att.team_games++; if (d === 0) att.exact++; if (Math.abs(d) <= 2) att.within_2++; sumAbs += Math.abs(d);
    diffs.push({ nhl_game_id: r.game_id, team: r.team, espn: n, nhl_feed: mineN, diff: d });
  }
  att.mean_abs_diff = att.team_games ? +(sumAbs / att.team_games).toFixed(3) : null;
  att.largest = diffs.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff)).slice(0, 5);

  /* lineups */
  const LU = loadLineups([SEASON]);
  const sk = readCsv(path.join(PACK, 'player_game_deduplicated_sample.csv')).rows.filter((r) => r.category !== 'goalies');
  const espnLu = new Map();
  for (const r of sk) {
    const side = sideOf(r.game_id, r.team_id); if (!side) continue;
    let toi = null; try { toi = toiSeconds(JSON.parse(r.native_stats_json).TOI); } catch (_) {}
    const k = r.game_id + '|' + side; const v = espnLu.get(k) || { n: 0, toi: 0, unparsed: 0 };
    v.n++; if (toi == null) v.unparsed++; else v.toi += toi; espnLu.set(k, v);
  }
  const lu = { available: LU.absent.indexOf(SEASON) < 0, team_games: 0, skaters_agree: 0, toi_within_60s: 0, disagreements: [] };
  if (lu.available) for (const [k, v] of espnLu) {
    const [gid, side] = k.split('|'); const nid = xmap.get(gid).nhl_game_id;
    const g = LU.map.get(nid); if (!g) { lu.disagreements.push({ nhl_game_id: nid, reason: 'no box score in my lineups' }); continue; }
    const mineL = g[side === 'h' ? 'home' : 'away'];
    const mineToi = mineL.reduce((a, x) => a + (x[1] || 0), 0);
    lu.team_games++;
    if (mineL.length === v.n) lu.skaters_agree++;
    if (Math.abs(mineToi - v.toi) <= 60) lu.toi_within_60s++;
    if (mineL.length !== v.n || Math.abs(mineToi - v.toi) > 60) lu.disagreements.push({ nhl_game_id: nid, side, espn_skaters: v.n, my_skaters: mineL.length, espn_toi_s: v.toi, my_toi_s: mineToi });
  }

  const espnFinal = espnGames.filter((e) => e.status === 'STATUS_FINAL').length;
  const report = {
    schema: 'edgedesk_nhl_crosscheck_v1', season: SEASON, season_label: '2024-25',
    sources: { primary: 'NHL game feeds via sportsdataverse fastRhockey (my history)', second: 'ESPN, as retrieved in the data pack (datapack/quant_v1/data/nhl), research copy' },
    games: { espn_rows: espnGames.length, espn_final: espnFinal, nhl_feed_games: mineGames.size, matched: xwalk.length, unmatched: unmatched.length, unmatched_by_reason: unmatched.reduce((o, u) => { const r = u.reason.replace(/\(.*\)/, '').trim(); o[r] = (o[r] || 0) + 1; return o; }, {}), unmatched_examples: unmatched.slice(0, 12) },
    results: { compared: results.compared, final_agree: results.final_agree, past_regulation_agree: results.past_regulation_agree, disagreements: results.disagreements.slice(0, 20) },
    goalies: Object.assign({}, goalies, { starter_disagreements: goalies.starter_disagreements.slice(0, 12), goals_against_disagreements: goalies.goals_against_disagreements.slice(0, 12) }),
    unblocked_attempts: att,
    lineups: Object.assign({}, lu, { disagreements: lu.disagreements.slice(0, 12) }),
    reading: [
      'Matched games prove the id map; a final that disagrees would be a data error in one source and is listed, never overwritten.',
      'ESPN supplies no starter flag (native_starter_flag is blank), so "starter" is checked as the goalie with the most time on ice; a pulled starter is expected to differ.',
      'Attempt counts can differ by a few: the two feeds classify some blocked or wide attempts differently, and ESPN coordinates are unverified native units (not converted).',
      'This is a consistency check of retrospective data, not a point-in-time certification.',
    ],
  };
  return { report, xwalk };
}

function write() {
  const { report, xwalk } = reconcile();
  fs.mkdirSync(path.dirname(XWALK), { recursive: true });
  fs.writeFileSync(XWALK, toCsv(['espn_game_id', 'nhl_game_id', 'home', 'away', 'espn_start', 'nhl_start', 'minutes_apart', 'basis'], xwalk));
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
  const r = report;
  console.log('[nhl crosscheck espn] games matched ' + r.games.matched + '/' + r.games.espn_final + ' ESPN finals (' + r.games.nhl_feed_games + ' NHL-feed games); finals agree ' + r.results.final_agree + '/' + r.results.compared + '; past-regulation agree ' + r.results.past_regulation_agree);
  console.log('  goalies: most-TOI = my starter ' + r.goalies.most_toi_is_my_starter + '/' + r.goalies.matched + '; GA agree ' + r.goalies.goals_against_agree + '/' + r.goalies.goalie_rows);
  console.log('  unblocked attempts: exact ' + r.unblocked_attempts.exact + ', within 2 ' + r.unblocked_attempts.within_2 + ' of ' + r.unblocked_attempts.team_games + ' (mean |diff| ' + r.unblocked_attempts.mean_abs_diff + ')');
  console.log('  lineups: skaters agree ' + r.lineups.skaters_agree + '/' + r.lineups.team_games + ', TOI within 60 s ' + r.lineups.toi_within_60s);
  return r;
}

function check() {
  const r = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const fails = [];
  if (r.results.compared < 1300) fails.push('fewer than 1300 games matched');
  if (r.games.unmatched_by_reason['no NHL-feed game with these clubs within 6 h']) fails.push('an ESPN regular-season or playoff game has no NHL-feed match');
  if (r.results.final_agree !== r.results.compared) fails.push((r.results.compared - r.results.final_agree) + ' finals disagree');
  if (!fs.existsSync(XWALK)) fails.push('no crosswalk');
  if (fails.length) { console.error('[nhl crosscheck --check] FAILED: ' + fails.join('; ')); process.exit(1); }
  console.log('[nhl crosscheck --check] ok: ' + r.results.compared + ' games, every final agrees');
}

module.exports = { reconcile, fold, lastName };
if (require.main === module) { if (process.argv.includes('--check')) check(); else write(); }
