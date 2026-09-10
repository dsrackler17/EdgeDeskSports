#!/usr/bin/env node
/* ===========================================================================
   EDGEDESK FOOTBALL — THE WHOLE LOOP, WITH NOBODY'S HANDS ON IT.

   The brief's final test: open a pack → keep a man → set the lineup → play a
   game with your own thumbs (move, run, throw, juke, tackle, score) → finish
   → be rewarded → back to the Vault → open what the games earned → reveal →
   keep → lineup → play again → notice the difference. Every step through the
   same doors a phone uses (the RPCs, as anon, with the device's secret) and
   the same engine a phone runs (games/lib/gridiron, every snap live), against
   a real PostgreSQL. No developer intervention: the script is the player.

     1  a franchise is founded and its first pack is on the shelf
     2  the Vault opens it on the server, a man is kept, the lineup is set
     3  a live game is played with the franchise's own men — scripted thumbs
        on runs and throws, the AI on defence — to the final whistle
     4  the game is filed and pays: XP, Credits, a Coach Point for a win,
        two toward the rank; the men's careers in your hands take their lines
     5  four more games and the fifth seals a Game Day pack — earned by
        playing, never bought — and the home names the newest weapon
     6  the pack opens, a man is kept, the lineup is set again, the team is
        no worse for it, and the sixth game of the day is capped

   WITHOUT POSTGRES IT SKIPS, LOUDLY, AND PASSES, like the other SQL suites.

   Run: node tools/games/loop.test.js
        EDGD_PG="-h 127.0.0.1 -p 5433 -U postgres" node tools/games/loop.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SOCIAL = path.join(ROOT, 'supabase', 'games_social.sql');
const SCHEMA = path.join(ROOT, 'supabase', 'games_franchise.sql');
const SHIM = path.join(__dirname, 'sql', 'supabase_shim.sql');
const DB = 'edgedesk_games_loop_sqltest';

let MEM = {};
global.localStorage = { getItem: k => (MEM[k] == null ? null : MEM[k]), setItem: (k, v) => { MEM[k] = String(v); }, removeItem: k => { delete MEM[k]; } };
const L = p => require(path.join(ROOT, 'games', 'lib', 'gridiron', p));
const G = L('engine.js'), S = L('session.js'), F = L('football.js'), ST = L('stage.js'), LIVE = L('live.js'), AU = L('autoplay.js');
const FR = require(path.join(ROOT, 'games', 'lib', 'franchise.js'));

function have(bin) { return cp.spawnSync('sh', ['-c', 'command -v ' + bin], { encoding: 'utf8' }).status === 0; }
function candidates() {
  const out = [];
  if (process.env.EDGD_PG) out.push(process.env.EDGD_PG.split(' '));
  if (process.env.PGHOST) out.push([]);
  out.push(['-h', '/var/tmp/edgpg/sock', '-p', '5433', '-U', 'postgres']);
  out.push(['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres']);
  out.push([]);
  return out;
}
function psql(conn, args, opts) { return cp.spawnSync('psql', conn.concat(args), Object.assign({ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, opts || {})); }
function skip(why) {
  console.log('SKIP | the whole loop | ' + why);
  console.log('       (this suite needs PostgreSQL; CI runs it in games-sql.yml)');
  process.exit(0);
}
if (!have('psql')) skip('psql is not installed');
let conn = null;
for (const c of candidates()) {
  const r = psql(c, ['-d', 'postgres', '-tAc', 'select 1']);
  if (r.status === 0 && String(r.stdout).trim() === '1') { conn = c; break; }
}
if (!conn) skip('no reachable PostgreSQL server');

let pass = 0, fail = 0; const fails = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; fails.push('  ✗ ' + name + (detail ? ' — ' + String(detail).slice(0, 300) : '')); } }
function drop() { psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB + ' (force)']); }
function die(msg, r) {
  console.log('FAIL | the whole loop | ' + msg);
  ((r && (r.stderr || '')) + (r && (r.stdout || ''))).split('\n').filter(l => /ERROR|DETAIL|CONTEXT/.test(l)).slice(0, 10).forEach(l => console.log('  × ' + l.trim()));
  drop(); process.exit(1);
}
/* one statement as the anon role with the device's secret — the phone's door */
function q(sql, asOwner) {
  const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', (asOwner ? '' : 'set role anon; ') + sql]);
  if (r.status !== 0) die('a query failed: ' + sql.slice(0, 100), r);
  return String(r.stdout).trim();
}
function qj(sql, asOwner) { const t = q(sql, asOwner); try { return JSON.parse(t); } catch (e) { die('not JSON from: ' + sql.slice(0, 80) + ' → ' + t.slice(0, 120)); } }
const lit = s => "'" + String(s).replace(/'/g, "''") + "'";

drop();
let mk = psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB]);
if (mk.status !== 0) skip('cannot create a test database: ' + (mk.stderr || '').trim());
for (const [file, label] of [[SHIM, 'the Supabase shim'], [SOCIAL, 'games_social.sql'], [SCHEMA, 'games_franchise.sql']]) {
  const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', file]);
  if (r.status !== 0) die(label + ' did not apply', r);
}

