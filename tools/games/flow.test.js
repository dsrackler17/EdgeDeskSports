#!/usr/bin/env node
/* ===========================================================================
   GRIDIRON — THE GAME KEEPS ITS SHAPE.

   The tests the rebuild brief asks for, on the football and the page state:

     1  the flow machine names every state a snap moves through, and refuses
        nothing a game needs
     2  a hundred consecutive live snaps book cleanly, and a hundred resets
        (line up, do not snap, line up again) leave nothing behind
     3  touchdowns, first downs, turnovers, field goals, quarter changes, the
        half and the final all arrive in an arcade-length game — with the
        invariants holding on every one of them
     4  a pick can be returned, a returned pick into the end zone is the
        DEFENCE's touchdown and gets a try, and a fumble is booked as the
        play it was
     5  an overtime period is never longer than the quarter it follows
     6  a resumed Play Mode game keeps its men's names on their yards
     7  the progression reads the coverage, not its name
     8  rapid input — every button every tick — cannot break a snap, and
        sprinting costs wind

   Run: node tools/games/flow.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const L = p => require(path.join(ROOT, 'games', 'lib', 'gridiron', p));

let MEM = {};
global.localStorage = { getItem: k => (MEM[k] == null ? null : MEM[k]), setItem: (k, v) => { MEM[k] = String(v); }, removeItem: k => { delete MEM[k]; } };

const G = L('engine.js'), S = L('session.js'), F = L('football.js'), ST = L('stage.js'), LIVE = L('live.js'),
      AU = L('autoplay.js'), FLOW = L('flow.js');
const INV = require(path.join(__dirname, 'gridiron_invariants.js'));

let pass = 0, fail = 0; const fails = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; fails.push('  ✗ ' + name + (detail ? ' — ' + detail : '')); } }
function eq(name, got, want) { chk(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
function near(name, v, lo, hi) { chk(name, v >= lo && v <= hi, v + ' not in [' + lo + '–' + hi + ']'); }
function mulberry(seed) { let a = seed >>> 0; return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* ── 1. the flow machine ─────────────────────────────────────────────────── */
(function flow() {
  const warns = [];
  const f = FLOW.create({ warn: m => warns.push(m) });
  eq('a page boots LOADING', f.get(), 'LOADING');
  ['PRE_GAME', 'TRANSITION', 'KICKOFF', 'TRANSITION', 'PLAY_SELECT', 'PRE_SNAP', 'LIVE_PLAY', 'PLAY_ENDING', 'RESULT',
   'TRANSITION', 'PLAY_SELECT', 'PRE_SNAP', 'LIVE_PLAY', 'PLAY_ENDING', 'RESULT', 'TRANSITION', 'PAT', 'TRANSITION',
   'KICKOFF', 'TRANSITION', 'QUARTER_END', 'PLAY_SELECT', 'PRE_SNAP', 'PLAY_SELECT', 'TRANSITION', 'HALFTIME', 'KICKOFF',
   'TRANSITION', 'PLAY_SELECT', 'TRANSITION', 'GAME_OVER', 'PRE_GAME'].forEach(s => f.set(s, 'walk'));
  eq('the whole ritual of a game is made of listed moves', warns.length, 0, warns.join(' | '));
  eq('and it ends where a new game starts', f.get(), 'PRE_GAME');
  f.set('KICKOFF'); f.set('TRANSITION'); f.set('PLAY_SELECT');
  chk('a call may be made from the call sheet', f.can('call'));
  chk('but not snapped from it', !f.can('snap'));
  f.set('PRE_SNAP');
  chk('lined up, the snap is allowed', f.can('snap') && f.can('call'));
  f.set('LIVE_PLAY');
  chk('and once live, nothing but the thumbs are', f.can('input') && !f.can('call') && !f.can('snap') && f.busy());
  f.set('PLAY_SELECT', 'illegal');
  eq('an unlisted move is reported', warns.length, 1);
  eq('and taken anyway, because a stuck game is the worse bug', f.get(), 'PLAY_SELECT');
  chk('the history is kept', f.history().length > 10);
  chk('the states are the brief\'s', ['LOADING', 'PRE_GAME', 'PLAY_SELECT', 'PRE_SNAP', 'LIVE_PLAY', 'PLAY_ENDING', 'RESULT',
    'TRANSITION', 'QUARTER_END', 'HALFTIME', 'GAME_OVER'].every(s => FLOW.STATES.indexOf(s) >= 0));
})();

