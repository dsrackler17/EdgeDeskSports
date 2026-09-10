#!/usr/bin/env node
/* ===========================================================================
   THE RUN GAME HAS A SHAPE — rush_v2

   A rushing model is not one number. Before this suite existed the live game
   averaged five yards a carry, which is a perfectly respectable average, and
   underneath it: 0.2% of runs lost a yard, 0.0% of them met a defender behind
   the line, and half of everything landed between three and five yards. The
   average was fine and the football was not, because a run play had no way to
   fail — the front's every landmark sat at or beyond the line of scrimmage
   and there was no code path that put a man in the backfield.

   So this suite is about the SHAPE, and about the things that have to be true
   underneath it:

     1  a run can lose yardage, and losing it is not rare
     2  the ordinary failed run — nothing, or nearly — actually happens
     3  short gains are still the biggest bucket
     4  explosive runs survive, and going the distance stays rare
     5  contact at the line has five answers, and all five happen
     6  a great front beats a poor line, and a great line protects
     7  the back on the card changes which answer he gets
     8  breaking one in the backfield costs him his legs for a moment

   It samples the engine directly with the cards set by hand, so a failure
   here names a football property rather than a seed.

   Run: node tools/games/rushing.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const L = p => require(path.join(ROOT, 'games', 'lib', 'gridiron', p));
const G = L('engine.js'), S = L('session.js'), F = L('football.js');
const ST = L('stage.js'), LIVE = L('live.js');

let pass = 0, fail = 0; const fails = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; fails.push('  ✗ ' + name + (detail ? ' — ' + detail : '')); } }
function band(name, v, lo, hi, unit) {
  chk(name, v >= lo && v <= hi, (Math.round(v * 100) / 100) + (unit || '') + ' not in [' + lo + '–' + hi + ']');
}

function mulberry(seed) {
  let h = 2166136261 >>> 0; const s = String(seed);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return function () { h |= 0; h = (h + 0x6D2B79F5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function freshGame(seed) {
  const g = S.build({ seed: 'RUSH' + seed, settings: { length: 'blitz', difficulty: 'pro' } });
  let guard = 0;
  while (g.phase !== 'play' && !g.over && guard++ < 40) {
    S.step(g, { type: g.phase === 'kickoff' ? 'kickoff' : g.phase === 'pat' ? 'pat' : 'halftime_done' });
  }
  return g;
}
function setCard(g, who, pos, patch) {
  const t = who === 'off' ? G.teamOf(g, g.possession) : G.teamOf(g, G.other(g.possession));
  const poss = Array.isArray(pos) ? pos : [pos];
  t.players.forEach(p => {
    if (poss.indexOf(p.position) >= 0) {
      p.ratings = p.ratings || {};
      Object.keys(patch).forEach(k => { p.ratings[k] = patch[k]; });
    }
  });
  t._units = null; t._unitsAt = -1;
  return g;
}
function oneRun(o) {
  const g = o.game, side = g.possession;
  const offT = G.teamOf(g, side), defT = G.teamOf(g, G.other(side));
  const playObj = F.play(o.play), parts = F.defParts(o.def);
  const env = G.prepare({ off: offT, def: defT, rand: mulberry(o.seed + ':e'), tick: g.tick,
    playKey: o.play, formKey: o.form, defCall: o.def, sit: G.situation(g), mem: g.mem[side] });
  const los = 40, bx = 26.665;
  const actors = ST.alignOffense(playObj, o.form, bx, los, G.unitsOf(offT, g.tick), {})
    .concat(ST.alignDefense(parts, bx, los, 1, G.unitsOf(defT, g.tick), playObj, o.form, {}));
  const sim = LIVE.Play({ actors, playObj, parts, formKey: o.form, los: los, ballX: bx, env: env,
    rand: mulberry(o.seed), userSide: 'off', userMode: 'coach' });
  sim.snap();
  let k = 0;
  while (!sim.outcome() && k++ < 2400) sim.step(1 / 120, {});
  return sim.outcome();
}

const CALLS = [['inside_zone', 'i_form'], ['outside_zone', 'singleback'], ['power', 'i_form'],
               ['counter', 'singleback'], ['draw', 'gun'], ['toss', 'singleback']];
const DEFS = ['base_3', 'stack', 'pinch_run', 'edge_contain', 'two_deep', 'a_gap'];
const CARDS = {
  rb: { low:   { spd: 62, elu: 56, pwr: 58, hnd: 60 },
        avg:   { spd: 78, elu: 75, pwr: 74, hnd: 75 },
        elite: { spd: 94, elu: 95, pwr: 90, hnd: 88 } },
  ol: { low:   { rbk: 58, pbk: 58, str: 60, blk: 58 },
        avg:   { rbk: 75, pbk: 75, str: 75, blk: 75 },
        elite: { rbk: 93, pbk: 92, str: 92, blk: 93 } },
  dl: { low:   { rst: 58, prs: 58, tkl: 60, str: 60 },
        avg:   { rst: 75, prs: 75, tkl: 75, str: 75 },
        elite: { rst: 93, prs: 93, tkl: 90, str: 92 } }
};
const TIER = ['low', 'avg', 'elite'];

/* ── the sample ─────────────────────────────────────────────────────────── */
const N = 756;                       /* 6 calls × 6 fronts × 21 rating mixes */
const rows = [];
for (let i = 0; i < N; i++) {
  const call = CALLS[i % CALLS.length];
  const def = DEFS[(i / CALLS.length | 0) % DEFS.length];
  const rb = TIER[(i / 3 | 0) % 3], ol = TIER[(i / 9 | 0) % 3], dl = TIER[(i / 27 | 0) % 3];
  const g = freshGame(i);
  setCard(g, 'off', 'RB', CARDS.rb[rb]);
  setCard(g, 'off', 'OL', CARDS.ol[ol]);
  setCard(g, 'def', ['DL', 'LB'], CARDS.dl[dl]);
  const out = oneRun({ game: g, seed: 'r' + i, play: call[0], form: call[1], def: def });
  if (!out || !out.rush) continue;
  rows.push(Object.assign({}, out.rush, { rb: rb, ol: ol, dl: dl, concept: out.rush.concept }));
}
const n = rows.length;
const y = rows.map(r => r.yards);
const share = f => 100 * rows.filter(f).length / (n || 1);
const mean = a => a.reduce((x, z) => x + z, 0) / (a.length || 1);
function pctile(a, p) {
  const s = a.slice().sort((x, z) => x - z);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p / 100 * (s.length - 1))))];
}
const ypc = mean(y);

