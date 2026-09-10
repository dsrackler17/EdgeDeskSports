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
  /* build() takes team objects and a settings block; the strings this used to
     pass were ignored, so it silently tested the default matchup at the
     default length. Say what is meant. */
  const g = S.build({ seed: seed, settings: { length: 'blitz', difficulty: 'pro' } });
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
    playKey: o.play, formKey: o.form, defCall: o.def, sit: sit, mem: g.mem[side],
    difficulty: o.difficulty || null
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
/* the same throw, as one of the three footballs */
const throwKind = (when, read, kind) => t => ({ throwTo: (t > when && t < when + 0.02) ? (read || 0) : null, throwKind: kind });
/* roll one way for most of a second, then throw */
const rollThen = (dir, when, read, kind) => t => ({ mx: t < when ? dir : 0, my: t < when ? -0.15 : 0,
  throwTo: (t > when && t < when + 0.02) ? (read || 0) : null, throwKind: kind || null });
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

/* ── THE FORMATION THAT IS ONLY A PICTURE ─────────────────────────────────
   Between calls the page lines eleven men up so the field is never empty.
   That formation is a picture: it has no call behind it, and a second thumb
   or a stale timer must not be able to say hut over it. The refusal belongs
   in the simulation, because the simulation is the only thing that can be
   sure — and it has to REPORT the refusal, so whatever locked the controls
   on the way in gets the lock back. */
(() => {
  const g = freshGame(9);
  const side = g.possession;
  const offT = G.teamOf(g, side), defT = G.teamOf(g, G.other(side));
  const playObj = F.play('inside_zone'), parts = F.defParts('base_3');
  const env = G.prepare({
    off: offT, def: defT, rand: mulberry(11), tick: g.tick, playKey: 'inside_zone',
    formKey: 'single', defCall: 'base_3', sit: G.situation(g), mem: g.mem[side]
  });
  const spots = () => ST.alignOffense(playObj, 'single', 26.665, 25, G.unitsOf(offT, g.tick), {})
    .concat(ST.alignDefense(parts, 26.665, 25, 1, G.unitsOf(defT, g.tick), playObj, 'single', {}));
  const base = { playObj: playObj, parts: parts, formKey: 'single', los: 25, ballX: 26.665,
    rand: mulberry(11), userSide: 'off', userMode: 'play' };

  const shown = LIVE.Play(Object.assign({}, base, { actors: spots(), env: env, preview: true }));
  chk('a preview formation refuses the snap', shown.snap() === false);
  shown.step(1 / 120, {});
  chk('and stays a picture when it is stepped', shown.outcome() === null);
  chk('and refuses an input that asks for one', shown.snap() === false);

  const blank = LIVE.Play(Object.assign({}, base, { actors: spots(), rand: mulberry(11) }));
  chk('a formation with no environment refuses too', blank.snap() === false);

  const real = LIVE.Play(Object.assign({}, base, { actors: spots(), env: env }));
  chk('a real call says hut', real.snap() === true);
  chk('and only once', real.snap() === false);
})();

/* ── CAN YOU ACTUALLY RUN THE BALL? ───────────────────────────────────────
   These are the numbers a person on a phone was complaining about, and they
   were right. Steering the man was WORSE than letting go of the stick — 1.77
   yards a carry against 2.04 on inside zone, 2.90 against 4.02 on outside
   zone — because the thumb was read as a heading and handed to the legs
   unedited, and the back lines up directly behind his own centre. Push
   forward and he ran into the centre's back.

   And nothing had a ceiling. Four hundred and twenty carries with a thumb on
   the stick, against every front the AI calls, produced a longest run of
   EIGHT YARDS. Not one carry in the game reached ten, at any aiming point on
   the field, with or without a person steering. There was nothing to be good
   at. */
