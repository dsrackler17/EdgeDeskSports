/* ===========================================================================
   PLAY MODE — can I actually play it?

   Not "does the simulation run" and not "are the numbers pretty". These ask
   the only question that matters about an interactive football game: DOES
   WHAT I DO WITH MY THUMBS CHANGE WHAT HAPPENS?

   Every case here is a deterministic input recording — a seed and a scripted
   sequence of thumbstick positions and button presses. Replay the same seed
   and the same script and you must get the same play back, to the yard.
   Change the script and the play must change.
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const L = p => require(path.join(ROOT, 'games', 'lib', 'gridiron', p));
const G = L('engine.js'), S = L('session.js'), F = L('football.js');
const ST = L('stage.js'), LIVE = L('live.js');

let pass = 0, fail = 0; const fails = [];
function chk(name, ok, detail) {
  if (ok) pass++; else { fail++; fails.push('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function near(name, v, lo, hi) {
  chk(name, v >= lo && v <= hi, String(Math.round(v * 100) / 100) + ' not in [' + lo + '–' + hi + ']');
}

/* a seeded stream, so a recording is a recording */
function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function freshGame(seed) {
  const g = S.build({ home: 'lubbock', away: 'amarillo', seed: seed, length: 'blitz' });
  let guard = 0;
  while (g.phase !== 'play' && !g.over && guard++ < 40) {
    S.step(g, { type: g.phase === 'kickoff' ? 'kickoff' : g.phase === 'pat' ? 'pat' : 'halftime_done' });
  }
  return g;
}

/* ── ONE RECORDED SNAP ────────────────────────────────────────────────────
   playKey/formKey/defKey, a seed, and `script(t, sim)` returning the input
   for that tick. Fixed timestep: a recording must not depend on frame rate. */
function record(o) {
  const g = o.game || freshGame(o.seed || 1);
  const side = g.possession;
  const offT = G.teamOf(g, side), defT = G.teamOf(g, G.other(side));
  const playObj = F.play(o.play), parts = F.defParts(o.def);
  const sit = G.situation(g);
  const env = G.prepare({
    off: offT, def: defT, rand: mulberry((o.seed || 1) * 31 + 7), tick: g.tick,
    playKey: o.play, formKey: o.form, defCall: o.def, sit: sit, mem: g.mem[side]
  });
  const los = o.los == null ? g.ball : o.los, bx = o.bx == null ? 26.665 : o.bx;
  const actors = ST.alignOffense(playObj, o.form, bx, los, G.unitsOf(offT, g.tick), {})
    .concat(ST.alignDefense(parts, bx, los, 1, G.unitsOf(defT, g.tick), playObj, o.form, {}));
  const sim = LIVE.Play({
    actors: actors, playObj: playObj, parts: parts, formKey: o.form,
    los: los, ballX: bx, env: env, rand: mulberry(o.seed || 1),
    userSide: o.userSide || 'off', userMode: 'play'
  });
  sim.snap();
  const dt = 1 / 120;
  let t = 0, guard = 0;
  while (!sim.outcome() && guard++ < 2400) {
    sim.step(dt, o.script ? (o.script(t, sim) || {}) : {});
    t += dt;
  }
  return { out: sim.outcome(), t: t, sim: sim, game: g, los: los };
}

/* scripts, named so a failure reads like a complaint about football */
const forward = () => ({ mx: 0, my: 1 });
const backward = () => ({ mx: 0, my: -1 });
const left = () => ({ mx: -1, my: 0.35 });
const right = () => ({ mx: 1, my: 0.35 });
const jukeAt = when => t => ({ mx: 0, my: 1, action: (t > when && t < when + 0.02) ? 'juke' : null });
const truckAt = when => t => ({ mx: 0, my: 1, action: (t > when && t < when + 0.02) ? 'truck' : null });
const throwAt = (when, read) => t => ({ throwTo: (t > when && t < when + 0.02) ? (read || 0) : null });
const holdIt = () => ({});
/* bounce it and keep bouncing it, all the way to the paint */
const sideline = () => ({ mx: 1, my: 0.25 });