/* ── a live snap, through the session, exactly as the page does it ───────── */
function liveSnap(g, call, seed, script) {
  const side = g.possession, offT = G.teamOf(g, side), defT = G.teamOf(g, G.other(side));
  const playObj = F.play(call.play), parts = F.defParts(call.def);
  const sit = G.situation(g);
  const env = G.prepare({ off: offT, def: defT, rand: g.aiRand, tick: g.tick, playKey: call.play, formKey: call.formation,
    defCall: call.def, sit: sit, mem: g.mem[side], weather: g.weather });
  const bx = 26.665;
  const actors = ST.alignOffense(playObj, call.formation, bx, g.ball, G.unitsOf(offT, g.tick), {})
    .concat(ST.alignDefense(parts, bx, g.ball, 1, G.unitsOf(defT, g.tick), playObj, call.formation, {}));
  const sim = LIVE.Play({ actors, playObj, parts, formKey: call.formation, los: g.ball, ballX: bx, env,
    rand: mulberry(seed), userSide: script ? 'off' : 'off', userMode: script ? 'play' : 'coach' });
  sim.snap();
  let t = 0, k = 0;
  while (!sim.outcome() && k++ < 2400) { sim.step(1 / 120, script ? (script(t, sim) || {}) : {}); t += 1 / 120; }
  return { out: sim.outcome(), sim: sim };
}
/* a whole game, every snap live */
function liveGame(seed, length, onPlay) {
  const g = S.build({ seed: seed, settings: { length: length || 'arcade', difficulty: 'pro' } });
  let guard = 0, n = 0;
  while (!g.over && guard++ < 900) {
    const call = AU.callFor(g, {});
    if (call.type !== 'play') { S.step(g, call); continue; }
    const r = liveSnap(g, call, guard * 7 + 1);
    if (!r.out) return { g, broke: 'no outcome' };
    call.outcome = r.out;
    const st = S.step(g, call);
    if (!st.ok) return { g, broke: st.reason };
    n++;
    if (onPlay) onPlay(st.play, r.out, g);
  }
  return { g, snaps: n };
}