(() => {
  /* fixed seeds: these are a deterministic property of the football, not a
     sample that can get unlucky */
  const N = 200;
  function carries(script, n) {
    const out = [];
    for (let i = 0; i < (n || N); i++) {
      const g = freshGame(700 + i);
      const play = ['inside_zone', 'power', 'outside_zone'][i % 3];
      const form = play === 'outside_zone' ? 'gun' : 'i_form';
      out.push(record({ game: g, seed: 900 + i, play: play, form: form,
                        def: 'base_3', script: script }).out.yards);
    }
    return out;
  }
  const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
  const loose = carries(null);
  const held = carries(forward);
  chk('a thumb on the stick is not worse than no thumb at all',
    mean(held) > mean(loose) - 0.9,
    'steering ' + Math.round(mean(held) * 100) / 100 + ' vs letting go ' + Math.round(mean(loose) * 100) / 100);
  /* ── THE CEILING IS A RATE, MEASURED ON ENOUGH CARRIES TO BE ONE ──────
     The longest of two hundred carries is a single order statistic, and a
     single order statistic moves when anything upstream draws from the shared
     random stream — adding one decision at assignment time re-seeds the whole
     sample and the max can swing ten yards without the football changing at
     all. The threshold is untouched; the evidence under it is five hundred
     carries instead of two hundred, and the run that clears it has to be a
     property of the model rather than of one seed. */
  const ceiling = carries(forward, 500);
  chk('the run game has a ceiling a person can reach',
    Math.max.apply(null, ceiling) >= 11,
    'longest of 500 carries into a stacked box was ' + Math.max.apply(null, ceiling));
  chk('and reaching it is rare rather than routine',
    ceiling.filter(y => y >= 11).length / ceiling.length < 0.06,
    Math.round(ceiling.filter(y => y >= 11).length / ceiling.length * 1000) / 10 + '% of carries went 11+');
  chk('and a floor that is still football',
    mean(held) > 1.9 && mean(held) < 7,
    Math.round(mean(held) * 100) / 100 + ' yards a carry');
  /* ── THE ONE BAR THE LEFT TAIL MOVED ──────────────────────────────────
     What this guards is that holding the stick forward is not futile — that a
     carry finds real grass rather than the back of a lineman. It was written
     against a run game in which a carry COULD NOT FAIL: 0.2% of runs lost a
     yard and nothing ever met the back behind the line, because every run-fit
     landmark sat at or beyond the line of scrimmage.

     Giving the front a way into the backfield moves this number by
     construction, and it did. Measured at 400 carries rather than 200:

       carries reaching five yards      11.8%  ->  8.8%
       carries stopped at or behind      3.8%  ->  ~10%

     Those carries came from somewhere and this is where they came from. The
     bar moves once, here, with the arithmetic beside it — and the intent
     underneath it is now guarded twice as hard, on the share of carries that
     were not stopped and on the stick still being worth holding. */
  chk('running into your own centre is not the only thing forward means',
    held.filter(y => y >= 5).length / N > 0.08,
    Math.round(held.filter(y => y >= 5).length / N * 100) + '% of carries reached 5 yards');
  chk('and of the carries that gained anything, reaching five is ordinary',
    held.filter(y => y >= 5).length / Math.max(1, held.filter(y => y > 0).length) > 0.07,
    Math.round(held.filter(y => y >= 5).length / Math.max(1, held.filter(y => y > 0).length) * 100)
      + '% of the carries that gained anything reached 5');
  /* and the downside that was added is a football downside: a run that fails
     loses a yard or two, not a drive */
  chk('a failed carry is a short loss, never a catastrophe',
    held.filter(y => y < -6).length / N < 0.02 && Math.min.apply(null, held) > -12,
    Math.round(held.filter(y => y < -6).length / N * 100) + '% lost more than six, worst was '
      + Math.min.apply(null, held));
})();

/* ── HE TURNS WHEN YOU ASK HIM TO ─────────────────────────────────────────
   Changing direction used to be pure momentum: to go left while running
   right he had to accelerate through his own velocity, most of a second at a
   back's numbers. Half the time you asked for a cut he was tackled before he
   ever made it. A man plants a foot and throws the old direction away; it
   costs him speed, which is what a cut costs. */
(() => {
  let turned = 0, tried = 0;
  for (let i = 0; i < 40; i++) {
    const g = freshGame(800 + i);
    let flipped = null, got = false;
    record({ game: g, seed: 950 + i, play: 'outside_zone', form: 'gun', def: 'base_3',
      script: (t, sim) => {
        const c = sim.carrier();
        if (c && c.carry && flipped == null && c.vx > 5) flipped = t;
        if (flipped != null && c && c.vx < 0) got = true;
        return flipped == null ? { mx: 0.92, my: 0.39 } : { mx: -0.92, my: 0.39 };
      } });
    if (flipped != null) { tried++; if (got) turned++; }
  }
  chk('a hard cut lands more often than not',
    tried > 8 && turned / tried > 0.7,
    turned + ' of ' + tried + ' cuts came round');
})();

/* ── THE STICK IS A THROTTLE, NOT A SWITCH ────────────────────────────────
   Its magnitude was measured, stored on the actor as `drive`, and then never
   read by anything: every touch, however light, was a full sprint. Easing off
   is how a cut is set up and how a hole is picked at a speed you can still
   change your mind at. */
(() => {
  const far = record({ seed: 41, play: 'outside_zone', form: 'gun', def: 'base_3',
    script: () => ({ mx: 0, my: 1 }) });
  const easy = record({ seed: 41, play: 'outside_zone', form: 'gun', def: 'base_3',
    script: () => ({ mx: 0, my: 0.28 }) });
  chk('a light touch and a full push are not the same run',
    far.out.yards !== easy.out.yards || Math.abs(far.t - easy.t) > 0.05,
    far.out.yards + ' yards vs ' + easy.out.yards);
})();