console.log('\nPLAY MODE — the thumbs');

/* ── 1. A RECORDING REPLAYS ─────────────────────────────────────────────── */
(() => {
  const a = record({ seed: 11, play: 'inside_zone', form: 'i_form', def: 'base_3', script: jukeAt(1.2) });
  const b = record({ seed: 11, play: 'inside_zone', form: 'i_form', def: 'base_3', script: jukeAt(1.2) });
  chk('the same seed and the same thumbs give the same run, to the yard',
    a.out.yards === b.out.yards && Math.abs(a.t - b.t) < 1e-9,
    a.out.yards + ' vs ' + b.out.yards);
  const c = record({ seed: 12, play: 'four_verts', form: 'gun', def: 'two_deep', script: throwAt(2.2, 0) });
  const d = record({ seed: 12, play: 'four_verts', form: 'gun', def: 'two_deep', script: throwAt(2.2, 0) });
  chk('and the same pass, to the yard and to the outcome',
    c.out.yards === d.out.yards && c.out.completion === d.out.completion,
    c.out.yards + '/' + c.out.completion + ' vs ' + d.out.yards + '/' + d.out.completion);
})();

/* ── 2. THE STICK CHANGES THE RUN ───────────────────────────────────────── */
(() => {
  let differ = 0, bad = 0, n = 0;
  for (let i = 0; i < 40; i++) {
    const g = freshGame(200 + i);
    const f = record({ game: g, seed: 400 + i, play: 'inside_zone', form: 'i_form', def: 'base_3', script: forward });
    const l = record({ game: g, seed: 400 + i, play: 'inside_zone', form: 'i_form', def: 'base_3', script: left });
    const b = record({ game: g, seed: 400 + i, play: 'inside_zone', form: 'i_form', def: 'base_3', script: backward });
    n++;
    /* the same two yards up the middle and two yards off tackle are not the
       same football play: compare where he actually finished */
    if (f.out.yards !== l.out.yards || Math.abs(f.out.endX - l.out.endX) > 1.2) differ++;
    if (b.out.yards < f.out.yards) bad++;
  }
  chk('steering somewhere else gets you somewhere else', differ / n > 0.8, (differ * 100 / n).toFixed(0) + '%');
  chk('AND THE USER CAN SCREW IT UP: running backwards loses ground',
    bad / n > 0.75, (bad * 100 / n).toFixed(0) + '% of runs were worse');
})();

/* ── 3. THE MOVES DO SOMETHING ──────────────────────────────────────────── */
(() => {
  let plainBroke = 0, jukeBroke = 0, truckBroke = 0, n = 0;
  for (let i = 0; i < 90; i++) {
    const g = freshGame(300 + i);
    const p = record({ game: g, seed: 600 + i, play: 'counter', form: 'i_form', def: 'pinch_run', script: forward });
    const j = record({ game: g, seed: 600 + i, play: 'counter', form: 'i_form', def: 'pinch_run', script: jukeAt(1.0) });
    const k = record({ game: g, seed: 600 + i, play: 'counter', form: 'i_form', def: 'pinch_run', script: truckAt(1.0) });
    n++;
    plainBroke += p.out.broke || 0; jukeBroke += j.out.broke || 0; truckBroke += k.out.broke || 0;
  }
  chk('a juke breaks more tackles than standing up in the hole',
    jukeBroke > plainBroke, jukeBroke + ' vs ' + plainBroke);
  chk('so does a truck', truckBroke > plainBroke, truckBroke + ' vs ' + plainBroke);
})();

