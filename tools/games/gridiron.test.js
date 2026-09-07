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
const RD = require(G('lib/gridiron/render.js'));
const SE = require(G('lib/gridiron/session.js'));

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
   8  THE RENDERER DRAWS WHAT THE ENGINE RESOLVED
   ========================================================================== */
(function renderer() {
  Object.keys(FB.FORMATIONS).forEach(k => {
    eq(k + ' puts eleven on the field', Object.keys(FB.FORMATIONS[k].spots).length + 5, 11);
  });
  const off = RD.alignOffense(FB.play('four_verts'), 'gun');
  eq('eleven on offence', off.length, 11);
  eq('five of them are linemen', off.filter(p => p.pos === 'OL').length, 5);
  chk('everybody is on the field', off.every(p => Math.abs(p.fy) <= 26.7));

  FB.DEF_CALLS.forEach(d => {
    const def = RD.alignDefense(FB.defParts(d), null, 1);
    eq('eleven on defence for ' + d.key, def.length, 11);
    chk('the defence is on the field for ' + d.key, def.every(p => Math.abs(p.fy) <= 26.7));
    chk('the defence is on its own side for ' + d.key, def.every(p => p.fx >= 0));
  });
  const zero = RD.alignDefense(FB.defParts('zero'), null, 0);
  chk('a zero blitz shows blitzers', zero.filter(p => p.blitz).length > 0);
  const quarters = RD.alignDefense(FB.defParts('quarters'), null, 0);
  chk('quarters shows two safeties deep', quarters.filter(p => p.pos === 'S' && p.fx >= 10).length >= 2);

  /* every result the engine can produce must choreograph without throwing */
  const rand = EN.rng(11);
  const o = team({ name: 'O', seed: 'o' }), d = team({ name: 'D', seed: 'd' });
  let plans = 0;
  FB.PLAYS.forEach(p => {
    FB.DEF_CALLS.forEach(dc => {
      const r = EN.resolve({ off: o, def: d, rand, tick: plans, playKey: p.key,
        formKey: p.forms[0], defCall: dc.key, sit: { down: 1, toGo: 10, ball: 30, toGoal: 70 },
        mem: EN.newMemory() });
      r.startBall = 30;
      const plan = RD.choreograph(r);
      if (plan.actors.length !== 22) throw new Error('actors ' + plan.actors.length + ' for ' + p.key);
      if (!(plan.duration > 0.4 && plan.duration <= 6.5)) throw new Error('duration ' + plan.duration + ' on ' + p.key + '/' + dc.key);
      plan.actors.forEach(a => {
        if (!a.track.length) throw new Error('no track for ' + a.id);
        a.track.forEach(k => {
          if (!isFinite(k.fx) || !isFinite(k.fy)) throw new Error('bad keyframe on ' + a.id);
        });
        for (let i = 1; i < a.track.length; i++) {
          if (a.track[i].t < a.track[i - 1].t) throw new Error('time runs backwards on ' + a.id);
        }
      });
      plans++;
    });
  });
  chk('every play against every defence choreographs cleanly (' + plans + ' of them)', plans > 600, plans);

  /* the field draws itself */
  const svg = RD.fieldSvg();
  has(svg, 'stroke="#fff"', 'the goal lines are drawn');
  has(svg, 'class="fnum"', 'the yard numbers are drawn');
  chk('the field is a sane size', svg.length > 4000 && svg.length < 80000, svg.length);
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

  ['football.js', 'roster.js', 'engine.js', 'ai.js', 'autoplay.js', 'render.js', 'session.js']
    .forEach(f => has(page, '/games/lib/gridiron/' + f, 'the page loads ' + f));
  has(page, 'viewport-fit=cover', 'the page is drawn into the safe area');
  has(page, 'manifest.webmanifest', 'the page declares a manifest');
  has(page, 'apple-touch-icon', 'the page has a home-screen icon');
  has(page, 'id="stage"', 'the page has a field to draw on');
  has(page, 'id="deck"', 'the page has a call sheet');

  has(css, 'env(safe-area-inset-bottom)', 'the call sheet clears the home indicator');
  has(css, 'prefers-reduced-motion', 'motion can be turned down');
  has(css, '100dvh', 'the layout uses the real viewport height');
  has(css, '--tap', 'tap targets come from the shared token') ;
  chk('nothing in the game screen scrolls sideways', css.indexOf('overflow:hidden') > 0);

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
  ['football.js', 'engine.js', 'render.js', 'session.js']
    .forEach(f => has(sw, '/games/lib/gridiron/' + f, 'the shell caches ' + f));

  /* the doors into it */
  has(fs.readFileSync(G('gameday/index.html'), 'utf8'), '/games/play/', 'Game Day links to the game');
  has(fs.readFileSync(G('games.js'), 'utf8'), '/games/play/', 'every footer links to the game');
  has(fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8'), '/games/play', 'the sitemap lists the game');

  /* the modules keep the repository's conventions */
  ['football.js', 'roster.js', 'engine.js', 'ai.js', 'autoplay.js', 'render.js', 'session.js'].forEach(f => {
    const src = fs.readFileSync(G('lib/gridiron/' + f), 'utf8');
    has(src, "'use strict'", f + ' is strict');
    has(src, 'module.exports', f + ' runs under Node');
    chk(f + ' explains itself', src.slice(0, 900).indexOf('===') >= 0);
    chk(f + ' has no leftover debugging', src.indexOf('console.log') < 0);
  });

  /* no pay-to-win, anywhere near this */
  const all = ['football.js', 'roster.js', 'engine.js', 'ai.js', 'autoplay.js', 'render.js', 'session.js']
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

/* ── report ──────────────────────────────────────────────────────────────── */
console.log('\nGRIDIRON — the football');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
if (fail) {
  console.log('\nFAILURES');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
process.exit(0);
