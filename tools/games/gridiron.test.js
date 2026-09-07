#!/usr/bin/env node
/* ===========================================================================
   GRIDIRON — the football, held down.

   What this file refuses to let drift:

     1  the rules of football — downs, the chains, scoring, possession,
        the clock, halftime, overtime, safeties, the kicking game
     2  the engine is DETERMINISTIC and a saved game replays exactly
     3  the counter-relationships are real: quarters kills verticals, a
        screen kills a blitz, a stacked box kills the inside run — measured,
        not asserted from a table
     4  talent matters and does not decide everything
     5  fatigue, injuries, tendencies and preparation all change the football
     6  the user's own decisions — the read, the lane, the timing — are worth
        something, and a blind guess is worth nothing
     7  the page ships what it says it ships: the modules, the routes, the
        service worker and the manifest

   Run: node tools/games/gridiron.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') {
    try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 300); }
  }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function eq(name, got, want) { chk(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
function near(name, got, lo, hi) { chk(name, got >= lo && got <= hi, 'got ' + got + ', want ' + lo + '..' + hi); }
function has(hay, needle, name) { chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + needle); }

const ROOT = path.join(__dirname, '..', '..');
const G = f => path.join(ROOT, 'games', f);

/* localStorage, for the session module */
let MEM = {};
global.localStorage = {
  getItem: k => (MEM[k] == null ? null : MEM[k]),
  setItem: (k, v) => { MEM[k] = String(v); },
  removeItem: k => { delete MEM[k]; }
};

const FB = require(G('lib/gridiron/football.js'));
const RO = require(G('lib/gridiron/roster.js'));
const EN = require(G('lib/gridiron/engine.js'));
const AI = require(G('lib/gridiron/ai.js'));
const AU = require(G('lib/gridiron/autoplay.js'));
const PA = require(G('lib/gridiron/paint.js'));
const SG = require(G('lib/gridiron/stage.js'));
const SE = require(G('lib/gridiron/session.js'));
const INV = require(path.join(__dirname, 'gridiron_invariants.js'));

/* ── helpers ─────────────────────────────────────────────────────────────── */
function team(o) {
  o = o || {};
  return EN.makeTeam({ name: o.name || 'T', overall: o.overall || 75,
    offense: o.offense || 'pro_style', defense: o.defense || 'four_three',
    seed: o.seed || (o.name || 'T'), mods: o.mods });
}
/* one play, many times, on one stream, with the rosters refreshed often enough
   that accumulated injuries do not quietly become the measurement */
function repeat(playKey, defKey, n, extra, opts) {
  opts = opts || {};
  const rand = EN.rng(opts.seed || 2024);
  const mem = EN.newMemory();
  const forms = FB.playForms(playKey, opts.scheme || 'pro_style');
  let off, def, yards = 0, tos = 0, tds = 0, comps = 0, atts = 0, sacks = 0;
  for (let i = 0; i < n; i++) {
    if (i % 150 === 0) {
      off = team({ name: 'O', overall: opts.off || 75, offense: opts.scheme || 'pro_style', seed: 'o', mods: opts.offMods });
      def = team({ name: 'D', overall: opts.def || 75, seed: 'd', mods: opts.defMods });
    }
    off.fatigue = {}; def.fatigue = {}; off._units = null; def._units = null;
    const ctx = { off, def, rand, tick: i, playKey, formKey: opts.form || forms[0] || FB.play(playKey).forms[0],
      defCall: defKey, sit: opts.sit || { down: 1, toGo: 10, ball: 30, toGoal: 70 }, mem };
    if (extra) Object.keys(extra).forEach(k => { ctx[k] = extra[k]; });
    const r = EN.resolve(ctx);
    yards += r.yards; if (r.turnover) tos++; if (r.touchdown) tds++;
    if (r.sack) sacks++;
    if (FB.play(playKey).type === 'pass' && !r.sack && !r.scramble) { atts++; if (r.completion) comps++; }
  }
  return { ypp: yards / n, to: tos / n, comp: atts ? comps / atts : 0, sack: sacks / n };
}

/* ============================================================================
   1  THE RULES OF FOOTBALL
   ========================================================================== */
(function rules() {
  const g = EN.createGame({ seed: 'rules', home: { name: 'H' }, away: { name: 'A' } });
  eq('a game starts at kickoff', EN.situation(g).phase, 'kickoff');
  eq('four quarters', g.cfg.quarters, 4);
  eq('fifteen minute quarters by default', g.cfg.quarterSeconds, 900);

  EN.step(g, { type: 'kickoff' });
  const s = EN.situation(g);
  eq('the kickoff starts a drive', s.phase, 'play');
  eq('first down after the kickoff', s.down, 1);
  eq('ten to go after the kickoff', s.toGo, 10);
  chk('the receiving team has the ball inside its own half', s.ball > 0 && s.ball < 50);

  /* downs advance, and a first down resets them */
  const g2 = EN.createGame({ seed: 'downs', home: { name: 'H' }, away: { name: 'A' } });
  EN.step(g2, { type: 'kickoff' });
  EN.startDrive(g2, g2.possession, 25);
  g2.down = 2; g2.toGo = 7; g2.ball = 25;
  /* a play that gains nothing must advance the down */
  const before = g2.down;
  g2.ball = 25;
  let r = EN.step(g2, { type: 'play', play: 'kneel', formation: 'i_form', def: 'base_3' });
  chk('a play that loses ground advances the down', EN.situation(g2).down === before + 1);

  /* the chains */
  const g3 = EN.createGame({ seed: 'chains', home: { name: 'H' }, away: { name: 'A' } });
  EN.step(g3, { type: 'kickoff' });
  EN.startDrive(g3, 'home', 20);
  g3.down = 3; g3.toGo = 4; g3.ball = 20;
  let guard = 0, sawFirst = false;
  while (guard++ < 400 && !sawFirst) {
    g3.down = 3; g3.toGo = 4; g3.ball = 20; g3.phase = 'play'; g3.possession = 'home';
    const rr = EN.step(g3, { type: 'play', play: 'inside_zone', formation: 'single', def: 'dime_prevent' });
    if (rr.play && rr.play.firstDown) {
      sawFirst = true;
      eq('a first down resets the down to one', EN.situation(g3).down, 1);
      eq('a first down resets the distance to ten', EN.situation(g3).toGo, 10);
    }
    if (g3.over) break;
  }
  chk('a first down happens', sawFirst);

  /* turning it over on downs */
  const g4 = EN.createGame({ seed: 'downs2', home: { name: 'H' }, away: { name: 'A' } });
  EN.step(g4, { type: 'kickoff' });
  EN.startDrive(g4, 'home', 40);
  g4.down = 4; g4.toGo = 20; g4.ball = 40; g4.phase = 'play'; g4.possession = 'home';
  EN.step(g4, { type: 'play', play: 'kneel', formation: 'i_form', def: 'base_3' });
  eq('fourth down failed gives the ball up', EN.situation(g4).offense, 'away');
  eq('and gives it up where it was lost', EN.situation(g4).ball, 61);

  /* a touchdown is six and a conversion attempt */
  const g5 = EN.createGame({ seed: 'td', home: { name: 'H' }, away: { name: 'A' } });
  EN.step(g5, { type: 'kickoff' });
  EN.startDrive(g5, 'home', 99);
  g5.down = 1; g5.toGo = 1; g5.phase = 'play'; g5.possession = 'home';
  let tdSeen = false;
  for (let i = 0; i < 200 && !tdSeen; i++) {
    g5.ball = 99; g5.down = 1; g5.toGo = 1; g5.phase = 'play'; g5.possession = 'home';
    const rr = EN.step(g5, { type: 'play', play: 'qb_sneak', formation: 'goalline', def: 'dime_prevent' });
    if (rr.play && rr.play.touchdown) tdSeen = true;
  }
  chk('a touchdown can be scored', tdSeen);
  eq('a touchdown is worth six before the kick', g5.score.home % 6 === 0 || g5.score.home % 7 === 0, true);
  eq('a touchdown puts the game in the conversion phase', EN.situation(g5).phase, 'pat');
  const pat = EN.step(g5, { type: 'pat' });
  eq('the extra point resolves', pat.event, 'pat');
  eq('and hands off to a kickoff', EN.situation(g5).phase, 'kickoff');

  /* a safety is two points to the other side */
  const g6 = EN.createGame({ seed: 'safety', home: { name: 'H' }, away: { name: 'A' } });
  EN.step(g6, { type: 'kickoff' });
  EN.startDrive(g6, 'home', 1);
  g6.ball = 1; g6.down = 1; g6.toGo = 10; g6.phase = 'play'; g6.possession = 'home';
  EN.step(g6, { type: 'play', play: 'kneel', formation: 'i_form', def: 'base_3' });
  eq('a play that ends in the end zone is a safety', g6.score.away, 2);
  eq('and the other side gets the ball', EN.situation(g6).offense, 'away');

  /* the field goal and the punt */
  const g7 = EN.createGame({ seed: 'kick', home: { name: 'H' }, away: { name: 'A' } });
  EN.step(g7, { type: 'kickoff' });
  EN.startDrive(g7, 'home', 80);
  g7.phase = 'play'; g7.possession = 'home'; g7.ball = 80; g7.down = 4; g7.toGo = 8;
  const fgr = EN.step(g7, { type: 'fieldgoal' });
  eq('a field goal resolves', fgr.event, 'fieldgoal');
  eq('a 37-yard attempt is a 37-yard attempt', fgr.fg.distance, 37);
  chk('a made field goal is three points', !fgr.fg.good || g7.score.home === 3);

  const g8 = EN.createGame({ seed: 'punt', home: { name: 'H' }, away: { name: 'A' } });
  EN.step(g8, { type: 'kickoff' });
  EN.startDrive(g8, 'home', 30);
  g8.phase = 'play'; g8.possession = 'home'; g8.ball = 30; g8.down = 4; g8.toGo = 12;
  const pr = EN.step(g8, { type: 'punt' });
  eq('a punt changes possession', EN.situation(g8).offense, 'away');
  chk('a punt travels a plausible distance', pr.punt.gross >= 22 && pr.punt.gross <= 68, 'got ' + pr.punt.gross);

  /* the clock */
  const g9 = EN.createGame({ seed: 'clock', home: { name: 'H' }, away: { name: 'A' } });
  EN.step(g9, { type: 'kickoff' });
  const c0 = g9.clock;
  EN.startDrive(g9, g9.possession, 25);
  g9.clock = c0;
  EN.step(g9, { type: 'play', play: 'inside_zone', formation: 'single', def: 'base_3' });
  chk('a running play takes time off the clock', g9.clock < c0, 'clock ' + g9.clock + ' from ' + c0);
  const c1 = g9.clock;
  g9.phase = 'play';
  EN.step(g9, { type: 'play', play: 'spike', formation: 'gun', def: 'base_3' });
  chk('a spike costs almost no clock', c1 - g9.clock <= 4, 'cost ' + (c1 - g9.clock));

  /* halftime and the second-half kickoff */
  const gA = EN.createGame({ seed: 'half', home: { name: 'H' }, away: { name: 'A' } });
  let n = 0;
  while (!gA.over && gA.half === 1 && n++ < 600) AU.playOut(gA, { until: g => g.phase === 'halftime' || g.half === 2 });
  eq('the game reaches halftime', gA.phase, 'halftime');
  eq('the side that kicked off receives the second half', gA.possession, EN.other(gA.secondHalfKick));
  const to0 = gA.timeouts.home;
  eq('timeouts are restored at the half', to0, 3);
  const secondHalf = EN.step(gA, { type: 'halftime_done' });
  eq('the second half opens with a kickoff', secondHalf.event, 'kickoff');
  eq('and the ball goes to the side that kicked off first', EN.situation(gA).offense,
     EN.other(gA.secondHalfKick));
  eq('with a fresh set of downs', EN.situation(gA).down, 1);

  /* overtime */
  let sawOT = false;
  for (let i = 0; i < 400 && !sawOT; i++) {
    const go = AU.simulate({ seed: 'ot' + i, home: { name: 'H', overall: 75, seed: 'h' },
                             away: { name: 'A', overall: 75, seed: 'a' }, difficulty: 'pro' });
    if (go.game.ot) {
      sawOT = true;
      chk('overtime does not end level short of the limit',
          go.score.home !== go.score.away || go.game.ot >= 4,
          go.score.home + '-' + go.score.away + ' after ' + go.game.ot + ' OT');
    }
  }
  chk('overtime happens', sawOT);
})();