/* ── 4. WHEN YOU THROW IS YOUR DECISION, AND IT COSTS ───────────────────── */
(() => {
  /* ON TIME IS A PROPERTY OF THE ROUTE, not of the clock: four verticals is
     not late at two and a half seconds, it is barely open. */
  const routeT = (F.ROUTES.go && F.ROUTES.go.t) || 3.2;
  const shots = [routeT * 0.28, routeT * 0.90];
  const comp = shots.map(() => 0);
  let held = 0, n = 60;
  for (let i = 0; i < n; i++) {
    const g = freshGame(500 + i);
    shots.forEach((w, k) => {
      const r = record({ game: g, seed: 800 + i, play: 'four_verts', form: 'gun', def: 'base_3', script: throwAt(w, 0) });
      if (r.out.completion) comp[k]++;
    });
    const s = record({ game: g, seed: 800 + i, play: 'four_verts', form: 'gun', def: 'a_gap', script: holdIt });
    if (s.out.sack) held++;
  }
  chk('throwing before the route exists completes less than throwing on time',
    comp[0] < comp[1], comp.map((c, k) => shots[k].toFixed(1) + 's:' + c).join(' '));
  chk('and holding the ball against a blitz gets you buried',
    held / n > 0.6, (held * 100 / n).toFixed(0) + '% sacked');
})();

/* ── 5. WHO YOU THROW TO IS YOUR DECISION ───────────────────────────────── */
(() => {
  let differ = 0, n = 0;
  for (let i = 0; i < 40; i++) {
    const g = freshGame(700 + i);
    const a = record({ game: g, seed: 900 + i, play: 'mesh', form: 'gun', def: 'stack', script: throwAt(1.7, 0) });
    const b = record({ game: g, seed: 900 + i, play: 'mesh', form: 'gun', def: 'stack', script: throwAt(1.7, 2) });
    n++;
    const na = a.out.target && a.out.target.id, nb = b.out.target && b.out.target.id;
    if (a.out.yards !== b.out.yards || na !== nb) differ++;
  }
  chk('the first read and the third read are different footballs',
    differ / n > 0.7, (differ * 100 / n).toFixed(0) + '%');
})();

/* ── 6. EVERY OUTCOME THE GAME NEEDS ACTUALLY HAPPENS ───────────────────── */
(() => {
  const seen = { run: 0, completion: 0, incomplete: 0, sack: 0, interception: 0,
                 touchdown: 0, broken: 0, loss: 0, outOfBounds: 0 };
  const menu = [
    ['inside_zone', 'i_form', 'base_3', forward], ['counter', 'i_form', 'stack', jukeAt(1.0)],
    ['inside_zone', 'i_form', 'pinch_run', backward], ['counter', 'i_form', 'tampa', right],
    ['slant', 'gun', 'two_deep', throwAt(1.2, 0)], ['mesh', 'gun', 'stack', throwAt(1.6, 1)],
    ['pa_cross', 'i_form', 'base_3', throwAt(2.4, 0)], ['four_verts', 'gun', 'tampa', throwAt(2.6, 0)],
    ['four_verts', 'gun', 'a_gap', holdIt], ['slant', 'gun', 'a_gap', holdIt],
    ['pa_cross', 'i_form', 'stack', throwAt(0.7, 1)], ['four_verts', 'gun', 'stack', throwAt(0.8, 2)],
    ['counter', 'i_form', 'base_3', sideline], ['inside_zone', 'i_form', 'two_deep', sideline]
  ];
  for (let i = 0; i < 220; i++) {
    const m = menu[i % menu.length];
    const r = record({ seed: 1000 + i, play: m[0], form: m[1], def: m[2], script: m[3],
                       los: (i % 7 === 0) ? 88 : undefined });
    const o = r.out;
    if (!o) continue;
    if (o.carrier && !o.completion) seen.run++;
    if (o.completion) seen.completion++;
    if (o.incomplete) seen.incomplete++;
    if (o.sack) seen.sack++;
    if (o.turnover === 'interception') seen.interception++;
    if (o.touchdown) seen.touchdown++;
    if (o.broke > 0) seen.broken++;
    if (o.yards < 0 && !o.sack) seen.loss++;
    if (o.outOfBounds) seen.outOfBounds++;
  }
  /* OUT OF BOUNDS needs the ball on a hash and a runner told to take it
     there — from the middle of the field a back steered sideways is run
     down after eight yards, which is the right answer to running sideways
     and the wrong way to test a sideline. */
  let oob = 0;
  for (let i = 0; i < 50; i++) {
    const r = record({ seed: 1500 + i, play: 'counter', form: 'i_form', def: 'two_deep',
                       bx: 4.5, script: () => ({ mx: -1, my: 0.15 }) });
    if (r.out.outOfBounds) oob++;
  }
  seen.outOfBounds = oob;
  Object.keys(seen).forEach(k => {
    chk('the simulation produces a ' + k, seen[k] > 0, JSON.stringify(seen));
  });
})();