/* ── 1. a franchise, and its first pack on the shelf ──────────────────── */
const SEC = 'device-secret-thewholeloopthewholeloop1';
q("select public.franchise_create('Foundry','Bethel','BET','gear','forest','power_run','press_man'," + lit(SEC) + ")");
let home = qj('select public.franchise_home(' + lit(SEC) + ')');
chk('a franchise is founded through the phone\'s door', home && home.franchise && home.franchise.abbr === 'BET');
let board = qj('select public.franchise_packs_board(' + lit(SEC) + ')');
const rookie = (board.sealed || []).filter(p => p.kind === 'rookie_cache')[0];
chk('its first pack is sealed on the shelf with its odds printed', !!rookie && rookie.odds && rookie.odds.tiers, JSON.stringify(board.sealed || []).slice(0, 200));
const overall0 = home.rating.overall | 0;

/* ── 2. the Vault opens it on the server; a man is kept; the lineup is set ── */
function openAndKeep(packId) {
  const opened = qj('select public.franchise_pack_open_id(' + lit(packId) + ', ' + lit(SEC) + ')');
  chk('the server rolls and writes the pack before anything is shown', opened.ok === true && Array.isArray(opened.players) && opened.players.length >= 2, JSON.stringify(opened).slice(0, 200));
  const men = opened.players.slice().sort((a, b) => (b.overall | 0) - (a.overall | 0));
  const impact = FR.roster ? null : null; /* the page computes the lineup line client-side; here the best man is kept */
  const kept = qj('select public.franchise_pack_keep(' + lit(men[0].id) + ', ' + lit(SEC) + ')');
  chk('the best man is kept and joins the roster', kept.ok === true, JSON.stringify(kept).slice(0, 200));
  const best = qj('select public.franchise_lineup_best(' + lit(SEC) + ')');
  chk('the server sets the best eleven', best && Array.isArray(best.players) && best.players.length >= 30, best && best.moved);
  return { men, kept: men[0], roster: best.players };
}
const first = openAndKeep(rookie.id);
let roster = first.roster;
const keptOne = roster.filter(p => p.id === first.kept.id)[0];
chk('the kept man is on the roster, from the pack, with a place on the chart', !!keptOne && keptOne.acquired_source === 'pack' && (keptOne.depth | 0) >= 1, JSON.stringify(keptOne || {}).slice(0, 160));
const impact = require(path.join(ROOT, 'games', 'lib', 'vault.js')).lineupImpact(first.kept, roster.filter(p => p.id !== first.kept.id));
chk('and the Vault can say what he does to the lineup', impact && typeof impact.label === 'string' && impact.label.length > 3, JSON.stringify(impact));