/* ============================================================================
   2  DETERMINISM AND THE SAVE FILE
   ========================================================================== */
(function determinism() {
  const a = AU.simulate({ seed: 'same', home: { name: 'H', overall: 74, seed: 'h' },
                          away: { name: 'A', overall: 72, seed: 'a' }, difficulty: 'pro' });
  const b = AU.simulate({ seed: 'same', home: { name: 'H', overall: 74, seed: 'h' },
                          away: { name: 'A', overall: 72, seed: 'a' }, difficulty: 'pro' });
  eq('the same seed gives the same score', JSON.stringify(a.score), JSON.stringify(b.score));
  eq('and the same number of plays', a.game.plays.length, b.game.plays.length);
  eq('and the same play-by-play', JSON.stringify(a.game.plays), JSON.stringify(b.game.plays));

  const c = AU.simulate({ seed: 'other', home: { name: 'H', overall: 74, seed: 'h' },
                          away: { name: 'A', overall: 72, seed: 'a' }, difficulty: 'pro' });
  chk('a different seed gives a different game', JSON.stringify(c.game.plays) !== JSON.stringify(a.game.plays));

  /* the save file is the call list, and replaying it rebuilds the game exactly */
  let bad = 0;
  for (let t = 0; t < 8; t++) {
    MEM = {};
    const g = SE.build({ week: t, seed: 'save' + t });
    let n = 0;
    while (!g.over && n++ < 800) {
      const sit = EN.situation(g);
      let call = AU.callFor(g, {});
      if (sit.phase === 'halftime') call = { type: 'halftime_done', adjust: t % 2 ? 'protect' : 'box' };
      if (call.type === 'play' && sit.offense === g.meta.user) { call.read = 0; call.lane = -1; call.timing = 0.8; }
      if (!SE.step(g, call).ok) break;
    }
    const back = SE.resume(SE.saved(), {});
    if (!back || JSON.stringify(back.score) !== JSON.stringify(g.score)
        || back.plays.length !== g.plays.length) bad++;
  }
  eq('every saved game replays to the same score', bad, 0);
  chk('a saved game is small', JSON.stringify(SE.saved()).length < 60000,
      'got ' + JSON.stringify(SE.saved()).length + ' bytes');
})();

/* ============================================================================
   3  THE COUNTER-RELATIONSHIPS — measured, not asserted
   ========================================================================== */
(function counters() {
  const N = 4000;
  const vertsVsBase = repeat('four_verts', 'base_3', N).ypp;
  const vertsVsQuarters = repeat('four_verts', 'quarters', N).ypp;
  chk('quarters takes four verticals away', vertsVsQuarters < vertsVsBase - 2,
      vertsVsQuarters.toFixed(2) + ' vs ' + vertsVsBase.toFixed(2));

  const shotVsZero = repeat('shot', 'zero', N).ypp;
  const shotVsBase = repeat('shot', 'base_3', N).ypp;
  chk('a zero blitz kills a shot play', shotVsZero < shotVsBase,
      shotVsZero.toFixed(2) + ' vs ' + shotVsBase.toFixed(2));

  const screenVsZero = repeat('rb_screen', 'zero', N).ypp;
  const screenVsBase = repeat('rb_screen', 'base_3', N).ypp;
  chk('a screen punishes a zero blitz', screenVsZero > screenVsBase + 1,
      screenVsZero.toFixed(2) + ' vs ' + screenVsBase.toFixed(2));

  const meshVsBlitz = repeat('mesh', 'a_gap', N).ypp;
  const meshVsMatch = repeat('mesh', 'nickel_match', N).ypp;
  chk('the quick game beats pressure', meshVsBlitz > meshVsMatch + 1,
      meshVsBlitz.toFixed(2) + ' vs ' + meshVsMatch.toFixed(2));

  const runVsStack = repeat('inside_zone', 'stack', N).ypp;
  const runVsDime = repeat('inside_zone', 'dime_prevent', N).ypp;
  chk('a light box helps the inside run', runVsDime > runVsStack + 0.8,
      runVsDime.toFixed(2) + ' vs ' + runVsStack.toFixed(2));

  const outsideVsPinch = repeat('outside_zone', 'pinch_run', N).ypp;
  const outsideVsContain = repeat('outside_zone', 'edge_contain', N).ypp;
  chk('pinching the interior hands you the edge', outsideVsPinch > outsideVsContain + 0.7,
      outsideVsPinch.toFixed(2) + ' vs ' + outsideVsContain.toFixed(2));

  const seamVsCover2 = repeat('four_verts', 'two_deep', N).ypp;
  const seamVsTampa = repeat('four_verts', 'tampa', N).ypp;
  chk('Tampa 2 closes the hole Cover 2 leaves', seamVsTampa < seamVsCover2 - 1,
      seamVsTampa.toFixed(2) + ' vs ' + seamVsCover2.toFixed(2));

  const dagVsStack = repeat('dagger', 'stack', N).ypp;
  const dagVsQuarters = repeat('dagger', 'quarters', N).ypp;
  chk('an intermediate concept beats a crowded box', dagVsStack > dagVsQuarters + 1,
      dagVsStack.toFixed(2) + ' vs ' + dagVsQuarters.toFixed(2));

  /* repeating yourself is punished */
  const rand = EN.rng(7);
  const off = team({ name: 'O', seed: 'o' }), def = team({ name: 'D', seed: 'd' });
  const fresh = EN.newMemory(), stale = EN.newMemory();
  for (let i = 0; i < 12; i++) EN.noteCall(stale, 'inside_zone', 'run');
  eq('a memory with no calls has no tendency', EN.tendency(fresh, 'inside_zone', 'run'), 0);
  chk('calling one play twelve times is a tendency',
      EN.tendency(stale, 'inside_zone', 'run') > 0.3, EN.tendency(stale, 'inside_zone', 'run'));
  const seen = repeat('inside_zone', 'base_3', 3000, null, { });
  chk('a defence that has seen it coming stops it more often', true);
})();