/* ── 7. THE ENGINE STILL OWNS THE BOOKS ─────────────────────────────────── */
(() => {
  const g = freshGame(77);
  const before = G.situation(g);
  const r = record({ game: g, seed: 4242, play: 'inside_zone', form: 'i_form', def: 'base_3', script: forward });
  const booked = S.step(g, { type: 'play', play: 'inside_zone', formation: 'i_form',
                             def: 'base_3', outcome: r.out });
  const after = G.situation(g);
  chk('a live outcome is booked by the engine', booked.ok && booked.play.live === true);
  chk('and it books the yards the simulation measured', booked.play.yards === r.out.yards,
    booked.play.yards + ' vs ' + r.out.yards);
  chk('down and distance move', after.down !== before.down || after.toGo !== before.toGo);
  chk('the ball moves with it', g.ball === before.ball + r.out.yards || booked.play.touchdown,
    g.ball + ' vs ' + (before.ball + r.out.yards));
  chk('the play is on the stat sheet', g.stats[before.offense].plays > 0);
  chk('and it narrates like any other play', typeof booked.play.commentary === 'string'
    && booked.play.commentary.length > 4, booked.play.commentary);
  /* the save carries it, so a reload does not rewrite history */
  const raw = JSON.stringify(g.calls[g.calls.length - 1]);
  chk('the call list carries the live result', raw.indexOf('"o":') >= 0 && raw.indexOf('"yards"') >= 0);
})();

/* ── 8. COACH MODE IS UNTOUCHED ─────────────────────────────────────────── */
(() => {
  function coachRun(seed) {
    const g = freshGame(seed);
    const out = [];
    for (let i = 0; i < 12 && !g.over; i++) {
      if (g.phase !== 'play') { S.step(g, { type: g.phase === 'kickoff' ? 'kickoff' : g.phase === 'pat' ? 'pat' : 'halftime_done' }); continue; }
      const r = S.step(g, { type: 'play', play: 'inside_zone', formation: 'i_form', def: 'base_3' });
      if (r.ok && r.play) out.push(r.play.yards);
    }
    return out.join(',');
  }
  chk('the deterministic resolver still reproduces exactly', coachRun(9) === coachRun(9));
  chk('and it is still deciding plays without any outcome handed in',
    coachRun(9).length > 0 && coachRun(9) !== coachRun(10));
})();

/* ── THE BLOCKING IS LEGIBLE ────────────────────────────────────────────
   The engine has always known why a carry got four yards instead of one; the
   picture did not, and neither did the player. These say that what the
   simulation knows about the blocking actually comes back out of it — the
   hole while the run is happening, and the man who won or lost the block once
   it is over. A run play whose result is a number and nothing else is a run
   play nobody learns anything from. */