console.log('\nTHE RUN GAME — ' + n + ' carries, cards set by hand');

/* ── 1-2. a run can fail, and failing is ordinary ──────────────────────── */
chk('every carry carries its own record', n >= N * 0.9 && rows.every(r => r.yards != null && r.attempts != null), n + ' of ' + N);
band('a run loses yardage often enough to be a risk', share(r => r.yards < 0), 4, 22, '%');
band('and the nothing-gain happens too', share(r => r.yards === 0), 1.2, 14, '%');
band('a carry is stopped at or behind the line about as often as football stops one',
  share(r => r.yards <= 0), 7, 26, '%');
chk('the fifth percentile of a carry is not a gain', pctile(y, 5) <= 0, 'p5 = ' + pctile(y, 5));
chk('and the tenth is not much of one', pctile(y, 10) <= 1, 'p10 = ' + pctile(y, 10));

/* ── 3. the middle is still the middle ─────────────────────────────────── */
const buckets = {
  neg: share(r => r.yards < 0), zero: share(r => r.yards === 0),
  short: share(r => r.yards >= 1 && r.yards <= 2), mid: share(r => r.yards >= 3 && r.yards <= 5),
  good: share(r => r.yards >= 6 && r.yards <= 9), big: share(r => r.yards >= 10)
};
chk('short gains are the biggest thing that happens',
  buckets.mid >= buckets.neg && buckets.mid >= buckets.big && buckets.mid >= buckets.good,
  JSON.stringify(Object.keys(buckets).reduce((o, k) => { o[k] = Math.round(buckets[k] * 10) / 10; return o; }, {})));