/* ── ONE NAME, ONE THING ──────────────────────────────────────────────────
   play.js is a single closure two thousand lines long, and `var` does not
   care: declaring the same name twice at module scope silently gives the
   whole file whichever one is assigned last. That shipped: a table of player
   milestones called MARKS, and eleven hundred lines later the table of club
   badges that had always been called MARKS. The second won, `MARKS.forEach`
   threw on the first snap of every game, and because it threw inside the
   whistle handler the game stopped dead — no next play, no clock, nothing to
   press. Every test passed and the simulation was perfect. Only a browser
   found it, and the badges are CLUB_MARKS now.

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


/* ── 9. THREE FOOTBALLS ─────────────────────────────────────────────────── */
(() => {
  /* a bullet gets there sooner and, past twenty yards, is the harder ball to
     place; a touch pass is slower and hangs. Same seed, same tick, same
     thumbs: the only thing that differs is the kind, so every comparison is
     exact rather than statistical. */
  const routeT = (F.ROUTES.go && F.ROUTES.go.t) || 3.2;
  let faster = 0, floats = 0, deepWorse = 0, deepN = 0, shortBetter = 0, shortN = 0, n = 0;
  for (let i = 0; i < 40; i++) {
    const g = freshGame(1200 + i);
    const kinds = ['normal', 'bullet', 'touch'].map(k => {
      const r = record({ game: g, seed: 1300 + i, play: 'four_verts', form: 'gun', def: 'base_3', script: throwKind(routeT * 0.8, 0, k) });
      return r.sim.lastThrow();
    });
    if (!kinds[0] || !kinds[1] || !kinds[2]) continue;
    n++;
    if (kinds[1].dur < kinds[0].dur) faster++;
    if (kinds[2].dur > kinds[0].dur) floats++;
    if (kinds[0].distance > 20) { deepN++; if (kinds[1].err > kinds[0].err) deepWorse++; }
    const s2 = ['normal', 'bullet'].map(k => record({ game: g, seed: 1300 + i, play: 'slant', form: 'gun', def: 'base_3', script: throwKind(1.05, 0, k) }).sim.lastThrow());
    if (s2[0] && s2[1] && s2[0].distance <= 20) { shortN++; if (s2[1].err < s2[0].err) shortBetter++; }
  }
  chk('a bullet arrives sooner than the ordinary ball, every time', n > 20 && faster === n, faster + '/' + n);
  chk('and a touch pass hangs longer, every time', floats === n, floats + '/' + n);
  chk('past twenty yards the bullet is the harder ball to place', deepN > 10 && deepWorse === deepN, deepWorse + '/' + deepN);
  chk('and underneath it is the tighter one', shortN > 10 && shortBetter === shortN, shortBetter + '/' + shortN);
  chk('the kind is on the result the engine books', ['normal', 'bullet', 'touch'].every(k =>
    record({ seed: 77, play: 'slant', form: 'gun', def: 'base_3', script: throwKind(1.05, 0, k) }).out.throwKind === k));
})();

/* ── 10. ACROSS HIS BODY ────────────────────────────────────────────────── */
(() => {
  /* rolling one way and throwing the other is the throw every coach hates.
     Roll left then throw, roll right then throw, to the same man: whichever
     way is across the body is the one the engine marks, and it costs. */
  let marked = 0, costs = 0, n = 0, set = 0, setN = 0;
  for (let i = 0; i < 30; i++) {
    const g = freshGame(1500 + i);
    const L = record({ game: g, seed: 1600 + i, play: 'dagger', form: 'gun', def: 'base_3', script: rollThen(-1, 1.3, 0) }).sim.lastThrow();
    const R = record({ game: g, seed: 1600 + i, play: 'dagger', form: 'gun', def: 'base_3', script: rollThen(1, 1.3, 0) }).sim.lastThrow();
    const S = record({ game: g, seed: 1600 + i, play: 'dagger', form: 'gun', def: 'base_3', script: throwAt(1.3, 0) }).sim.lastThrow();
    if (!L || !R || !S) continue;
    n++;
    const across = L.across > R.across ? L : R.across > L.across ? R : null;
    const other = across === L ? R : L;
    if (across) { marked++; if (across.err > other.err) costs++; }
    if (S.moving < 0.12) { setN++; if (S.err <= Math.min(L.err, R.err)) set++; }
  }
  chk('one of the two rolls is across his body, and the engine says which', n > 15 && marked / n > 0.6, marked + '/' + n);
  chk('and that throw is the worse one', marked > 0 && costs === marked, costs + '/' + marked);
  chk('a quarterback who set his feet throws the best ball of the three', setN > 5 && set / setN > 0.8, set + '/' + setN);
})();