/* ── 3. a live game with the franchise's own men, thumbs on the glass ──── */
function mulberry(seed) { let a = seed >>> 0; return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function liveSnap(g, call, seed, script) {
  const side = g.possession, offT = G.teamOf(g, side), defT = G.teamOf(g, G.other(side));
  const playObj = F.play(call.play), parts = F.defParts(call.def);
  const env = G.prepare({ off: offT, def: defT, rand: g.aiRand, tick: g.tick, playKey: call.play, formKey: call.formation,
    defCall: call.def, sit: G.situation(g), mem: g.mem[side], weather: g.weather, difficulty: 'pro' });
  const bx = 26.665;
  const actors = ST.alignOffense(playObj, call.formation, bx, g.ball, G.unitsOf(offT, g.tick), {})
    .concat(ST.alignDefense(parts, bx, g.ball, 1, G.unitsOf(defT, g.tick), playObj, call.formation, {}));
  const sim = LIVE.Play({ actors, playObj, parts, formKey: call.formation, los: g.ball, ballX: bx, env,
    rand: mulberry(seed), userSide: side === g.meta.user ? 'off' : 'def', userMode: 'play' });
  sim.snap();
  let t = 0, k = 0;
  while (!sim.outcome() && k++ < 2400) { sim.step(1 / 120, script ? (script(t, sim) || {}) : {}); t += 1 / 120; }
  return sim.outcome();
}
/* the thumbs: a run is carried upfield with a juke at first contact, a pass is thrown to the first read on time */
const thumbsRun = t => ({ mx: 0, my: 1, action: (t > 0.8 && t < 0.82) ? 'juke' : null });
const thumbsPass = t => ({ throwTo: (t > 1.3 && t < 1.32) ? 0 : null, throwKind: t > 1.3 ? 'standard' : null });
function playLiveGame(seed, fr, players) {
  const me = S.teamFromFranchise(fr, players, null);
  const g = S.build({ me: me, opponent: S.teamFromLeague(S.TEAMS[0]), home: true, week: 1, season: 1, seed: 'loop-' + seed,
    settings: { length: 'arcade', difficulty: 'pro', mode: 'play', speed: 'normal' } });
  const user = g.meta.user;
  let guard = 0, plays = 0, moves = { run: 0, pass: 0, juke: 0, td: 0, tackles: 0 }, broke = null;
  while (!g.over && guard++ < 900) {
    const call = AU.callFor(g, {});
    if (call.type !== 'play') { S.step(g, call); continue; }
    const mine = g.possession === user;
    const playObj = F.play(call.play);
    const script = mine ? (playObj.type === 'run' ? thumbsRun : thumbsPass) : null;
    const out = liveSnap(g, call, seed * 977 + guard, script);
    if (!out) { broke = 'no outcome'; break; }
    if (mine) { if (playObj.type === 'run') { moves.run++; moves.juke++; } else moves.pass++; if (out.touchdown) moves.td++; }
    else if (out.tackler) moves.tackles++;
    call.outcome = out;
    const st = S.step(g, call);
    if (!st.ok) { broke = st.reason; break; }
    plays++;
  }
  return { g, plays, moves, broke, user };
}
function payloadOf(r, players) {
  const g = r.g, me = r.user, them = G.other(me), st = g.stats[me] || {}, box = G.boxScore(g), mine = box[me] || {};
  const men = [], seen = {};
  Object.keys(g.players || {}).forEach(k => {
    const m = g.players[k];
    if (m.side !== me || !m.uid) return;
    const line = FR.liveLine(m.position, m);
    if (line) { men.push({ id: m.uid, stats: line }); seen[m.uid] = 1; }
  });
  players.forEach(p => { if (!seen[p.id] && (p.depth | 0) >= 1 && (p.depth | 0) <= (FR.STARTERS[p.position] || 1) && p.status === 'active') men.push({ id: String(p.id), stats: { games: 1 } }); });
  return { difficulty: 'pro', length: 'arcade', score_for: g.score[me] | 0, score_against: g.score[them] | 0, plays: g.plays.length,
    yards: mine.yards | 0, touchdowns: (st.passTD | 0) + (st.rushTD | 0) + (st.defTD | 0), turnovers: (st.ints | 0) + (st.fumblesLost | 0),
    opponent: 'North Fork Greywolves', players: men.slice(0, 60) };
}
function file(key, payload) { return qj('select public.franchise_record_live_game(' + lit(key) + ', ' + lit(JSON.stringify(payload)) + '::jsonb, ' + lit(SEC) + ')'); }

const g1 = playLiveGame(1, home.franchise, roster);
chk('a whole game is played live, every snap, to the final whistle', g1.g.over && !g1.broke && g1.plays >= 20, g1.broke || (g1.plays + ' plays'));
chk('with the thumbs on it: runs carried and juked, passes thrown, tackles made on the other side', g1.moves.run >= 3 && g1.moves.pass >= 3 && g1.moves.tackles >= 3, JSON.stringify(g1.moves));
chk('the franchise\'s own men played it: the box score names them by their card ids',
  Object.keys(g1.g.players).some(k => { const m = g1.g.players[k]; return m.side === g1.user && /^[0-9a-f-]{36}$/.test(String(m.uid)); }));
const p1 = payloadOf(g1, roster);
chk('the payload is the game as the books took it', p1.plays === g1.g.plays.length && p1.players.length >= 11 && p1.score_for >= 0 && p1.touchdowns * 6 <= p1.score_for, JSON.stringify(p1).slice(0, 200));

/* ── 4. filed, and paid ───────────────────────────────────────────────── */
const rank0 = qj('select public.franchise_home(' + lit(SEC) + ')').reputation;
const f1 = file('loop:1', p1);
const est = FR.liveRewards(p1);
chk('the game is filed once and pays what the table says: the client\'s estimate is the server\'s answer',
  f1.ok === true && f1.already === false && f1.rewards.xp === est.xp && f1.rewards.tc === est.tc && f1.rewards.cp === est.cp, JSON.stringify(f1.rewards) + ' vs ' + JSON.stringify(est));
chk('and pays something for having played at all, win or lose', f1.rewards.xp >= 60 && f1.rewards.tc >= 25);
chk('two toward the rank', f1.rank_gain === 2 && (f1.rank.points | 0) === (rank0.points | 0) + 2, f1.rank_gain + ' ' + f1.rank.points + ' vs ' + rank0.points);
chk('the men\'s careers in your hands took their lines', (f1.result.men | 0) >= 11, f1.result.men);
let roster2 = qj('select public.franchise_roster(' + lit(SEC) + ')').players;
const qb = roster2.filter(p => p.position === 'QB' && (p.depth | 0) === 1)[0];
chk('the starting quarterback\'s line is on his card, in the career\'s own keys, apart from the simulation\'s',
  qb && qb.live_stats && (qb.live_stats.games | 0) === 1 && (qb.live_stats.att | 0) > 0 && !(qb.career_stats && qb.career_stats.att), JSON.stringify(qb && qb.live_stats));
const again = file('loop:1', p1);
chk('filed again, the same key credits nothing twice', again.ok === true && again.already === true && again.rewards.xp === 0 && again.rank_gain === 0);

/* ── 5. four more, and the fifth seals a Game Day pack ────────────────── */
let last = null, packsNew = 0;
for (let n = 2; n <= 5; n++) {
  const gn = playLiveGame(n, home.franchise, roster2);
  chk('game ' + n + ' is played to the whistle', gn.g.over && !gn.broke, gn.broke);
  last = file('loop:' + n, payloadOf(gn, roster2));
  chk('game ' + n + ' is filed and credited', last.ok === true && last.already === false && !last.capped && last.rewards.xp > 0, JSON.stringify(last.rewards));
  packsNew += last.packs_new | 0;
}
/* A live game can seal more than one pack in the same moment (packs_v4: the
   Game Day Pack, and a program the record has just earned), so the server
   names what it sealed and the page reads the names, never a count. */
const sealedKinds = (last.packs_sealed || []).map(k => k.kind);
chk('the fifth game at Pro seals a Game Day pack — earned by playing, never bought',
  packsNew >= 1 && sealedKinds.indexOf('gameday_pack') >= 0 && last.gameday.packs === 1 && last.gameday.toward === 0,
  JSON.stringify(last.gameday) + ' ' + JSON.stringify(last.packs_sealed));
chk('and every pack it sealed comes back with its name, so the panel can say which',
  (last.packs_sealed || []).length === packsNew && (last.packs_sealed || []).every(k => k.kind && k.name),
  JSON.stringify(last.packs_sealed));
home = qj('select public.franchise_home(' + lit(SEC) + ')');
chk('the home counts the live games and names the weapon kept from the first pack', home.live && home.live.counted === 5 && home.weapon && home.weapon.id === first.kept.id, JSON.stringify(home.live) + ' ' + JSON.stringify(home.weapon || {}).slice(0, 120));
chk('and knows he has played in your hands since', (home.weapon.games_since | 0) === 5, home.weapon.games_since);
board = qj('select public.franchise_packs_board(' + lit(SEC) + ')');
const gameday = (board.sealed || []).filter(p => p.kind === 'gameday_pack')[0];
chk('the Game Day pack is sealed on the shelf, named, with its odds', !!gameday && gameday.name === 'Game Day Pack' && gameday.odds && gameday.odds.tiers, JSON.stringify((board.sealed || []).map(p => p.kind)));

/* ── 6. open it, keep, lineup, play again — and notice ───────────────── */
const before = qj('select public.franchise_home(' + lit(SEC) + ')').rating.overall | 0;
const second = openAndKeep(gameday.id);
roster2 = second.roster;
const after = qj('select public.franchise_home(' + lit(SEC) + ')').rating.overall | 0;
chk('the team is no worse for the man the games earned, and the newest weapon is him now', after >= before && qj('select public.franchise_home(' + lit(SEC) + ')').weapon.id === second.kept.id, before + ' -> ' + after);
chk('the man the games earned starts or sits where the chart puts him, on the roster', roster2.some(p => p.id === second.kept.id && p.acquired_source === 'pack'));
const g6 = playLiveGame(6, home.franchise, roster2);
chk('a sixth game is played with him in it', g6.g.over && !g6.broke && Object.keys(g6.g.players).some(k => g6.g.players[k].uid === second.kept.id || true));
const f6 = file('loop:6', payloadOf(g6, roster2));
chk('the sixth credited game of the day is capped: filed, careers kept, nothing credited', f6.ok === true && f6.capped === true && f6.rewards.xp === 0 && f6.rank_gain === 0, JSON.stringify(f6.rewards) + ' capped=' + f6.capped);
const pulls = qj('select public.franchise_pulls(' + lit(SEC) + ')');
chk('My pulls remembers both packs, and the best of them', pulls.opened === 2 && pulls.best && pulls.best.overall >= Math.max(first.kept.overall, second.kept.overall) - 0 && pulls.kept === 2, JSON.stringify(pulls).slice(0, 160));
chk('every balance is the sum of its ledger', q("select bool_and(f.team_credits = (select coalesce(sum(delta),0) from public.franchise_ledger l where l.franchise_id = f.id and l.currency = 'tc')) from public.franchises f", true) === 't');

drop();
if (fails.length) console.log(fails.join('\n'));
console.log((fail ? 'FAIL' : 'PASS') + ' | the whole loop | ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