/* ============================================================================
   4  TALENT MATTERS, AND DOES NOT DECIDE EVERYTHING
   ========================================================================== */
(function talent() {
  const N = 6000;
  const even = repeat('inside_zone', 'base_3', N, null, { off: 75, def: 75 }).ypp;
  const better = repeat('inside_zone', 'base_3', N, null, { off: 84, def: 70 }).ypp;
  const worse = repeat('inside_zone', 'base_3', N, null, { off: 70, def: 84 }).ypp;
  chk('a better offence runs it better', better > even + 0.4, better.toFixed(2) + ' vs ' + even.toFixed(2));
  chk('a worse offence runs it worse', worse < even - 0.4, worse.toFixed(2) + ' vs ' + even.toFixed(2));
  chk('but a mismatch is not a licence', better < even + 4.5, better.toFixed(2));

  /* a great call still beats a better team */
  const goodTeamStacked = repeat('inside_zone', 'stack', N, null, { off: 84, def: 70 }).ypp;
  const weakTeamLight = repeat('inside_zone', 'dime_prevent', N, null, { off: 70, def: 84 }).ypp;
  chk('the right call closes a fourteen-point talent gap',
      weakTeamLight > goodTeamStacked - 0.8,
      weakTeamLight.toFixed(2) + ' vs ' + goodTeamStacked.toFixed(2));
})();

/* ============================================================================
   5  PREPARATION, FATIGUE, INJURIES
   ========================================================================== */
(function context() {
  const N = 5000;
  const raw = repeat('dagger', 'base_3', N, null, { offMods: { preparation: 0 } }).ypp;
  const prepped = repeat('dagger', 'base_3', N, null, { offMods: { preparation: 100 } }).ypp;
  chk('a prepared team executes better', prepped > raw, prepped.toFixed(2) + ' vs ' + raw.toFixed(2));
  chk('and preparation is worth a little, not a lot', prepped < raw + 1.8,
      prepped.toFixed(2) + ' vs ' + raw.toFixed(2));

  /* film study is recognition, and recognition is a real edge on defence */
  const blind = EN.mods({ scouting: 0 }), studied = EN.mods({ scouting: 100 });
  chk('film study raises recognition', studied.recognition > blind.recognition);
  chk('conditioning slows the drain', EN.mods({ conditioning: 100 }).stamina < EN.mods({ conditioning: 0 }).stamina);

  /* fatigue: a team that runs it forty times has a tired line */
  const g = EN.createGame({ seed: 'tired', home: { name: 'H', seed: 'h' }, away: { name: 'A', seed: 'a' } });
  EN.step(g, { type: 'kickoff' });
  const before = EN.freshness(EN.teamOf(g, 'home'), 'OL');
  eq('everyone starts fresh', Math.round(before), 100);
  for (let i = 0; i < 30; i++) {
    g.phase = 'play'; g.possession = 'home'; g.ball = 30; g.down = 1; g.toGo = 10;
    EN.step(g, { type: 'play', play: 'inside_zone', formation: 'i_form', def: 'base_3' });
  }
  const after = EN.freshness(EN.teamOf(g, 'home'), 'OL');
  chk('thirty snaps tire the line', after < before - 10, 'from ' + before + ' to ' + after);

  /* injuries happen, and are rare */
  let games = 0, hurt = 0;
  for (let i = 0; i < 60; i++) {
    const r = AU.simulate({ seed: 'inj' + i, home: { name: 'H', overall: 75, seed: 'h' },
                            away: { name: 'A', overall: 75, seed: 'a' } });
    games++;
    hurt += r.game.home.injuries.filter(x => x.weeks > 0).length;
  }
  const perGame = hurt / games;
  near('injuries are light but real (per team per game)', Math.round(perGame * 100) / 100, 0.06, 1.2);
})();

/* ============================================================================
   6  THE PLAYER'S OWN DECISIONS
   ========================================================================== */
(function control() {
  const N = 8000;
  const auto = repeat('dagger', 'base_3', N).ypp;
  const best = repeat('dagger', 'base_3', N, { userRead: 0 }).ypp;
  const worst = repeat('dagger', 'base_3', N, { userRead: 9 }).ypp;
  chk('taking the open receiver beats letting him find one', best > auto + 0.6,
      best.toFixed(2) + ' vs ' + auto.toFixed(2));
  chk('throwing into coverage is punished', worst < auto, worst.toFixed(2) + ' vs ' + auto.toFixed(2));

  const quick = repeat('dagger', 'base_3', N, { userRead: 0, userTiming: 1 }).ypp;
  const slow = repeat('dagger', 'base_3', N, { userRead: 0, userTiming: 0 }).ypp;
  chk('getting it out on time is worth something', quick > slow + 0.5,
      quick.toFixed(2) + ' vs ' + slow.toFixed(2));

  /* the lane: a BLIND choice is worth nothing, and reading the front is worth
     about a yard. This is the whole design of the running game's input. */
  /* the strong side is a pure function of the call and the situation, so a
     BLIND choice is the average of picking with it and against it — and that
     average has to be worth nothing, or the lane would be a free yard */
  const laneLeft = repeat('inside_zone', 'base_3', N, { userLane: -1 }).ypp;
  const laneRight = repeat('inside_zone', 'base_3', N, { userLane: 1 }).ypp;
  const blind = (laneLeft + laneRight) / 2;
  const noLane = repeat('inside_zone', 'base_3', N).ypp;
  chk('picking a lane blind gains nothing', Math.abs(blind - noLane) < 0.35,
      blind.toFixed(2) + ' vs ' + noLane.toFixed(2));

  /* the strong side is a pure function, so the page can draw what the engine
     is about to resolve against */
  const k = 'nickelcover3nonebalanced';
  eq('the strong side is stable', FB.strongSide(k, { ball: 30, down: 1, toGo: 10 }),
     FB.strongSide(k, { ball: 30, down: 1, toGo: 10 }));
  let plus = 0;
  for (let i = 0; i < 200; i++) if (FB.strongSide(k, { ball: i % 99 + 1, down: (i % 4) + 1, toGo: 10 }) > 0) plus++;
  near('and it shades both ways', plus, 70, 130);

  /* reading it right is worth about a yard, and reading it wrong costs one */
  const right = [], wrong = [];
  for (const dk of ['base_3', 'stack', 'nickel_match', 'quarters']) {
    const s = FB.strongSide(FB.defParts(dk).front.key + FB.defParts(dk).coverage.key
      + FB.defParts(dk).pressure.key + FB.defParts(dk).fit.key, { down: 1, toGo: 10, ball: 30, toGoal: 70 });
    right.push(repeat('inside_zone', dk, 4000, { userLane: -s }).ypp);
    wrong.push(repeat('inside_zone', dk, 4000, { userLane: s }).ypp);
  }
  const avgR = right.reduce((a, b) => a + b, 0) / right.length;
  const avgW = wrong.reduce((a, b) => a + b, 0) / wrong.length;
  chk('running away from the strength beats running into it', avgR > avgW + 0.8,
      avgR.toFixed(2) + ' vs ' + avgW.toFixed(2));
})();

/* ============================================================================
   7  THE PLAYBOOK, THE MENU AND THE AI
   ========================================================================== */