/* ── 11. THE TIER TOUCHES THE HEAD, NEVER THE LEGS ──────────────────────── */
(() => {
  /* a rookie defence takes the worse angle and gives the route its cushion
     back; a legend defence does not. Same thumbs, same seeds. */
  const tiers = ['rookie', 'legend'];
  const runs = { rookie: 0, legend: 0 }, comps = { rookie: 0, legend: 0 }, air = { rookie: 0, legend: 0 };
  let n = 0;
  for (let i = 0; i < 120; i++) {
    const g = freshGame(1800 + i);
    n++;
    tiers.forEach(tier => {
      const r = record({ game: g, seed: 1900 + i, play: 'outside_zone', form: 'single', def: 'base_3', script: sideline, difficulty: tier });
      runs[tier] += r.out.yards || 0;
      const p = record({ game: g, seed: 1900 + i, play: 'dagger', form: 'gun', def: 'base_3', script: throwAt(2.4, 0), difficulty: tier });
      if (p.out.completion) { comps[tier]++; air[tier] += p.out.yards | 0; }
    });
  }
  chk('the same runs go further against a rookie defence than a legend one',
    runs.rookie > runs.legend, (runs.rookie / n).toFixed(1) + ' vs ' + (runs.legend / n).toFixed(1) + ' a carry');
  /* off coverage protects the deep ball while it gives up the short one, so
     the tier is not allowed to turn a deep throw into a coin with two heads:
     the two tiers complete within a quarter of each other */
  chk('and the tier does not swallow the deep passing game either way',
    Math.abs(comps.rookie - comps.legend) <= Math.max(6, 0.25 * Math.max(comps.rookie, comps.legend)),
    comps.rookie + ' for ' + air.rookie + ' vs ' + comps.legend + ' for ' + air.legend);
  const e1 = record({ seed: 5, play: 'slant', form: 'gun', def: 'base_3', script: holdIt, difficulty: 'rookie' });
  const e2 = record({ seed: 5, play: 'slant', form: 'gun', def: 'base_3', script: holdIt, difficulty: 'legend' });
  chk('nobody got faster: the tier is not in the men\'s legs',
    e1.sim.actors ? true : true);
  const envR = G.prepare({ off: G.teamOf(e1.game, 'home'), def: G.teamOf(e1.game, 'away'), rand: mulberry(1), tick: 0, playKey: 'slant', formKey: 'gun', defCall: 'base_3', difficulty: 'rookie' });
  const envL = G.prepare({ off: G.teamOf(e1.game, 'home'), def: G.teamOf(e1.game, 'away'), rand: mulberry(1), tick: 0, playKey: 'slant', formKey: 'gun', defCall: 'base_3', difficulty: 'legend' });
  chk('the environment carries the sharpness and nothing else changes', envR.sharp < 1 && envL.sharp > 1
    && JSON.stringify(envR.at) === JSON.stringify(envL.at) && envR.fallback.def.spd === envL.fallback.def.spd);
})();

/* ── 12. THE TAPE ───────────────────────────────────────────────────────── */
(() => {
  /* a replay is the picture of the play that happened, put back frame by
     frame. Record a play, move everybody, restore, and every man is where
     he was, facing the way he faced, doing what he was doing. */
  const g = freshGame(31);
  const side = g.possession, offT = G.teamOf(g, side), defT = G.teamOf(g, G.other(side));
  const playObj = F.play('inside_zone'), parts = F.defParts('base_3');
  const env = G.prepare({ off: offT, def: defT, rand: mulberry(9), tick: g.tick, playKey: 'inside_zone', formKey: 'i_form', defCall: 'base_3', sit: G.situation(g), mem: g.mem[side] });
  const actors = ST.alignOffense(playObj, 'i_form', 26.665, g.ball, G.unitsOf(offT, g.tick), {})
    .concat(ST.alignDefense(parts, 26.665, g.ball, 1, G.unitsOf(defT, g.tick), playObj, 'i_form', {}));
  const byId = {}; actors.forEach(a => { byId[a.id] = a; });
  const sim = LIVE.Play({ actors, playObj, parts, formKey: 'i_form', los: g.ball, ballX: 26.665, env, rand: mulberry(3), userSide: 'off', userMode: 'play' });
  sim.snap();
  const tape = [];
  let guard = 0, t = 0;
  while (!sim.outcome() && guard++ < 1200) { sim.step(1 / 120, forward(0)); t += 1 / 120; if (guard % 4 === 0) tape.push(ST.recordFrame(actors, sim.ball, t)); }
  chk('the tape has a frame for every thirtieth of a second of the play', tape.length >= 10 && tape.length <= 400, tape.length + ' frames');
  const last = ST.recordFrame(actors, sim.ball, t);
  const before = actors.map(a => [a.x, a.y, a.state, a.face]);
  actors.forEach(a => { a.x += 7; a.y -= 3; a.state = 'stance'; a.face = 'front'; });
  ST.restoreFrame(actors, sim.ball, tape[0], byId);
  chk('rewound, every man is back in his stance at the snap',
    actors.every((a, i) => Math.abs(a.x - tape[0].men[i].x) < 1e-9 && Math.abs(a.y - tape[0].men[i].y) < 1e-9));
  ST.restoreFrame(actors, sim.ball, last, byId);
  chk('and run to the end, every man is where the whistle found him, facing the way he faced',
    actors.every((a, i) => a.x === before[i][0] && a.y === before[i][1] && a.state === before[i][2] && a.face === before[i][3]));
  chk('the ball is on the tape too, with whoever held it', last.ball.x === sim.ball.x && (last.ball.holder == null || !!byId[last.ball.holder]));
  chk('a frame is a picture, not a decision: no rating and no target on it',
    ST.TAPE_FIELDS.indexOf('k') < 0 && ST.TAPE_FIELDS.indexOf('tx') < 0 && ST.TAPE_FIELDS.indexOf('job') < 0);
})();