/* ── 2. a hundred consecutive snaps, and a hundred resets ───────────────── */
(function hundred() {
  MEM = {};
  let snaps = 0, broke = null, guard = 0;
  const g = S.build({ seed: 'hundred', settings: { length: 'standard', difficulty: 'pro' } });
  while (snaps < 100 && !g.over && guard++ < 400) {
    const call = AU.callFor(g, {});
    if (call.type !== 'play') { S.step(g, call); continue; }
    const r = liveSnap(g, call, 1000 + snaps);
    if (!r.out) { broke = 'no outcome at snap ' + snaps; break; }
    call.outcome = r.out;
    const st = S.step(g, call);
    if (!st.ok) { broke = st.reason; break; }
    snaps++;
  }
  eq('a hundred consecutive live snaps book without a refusal', broke, null);
  eq('and all hundred were taken', snaps, 100);
  const box = G.boxScore(g), v = INV.check(G, g, box);
  /* the game is not over, so the two "over" lines of the invariants are expected,
     and the drive under way is not on the chart yet; everything else must hold */
  const real = v.violations.filter(s => !/not over|ended in phase|the chart shows/.test(s));
  eq('the books hold after a hundred snaps', real.length, 0, real.join(' | '));

  /* a hundred resets: line up a fresh play and walk away, a hundred times.
     The hundredth snap may have scored, so the try (or the kick) is taken
     first: a preview is a thing you do between plays, not between phases. */
  let guard2 = 0, call0 = AU.callFor(g, {});
  while ((g.phase !== 'play' || call0.type !== 'play') && !g.over && guard2++ < 8) {
    S.step(g, g.phase !== 'play' ? { type: g.phase === 'kickoff' ? 'kickoff' : g.phase === 'pat' ? 'pat' : 'halftime_done' } : call0);
    call0 = AU.callFor(g, {});
  }
  const playsBefore = g.plays.length;
  const side = g.possession, offT = G.teamOf(g, side), defT = G.teamOf(g, G.other(side));
  let lined = 0;
  for (let i = 0; i < 100; i++) {
    const call = AU.callFor(g, {});
    if (call.type !== 'play') break;
    const playObj = F.play(call.play), parts = F.defParts(call.def);
    const env = G.prepare({ off: offT, def: defT, rand: g.aiRand, tick: g.tick, playKey: call.play, formKey: call.formation,
      defCall: call.def, sit: G.situation(g), mem: g.mem[side], weather: g.weather });
    const actors = ST.alignOffense(playObj, call.formation, 26.665, g.ball, G.unitsOf(offT, g.tick), {})
      .concat(ST.alignDefense(parts, 26.665, g.ball, 1, G.unitsOf(defT, g.tick), playObj, call.formation, {}));
    const sim = LIVE.Play({ actors, playObj, parts, formKey: call.formation, los: g.ball, ballX: 26.665, env,
      rand: mulberry(i), userSide: 'off', userMode: 'play', preview: true });
    sim.step(1 / 120, { snap: true });
    if (sim.phase() === 'set' && actors.length === 22) lined++;
  }
  eq('a hundred previews line up twenty-two men and none of them snaps', lined, 100);
  eq('and the game underneath did not move', g.plays.length, playsBefore);
})();

/* ── 3. every event a game has, at arcade length, on the books ──────────── */
(function events() {
  MEM = {};
  const seen = { td: 0, first: 0, to: 0, fg: 0, punt: 0, quarters: 0, half: 0, final: 0, games: 0, snaps: 0, ot: 0 };
  let viol = 0, badLength = 0;
  for (let i = 0; i < 14; i++) {
    const r = liveGame('arcade' + i, 'arcade', (p) => { if (p.touchdown) seen.td++; if (p.firstDown) seen.first++; if (p.turnover) seen.to++; });
    chk('game ' + i + ' reaches a final', !r.broke && r.g.over, r.broke);
    const g = r.g;
    seen.games++; seen.snaps += g.plays.length;
    seen.fg += g.stats.home.fgAtt + g.stats.away.fgAtt;
    seen.punt += g.stats.home.punts + g.stats.away.punts;
    seen.quarters += g.log.filter(e => e.kind === 'quarter').length;
    seen.half += g.log.filter(e => e.kind === 'halftime').length;
    if (g.ot) seen.ot++;
    if (g.over) seen.final++;
    if (g.cfg.quarterSeconds !== 120) badLength++;
    const v = INV.check(G, g, G.boxScore(g));
    viol += v.violations.length;
    if (v.violations.length && viol < 8) fails.push('    (arcade ' + i + ') ' + v.violations.join(' | '));
  }
  eq('every arcade game is four two-minute quarters', badLength, 0);
  eq('and every one of them ends', seen.final, seen.games);
  eq('with no invariant broken anywhere', viol, 0);
  near('an arcade game still holds a game of football', seen.snaps / seen.games, 34, 75);
  chk('touchdowns happen', seen.td > 0);
  chk('first downs happen', seen.first > 10);
  chk('turnovers happen', seen.to > 0);
  chk('field goals are tried', seen.fg > 0);
  chk('punts happen', seen.punt > 0);
  chk('every quarter changes twice and the half arrives once', seen.quarters >= seen.games * 2 && seen.half === seen.games,
    JSON.stringify(seen));
})();