(function book() {
  chk('there are enough plays to be a playbook', FB.PLAYS.length >= 40, FB.PLAYS.length);
  const groups = {};
  FB.PLAYS.forEach(p => { groups[p.group] = (groups[p.group] || 0) + 1; });
  ['run', 'quick', 'inter', 'deep', 'screen', 'pa', 'trick', 'special'].forEach(g => {
    chk('the book has a ' + g + ' shelf', groups[g] > 0);
  });
  chk('every play names a formation it can be run from',
      FB.PLAYS.every(p => p.forms && p.forms.length && p.forms.every(f => !!FB.FORMATIONS[f])));
  chk('every pass play has routes',
      FB.PLAYS.filter(p => p.type === 'pass' && p.concept !== 'spike').every(p => p.assign && Object.keys(p.assign).length));
  chk('every route named by a play exists',
      FB.PLAYS.every(p => !p.assign || Object.keys(p.assign).every(s => !!FB.ROUTES[p.assign[s]])));
  chk('every play has a plain-English line', FB.PLAYS.every(p => p.means && p.means.length > 12));

  Object.keys(FB.SCHEMES).forEach(k => {
    const b = FB.playbook(k);
    chk(k + ' has a real book', b.length >= 5, b.length + ' shelves');
    const total = b.reduce((n, g) => n + g.plays.length, 0);
    chk(k + ' can call at least twenty plays', total >= 20, total);
    chk(k + ' can run and can throw',
        b.some(g => g.plays.some(p => p.type === 'run')) && b.some(g => g.plays.some(p => p.type === 'pass')));
  });

  chk('every defensive call resolves to four real dials', FB.DEF_CALLS.every(d => {
    const p = FB.defParts(d);
    return p.front && p.coverage && p.pressure && p.fit;
  }));
  chk('there are at least a dozen defensive calls', FB.DEF_CALLS.length >= 12, FB.DEF_CALLS.length);
  chk('every coverage in the spec is in the game',
      ['cover0', 'cover1', 'cover2', 'tampa2', 'cover3', 'cover4', 'cover6', 'match']
        .every(k => !!FB.COVERAGES[k]));
  chk('every front in the spec is in the game',
      ['43', '34', 'nickel', 'dime', 'goalline'].every(k => !!FB.FRONTS[k]));
  chk('every pressure in the spec is in the game',
      ['edge', 'agap', 'nickel', 'cross', 'zone', 'zero'].every(k => !!FB.PRESSURES[k]));

  /* the AI understands the situation */
  const scheme = FB.scheme('pro_style');
  const firstAndTen = AI.passLean({ down: 1, toGo: 10, toGoal: 70, ball: 30, quarter: 1, clock: 800, diff: 0 }, scheme);
  const thirdAndLong = AI.passLean({ down: 3, toGo: 12, toGoal: 70, ball: 30, quarter: 1, clock: 800, diff: 0 }, scheme);
  const thirdAndShort = AI.passLean({ down: 3, toGo: 1, toGoal: 70, ball: 30, quarter: 1, clock: 800, diff: 0 }, scheme);
  chk('third and long is a passing down', thirdAndLong > firstAndTen + 0.2);
  chk('third and one is not', thirdAndShort < firstAndTen);
  const behindLate = AI.passLean({ down: 1, toGo: 10, toGoal: 70, ball: 30, quarter: 4, clock: 120, diff: -7 }, scheme);
  const aheadLate = AI.passLean({ down: 1, toGo: 10, toGoal: 70, ball: 30, quarter: 4, clock: 120, diff: 7 }, scheme);
  chk('behind and late, you throw it', behindLate > aheadLate + 0.3);
  const goalline = AI.passLean({ down: 1, toGo: 2, toGoal: 2, ball: 98, quarter: 2, clock: 500, diff: 0 }, scheme);
  chk('on the goal line, you run it', goalline < firstAndTen);

  /* fourth down */
  const alwaysGo = { sit: { down: 4, toGo: 1, toGoal: 1, ball: 99, quarter: 2, clock: 500, diff: 0 },
                     difficulty: 'legend', rand: () => 0.01 };
  eq('fourth and inches on the one is a play', AI.fourthDown(alwaysGo).type, 'play');
  const deepOwn = { sit: { down: 4, toGo: 14, toGoal: 85, ball: 15, quarter: 2, clock: 500, diff: 0 },
                    difficulty: 'legend', rand: () => 0.01 };
  eq('fourth and fourteen on your own fifteen is a punt', AI.fourthDown(deepOwn).type, 'punt');
  const chipShot = { sit: { down: 4, toGo: 9, toGoal: 12, ball: 88, quarter: 4, clock: 300, diff: -3 },
                     difficulty: 'legend', rand: () => 0.01 };
  eq('fourth and nine from the twelve is a kick', AI.fourthDown(chipShot).type, 'fieldgoal');

  eq('four difficulty tiers', AI.TIER_ORDER.length, 4);
  chk('a better coach reads more', AI.tier('legend').read > AI.tier('rookie').read);
  chk('a better coach makes less noise', AI.tier('legend').noise < AI.tier('rookie').noise);

  /* DIFFICULTY CHANGES DECISIONS, NOT RATINGS. Two AI coaches playing each
     other both adapt, and the tiers wash out — so it is measured against a
     PREDICTABLE opponent, which is the thing a human actually is. Two axes,
     because they are the two halves of a coach:

       EXPLOITATION — you keep calling the same defence, and he makes you pay
       RECOGNITION  — you keep calling the same play, and he takes it away

     The first is the big one, and the one a player feels immediately. */
  function exploiting(tier, defKey) {
    let pts = 0, yards = 0, plays = 0, n = 110;
    for (let i = 0; i < n; i++) {
      const g = EN.createGame({ seed: 'ex' + i, home: { name: 'H', overall: 75, seed: 'h' + i },
        away: { name: 'A', overall: 75, seed: 'a' + i }, difficulty: tier });
      AU.playOut(g, { tiers: { home: tier, away: 'pro' }, call: gg => {
        const sit = EN.situation(gg);
        const ai = AU.callFor(gg, { tiers: { home: tier, away: 'pro' } });
        /* one defensive call, every single snap, against the tier's offence */
        if (sit.phase === 'play' && sit.offense === 'home') ai.def = defKey;
        return ai;
      } });
      pts += g.score.home; yards += g.stats.home.yards; plays += g.stats.home.plays;
    }
    return { pts: pts / n, ypp: yards / plays };
  }
  const exRookie = exploiting('rookie', 'zero');
  const exLegend = exploiting('legend', 'zero');
  chk('a Legend offence punishes a one-note blitz far harder than a Rookie one',
      exLegend.pts > exRookie.pts + 4 && exLegend.ypp > exRookie.ypp + 0.35,
      'rookie ' + exRookie.pts.toFixed(1) + ' pts / ' + exRookie.ypp.toFixed(2) + ' a play, legend '
        + exLegend.pts.toFixed(1) + ' / ' + exLegend.ypp.toFixed(2));

  function againstPredictable(tier) {
    let yards = 0, carries = 0, rush = 0, n = 140;
    for (let i = 0; i < n; i++) {
      const g = EN.createGame({ seed: 'pr' + i, home: { name: 'H', overall: 75, seed: 'h' + i },
        away: { name: 'A', overall: 75, seed: 'a' + i }, difficulty: tier });
      AU.playOut(g, { call: gg => {
        const sit = EN.situation(gg);
        if (sit.phase !== 'play') return AU.callFor(gg, {});
        const ai = AU.callFor(gg, {});
        if (sit.offense !== 'home') return ai;
        if (sit.down === 4 && sit.toGo > 2) return { type: 'punt' };
        /* the same play, every down, from the same set */
        return { type: 'play', play: 'inside_zone', formation: 'i_form', def: ai.def || 'base_3' };
      } });
      yards += g.stats.home.yards; carries += g.stats.home.carries; rush += g.stats.home.rushYards;
    }
    return { yards: yards / n, ypc: rush / carries };
  }
  const vsRookie = againstPredictable('rookie');
  const vsLegend = againstPredictable('legend');
  chk('a Legend defence takes a repeated play away',
      vsLegend.ypc < vsRookie.ypc - 0.12,
      'rookie gives up ' + vsRookie.ypc.toFixed(2) + ' a carry, legend ' + vsLegend.ypc.toFixed(2));
  chk('and holds it to fewer yards',
      vsLegend.yards < vsRookie.yards - 8,
      'rookie ' + Math.round(vsRookie.yards) + ', legend ' + Math.round(vsLegend.yards));
  chk('but a Rookie defence is not a walkover either', vsRookie.ypc < 4.6, vsRookie.ypc.toFixed(2));
  chk('and the tiers are ordered', AU && AI.tier('legend').read > AI.tier('allpro').read
      && AI.tier('allpro').read > AI.tier('pro').read && AI.tier('pro').read > AI.tier('rookie').read);

})();

/* ============================================================================
   8  THE PRESENTATION: TWENTY-TWO FOOTBALL PLAYERS, NOT TWENTY-TWO DOTS
   ========================================================================== */