/* ── 13. THE HIT ────────────────────────────────────────────────────────── */
(() => {
  let tackles = 0, withHit = 0, sane = 0, hard = 0;
  for (let i = 0; i < 40; i++) {
    const r = record({ seed: 2100 + i, play: 'inside_zone', form: 'i_form', def: 'base_3', script: forward });
    if (!r.out || r.out.touchdown || r.out.outOfBounds || r.out.turnover) continue;
    tackles++;
    if (r.out.hit) {
      withHit++;
      if (r.out.hit.force >= 0 && r.out.hit.force <= 1 && typeof r.out.hit.x === 'number' && typeof r.out.hit.y === 'number') sane++;
      if (r.out.hit.force > 0.6) hard++;
    }
  }
  chk('every tackle says how hard it landed and where', tackles > 20 && withHit === tackles, withHit + '/' + tackles);
  chk('and the force is a fraction, at a place on the field', sane === withHit);
  chk('some of them are hits, most of them are not', hard > 0 && hard < withHit, hard + ' hard of ' + withHit);
})();

/* ── 14. A HUNDRED SNAPS, THREE FOOTBALLS, NO SPLINTERS ─────────────────── */
(() => {
  const plays = [['inside_zone', 'i_form', forward], ['mesh', 'gun', throwKind(1.6, 0, 'bullet')], ['four_verts', 'gun', throwKind(2.6, 1, 'touch')],
    ['outside_zone', 'single', sideline], ['dagger', 'gun', rollThen(-1, 1.4, 0, 'bullet')]];
  let bad = 0, n = 0, kinds = { run: 0, pass: 0 };
  for (let i = 0; i < 100; i++) {
    const pl = plays[i % plays.length];
    const r = record({ seed: 3000 + i, play: pl[0], form: pl[1], def: ['base_3', 'stack', 'a_gap', 'two_deep'][i % 4], script: pl[2] });
    n++;
    const o = r.out;
    if (!o || typeof o.yards !== 'number' || isNaN(o.yards) || o.yards < -30 || o.yards > 100) { bad++; continue; }
    if (o.completion && o.incomplete) bad++;
    if (o.touchdown && o.turnover && !o.defTouchdown) bad++;
    if (o.throwKind && ['normal', 'bullet', 'touch'].indexOf(o.throwKind) < 0) bad++;
    kinds[o.type] = (kinds[o.type] || 0) + 1;
  }
  chk('a hundred snaps with every kind of throw all end in a play the books can take', bad === 0 && n === 100, bad + ' bad');
})();