band('the median carry is a football play', pctile(y, 50), 2, 6, ' yards');

/* ── 4. explosives survive, and the distance stays rare ────────────────── */
band('a run can still break', share(r => r.yards >= 20), 0.3, 5, '%');
band('and going the distance is rare', share(r => r.yards >= 40), 0, 2.5, '%');
/* ── THE ONE THING THIS MODEL STILL GETS WRONG, MEASURED RATHER THAN HIDDEN
   Nearly every run that reaches twenty yards goes the distance. It is not new
   — before this pass 2.6% of carries reached twenty and 1.8% reached forty —
   and it is not the left tail's doing: it is the movement model. Every
   defensive back is faster than every back, but once the ball is past the
   second level the chase is a stern chase, and a stern chase at equal speed is
   a race the man in front wins. Fixing it means giving pursuit an angle the
   geometry does not currently produce, and holding a safety over the top to
   buy it was measured and cost more than it bought: power went to 8.04 yards
   a carry with the last man held out of the box, and 5.42 with him merely
   kept at a cushion.

   So it is bounded above (40+ is rare in absolute terms, asserted below) and
   the ratio is REPORTED on every run rather than asserted, because asserting
   a property the model does not have would be a test that lies. */
const twenty = share(r => r.yards >= 20), forty = share(r => r.yards >= 40);
chk('a twenty-yard run is more common than a forty-yard one',
  twenty > forty, Math.round(twenty * 10) / 10 + '% vs ' + Math.round(forty * 10) / 10 + '%');
chk('and most of the runs that break do not go the distance',
  forty / (twenty || 1) < 0.75, Math.round(100 * forty / (twenty || 1)) + '% of 20-yard runs went 40+');
band('yards per carry stays inside the band the regression enforces', ypc, 3.0, 5.6);
chk('and not within a tenth of its ceiling', ypc < 5.5, ypc.toFixed(2));

/* ── 5. contact at the line has five answers ───────────────────────────── */
const kinds = {};
let contacts = 0;
rows.forEach(r => (r.contacts || []).forEach(c => { kinds[c.kind] = (kinds[c.kind] || 0) + 1; contacts++; }));
band('a carry meets somebody at or behind the line often enough to matter',
  100 * rows.filter(r => (r.contacts || []).length > 0).length / n, 10, 55, '%');
['stuff', 'wrap', 'glance', 'deflect', 'broken'].forEach(k => {
  chk('contact behind the line can end in a ' + k, (kinds[k] || 0) > 0, JSON.stringify(kinds));
});
chk('being stopped is the most common answer to it',
  (kinds.stuff || 0) >= (kinds.broken || 0),
  'stuff ' + (kinds.stuff || 0) + ' vs broken ' + (kinds.broken || 0));
chk('and breaking one clean is the rarest way out of it',
  (kinds.broken || 0) <= (kinds.stuff || 0) + (kinds.wrap || 0),
  JSON.stringify(kinds));

/* ── 6. the front and the line decide it ───────────────────────────────── */
function slice(f) { const r = rows.filter(f); return { n: r.length, ypc: mean(r.map(x => x.yards)),
  neg: 100 * r.filter(x => x.yards < 0).length / (r.length || 1),
  stuffed: 100 * r.filter(x => x.yards <= 0).length / (r.length || 1) }; }
const weakLine = slice(r => r.ol === 'low' && r.dl === 'elite');
const strongLine = slice(r => r.ol === 'elite' && r.dl === 'low');
chk('a great front against a poor line lives in the backfield',
  weakLine.neg > strongLine.neg + 8,
  weakLine.neg.toFixed(1) + '% negative vs ' + strongLine.neg.toFixed(1) + '%');
chk('and a great line against a poor front keeps him clean',
  strongLine.ypc > weakLine.ypc + 0.8,
  strongLine.ypc.toFixed(2) + ' vs ' + weakLine.ypc.toFixed(2));
const dlUp = slice(r => r.dl === 'elite'), dlDown = slice(r => r.dl === 'low');
chk('a better front stuffs more runs', dlUp.stuffed > dlDown.stuffed + 3,
  dlUp.stuffed.toFixed(1) + '% vs ' + dlDown.stuffed.toFixed(1) + '%');