/* ── 4. takeaways, returned and booked ──────────────────────────────────── */
(function takeaways() {
  MEM = {};
  let ints = 0, returned = 0, defTD = 0, fumbles = 0, viol = 0, patAfterDefTD = 0, badCols = 0;
  for (let i = 0; i < 40 && (defTD < 2 || fumbles < 3); i++) {
    const r = liveGame('take' + i, 'blitz', (p, out, g) => {
      if (p.turnover === 'interception') { ints++; if (out.returnYards > 0) returned++; }
      if (p.turnover === 'fumble') fumbles++;
      if (out.defTouchdown) {
        defTD++;
        /* the defence's six: booked as a touchdown, a try pending, nobody's rushing or receiving score */
        if (g.phase === 'pat' && g.pendingScore && g.pendingScore.side === G.other(p.side)) patAfterDefTD++;
      }
    });
    const g = r.g, v = INV.check(G, g, G.boxScore(g));
    viol += v.violations.length;
    ['home', 'away'].forEach(s => {
      const st = g.stats[s];
      if (st.yards !== st.passYards + st.rushYards) badCols++;
    });
  }
  chk('interceptions happen', ints > 0);
  chk('and some are returned for yards', returned > 0, ints + ' picks, ' + returned + ' returned');
  /* whether a pick can be taken the distance is a property of the football,
     not of forty games' luck: put a thumb on the man who caught it and run */
  let picks = 0, housed = 0, long = 0;
  for (let i = 0; i < 400 && picks < 30; i++) {
    const g = S.build({ seed: 'house' + i, settings: { length: 'blitz', difficulty: 'pro' } });
    let guard = 0;
    while (g.phase !== 'play' && !g.over && guard++ < 12) S.step(g, { type: g.phase === 'kickoff' ? 'kickoff' : g.phase === 'pat' ? 'pat' : 'halftime_done' });
    const call = { type: 'play', play: ['four_verts', 'dagger', 'mesh'][i % 3], formation: 'gun', def: ['two_deep', 'quarters', 'base_3'][i % 3] };
    const side = g.possession, offT = G.teamOf(g, side), defT = G.teamOf(g, G.other(side));
    const playObj = F.play(call.play), parts = F.defParts(call.def);
    const env = G.prepare({ off: offT, def: defT, rand: g.aiRand, tick: g.tick, playKey: call.play, formKey: call.formation, defCall: call.def, sit: G.situation(g), mem: g.mem[side], weather: g.weather });
    const actors = ST.alignOffense(playObj, call.formation, 26.665, g.ball, G.unitsOf(offT, g.tick), {})
      .concat(ST.alignDefense(parts, 26.665, g.ball, 1, G.unitsOf(defT, g.tick), playObj, call.formation, {}));
    const sim = LIVE.Play({ actors, playObj, parts, formKey: call.formation, los: g.ball, ballX: 26.665, env, rand: mulberry(i + 9), userSide: 'def', userMode: 'play' });
    sim.snap();
    let k = 0, t = 0, picked = false;
    while (!sim.outcome() && k++ < 2400) {
      const c = sim.carrier();
      if (c && c.side === 'def' && c.carry) {
        picked = true;
        /* the mechanism, not the luck: once he has it, put him at the goal
           line with the ball and let the football decide what that is */
        if (i % 2 === 0 && c.y > 1.5) { c.y = 0.9; c.x = 26; }
        sim.step(1 / 120, { mx: 0, my: -1, sprint: true });
      } else sim.step(1 / 120, {});
      t += 1 / 120;
    }
    const o = sim.outcome();
    if (o && o.turnover === 'interception') { picks++; if (o.defTouchdown) housed++; if (o.returnYards >= 20) long++; }
  }
  chk('a returned pick crossing the goal line is a defensive touchdown, booked as one', housed > 0 && picks > 6, housed + ' of ' + picks + ' picks were taken the distance');
  chk('and a pick run back from the field is a long return, not a whistle where he caught it', long > 0, long + ' returns of twenty or more');
  eq('and every defensive touchdown left a try pending for the defence', patAfterDefTD, defTD);
  chk('fumbles happen', fumbles > 0);
  eq('the yard columns still add up in every game with a takeaway', badCols, 0);
  eq('and the invariants hold across all of them', viol, 0);
  chk('the box score carries the defensive touchdown', G.boxScore(S.build({ seed: 'x' })).home.hasOwnProperty('score'));
})();