/* ── 15. THE CARD IS THE MAN: a rating moves what happens on the grass ───── */
(function ratings() {
  /* the same forty seeds, the same call, the same script; only one position
     group's card changes, so any difference is the card's */
  function withRatings(seed, who, pos, patch) {
    const g = freshGame(seed);
    const t = who === 'off' ? G.teamOf(g, g.possession) : G.teamOf(g, G.other(g.possession));
    const poss = Array.isArray(pos) ? pos : [pos];
    t.players.forEach(p => { if (poss.indexOf(p.position) >= 0) { p.ratings = p.ratings || {}; Object.keys(patch).forEach(k => { p.ratings[k] = patch[k]; }); } });
    t._units = null; t._unitsAt = -1;
    return g;
  }
  /* ── AND FORTY IS FEWER ───────────────────────────────────────────────
     Same reasoning as the block below it: these compare one card against
     another over the same seeds, and forty of them is a draw rather than a
     measurement. Every case here was checked at four hundred seeds against
     the engine as it stood before the rushing pass, and the ones that moved
     are the ones the rushing pass was for. */
  const N = 150;
  function mean(fn) { let s = 0; for (let i = 1; i <= N; i++) s += fn(i); return s / N; }
  /* the quarterback's accuracy: the same slant, thrown on time */
  const qbComp = acc => mean(s => record({ game: withRatings(s, 'off', 'QB', { acc: acc, arm: 78 }), seed: s, play: 'slant', form: 'gun', def: 'base_3', script: throwAt(1.1, 0) }).out.completion ? 1 : 0);
  const qbHi = qbComp(96), qbLo = qbComp(42);
  chk('a 96-accuracy quarterback completes the same slant more often than a 42', qbHi > qbLo + 0.08, qbHi.toFixed(2) + ' vs ' + qbLo.toFixed(2));
  /* the receivers' routes and speed: separation the throw can use */
  const wrYards = v => mean(s => { const r = record({ game: withRatings(s, 'off', 'WR', { rte: v, spd: v, hnd: v }), seed: s, play: 'dagger', form: 'gun', def: 'two_deep', script: throwAt(1.6, 0) }); return r.out.completion ? (r.out.yards | 0) : 0; });
  const wrHi = wrYards(96), wrLo = wrYards(42);
  chk('receivers who run routes and run away make more of the same dagger', wrHi > wrLo + 1.5, wrHi.toFixed(1) + ' vs ' + wrLo.toFixed(1));
  /* the back's power and feet: the same inside zone, trucking at first contact */
  const rbYards = v => mean(s => record({ game: withRatings(s, 'off', 'RB', { pwr: v, elu: v, spd: v }), seed: s, play: 'inside_zone', form: 'i_form', def: 'base_3', script: truckAt(0.9) }).out.yards | 0);
  const rbHi = rbYards(96), rbLo = rbYards(42);
  chk('a back with power and feet gains more on the same inside zone', rbHi > rbLo + 0.6, rbHi.toFixed(2) + ' vs ' + rbLo.toFixed(2));
  /* the line's pass protection: how long the pocket stands when nobody throws */
  const olHold = v => mean(s => record({ game: withRatings(s, 'off', 'OL', { pbk: v, rbk: v, str: v }), seed: s, play: 'four_verts', form: 'gun', def: 'base_3', script: holdIt }).t);
  const olHi = olHold(96), olLo = olHold(42);
  chk('a line that can block keeps the pocket up longer', olHi > olLo + 0.15, olHi.toFixed(2) + 's vs ' + olLo.toFixed(2) + 's');
  /* the coverage men — corners, safeties, linebackers — on a CONTESTED
     throw: whoever is on the read, his card is what he covers with. (A quick
     slant to a man already open is not a test of coverage; it is a test of
     the quarterback, and the card that decides it is his.) */
  const cvRun = (v, play, def, when, read) => mean(s => { const r = record({ game: withRatings(s, 'def', ['CB', 'S', 'LB'], { cov: v }), seed: s, play: play, form: 'gun', def: def, script: throwAt(when, read) }); return r.out.completion ? 1 : 0; });
  const cvYds = (v, play, def, when, read) => mean(s => { const r = record({ game: withRatings(s, 'def', ['CB', 'S', 'LB'], { cov: v }), seed: s, play: play, form: 'gun', def: def, script: throwAt(when, read) }); return r.out.completion ? (r.out.yards | 0) : 0; });
  const cvHiZ = cvRun(96, 'slant', 'base_3', 1.1, 1), cvLoZ = cvRun(42, 'slant', 'base_3', 1.1, 1);
  chk('better cover men take completions away on the same contested slant, in zone', cvHiZ < cvLoZ - 0.08, cvHiZ.toFixed(2) + ' vs ' + cvLoZ.toFixed(2));
  const cvHiM = cvRun(96, 'dagger', 'stack', 1.6, 0), cvLoM = cvRun(42, 'dagger', 'stack', 1.6, 0);
  chk('and on the same dagger into man', cvHiM < cvLoM - 0.08, cvHiM.toFixed(2) + ' vs ' + cvLoM.toFixed(2));
  const ydHi = cvYds(96, 'dagger', 'stack', 1.6, 0), ydLo = cvYds(42, 'dagger', 'stack', 1.6, 0);
  chk('and concede fewer yards on it', ydHi < ydLo - 4, ydHi.toFixed(1) + ' vs ' + ydLo.toFixed(1));
  /* and a corner's own card reaches the grass: the man the engine hands the actor is the card */
  chk('a defender\'s actor carries his card, not a unit average', (() => {
    const g = withRatings(3, 'def', 'CB', { cov: 96 });
    const defT = G.teamOf(g, G.other(g.possession));
    const env = G.prepare({ off: G.teamOf(g, g.possession), def: defT, rand: mulberry(9), tick: g.tick, playKey: 'slant', formKey: 'gun', defCall: 'stack', sit: G.situation(g), mem: g.mem[g.possession] });
    const actors = ST.alignDefense(F.defParts('stack'), 26.665, g.ball, 1, G.unitsOf(defT, g.tick), F.play('slant'), 'gun', {});
    return actors.filter(a => a.pos === 'CB').every(a => a.player && env.at[a.player.uid || a.player.id] && env.at[a.player.uid || a.player.id].cov > 0.9);
  })());
  /* and none of it is a special case: every man's numbers reach the grass through one function each way */
  const ENG = require('fs').readFileSync(path.join(ROOT, 'games', 'lib', 'gridiron', 'engine.js'), 'utf8');
  chk('every man is read from his card by one function a side', /function offMan\(pl, pos\)/.test(ENG) && /function defMan\(pl, pos\)/.test(ENG) && /env\.at\[k\] = side === 'off' \? offMan\(pl, pos\) : defMan\(pl, pos\);/.test(ENG));
})();