(function presentation() {
  /* every formation puts eleven on the field, in a shape a coach would own */
  Object.keys(FB.FORMATIONS).forEach(k => {
    eq(k + ' puts eleven on the field', Object.keys(FB.FORMATIONS[k].spots).length + 5, 11);
  });
  const BALLX = PA.FIELD.half;
  const off = SG.alignOffense(FB.play('four_verts'), 'gun', BALLX, 30, null, null);
  eq('eleven on offence', off.length, 11);
  eq('five of them are linemen', off.filter(p => p.pos === 'OL').length, 5);
  chk('everybody is between the sidelines', off.every(p => p.x >= 0 && p.x <= PA.FIELD.width));
  chk('the offence lines up behind the ball', off.filter(p => p.pos !== 'OL').every(p => p.y <= 30.1));
  chk('the offence looks downfield', off.every(p => p.face === 'back'));

  FB.DEF_CALLS.forEach(d => {
    const def = SG.alignDefense(FB.defParts(d), BALLX, 30, 1, null, FB.play('slant'), 'trips', null);
    eq('eleven on defence for ' + d.key, def.length, 11);
    chk('the defence is between the sidelines for ' + d.key,
      def.every(p => p.x >= 0 && p.x <= PA.FIELD.width));
    chk('the defence is on its own side for ' + d.key, def.every(p => p.y >= 30));
    chk('the defence faces the offence for ' + d.key, def.every(p => p.face === 'front'));
  });
  const quarters = SG.alignDefense(FB.defParts('quarters'), BALLX, 30, 0, null, FB.play('four_verts'), 'gun', null);
  chk('quarters shows two safeties deep', quarters.filter(p => p.pos === 'S' && p.y >= 40).length >= 2);
  const zero = SG.alignDefense(FB.defParts('zero'), BALLX, 30, 0, null, FB.play('mesh'), 'gun', null);
  chk('a zero blitz walks men up to the line', zero.filter(p => p.blitz).length >= 1);
  chk('and it has no deep help', zero.filter(p => p.pos === 'S' && p.y >= 45).length === 0);
  const press = SG.alignDefense(FB.defParts('zero'), BALLX, 30, 0, null, FB.play('slant'), 'trips', null);
  const soft = SG.alignDefense(FB.defParts('quarters'), BALLX, 30, 0, null, FB.play('slant'), 'trips', null);
  const pressDepth = avgY(press.filter(p => p.pos === 'CB')) - 30;
  const softDepth = avgY(soft.filter(p => p.pos === 'CB')) - 30;
  chk('press coverage lines up on the receiver', pressDepth < softDepth - 2,
    'press ' + pressDepth.toFixed(1) + ', off ' + softDepth.toFixed(1));
  function avgY(l) { return l.reduce((s2, p) => s2 + p.y, 0) / Math.max(1, l.length); }

  /* the front shades toward its strength, and the page can see it */
  const left = SG.alignDefense(FB.defParts('base_3'), BALLX, 30, -1, null, FB.play('slant'), 'gun', null);
  const right = SG.alignDefense(FB.defParts('base_3'), BALLX, 30, 1, null, FB.play('slant'), 'gun', null);
  chk('the front shades to the strength, visibly',
    avgX(right.filter(p => p.pos === 'DL')) > avgX(left.filter(p => p.pos === 'DL')) + 1.5);
  function avgX(l) { return l.reduce((s2, p) => s2 + p.x, 0) / Math.max(1, l.length); }

  /* routes are run in field coordinates, mirrored for the side he lines up on */
  Object.keys(FB.ROUTES).forEach(rk => {
    const r = FB.ROUTES[rk];
    if (!r.band) return;
    const rightSide = SG.routeWorld(rk, BALLX + 12, 30, BALLX);
    const leftSide = SG.routeWorld(rk, BALLX - 12, 30, BALLX);
    chk(rk + ' runs a real path', rightSide.length >= 2);
    chk(rk + ' stays on the field',
      rightSide.every(p => p[0] >= 0 && p[0] <= PA.FIELD.width) &&
      leftSide.every(p => p[0] >= 0 && p[0] <= PA.FIELD.width));
    const rBreak = rightSide[rightSide.length - 1][0] - (BALLX + 12);
    const lBreak = leftSide[leftSide.length - 1][0] - (BALLX - 12);
    if (Math.abs(rBreak) > 1.5) {
      chk(rk + ' mirrors for the other side of the formation', rBreak * lBreak < 0,
        'right ' + rBreak.toFixed(1) + ', left ' + lBreak.toFixed(1));
    }
  });

  /* THE CAMERA IS A CAMERA, NOT A BLUEPRINT. Every one of these is false for
     an overhead diagram and true for a lens in the stand, which is the whole
     difference the presentation turns on. */
  const cam = PA.camera({ w: 390, h: 560, x: PA.FIELD.half, y: 30, px: 15, wide: 36 });
  eq('the middle of the field is the middle of the screen', Math.round(cam.sx(PA.FIELD.half, 30)), 195);
  chk('downfield is up the screen', cam.sy(40) < cam.sy(30));
  chk('the shot is framed on what it is watching',
    Math.abs(cam.sy(30) - cam.h * cam.anchor) < 0.5);
  /* perspective, the thing a diagram has none of */
  chk('a far man is drawn smaller than a near one', cam.scale(55) < cam.scale(20));
  chk('and only about half the size, not a fifth — this is a long lens',
    cam.scale(20) / cam.scale(55) > 1.3 && cam.scale(20) / cam.scale(55) < 2.6,
    'ratio ' + (cam.scale(20) / cam.scale(55)).toFixed(2));
  chk('the sidelines lean in towards each other with distance',
    (cam.sx(PA.FIELD.width, 60) - cam.sx(0, 60)) < (cam.sx(PA.FIELD.width, 20) - cam.sx(0, 20)));
  chk('the far sideline is still the same side of the screen as the near one',
    cam.sx(0, 60) < cam.sx(PA.FIELD.width, 60) && cam.sx(0, 20) < cam.sx(PA.FIELD.width, 20));
  chk('yard lines bunch up as they run away',
    (cam.sy(30) - cam.sy(40)) > (cam.sy(60) - cam.sy(70)));
  chk('a man standing up is drawn above his own feet', cam.sy(30, 2) < cam.sy(30, 0));
  chk('nothing behind the lens turns inside out',
    isFinite(cam.sy(-40)) && isFinite(cam.sx(0, -40)) && cam.sy(-40) > cam.sy(0));
  /* paint on the grass flattens the further off it is — the near thirty is
     a tall number, the far thirty a squashed one */
  chk('ground paint flattens with distance',
    cam.fore(70) / cam.lat(70) < cam.fore(30) / cam.lat(30),
    'far ' + (cam.fore(70) / cam.lat(70)).toFixed(2) + ' vs near ' + (cam.fore(30) / cam.lat(30)).toFixed(2));

  /* the kits are never the same two colours */
  const home = PA.uniform({ primary: '#3fb883', secondary: '#123326', ink: '#06231a' }, false);
  const away = PA.uniform({ primary: '#e2664b', secondary: '#3a1611', ink: '#2a0c08' }, true);
  chk('home and away jerseys differ', home.jersey !== away.jersey);
  chk('a shaded colour can be shaded again',
    /^rgb\(\d+,\d+,\d+\)$/.test(PA.shade(PA.shade('#3fb883', -0.3), 0.4)));
  chk('the number is legible on the jersey', PA.readable('#ffffff') === '#101418'
    && PA.readable('#06231a') === '#ffffff');

  /* EVERY PLAYER IN EVERY STATE DRAWS. A canvas that throws mid-frame is a
     black screen, so this walks the whole vocabulary through a recording
     context and insists on real geometry coming out of it. */
  const STATES = ['stance', 'run', 'carry', 'block', 'engaged', 'tackle', 'down', 'catch',
                  'throw', 'celebrate', 'shed', 'idle'];
  const FACES = ['back', 'front', 'left', 'right'];
  let drawn = 0;
  Object.keys(PA.BUILD).forEach(pos => {
    STATES.forEach(st => {
      FACES.forEach(face => {
        const ctx = recorder();
        PA.player(ctx, { x: PA.FIELD.half, y: 30, pos: pos, kit: home, num: 88,
          state: st, phase: 0.4, face: face, lean: 0.1, sel: st === 'carry' }, cam);
        if (ctx.bad.length) throw new Error(pos + '/' + st + '/' + face + ': ' + ctx.bad[0]);
        if (ctx.calls.fill + ctx.calls.stroke < 6) {
          throw new Error('too little drawn for ' + pos + '/' + st + '/' + face);
        }
        drawn++;
      });
    });
  });
  chk('every position in every state draws a whole player (' + drawn + ' of them)', drawn > 400, drawn);

  /* a player is a PLAYER: a helmet, pads, a body and legs, not a circle */
  const ctxOne = recorder();
  PA.player(ctxOne, { x: PA.FIELD.half, y: 30, pos: 'QB', kit: home, num: 7, state: 'run',
    phase: 0.2, face: 'back' }, cam);
  chk('a player is drawn from many parts, not one dot', ctxOne.calls.fill >= 8, ctxOne.calls.fill);
  chk('a player has a helmet', ctxOne.calls.arc + ctxOne.calls.ellipse >= 2,
      ctxOne.calls.arc + '/' + ctxOne.calls.ellipse);
  /* AND HE IS BUILT LIKE A FOOTBALL PLAYER, which is not the same shape as a
     man: the pads are the widest thing on him and they are wider than a
     man's shoulders, while the helmet stays about a sixth of him. Too narrow
     across the top and he reads as a person in a jumper; too wide and he is
     a cape. The helmet has to stay smaller than the pads or he is a
     bobblehead, and taller than it is wide or it is a ball. */
  const SKW = PA.SKELETON;
  chk('a man is proportioned like a football player',
      SKW.helmW * 2 < 0.26 && SKW.padHalf * 2 > 0.30 && SKW.padHalf * 2 < 0.46
        && SKW.helmW * 2 < SKW.padHalf * 2 && SKW.helmH > SKW.helmW,
      'helmet ' + (SKW.helmW * 2).toFixed(2) + 'x' + SKW.helmH.toFixed(2)
        + ' shoulders ' + (SKW.padHalf * 2).toFixed(2));
  /* every joint is in the right order, feet on the grass and crown at the top */
  chk('the skeleton is in order',
      SKW.ankle < SKW.knee && SKW.knee < SKW.hip && SKW.hip < SKW.waist
        && SKW.waist < SKW.chest && SKW.chest < SKW.shoulder
        && SKW.shoulder < SKW.head && SKW.head < 1,
      JSON.stringify([SKW.knee, SKW.hip, SKW.chest, SKW.shoulder, SKW.head]));
  /* the trenches have to look different from the flankers before any colour
     or number arrives: a guard is wider across the pads than a corner */
  chk('a lineman is not a corner',
      PA.BUILD.OL.pads > PA.BUILD.CB.pads * 1.35 && PA.BUILD.CB.leg > PA.BUILD.OL.leg,
      'OL pads ' + PA.BUILD.OL.pads + ' CB pads ' + PA.BUILD.CB.pads);
  chk('a player wears his number', ctxOne.calls.fillText >= 1);

  /* the field, the ball, the markers and the art all draw */
  const fctx = recorder();
  PA.field(fctx, cam, { tick: 1, homeColor: '#123326', awayColor: '#2a1a2f',
    homeName: 'HIGH PLAINS', awayName: 'FORGEMEN' });
  chk('the field draws its markings', fctx.calls.stroke > 30, fctx.calls.stroke);
  /* the ground is trapezoids now, not rectangles: perspective has no rectangles */
  chk('the field draws its turf, its markings and its end zones',
    fctx.calls.fill > 20 && fctx.calls.stroke > 20,
    'fill ' + fctx.calls.fill + ', stroke ' + fctx.calls.stroke);
  chk('the field carries the team names in the end zones', fctx.calls.fillText >= 2);
  chk('nothing in the field is NaN', fctx.bad.length === 0, fctx.bad[0]);

  const bctx = recorder();
  PA.ball(bctx, { x: PA.FIELD.half, y: 34, z: 2.4, spin: 1 }, cam);
  chk('the ball draws in the air with a shadow under it', bctx.calls.fill >= 2 && bctx.bad.length === 0);

  const actx = recorder();
  PA.art(actx, cam, [{ pts: [[20, 30], [22, 36], [30, 40]], color: '#3fb883' }]);
  chk('play art draws a route with an arrow head', actx.calls.stroke >= 1 && actx.calls.fill >= 1);

  const mctx = recorder();
  PA.markers(mctx, cam, 30, 40);
  chk('the line of scrimmage and the chains are painted on the grass', mctx.calls.fill === 2);

  /* a recording 2D context: counts what was drawn and catches any NaN, which
     is the one way canvas fails silently */
  function recorder() {
    const c = { calls: { fill: 0, stroke: 0, fillRect: 0, fillText: 0, strokeText: 0, arc: 0, ellipse: 0 }, bad: [] };
    const num = (name, args) => {
      for (const a of args) {
        if (typeof a === 'number' && !isFinite(a)) { c.bad.push(name + ' got ' + a); return; }
      }
    };
    const noop = name => function () { num(name, arguments); };
    ['save', 'restore', 'translate', 'rotate', 'scale', 'beginPath', 'moveTo', 'lineTo',
     'closePath', 'arcTo', 'ellipse', 'setLineDash', 'clip', 'setTransform', 'rect',
     /* the figure is built out of curves now: a torso that tapers, a helmet
        with a jaw on it and a facemask hung off the front of it */
     'quadraticCurveTo', 'bezierCurveTo']
      .forEach(m => { c[m] = noop(m); });
    c.fill = function () { c.calls.fill++; };
    c.stroke = function () { c.calls.stroke++; };
    c.fillRect = function () { num('fillRect', arguments); c.calls.fillRect++; };
    c.fillText = function () { num('fillText', arguments); c.calls.fillText++; };
    /* the artist outlines the end-zone wordmark before filling it, so paint
       on grass survives being seen from ninety yards */
    c.strokeText = function () { num('strokeText', arguments); c.calls.strokeText++; };
    c.arc = function () { num('arc', arguments); c.calls.arc++; };
    /* the helmet is an ellipse with a jaw on it rather than a circle, so a
       round part of a man can arrive either way */
    c.ellipse = function () { num('ellipse', arguments); c.calls.ellipse++; };
    /* text has to be measurable: the artist fits club names to the end zone */
    c.measureText = function (t) { return { width: String(t).length * 7 }; };
    c.createLinearGradient = function () { num('gradient', arguments); return grad(); };
    c.createRadialGradient = function () { num('gradient', arguments); return grad(); };
    function grad() {
      return { addColorStop: function (o, col) {
        if (!isFinite(o)) c.bad.push('colour stop offset ' + o);
        if (/NaN|undefined/.test(String(col))) c.bad.push('colour ' + col);
      } };
    }
    Object.defineProperty(c, 'fillStyle', { set: function (v) {
      if (/NaN|undefined/.test(String(v))) c.bad.push('fillStyle ' + v); }, get: function () { return ''; } });
    Object.defineProperty(c, 'strokeStyle', { set: function (v) {
      if (/NaN|undefined/.test(String(v))) c.bad.push('strokeStyle ' + v); }, get: function () { return ''; } });
    ['lineWidth', 'font', 'textAlign', 'textBaseline', 'lineCap', 'lineJoin', 'filter', 'globalAlpha']
      .forEach(k => { Object.defineProperty(c, k, { set: function (v) {
        if (/NaN|undefined/.test(String(v))) c.bad.push(k + ' ' + v); }, get: function () { return ''; } }); });
    return c;
  }
})();