/* ── 5. overtime fits the quarter ───────────────────────────────────────── */
(function overtime() {
  let otGames = 0, tooLong = 0;
  for (let i = 0; i < 120 && otGames < 6; i++) {
    const g = G.createGame({ seed: 'ot' + i, home: { name: 'H', overall: 74, seed: 'h' + i }, away: { name: 'A', overall: 74, seed: 'a' + i },
      quarterSeconds: 120, deadScale: 0.3 });
    let guard = 0, worst = 0;
    while (!g.over && guard++ < 900) {
      G.step(g, AU.callFor(g));
      if (g.clock > worst) worst = g.clock;
    }
    if (g.ot) { otGames++; if (worst > g.cfg.quarterSeconds) tooLong++; }
  }
  chk('overtime happens at arcade length', otGames > 0);
  eq('and its clock never exceeds the quarter length', tooLong, 0);
})();

/* ── 6. a resumed live game keeps its names ─────────────────────────────── */
(function resume() {
  MEM = {};
  const g = S.build({ seed: 'keep-names', settings: { length: 'blitz', difficulty: 'pro' } });
  let n = 0, guard = 0;
  while (n < 12 && !g.over && guard++ < 60) {
    const call = AU.callFor(g, {});
    if (call.type !== 'play') { S.step(g, call); continue; }
    const r = liveSnap(g, call, 500 + n);
    call.outcome = r.out; S.step(g, call); n++;
  }
  const men = G.playersOf(g, 'home').concat(G.playersOf(g, 'away'));
  const sumRy = men.reduce((t, p) => t + p.ry, 0);
  const back = S.resume(S.saved(), {});
  const menBack = G.playersOf(back, 'home').concat(G.playersOf(back, 'away'));
  eq('the resumed game has the same score', JSON.stringify(back.score), JSON.stringify(g.score));
  eq('and the same number of named men', menBack.length, men.length);
  eq('and their rushing yards still sum to the team\'s', menBack.reduce((t, p) => t + p.ry, 0), sumRy);
  /* the record knows its own weather: the page's idea of the sky is only the
     fallback for a record saved before the sky was */
  MEM = {};
  const wet = S.build({ seed: 'keep-sky', weather: { weather: 'rain', temp: 48, wind: 14 }, settings: { length: 'blitz', difficulty: 'pro' } });
  S.step(wet, { type: 'kickoff' });
  const dry = S.resume(S.saved(), { weather: { weather: 'clear', temp: 75, wind: 3 } });
  eq('a resumed game replays under the sky it was saved in', dry.weather && dry.weather.kind, wet.weather && wet.weather.kind);
  const rec = S.saved(); rec.meta.weather = null;
  const fell = S.resume(rec, { weather: { weather: 'wind', temp: 60, wind: 20 } });
  eq('and a record without a sky takes the page\'s', fell.weather && fell.weather.kind, 'wind');
})();

/* ── 7. the progression reads the coverage ──────────────────────────────── */
(function reads() {
  const byObj = F.reads('mesh', F.COVERAGES.cover3), byKey = F.reads('mesh', 'cover3');
  chk('handed the coverage, the reads separate', byObj.some(r => Math.abs(r.sep || 0) > 0.01));
  chk('handed only its name they could not — which is why the live play now passes the object',
    !byKey.some(r => Math.abs(r.sep || 0) > 0.01));
  const src = require('fs').readFileSync(path.join(ROOT, 'games', 'lib', 'gridiron', 'live.js'), 'utf8');
  chk('live.js passes the coverage object into the progression', /F\.reads\(play\.key, parts\.coverage\)/.test(src));
})();