const olUp = slice(r => r.ol === 'elite'), olDown = slice(r => r.ol === 'low');
chk('a better line allows fewer', olDown.stuffed > olUp.stuffed + 3,
  olDown.stuffed.toFixed(1) + '% vs ' + olUp.stuffed.toFixed(1) + '%');

/* ── 7. the man carrying it decides it too ─────────────────────────────── */
const rbUp = slice(r => r.rb === 'elite'), rbMid = slice(r => r.rb === 'avg'), rbDown = slice(r => r.rb === 'low');
chk('an elite back gains more than an average one, who gains more than a poor one',
  rbUp.ypc > rbMid.ypc && rbMid.ypc > rbDown.ypc,
  [rbDown.ypc, rbMid.ypc, rbUp.ypc].map(v => v.toFixed(2)).join(' < '));
chk('and an elite back is stopped behind the line far less often',
  rbDown.stuffed > rbUp.stuffed + 5,
  rbDown.stuffed.toFixed(1) + '% vs ' + rbUp.stuffed.toFixed(1) + '%');
const brkUp = mean(rows.filter(r => r.rb === 'elite').map(r => r.broken || 0));
const brkDown = mean(rows.filter(r => r.rb === 'low').map(r => r.broken || 0));
chk('an elite back gets out of contact he should not have', brkUp > brkDown,
  brkUp.toFixed(2) + ' broken a carry vs ' + brkDown.toFixed(2));
chk('but he does not simply always escape: he is still stopped sometimes',
  rbUp.stuffed > 0.5, rbUp.stuffed.toFixed(1) + '%');

/* ── 8. surviving a hit is not the same as never being hit ─────────────── */
const brokeOut = rows.filter(r => (r.contacts || []).some(c => c.kind === 'broken'));
if (brokeOut.length >= 8) {
  chk('a back who breaks one in the backfield does not simply score',
    100 * brokeOut.filter(r => r.yards >= 40).length / brokeOut.length < 25,
    Math.round(100 * brokeOut.filter(r => r.yards >= 40).length / brokeOut.length) + '% of escapes went 40+');
  chk('though it is worth a great deal when it happens',
    mean(brokeOut.map(r => r.yards)) > ypc,
    mean(brokeOut.map(r => r.yards)).toFixed(2) + ' vs ' + ypc.toFixed(2) + ' overall');
} else {
  chk('enough backfield escapes to judge them', false, brokeOut.length + ' escapes in ' + n + ' carries');
}

/* ── and the record adds up ────────────────────────────────────────────── */
const withContact = rows.filter(r => r.ybc != null && r.contacts && r.contacts.length);
chk('yards before contact and after it are the whole carry',
  withContact.every(r => Math.abs((r.ybc + r.yac) - r.yards) < 0.51),
  'a carry did not add up');
chk('a stuffed carry is one that gained nothing', rows.every(r => r.stuffed === (r.yards <= 0)));
chk('a tackle for loss is one that lost', rows.every(r => r.tfl === (r.yards < 0)));
chk('and an explosive one is twenty', rows.every(r => r.explosive === (r.yards >= 20)));

console.log('  ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('\nFAILURES'); fails.forEach(l => console.log(l)); }
console.log('  ypc ' + ypc.toFixed(2) + ' · p5 ' + pctile(y, 5) + ' · p50 ' + pctile(y, 50) + ' · p95 ' + pctile(y, 95)
  + ' · negative ' + share(r => r.yards < 0).toFixed(1) + '% · zero ' + share(r => r.yards === 0).toFixed(1)
  + '% · stuffed ' + share(r => r.yards <= 0).toFixed(1) + '% · 20+ ' + share(r => r.yards >= 20).toFixed(1)
  + '% · 40+ ' + share(r => r.yards >= 40).toFixed(1) + '%');
console.log('  of the carries that reach 20 yards, ' + Math.round(100 * forty / (twenty || 1))
  + '% go 40+ — the long-run tail, unchanged by this pass and still open');
process.exit(fail ? 1 : 0);