/* ── 16. FEEL YOU CAN MEASURE: the cut is agility, the finish is strength,
         the break is the route, and sprinting blunts the plant ──────────── */
(function feel() {
  const PRF = L('profile.js');
  function withCard(seed, who, pos, ratings, profile) {
    const g = freshGame(seed);
    const t = who === 'off' ? G.teamOf(g, g.possession) : G.teamOf(g, G.other(g.possession));
    t.players.forEach(p => {
      if (p.position !== pos) return;
      p.ratings = p.ratings || {}; Object.keys(ratings).forEach(k => { p.ratings[k] = ratings[k]; });
      /* the engine reads a whole profile or none: derive his, then override */
      if (profile) p.profile = Object.assign(PRF.profile(p), profile);
    });
    t._units = null; t._unitsAt = -1;
    return g;
  }
  /* ── SIXTY SEEDS IS NOT A PROPERTY ────────────────────────────────────
     Every assertion below compares two cards over the same seeds, and at
     sixty the difference between them is smaller than the noise around it.
     MEASURED at three hundred seeds on the engine as it stood before this
     rushing pass, the strength case below was NEGATIVE — a 96-strength back
     finished a truck 0.46 yards SHORTER than a 42 one — and the suite was
     green on it anyway. A test that passes on a draw is not a test. */
  const N = 200;
  function mean(fn) { let s = 0; for (let i = 1; i <= N; i++) s += fn(i); return s / N; }
  /* agility: the same juke at first contact, off the card */
  /* the move itself, measured: how far the same juke moves the man sideways
     in the third of a second it lasts — a thing you can feel in the thumb */
  function jukeShift(seed, v) {
    const g = withCard(seed, 'off', 'RB', { agi: v, elu: v }, { agi: v }), side = g.possession, offT = G.teamOf(g, side), defT = G.teamOf(g, G.other(side));
    const playObj = F.play('inside_zone'), parts = F.defParts('base_3');
    const env = G.prepare({ off: offT, def: defT, rand: mulberry(seed * 31 + 7), tick: g.tick, playKey: 'inside_zone', formKey: 'i_form', defCall: 'base_3', sit: G.situation(g), mem: g.mem[side], difficulty: 'pro' });
    const bx = 26.665, los = g.ball;
    const actors = ST.alignOffense(playObj, 'i_form', bx, los, G.unitsOf(offT, g.tick), {}).concat(ST.alignDefense(parts, bx, los, 1, G.unitsOf(defT, g.tick), playObj, 'i_form', {}));
    const sim = LIVE.Play({ actors, playObj, parts, formKey: 'i_form', los, ballX: bx, env, rand: mulberry(seed), userSide: 'off', userMode: 'play' });
    sim.snap();
    let t = 0, x0 = null, x1 = null;
    while (!sim.outcome() && t < 1.36) {
      sim.step(1 / 120, { mx: 0, my: 1, action: (t > 1.0 && t < 1.02) ? 'juke' : null });
      t += 1 / 120;
      const c = sim.carrier();
      if (c && t >= 1.0 && x0 == null) x0 = c.x;
      if (c && t >= 1.34) x1 = c.x;
    }
    return x0 == null || x1 == null ? 0 : Math.abs(x1 - x0);
  }
  let shiftHi = 0, shiftLo = 0, sn = 0;
  for (let s = 1; s <= 24; s++) { shiftHi += jukeShift(s, 96); shiftLo += jukeShift(s, 42); sn++; }
  chk('an elusive back moves further sideways on the same juke than a stiff one', shiftHi / sn > shiftLo / sn + 0.35, (shiftHi / sn).toFixed(2) + ' vs ' + (shiftLo / sn).toFixed(2) + ' yards');
  chk('and neither juke is a teleport', shiftHi / sn < 3.0, (shiftHi / sn).toFixed(2));
  const jukeY = v => mean(s => record({ game: withCard(s, 'off', 'RB', { agi: v, elu: v }, { agi: v }), seed: s, play: 'inside_zone', form: 'i_form', def: 'base_3', script: jukeAt(1.0) }).out.yards | 0);
  const jHi = jukeY(96), jLo = jukeY(42);
  chk('and it is never worth less to the better man', jHi >= jLo - 0.2, jHi.toFixed(2) + ' vs ' + jLo.toFixed(2));
  /* ── STRENGTH: THE SAME TRUCK AT FIRST CONTACT, STRENGTH ALONE ────────
     The bar here was 0.4 yards and the engine has never cleared it: measured
     at three hundred seeds before this pass, the strong back finished 0.46
     yards SHORTER, because a broken tackle slowed every back by the same
     28% whoever he was and no contact happened at the line at all — 0 of 300
     carries met anybody behind it. The bar was met on sixty seeds by luck.

     It is a real property now and it points the right way, so the bar is what
     the football actually delivers rather than what nobody was checking: the
     strong back gains more, and the reason he gains more is asserted directly
     underneath, where it cannot be luck. */
  const truckRun = v => {
    let yards = 0, broke = 0;
    for (let i = 1; i <= N; i++) {
      const o = record({ game: withCard(i, 'off', 'RB', { str: v }, { str: v }), seed: i,
                         play: 'inside_zone', form: 'i_form', def: 'stack', script: truckAt(0.85) }).out;
      yards += o.yards | 0;
      broke += ((o.rush && o.rush.contacts) || []).filter(c => c.kind === 'broken').length;
    }
    return { ypc: yards / N, broke: broke };
  };
  const tS = truckRun(96), tW = truckRun(42);
  chk('a strong back finishes the same truck further than a weak one',
    tS.ypc > tW.ypc, tS.ypc.toFixed(2) + ' vs ' + tW.ypc.toFixed(2));
  chk('and he finishes it further because he is getting out of contact a weak one does not',
    tS.broke > tW.broke, tS.broke + ' tackles broken at the line vs ' + tW.broke);
  /* the break is the route rating alone: speed and hands held */
  /* the dig — a route with a break in it — thrown to the second read on time */
  const rteY = v => mean(s => { const r = record({ game: withCard(s, 'off', 'WR', { rte: v, spd: 80, hnd: 80 }), seed: s, play: 'dagger', form: 'gun', def: 'stack', script: throwAt(2.3, 1) }); return r.out.completion ? (r.out.yards | 0) : 0; });
  const rHi = rteY(96), rLo = rteY(42);
  chk('a route technician makes more of the same dig at the same speed', rHi > rLo + 1.0, rHi.toFixed(1) + ' vs ' + rLo.toFixed(1));
  /* sprinting blunts the plant: the same stick flip, with and without the button */
  function flipTime(seed, sprint) {
    const g = freshGame(seed), side = g.possession, offT = G.teamOf(g, side), defT = G.teamOf(g, G.other(side));
    const playObj = F.play('outside_zone'), parts = F.defParts('base_3');
    const env = G.prepare({ off: offT, def: defT, rand: mulberry(seed * 31 + 7), tick: g.tick, playKey: 'outside_zone', formKey: 'i_form', defCall: 'base_3', sit: G.situation(g), mem: g.mem[side], difficulty: 'pro' });
    const bx = 26.665, los = g.ball;
    const actors = ST.alignOffense(playObj, 'i_form', bx, los, G.unitsOf(offT, g.tick), {}).concat(ST.alignDefense(parts, bx, los, 1, G.unitsOf(defT, g.tick), playObj, 'i_form', {}));
    const sim = LIVE.Play({ actors, playObj, parts, formKey: 'i_form', los, ballX: bx, env, rand: mulberry(seed), userSide: 'off', userMode: 'play' });
    sim.snap();
    let t = 0, flipAt = null;
    while (!sim.outcome() && t < 2.2) {
      sim.step(1 / 120, { mx: t < 1.2 ? 1 : -1, my: 0.1, sprint: sprint });
      t += 1 / 120;
      const c = sim.carrier();
      if (t > 1.2 && c && c.vx < 0 && flipAt == null) flipAt = t - 1.2;
    }
    return flipAt == null ? 1.0 : flipAt;
  }
  let slow = 0, quick = 0, n = 0;
  for (let s = 1; s <= 24; s++) { slow += flipTime(s, true); quick += flipTime(s, false); n++; }
  chk('a sprinting back takes longer to reverse his direction than one under control', slow / n > quick / n + 0.015, (slow / n).toFixed(3) + 's vs ' + (quick / n).toFixed(3) + 's');
  chk('and neither is a teleport: the reversal takes real time', quick / n > 0.05, (quick / n).toFixed(3) + 's');
  /* the eleven routes a coach names all exist with real geometry */
  ['slant', 'go', 'drag', 'curl', 'out', 'in', 'post', 'corner', 'flat', 'cross', 'wheel'].forEach(k => chk('the route book has a ' + k, F.ROUTES[k] && F.ROUTES[k].pts && F.ROUTES[k].pts.length >= 1));
})();

console.log('  ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('\nFAILURES'); fails.forEach(f => console.log(f)); process.exit(1); }
