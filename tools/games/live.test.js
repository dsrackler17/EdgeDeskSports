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

console.log('  ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('\nFAILURES'); fails.forEach(f => console.log(f)); process.exit(1); }