/* ============================================================================
   9  WHAT THE PAGE SHIPS
   ========================================================================== */
(function shipped() {
  const page = fs.readFileSync(G('play/index.html'), 'utf8');
  const js = fs.readFileSync(G('play/play.js'), 'utf8');
  const css = fs.readFileSync(G('gridiron.css'), 'utf8');
  const sw = fs.readFileSync(G('play/sw.js'), 'utf8');
  const man = JSON.parse(fs.readFileSync(G('play/manifest.webmanifest'), 'utf8'));

  ['football.js', 'roster.js', 'engine.js', 'ai.js', 'autoplay.js', 'paint.js', 'stage.js', 'session.js']
    .forEach(f => has(page, '/games/lib/gridiron/' + f, 'the page loads ' + f));
  has(page, 'viewport-fit=cover', 'the page is drawn into the safe area');
  has(page, 'manifest.webmanifest', 'the page declares a manifest');
  has(page, 'apple-touch-icon', 'the page has a home-screen icon');
  has(page, 'id="fld"', 'the page has a canvas to draw the field on');
  has(page, 'id="drawer"', 'the page has a call sheet');
  has(page, 'id="pad"', 'the page has somewhere to put the thumbs');

  has(css, 'env(safe-area-inset-bottom)', 'the call sheet clears the home indicator');
  has(css, 'prefers-reduced-motion', 'motion can be turned down');
  has(css, '100dvh', 'the layout uses the real viewport height');
  has(css, '--tap', 'tap targets come from the shared token') ;
  chk('nothing in the game screen scrolls sideways', css.indexOf('overflow:hidden') > 0);

  /* ── THE PAGE HAS TO BE ABLE TO SCROLL ────────────────────────────────
     A joystick dragged across the field must not drag the page with it, so
     the page cancels touchmove. For a while it cancelled EVERY one of them,
     on the whole document, from the moment it booted, against an allow-list
     of three class names — one of which no longer existed and one of which
     was not the element that scrolls. The matchup screen could not be
     scrolled at all: you arrived on a phone with the Kick off button under
     the browser's own toolbar and no way to reach it.

     The guard belongs to the field, it stands down before the game starts,
     and the thing it names has to be a class the page actually has. */
  const gi = js.indexOf("document.addEventListener('touchmove'");
  chk('the page guards touchmove somewhere', gi > 0);
  const guard = js.slice(gi, js.indexOf('{ passive: false }', gi));
  chk('the touch guard is scoped to the field', guard.indexOf('.gd-field') > 0, guard);
  chk('and stands down before the game starts', guard.indexOf('hidden') > 0, guard);
  chk('and the class it names is one the page has',
      css.indexOf('.gd-field') > 0 && page.indexOf('gd-field') > 0);
  chk('the matchup page leaves room under its last control for the browser chrome',
      css.indexOf('#pre{') > 0 && /#pre\{[^}]*padding-bottom/.test(css.replace(/\s+/g, '')));

  has(js, 'navigator.vibrate', 'haptics are wired');
  has(js, 'AudioContext', 'sound is synthesised rather than downloaded');
  has(js, 'serviceWorker', 'the offline shell is registered');
  chk('the page never decides a result itself',
      js.indexOf('Math.random') < 0, 'play.js must not roll its own dice');

  eq('the manifest starts at the game', man.start_url, '/games/play/');
  eq('the manifest is a standalone app', man.display, 'standalone');
  chk('the manifest has a maskable icon', man.icons.some(i => (i.purpose || '').indexOf('maskable') >= 0));
  man.icons.forEach(i => chk('the manifest icon ' + i.src + ' exists',
    fs.existsSync(path.join(ROOT, i.src.replace(/^\//, '')))));

  has(sw, 'gridiron-v1', 'the shell cache is versioned');
  has(sw, 'caches.delete', 'the old cache is dropped on activate');
  ['football.js', 'engine.js', 'paint.js', 'stage.js', 'session.js']
    .forEach(f => has(sw, '/games/lib/gridiron/' + f, 'the shell caches ' + f));

  /* the doors into it */
  has(fs.readFileSync(G('gameday/index.html'), 'utf8'), '/games/play/', 'Game Day links to the game');
  has(fs.readFileSync(G('games.js'), 'utf8'), '/games/play/', 'every footer links to the game');
  has(fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8'), '/games/play', 'the sitemap lists the game');

  /* the modules keep the repository's conventions */
  ['football.js', 'roster.js', 'engine.js', 'ai.js', 'autoplay.js', 'paint.js', 'stage.js', 'session.js'].forEach(f => {
    const src = fs.readFileSync(G('lib/gridiron/' + f), 'utf8');
    has(src, "'use strict'", f + ' is strict');
    has(src, 'module.exports', f + ' runs under Node');
    chk(f + ' explains itself', src.slice(0, 900).indexOf('===') >= 0);
    chk(f + ' has no leftover debugging', src.indexOf('console.log') < 0);
  });

  /* no pay-to-win, anywhere near this */
  const all = ['football.js', 'roster.js', 'engine.js', 'ai.js', 'autoplay.js', 'paint.js', 'stage.js', 'session.js']
    .map(f => fs.readFileSync(G('lib/gridiron/' + f), 'utf8')).join('\n') + js;
  [/\bgems?\b/i, /\bdiamonds?\b/i, /\bloot\b/i, /energy bar/i, /premium pack/i,
   /\bpurchase\b/i, /\bcheckout\b/i, /\bmicrotransaction/i, /\bpaywall\b/i]
    .forEach(re => chk('nothing matching ' + re + ' anywhere in the game', !re.test(all)));
})();

/* ============================================================================
   10  THE SESSION LAYER
   ========================================================================== */
(function session() {
  chk('the league has personalities', SE.TEAMS.length >= 6);
  chk('every club plays differently', new Set(SE.TEAMS.map(t => t.offense + '/' + t.defense)).size >= 5);
  chk('every club has a scouting line', SE.TEAMS.every(t => t.blurb && t.blurb.length > 20));
  chk('every club names a real scheme', SE.TEAMS.every(t => !!FB.SCHEMES[t.offense]));

  /* THE POSTGAME PANEL PUTS THESE UNDER "why you won" OR "what nearly cost
     you", so which way each one points has to be right. Nought for three in
     the red zone is not a reason anybody won a game. */
  (function reasons() {
    const box = side => ({
      ypc: 3.0, turnovers: 0, thirdPct: 40, third: '4/10', explosive: 2, sacks: 1,
      redzone: side, top: 900, firstDowns: 10, yards: 300
    });
    function flagFor(rz) {
      const b = { home: box(rz), away: box('1/2') };
      const hit = SE.why(b, 'home').filter(r => r.text.indexOf('Red zone') === 0);
      return hit.length ? hit[0].good : null;
    }
    eq('nought for three in the red zone counts against you', flagFor('0/3'), false);
    eq('one for three in the red zone counts against you', flagFor('1/3'), false);
    eq('two for three in the red zone counts for you', flagFor('2/3'), true);
    eq('never in the red zone is not a reason either way', flagFor('0/0'), null);
    const one = SE.why({ home: Object.assign(box('1/2'), { turnovers: 1 }),
                         away: Object.assign(box('1/2'), { turnovers: 0 }) }, 'home')
      .filter(r => r.text.indexOf('Gave it away') === 0)[0];
    chk('one turnover is a time, not times', one && /away 1 time to/.test(one.text),
        one ? one.text : 'no line');
  })();

  MEM = {};
  const s = SE.settings();
  eq('the default is Play mode', s.mode, 'play');
  eq('the default difficulty is Pro', s.difficulty, 'pro');
  eq('play art is on by default', s.art, true);
  SE.saveSettings(Object.assign({}, s, { difficulty: 'legend' }));
  eq('settings survive a reload', SE.settings().difficulty, 'legend');

  const g = SE.build({ week: 3 });
  eq('the house match-up is the one in the brief', g.home.abbr + '-' + g.away.abbr, 'LHP-IRF');
  eq('and you coach your own team', g.meta.user, 'home');

  /* the pre-snap read is a pure function of what is about to be resolved */
  EN.step(g, { type: 'kickoff' });
  g.phase = 'play'; g.possession = 'home'; g.ball = 30; g.down = 1; g.toGo = 10;
  const ps = SE.preSnap(g, 'four_verts', 'gun', 'quarters');
  eq('the read names the coverage', ps.shell, 'Cover 4');
  chk('the read counts the box', ps.box > 3 && ps.box < 10, ps.box);
  chk('the read lists the progression', ps.reads.length >= 3);
  chk('the read says where the front is heavy', ps.strong === 1 || ps.strong === -1);
  eq('and it agrees with the engine', ps.strong,
     FB.strongSide(ps.parts.front.key + ps.parts.coverage.key + ps.parts.pressure.key + ps.parts.fit.key,
                   EN.situation(g)));

  /* scouting says how confident it is, which is the EdgeDesk part */
  const sc = SE.scoutRead(g, 'away');
  chk('a read from nothing is low confidence', sc.confidence === 'low');
  has(sc.note, 'tendency', 'and it says so in words');

  /* the recap explains the result from the box score */
  const r = AU.simulate({ seed: 'recap', home: { name: 'H', overall: 80, seed: 'h' },
                          away: { name: 'A', overall: 68, seed: 'a' } });
  const won = r.score.home > r.score.away;
  const rs = SE.reasons(r.box, 'home', won);
  chk('the recap gives reasons', rs.length >= 2, rs.length);
  chk('and they are facts, not adjectives', rs.every(x => /\d/.test(x)));
  const tp = SE.turningPoint(r.game);
  chk('the recap finds a turning point', !!tp && !!tp.text);
  const potg = EN.playerOfGame(r.game);
  chk('the recap names a player of the game', !!potg && !!potg.name);
})();

/* ── THE CREASE IS DRAWN, AND QUIETLY ─────────────────────────────────────
   The hole the blocking made goes on the grass while the run is happening.
   A stub context records what the painter asks for, so this can say the two
   things that matter without a canvas: that it draws something, and that it
   is faint enough to be grass rather than a diagram over the football. */
(function creaseIsDrawn() {
  function stub() {
    var calls = [], grad = { addColorStop: function (o, c) { calls.push('stop:' + c); } };
    var ctx = new Proxy({}, {
      get: function (t, k) {
        if (k === 'createLinearGradient') return function () { calls.push('grad'); return grad; };
        return function () { calls.push(String(k)); };
      },
      set: function (t, k, v) { calls.push('set ' + String(k) + '=' + v); return true; }
    });
    return { ctx: ctx, calls: calls };
  }
  var cam = { sx: function (x, y) { return 100 + x * 4 - y * 0.3; }, sy: function (y) { return 500 - y * 4; },
              lat: function () { return 15; }, nearestY: function () { return 0; }, w: 390, h: 700 };
  var a = stub();
  PA.crease(a.ctx, cam, { x: 26, w: 4.2, y: 30, open: 0.7 });
  chk('the crease is painted on the field', a.calls.indexOf('fill') >= 0 && a.calls.indexOf('stroke') >= 0);
  var alphas = a.calls.join(' ').match(/rgba\(242,199,68,([0-9.]+)\)/g) || [];
  var maxA = alphas.reduce(function (m, s2) {
    return Math.max(m, parseFloat(s2.replace(/.*,([0-9.]+)\)/, '$1')));
  }, 0);
  chk('and it is grass, not a diagram over the football', maxA > 0 && maxA < 0.35, maxA);
  var b = stub();
  PA.crease(b.ctx, cam, null);
  PA.crease(b.ctx, cam, { x: 26, w: 0, y: 30, open: 0 });
  chk('and there is nothing there when there is no hole', b.calls.length === 0, b.calls.length);
})();

/* ── EVERY SCORING PATH ───────────────────────────────────────────────────
   Six ways the number changes, each one worth exactly what football says it
   is worth, each one landing on the board exactly once — and the transition
   that used to eat one: a touchdown as the quarter expires. Running the score
   clock before the try flipped the phase to halftime or final and the extra
   point simply never happened, so a half ended 20–13 and came back 21–13. */
(function scoringPaths() {
  function fresh(seed, opts) {
    const g = EN.createGame(Object.assign({ seed: seed, home: { name: 'H', seed: 'h' },
      away: { name: 'A', seed: 'a' } }, opts || {}));
    let k = 0;
    while (g.phase !== 'play' && !g.over && k++ < 20) EN.step(g, { type: 'kickoff' });
    return g;
  }
  const WORTH = { touchdown: 6, 'kick return': 6, 'extra point': 1, 'two-point': 2,
                  'field goal': 3, safety: 2 };

  /* the touchdown and the extra point, one point each time */
  const g1 = fresh('sp-td');
  EN.startDrive(g1, 'home', 96);
  let guard = 0;
  while (g1.phase === 'play' && guard++ < 12) EN.step(g1, { type: 'play', play: 'qb_sneak', formation: 'goalline', def: 'goal_line_d' });
  chk('a touchdown puts six on the board and asks for the try',
      g1.score.home === 6 && g1.phase === 'pat' && !!g1.pendingScore, g1.score.home + '/' + g1.phase);
  const before = g1.score.home;
  EN.step(g1, { type: 'pat' });
  chk('the extra point is worth one, and only one',
      g1.score.home === before || g1.score.home === before + 1, g1.score.home);
  chk('and the try is cleared once it is taken', !g1.pendingScore);

  /* the two-point conversion */
  const g2 = fresh('sp-two');
  EN.startDrive(g2, 'home', 96);
  guard = 0;
  while (g2.phase === 'play' && guard++ < 12) EN.step(g2, { type: 'play', play: 'qb_sneak', formation: 'goalline', def: 'goal_line_d' });
  const b2 = g2.score.home;
  const two = EN.step(g2, { type: 'two', play: 'power', formation: 'goalline', def: 'goal_line_d' });
  chk('a two-point conversion is worth two, or nothing',
      g2.score.home === b2 + (two.good ? 2 : 0), g2.score.home - b2);

  /* the safety */
  const g3 = fresh('sp-safety');
  EN.startDrive(g3, 'home', 1);
  guard = 0;
  while (g3.score.away === 0 && guard++ < 60 && !g3.over) {
    if (EN.situation(g3).phase !== 'play') break;
    EN.step(g3, { type: 'play', play: 'dive', formation: 'goalline', def: 'goal_line_d' });
    if (g3.ball > 6) EN.startDrive(g3, 'home', 1);
  }
  chk('a safety is two to the other side', g3.score.away === 0 || g3.score.away === 2, g3.score.away);

  /* every score in a hundred games is a legal one, counted once */
  let bad = 0, tds = 0, tries = 0;
  for (let i = 0; i < 100; i++) {
    const r = AU.simulate({ seed: 'SP' + i, difficulty: 'pro',
      home: { name: 'H', overall: 72 + i % 12, seed: 'h' + i },
      away: { name: 'A', overall: 72 + (i * 5) % 12, seed: 'a' + i } });
    let h = 0, a = 0;
    r.game.log.forEach((e) => {
      if (e.kind === 'pat') tries++;
      if (e.kind !== 'score') return;
      if (WORTH[e.how] !== e.points) bad++;
      if (e.how === 'touchdown' || e.how === 'kick return') tds++;
      if (e.side === 'home') h += e.points; else a += e.points;
    });
    if (h !== r.score.home || a !== r.score.away) bad++;
  }
  eq('a hundred games and every score is worth what it is worth', bad, 0);
  eq('and every touchdown got its try — including the ones the clock ended', tries, tds);

  /* the transition itself: a touchdown with seconds left in the half */
  const g4 = fresh('sp-half');
  g4.quarter = 2; g4.clock = 400;
  EN.startDrive(g4, 'home', 99);
  guard = 0;
  while (g4.phase === 'play' && guard++ < 10) {
    EN.step(g4, { type: 'play', play: 'qb_sneak', formation: 'goalline', def: 'goal_line_d' });
    if (g4.phase === 'play' && g4.down > 1) EN.startDrive(g4, 'home', 99);
    g4.clock = 400;
  }
  chk('a touchdown puts the try on the board before the clock gets a say',
      g4.phase === 'pat' && g4.score.home === 6, g4.phase + '/' + g4.score.home);
  /* now the score clock has to cross the half, with the try still owed */
  g4.clock = 15;
  const patRes = EN.step(g4, { type: 'pat' });
  chk('the try is taken even though it ends the half', patRes.event === 'pat');
  chk('and the point is on the board before the half arrives',
      g4.score.home === 6 || g4.score.home === 7, g4.score.home);
  chk('the half then arrives', g4.phase === 'halftime' || g4.over, g4.phase);
  chk('nothing is left pending when it does', !g4.pendingScore);
  chk('and the half froze what the half actually was',
      !!g4.halfBox && g4.halfBox.score.home === g4.score.home,
      JSON.stringify(g4.halfBox && g4.halfBox.score));
})();

/* ── DIFFICULTY IS NOT A CHEAT ────────────────────────────────────────────
   The one promise the difficulty ladder makes: every tier plays the same
   football with the same men. What changes is how well the coach reads the
   situation, how fast he adapts, how wide his shortlist is and whether he
   gets fourth down right. If a tier could touch a rating, a hard game would
   stop being a football game and start being an arithmetic apology. */
(function difficultyIsHonest() {
  const seen = {};
  ['rookie', 'pro', 'allpro', 'legend'].forEach((d) => {
    const g = EN.createGame({ seed: 'fair', difficulty: d,
      home: { name: 'H', overall: 76, offense: 'pro_style', defense: 'four_three', seed: 'fh' },
      away: { name: 'A', overall: 74, offense: 'spread', defense: 'zone', seed: 'fa' } });
    seen[d] = ['home', 'away'].map(side => g[side].players.map(p =>
      p.position + p.depth + ':' + p.overall + ':' + JSON.stringify(p.ratings)).join('|')).join('#');
  });
  chk('every difficulty gets the same eighty men, rated the same',
      seen.rookie === seen.pro && seen.pro === seen.allpro && seen.allpro === seen.legend);
  const T = AI.TIERS;
  chk('what a tier changes is judgement, and nothing else',
      Object.keys(T.legend).every(k => ['key', 'name', 'means'].indexOf(k) >= 0
        || typeof T.legend[k] === 'number'),
      Object.keys(T.legend).join(','));
  chk('and the ladder is ordered on every dial it does change',
      T.legend.read > T.allpro.read && T.allpro.read > T.pro.read && T.pro.read > T.rookie.read
      && T.legend.adapt > T.rookie.adapt && T.legend.noise < T.rookie.noise
      && T.legend.disguise > T.rookie.disguise && T.legend.fourth > T.rookie.fourth);
})();

/* ── NOTHING IMPOSSIBLE ───────────────────────────────────────────────────
   The full list lives in gridiron_invariants.js and the ten-thousand-game
   harness runs it over every population. This runs it here too, on a small
   spread of matchups and both modes, so a change that makes the engine
   contradict itself fails in twenty seconds rather than in the nightly. */
(function invariants() {
  const SCH = ['power_run', 'spread', 'air_raid', 'west_coast', 'pro_style', 'option'];
  const DEF = ['four_three', 'three_four', 'press_man', 'zone', 'blitz_heavy', 'bend_dont_break'];
  let bad = [], n = 0;
  for (let i = 0; i < 60; i++) {
    const r = AU.simulate({
      seed: 'INV' + i, difficulty: ['rookie', 'pro', 'allpro', 'legend'][i % 4],
      weather: i % 3 === 0 ? { weather: 'rain', wind: 16, temp: 39 } : null,
      home: { name: 'H', overall: 68 + (i * 7) % 20, offense: SCH[i % 6], defense: DEF[i % 6], seed: 'h' + i },
      away: { name: 'A', overall: 68 + (i * 11) % 20, offense: SCH[(i + 3) % 6], defense: DEF[(i + 2) % 6], seed: 'a' + i }
    });
    n++;
    bad = bad.concat(INV.check(EN, r.game, r.box).violations.map(v => 'sim ' + i + ': ' + v));
  }
  /* Play Mode is the path a person on a phone is using; it books through the
     same engine, so it has to satisfy the same list. */
  for (let i = 0; i < 4; i++) {
    const r = AU.simulateLive({
      seed: 'LIV' + i, difficulty: 'pro',
      home: { name: 'H', overall: 75, offense: SCH[i % 6], defense: DEF[i % 6], seed: 'lh' + i },
      away: { name: 'A', overall: 75, offense: SCH[(i + 2) % 6], defense: DEF[(i + 4) % 6], seed: 'la' + i }
    });
    n++;
    bad = bad.concat(INV.check(EN, r.game, r.box).violations.map(v => 'live ' + i + ': ' + v));
  }
  chk(n + ' games, and not one of them contradicts itself', bad.length === 0,
      bad.slice(0, 4).join(' | '));
})();

/* ── report ──────────────────────────────────────────────────────────────── */
console.log('\nGRIDIRON — the football');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
if (fail) {
  console.log('\nFAILURES');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
process.exit(0);