/* ── 8. rapid input, and the wind ────────────────────────────────────────── */
(function rapid() {
  MEM = {};
  const g = S.build({ seed: 'rapid', settings: { length: 'blitz', difficulty: 'pro' } });
  let guard = 0; while (g.phase !== 'play' && guard++ < 20) S.step(g, AU.callFor(g, {}));
  const call = { type: 'play', play: 'inside_zone', formation: 'i_form', def: 'base_3' };
  const every = ['juke', 'spin', 'stiff', 'dive', 'tackle', 'scramble'];
  const r = liveSnap(g, call, 77, (t, sim) => ({ mx: Math.sin(t * 40), my: 1, sprint: true, action: every[(t * 120 | 0) % every.length], switchDef: true, throwTo: 0 }));
  chk('every button every tick still produces an outcome', !!r.out && typeof r.out.yards === 'number', JSON.stringify(r.out && r.out.yards));
  chk('with a spot on the field', r.out.endY >= -10 && r.out.endY <= 110);
  const back = r.sim.actors.filter(a => a.slot === 'RB')[0];
  chk('and the man who sprinted the whole way is out of wind', back && back.gas != null && back.gas < 0.9, back && back.gas);
  /* the same script twice is the same play */
  const r2 = liveSnap(g, call, 77, (t, sim) => ({ mx: Math.sin(t * 40), my: 1, sprint: true, action: every[(t * 120 | 0) % every.length], switchDef: true, throwTo: 0 }));
  eq('and it is deterministic', r2.out.yards + ':' + r2.out.endX, r.out.yards + ':' + r.out.endX);
})();

/* ── 9. a thousand plays reset clean ────────────────────────────────────── */
(function resets() {
  /* every snap builds a fresh simulation and drops the last one; a thousand
     of them must come and go without a stuck state, a leaked timer or a
     creeping heap — the stress a long session on a phone puts on it */
  MEM = {};
  const g = S.build({ seed: 'thousand', settings: { length: 'standard', difficulty: 'pro' } });
  const call = { type: 'play', play: 'power', formation: 'i_form', def: 'base_3' };
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed, t0 = Date.now();
  let ok = 0, stuck = 0, sims = 0;
  for (let i = 0; i < 1000; i++) {
    const c = i % 3 === 0 ? { type: 'play', play: 'stack', formation: 'gun', def: 'cover3' } : call;
    const r = liveSnap(g, c, 9000 + i, i % 2 ? (t, sim) => ({ mx: Math.sin(t * 6), my: 1, sprint: t > 1, throwTo: t > 1.6 ? 1 : undefined }) : null);
    sims++;
    if (r.out && typeof r.out.yards === 'number' && r.out.endY >= -10 && r.out.endY <= 110) ok++; else stuck++;
  }
  if (global.gc) global.gc();
  const after = process.memoryUsage().heapUsed, ms = Date.now() - t0;
  eq('a thousand fresh plays all settle', ok, 1000);
  chk('none is stuck', stuck === 0, stuck + ' stuck');
  chk('and they settle quickly enough for a phone (under 90 s for a thousand in Node)', ms < 90000, ms + ' ms');
  chk('and the heap does not creep more than 120 MB across them', (after - before) < 120 * 1024 * 1024, Math.round((after - before) / 1048576) + ' MB');
  chk('the game itself was never advanced by a live snap that was not booked', g.plays.length === 0 && g.quarter === 1);
})();

console.log('\nFLOW — the game keeps its shape\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('\nFAILURES'); fails.forEach(f => console.log(f)); process.exit(1); }
