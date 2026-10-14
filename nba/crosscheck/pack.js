#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NBA — my 2025-26 feed against the NBA Data Pack, game by game.

     node nba/crosscheck/pack.js            writes nba/validation/nba_crosscheck_pack.json
     node nba/crosscheck/pack.js --check    recomputes; fails on any difference

   Two retrievals of one provider: my feed is sportsdataverse hoopR-nba-data
   (ESPN's feeds, compiled by a third party), the pack is ESPN's site API read
   directly (datapack/nba_v1, verified by tools/datapack/verify_nba.js). They
   are NOT independent sources — the same upstream can be wrong in both — but
   they are independent retrievals and parsers, so every disagreement is a
   parsing, scoping or retrieval error in one of them. Joined only on native
   ids: game_id, team_id, player_id (never names).

   Compared: the games (set, finals, start, teams, overtime, scope — the NBA
   Cup final included —, neutral site), period scores, team boxes (every
   counted stat), possessions (my Basketball-Reference estimator beside the
   pack's 0.44-FTA proxy), player boxes (who was listed, who played, starters,
   minutes, every counted stat, the DNP reason category), the shots (FGA and
   field-goal points per team-game from my play-by-play beside the pack's
   shooting plays and both boxes), and the minutes my lineup stints
   reconstruct beside the box score's.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const D = require('../lib/data');
const io = require('../lib/io');
const { reasonCat } = require('../ingest/season');

const PACK = path.join(C.ROOT, 'datapack', 'nba_v1');
const OUT = path.join(C.PATHS.validation, 'nba_crosscheck_pack.json');
const SEASON = 2026;
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
const pair = (v) => { const m = /^(\d+)-(\d+)$/.exec(String(v == null ? '' : v)); return m ? [Number(m[1]), Number(m[2])] : [null, null]; };
const r4 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
const count = (a, f) => { const m = {}; for (const x of a) { const k = f(x); m[k] = (m[k] || 0) + 1; } return m; };
const sorted = (m) => Object.fromEntries(Object.keys(m).sort().map((k) => [k, m[k]]));
async function load(table, cols) { const rows = []; for await (const r of io.parquetRows(path.join(PACK, 'data', table + '.parquet'), cols)) rows.push(r); return rows; }
function agree(pairs) { const n = pairs.length; const same = pairs.filter(([a, b]) => a === b).length; return { compared: n, agree: same, rate: n ? r4(same / n) : null }; }

async function run() {
  const out = { schema: 'edgedesk_nba_crosscheck_pack_v1', generated_at: new Date().toISOString(), season: '2025-26',
    sources: { mine: 'nba/data + .cache/nba_work (sportsdataverse hoopR-nba-data, from ESPN)', pack: 'datapack/nba_v1 (ESPN site API, collected 2026-10-14)', independence: 'two retrievals of one provider: agreement rules out parsing and retrieval errors, not an upstream error' } };
  const ver = JSON.parse(fs.readFileSync(path.join(PACK, 'EDGEDESK_VERIFICATION.json'), 'utf8'));
  out.pack_verification = { status: ver.status, checks: ver.summary.checks_passed + '/' + ver.summary.checks };

  /* games */
  const pg = await load('games', ['game_id', 'date', 'scope', 'home_id', 'away_id', 'home_score', 'away_score', 'last_scoring_period', 'venue', 'summary_available']);
  const mg = D.games([SEASON]).filter((g) => g.status === 'FINAL');
  const P = new Map(pg.map((g) => [g.game_id, g])), M = new Map(mg.map((g) => [String(g.game_id), g]));
  const both = [...P.keys()].filter((k) => M.has(k));
  const scopeOf = (g) => g.scope || (g.type === 'P' ? 'playoffs' : g.type === 'I' ? 'play_in' : 'regular_season');
  const venueCity = (g) => { try { return JSON.parse(g.venue).address.city; } catch (_) { return null; } };
  out.games = {
    pack: pg.length, mine: mg.length, matched: both.length,
    only_pack: [...P.keys()].filter((k) => !M.has(k)), only_mine: [...M.keys()].filter((k) => !P.has(k)),
    finals: agree(both.map((k) => [P.get(k).home_score + '-' + P.get(k).away_score, M.get(k).hs + '-' + M.get(k).as])),
    teams: agree(both.map((k) => [P.get(k).home_id + '@' + P.get(k).away_id, String(M.get(k).home_id) + '@' + String(M.get(k).away_id)])),
    start: agree(both.map((k) => [Date.parse(P.get(k).date), Date.parse(M.get(k).start_utc)])),
    overtimes: agree(both.map((k) => [num(P.get(k).last_scoring_period) - 4, Number(M.get(k).ot)])),
    scope: { agree: agree(both.map((k) => [P.get(k).scope, scopeOf(M.get(k))])), mine_vs_pack: sorted(count(both.filter((k) => P.get(k).scope !== scopeOf(M.get(k))), (k) => scopeOf(M.get(k)) + ' (mine) vs ' + P.get(k).scope + ' (pack)')) },
    neutral_site: { las_vegas_games: both.filter((k) => venueCity(P.get(k)) === 'Las Vegas').length, flagged_neutral_by_me: both.filter((k) => venueCity(P.get(k)) === 'Las Vegas' && M.get(k).neutral).length,
      my_other_neutral: both.filter((k) => venueCity(P.get(k)) !== 'Las Vegas' && M.get(k).neutral).map((k) => ({ game_id: k, city: venueCity(P.get(k)) })) },
  };

  /* period scores */
  const per = await load('period_scores', ['game_id', 'team_id', 'period', 'points']);
  const pp = new Map(); for (const r of per) pp.set(r.game_id + '|' + r.team_id + '|' + r.period, num(r.points));
  const perPairs = [];
  for (const k of both) { const g = M.get(k); for (const [side, tid] of [['h', g.home_id], ['a', g.away_id]]) { for (let q = 1; q <= 4; q++) perPairs.push([pp.get(k + '|' + tid + '|' + q), g[side + '_q' + q]]); let ot = 0; for (let q = 5; q <= 10; q++) ot += pp.get(k + '|' + tid + '|' + q) || 0; perPairs.push([ot, g[side + '_ot']]); } }
  out.period_scores = agree(perPairs);

  /* team boxes and possessions */
  const tb = await load('team_boxscores', ['game_id', 'team_id', 'fieldGoalsMade-fieldGoalsAttempted', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'freeThrowsMade-freeThrowsAttempted', 'offensiveRebounds', 'defensiveRebounds', 'assists', 'steals', 'blocks', 'turnovers', 'totalTurnovers', 'teamTurnovers', 'fouls', 'pointsInPaint', 'fastBreakPoints', 'turnoverPoints']);
  const tm = await load('team_measured_features', ['game_id', 'team_id', 'possessions_proxy']);
  const TB = new Map(tb.map((r) => [r.game_id + '|' + r.team_id, r])), TMF = new Map(tm.map((r) => [r.game_id + '|' + r.team_id, num(r.possessions_proxy)]));
  const mtg = D.teamGames([SEASON]); const MT = new Map(mtg.map((r) => [String(r.game_id) + '|' + String(r.team_id), r]));
  const keysT = [...TB.keys()].filter((k) => MT.has(k));
  const stat = {};
  const add = (name, a, b) => { (stat[name] = stat[name] || []).push([a, b]); };
  for (const k of keysT) {
    const p = TB.get(k), m = MT.get(k);
    const [fg, fga] = pair(p['fieldGoalsMade-fieldGoalsAttempted']), [th, tha] = pair(p['threePointFieldGoalsMade-threePointFieldGoalsAttempted']), [ft, fta] = pair(p['freeThrowsMade-freeThrowsAttempted']);
    add('fgm', fg, m.fgm); add('fga', fga, m.fga); add('fg3m', th, m.fg3m); add('fg3a', tha, m.fg3a); add('ftm', ft, m.ftm); add('fta', fta, m.fta);
    add('oreb', num(p.offensiveRebounds), m.oreb); add('dreb', num(p.defensiveRebounds), m.dreb); add('ast', num(p.assists), m.ast); add('stl', num(p.steals), m.stl); add('blk', num(p.blocks), m.blk);
    add('pf', num(p.fouls), m.pf); add('paint_pts', num(p.pointsInPaint), m.paint_pts); add('fb_pts', num(p.fastBreakPoints), m.fb_pts); add('pts_off_tov', num(p.turnoverPoints), m.pts_off_tov);
    add('tov (vs pack turnovers)', num(p.turnovers), m.tov); add('tov (vs pack totalTurnovers)', num(p.totalTurnovers), m.tov);
  }
  out.team_box = { team_games: keysT.length, pack_only: [...TB.keys()].filter((k) => !MT.has(k)).length, mine_only: [...MT.keys()].filter((k) => !TB.has(k)).length, by_stat: Object.fromEntries(Object.entries(stat).map(([k, v]) => [k, agree(v)])),
    disagreements: keysT.flatMap((k) => ['ast', 'pf', 'paint_pts', 'fb_pts', 'pts_off_tov'].map((st) => { const p = TB.get(k), m = MT.get(k); const pv = num(p[{ ast: 'assists', pf: 'fouls', paint_pts: 'pointsInPaint', fb_pts: 'fastBreakPoints', pts_off_tov: 'turnoverPoints' }[st]]); return pv !== m[st] ? { game_id: k.split('|')[0], team_id: k.split('|')[1], stat: st, mine: m[st], pack: pv } : null; }).filter(Boolean)),
    note: 'my tov is the team total (players + team turnovers), the pack\'s totalTurnovers; its `turnovers` excludes team turnovers.' };
  /* where they differ: are all the disagreements on team-games carrying an athlete the source gave no id? */
  const unTG = new Set((await load('unresolved_player_identity_records', ['game_id', 'team_id'])).map((u) => u.game_id + '|' + u.team_id));
  const dTG = [...new Set(out.team_box.disagreements.map((d) => d.game_id + '|' + d.team_id))];
  out.team_box.disagreements_on_unidentified_team_games = dTG.filter((k) => unTG.has(k)).length + ' of ' + dTG.length;
  out.team_box.disagreement_note = dTG.every((k) => unTG.has(k))
    ? 'every disagreement is on a team-game where the source listed an athlete without an id: my feed\'s team totals leave his line out, the pack\'s (ESPN\'s team statistics) keep it — the team statistics are the complete record there'
    : 'not every disagreement sits on a team-game with an unidentified athlete: see the list';
  const dp = keysT.map((k) => [MT.get(k).poss, TMF.get(k)]).filter(([a, b]) => a != null && b != null);
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length; const ma = mean(dp.map((x) => x[0])), mb = mean(dp.map((x) => x[1]));
  const cov = mean(dp.map(([a, b]) => (a - ma) * (b - mb))), sa = Math.sqrt(mean(dp.map(([a]) => (a - ma) ** 2))), sb = Math.sqrt(mean(dp.map(([, b]) => (b - mb) ** 2)));
  out.possessions = { team_games: dp.length, mine_bbref_mean: r4(ma), pack_044_proxy_mean: r4(mb), mean_difference: r4(ma - mb), correlation: r4(cov / (sa * sb)), mean_abs_difference: r4(mean(dp.map(([a, b]) => Math.abs(a - b)))),
    note: 'mine: Basketball-Reference (0.4·FTA, the offensive-rebound share applied to misses, both teams averaged); pack: FGA − ORB + TOV + 0.44·FTA averaged. Both are estimators, not counted possessions.' };

  /* player boxes */
  const pb = await load('player_boxscores', ['game_id', 'team_id', 'player_id', 'MIN', 'PTS', 'REB', 'AST', 'TO', 'STL', 'BLK', 'OREB', 'DREB', 'PF', '+/-', 'FG', '3PT', 'FT', 'starter', 'did_not_play', 'reason']);
  const PB = new Map(pb.filter((r) => r.player_id != null).map((r) => [r.game_id + '|' + r.player_id, r]));
  const mp = D.playerGames(SEASON); const MP = new Map(mp.map((r) => [String(r.g) + '|' + String(r.p), r]));
  const keysP = [...PB.keys()].filter((k) => MP.has(k));
  const onlyMine = [...MP.keys()].filter((k) => !PB.has(k)); const onlyPack = [...PB.keys()].filter((k) => !MP.has(k));
  const pst = {}; const addp = (n, a, b) => { (pst[n] = pst[n] || []).push([a, b]); };
  for (const k of keysP) {
    const p = PB.get(k), m = MP.get(k); const played = p.did_not_play !== 'True' && p.MIN != null;
    addp('listed_team', p.team_id, String(m.tm)); addp('played', played ? 1 : 0, m.pl ? 1 : 0); addp('starter', p.starter === 'True' ? 1 : 0, m.st ? 1 : 0);
    if (p.did_not_play === 'True') addp('dnp_reason_category', reasonCat(p.reason), m.rc);
    if (!played || !m.pl) continue;
    const [fg, fga] = pair(p.FG), [th, tha] = pair(p['3PT']), [ft, fta] = pair(p.FT);
    addp('minutes', num(p.MIN), m.min); addp('pts', num(p.PTS), m.pts); addp('fgm', fg, m.fgm); addp('fga', fga, m.fga); addp('fg3m', th, m.f3m); addp('fg3a', tha, m.f3a); addp('ftm', ft, m.ftm); addp('fta', fta, m.fta);
    addp('oreb', num(p.OREB), m.or); addp('dreb', num(p.DREB), m.dr); addp('ast', num(p.AST), m.ast); addp('stl', num(p.STL), m.stl); addp('blk', num(p.BLK), m.blk); addp('tov', num(p.TO), m.tov); addp('pf', num(p.PF), m.pf); addp('plus_minus', num(p['+/-']), m.pm);
  }
  const missingGames = new Set(JSON.parse(fs.readFileSync(path.join(PACK, 'COVERAGE.json'), 'utf8')).missing_detail_games.map((x) => x.game_id));
  const playedOff = keysP.filter((k) => { const p = PB.get(k), m = MP.get(k); return (p.did_not_play !== 'True' && p.MIN != null) !== !!m.pl; });
  const playedWhy = sorted(count(playedOff, (k) => { const p = PB.get(k), m = MP.get(k); return 'pack MIN ' + p.MIN + ', did_not_play ' + p.did_not_play + ' | mine played ' + m.pl; }));
  out.player_box = { played_disagreements: playedWhy, played_note: 'a box row with minutes "--" and no DNP flag never entered the game (my stints never put him on court): mine reads it as not played, the pack leaves it unflagged',
    pack_rows_with_id: PB.size, pack_rows_without_id: pb.length - PB.size, mine: MP.size, matched: keysP.length,
    only_mine: { rows: onlyMine.length, in_the_four_games_the_pack_lacks: onlyMine.filter((k) => missingGames.has(k.split('|')[0])).length, elsewhere: onlyMine.filter((k) => !missingGames.has(k.split('|')[0])).slice(0, 50) },
    only_pack: onlyPack.slice(0, 50), only_pack_rows: onlyPack.length,
    by_field: Object.fromEntries(Object.entries(pst).map(([k, v]) => [k, agree(v)])) };
  /* the pack's unidentified rows: what my feed has for that team-game that the pack does not */
  const un = await load('unresolved_player_identity_records', ['game_id', 'team_id', 'native_athlete', 'native_stats']);
  const players = D.playersMap();
  out.unidentified_rows = un.map((u) => {
    const mine = mp.filter((r) => String(r.g) === u.game_id && String(r.tm) === u.team_id && !PB.has(String(r.g) + '|' + String(r.p)));
    let short = null; try { short = JSON.parse(u.native_athlete).shortName; } catch (_) {}
    return { game_id: u.game_id, team_id: u.team_id, pack_short_name: short, my_rows_absent_from_pack: mine.map((r) => ({ player_id: String(r.p), name: (players[r.p] || {}).name || null, played: !!r.pl, min: r.min, pts: r.pts })) };
  });
  const resolved = out.unidentified_rows.filter((u) => u.my_rows_absent_from_pack.length === 1);
  out.unidentified_summary = { rows: un.length, one_candidate_in_my_feed: resolved.length, candidate_ids: sorted(count(resolved, (u) => u.my_rows_absent_from_pack[0].player_id + ' ' + (u.my_rows_absent_from_pack[0].name || ''))),
    note: 'my feed carries an id for the athlete the pack lost; the pack is still never joined by name — this only says which record the pack is missing' };

  /* shots: FGA and field-goal points per team-game */
  const myShots = D.shots(SEASON); const cols = myShots.cols; const ix = (c) => cols.indexOf(c);
  const myFga = new Map(), myFgPts = new Map();
  for (const r of myShots.rows) { const k = String(r[ix('g')]) + '|' + String(r[ix('tm')]); myFga.set(k, (myFga.get(k) || 0) + 1); if (r[ix('mk')]) myFgPts.set(k, (myFgPts.get(k) || 0) + (r[ix('v')] || 0)); }
  const pkFga = new Map(), pkFgPts = new Map();
  for await (const r of io.parquetRows(path.join(PACK, 'data', 'shots_and_free_throws.parquet'), ['game_id', 'team_id', 'points_attempted', 'scoring_play', 'score_value'])) {
    const pa = num(r.points_attempted); if (pa !== 2 && pa !== 3) continue; const k = r.game_id + '|' + r.team_id;
    pkFga.set(k, (pkFga.get(k) || 0) + 1); if (r.scoring_play === 'True') pkFgPts.set(k, (pkFgPts.get(k) || 0) + (num(r.score_value) || 0));
  }
  const boxFgPts = (m) => 2 * m.fgm + m.fg3m;
  const fgaBox = keysT.map((k) => [k, MT.get(k)]);
  const vsBox = (fga, pts, label) => {
    const rows = fgaBox.filter(([k]) => fga.has(k));
    const dF = rows.map(([k, m]) => fga.get(k) - m.fga), ptsOff = rows.filter(([k, m]) => (pts.get(k) || 0) !== boxFgPts(m));
    return { source: label, team_games: rows.length, fga_equal_box: dF.filter((d) => d === 0).length, fga_minus_box: sorted(count(dF, (d) => d)),
      fg_points_equal_box: rows.length - ptsOff.length, fg_points_differ_games: [...new Set(ptsOff.map(([k]) => k.split('|')[0]))].sort() };
  };
  out.shots = { team_games: fgaBox.length, mine: vsBox(myFga, myFgPts, 'my play-by-play (hoopR)'), pack: vsBox(pkFga, pkFgPts, 'the pack\'s shooting plays (ESPN site API)'),
    both_pbp_fga_equal: agree(fgaBox.filter(([k]) => myFga.has(k) && pkFga.has(k)).map(([k]) => [myFga.get(k), pkFga.get(k)])),
    note: 'Both retrievals log the same attempts (the play-by-play is one upstream record). The play-by-play counts about one attempt more than the box in roughly a third of team-games while made field goals agree: an upstream definitional gap (a shot the box does not count as an attempt), not a parser error. Where field-goal points differ, the play-by-play is missing a made shot (the incomplete games under the pack verification\'s findings). Shot-zone features use shares of logged attempts, so a uniform extra attempt barely moves them.' };

  /* minutes from my reconstructed stints beside the box score's whole minutes */
  const st = D.stints(SEASON); const sec = new Map();
  for (const g of st.games) for (const s of g.s) { const d = s[1] - s[0]; for (const pid of String(s[2]).split(' ').concat(String(s[3]).split(' '))) { const k = g.g + '|' + pid; sec.set(k, (sec.get(k) || 0) + d); } }
  const mm = keysP.map((k) => [sec.get(k), num(PB.get(k).MIN)]).filter(([a, b]) => a != null && b != null);
  const ae = mm.map(([a, b]) => Math.abs(a / 60 - b));
  out.stint_minutes = { player_games: mm.length, mae_minutes: r4(mean(ae)), within_1_minute: r4(ae.filter((x) => x <= 1).length / ae.length), over_3_minutes: ae.filter((x) => x > 3).length,
    note: 'the box reports whole minutes, so a reconstruction exact to the second differs by up to one minute from rounding alone' };

  /* summary */
  const f = [];
  f.push(out.games.matched + ' of ' + out.games.pack + ' games matched; finals agree in ' + out.games.finals.agree + ', teams in ' + out.games.teams.agree + ', overtimes in ' + out.games.overtimes.agree + '.');
  f.push('Scope: ' + out.games.scope.agree.agree + ' of ' + out.games.scope.agree.compared + ' agree' + (Object.keys(out.games.scope.mine_vs_pack).length ? ' (' + Object.entries(out.games.scope.mine_vs_pack).map(([k, v]) => v + '× ' + k).join('; ') + ')' : '') + '.');
  f.push('Player rows: ' + out.player_box.matched + ' matched on (game, player); ' + out.player_box.only_mine.in_the_four_games_the_pack_lacks + ' of my rows sit in the four games whose summaries the pack could not fetch.');
  out.summary = f;
  return out;
}

async function main() {
  const r = await run();
  if (process.argv.includes('--check')) {
    const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
    const strip = (o) => JSON.stringify(Object.assign({}, o, { generated_at: null }));
    if (!prev || strip(prev) !== strip(r)) { console.error('[nba crosscheck pack --check] FAILED: differs from the committed nba/validation/nba_crosscheck_pack.json'); process.exit(1); }
    console.log('[nba crosscheck pack --check] ok'); return;
  }
  fs.mkdirSync(C.PATHS.validation, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(r, null, 1) + '\n');
  for (const s of r.summary) console.log('[nba crosscheck pack] ' + s);
}
module.exports = { run, OUT };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