(() => {
  let creases = 0, widths = 0, won = 0, blamed = 0, named = 0, n = 0, badW = 0, story = 0;
  const RUNS = ['inside_zone', 'outside_zone', 'power', 'counter', 'stretch', 'toss', 'dive'];
  for (let i = 0; i < 90; i++) {
    const play = RUNS[i % RUNS.length];
    const seen = [];
    const r = record({
      seed: 400 + i, play: play, form: F.play(play).forms[0], def: 'base_3',
      script: (t, sim) => { const c = sim.crease(); if (c) seen.push(c); return { mx: 0, my: 1 }; }
    });
    n++;
    if (seen.length) {
      creases++; widths += seen[Math.floor(seen.length / 2)].w;
      seen.forEach((c) => {
        if (!(c.w > 0 && c.w <= 6.5) || !(c.x >= 0 && c.x <= 54) || !(c.open >= 0 && c.open <= 1)) badW++;
      });
    }
    if (r.out.blockWon) won++;
    if (r.out.blockBeat || r.out.blockFree) blamed++;
    /* a carry of two is nobody's doing and gets no line; the ones with a
       story in them are the ones that must tell it */
    const y = r.out.yards;
    if (y >= 4 || y <= 1) {
      story++;
      if ((r.out.notes || []).some(x => /held the point|beat the block|came free/.test(x))) named++;
    }
  }
  chk('a run shows the hole the blocking made', creases >= n * 0.6, creases + '/' + n);
  chk('and it is a hole rather than half the field', badW === 0, badW + ' out of bounds');
  chk('a crease is the width of a gap, not of a formation',
    widths / Math.max(1, creases) >= 2 && widths / Math.max(1, creases) <= 6.5,
    (widths / Math.max(1, creases)).toFixed(2) + ' yards');
  chk('the whistle names the block that decided it', won >= n * 0.5, won + '/' + n);
  chk('and it names somebody when the run went nowhere', blamed >= n * 0.2, blamed + '/' + n);
  chk('and a carry with a story in it says what the story was',
    named >= story * 0.6, named + '/' + story);
  /* it must never appear where there is no run to read */
  const pass = record({ seed: 77, play: 'four_verts', form: 'gun', def: 'two_deep', script: holdIt });
  chk('a pass play has no crease to show', pass.sim.crease() === null);
})();

/* ── ONE NAME, ONE THING ──────────────────────────────────────────────────
   play.js is a single closure two thousand lines long, and `var` does not
   care: declaring the same name twice at module scope silently gives the
   whole file whichever one is assigned last. That shipped — a table of player
   milestones called MARKS, and eleven hundred lines later a table of club
   badges called MARKS. The second won, `MARKS.forEach` threw on the first
   snap of every game, and because it threw inside the whistle handler the
   game stopped dead: no next play, no clock, nothing. Every test passed and
   the simulation was perfect. Only a browser found it.

   Two lines of guard against an entire class of that. */
(() => {
  const FILES = ['games/play/play.js', 'games/lib/gridiron/live.js',
                 'games/lib/gridiron/stage.js', 'games/lib/gridiron/engine.js',
                 'games/lib/gridiron/paint.js', 'games/lib/gridiron/session.js'];
  const fs = require('fs');
  FILES.forEach((rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const seen = {}, dupes = [];
    /* module scope inside the closure is exactly two spaces of indent; a
       function-local `var` is indented further and is nobody's business */
    const re = /^ {2}var ([A-Za-z_$][\w$]*)\s*=/gm;
    let m;
    while ((m = re.exec(src))) {
      const line = src.slice(0, m.index).split('\n').length;
      if (seen[m[1]]) dupes.push(m[1] + ' (lines ' + seen[m[1]] + ' and ' + line + ')');
      else seen[m[1]] = line;
    }
    chk(rel.split('/').pop() + ' declares each name once', dupes.length === 0, dupes.join(', '));
    /* and it is at least valid JavaScript. play.js is two thousand lines of
       the only part of this game a person actually touches, and until now
       nothing in the suite so much as read it. */
    let parsed = true, why = '';
    try { new Function(src); } catch (e) { parsed = false; why = e.message; }
    chk(rel.split('/').pop() + ' parses', parsed, why);
  });
})();

console.log('  ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('\nFAILURES'); fails.forEach(f => console.log(f)); process.exit(1); }
