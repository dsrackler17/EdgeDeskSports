#!/usr/bin/env node
/* ===========================================================================
   GRIDIRON — ten thousand games.

   The unit tests say the rules are the rules. This one says the FOOTBALL is
   football: play ten thousand games between fictional clubs and check that
   what comes out the other end looks like a season of real results.

   Every band below is a real-world figure with room either side of it, and
   every one of them is a rate rather than a total, so the numbers mean the
   same thing whatever quarter length a game is played at.

   Two populations, because they answer different questions:

     LEVEL   two identical teams. This is where the ABSOLUTE numbers have to
             be right — points, yards per play, completion percentage, sack
             rate, third down, the lot — because nothing is being skewed by
             one side simply being better.
     MIXED   clubs rated 68 to 85 against each other, on six schemes. This is
             where the SHAPE has to be right: the better team usually wins,
             the worse team sometimes does, and the margin does not run away.

   Then five MATCHUPS, because a distribution that is right on average can be
   made of two things that are both wrong. Elite protection against an elite
   rush has to produce fewer sacks than the other way round; a mobile
   quarterback has to take fewer of them than a statue; a run-heavy club has
   to run it. If those do not separate, the ratings are decoration.

   And PLAY MODE, on a smaller sample, because it is the code path a person on
   a phone is actually using and until recently nothing measured it at all.
   Coach Mode's football is `resolve`; Play Mode's is twenty-two men in
   live.js. They have to be the same sport.

   Every finished game — all of them, in every population — is put through
   tools/games/gridiron_invariants.js, which asserts the things that cannot be
   true: a score that moved without a scoring event, a completion that was not
   an attempt, a player total that does not sum to its team's.

   ── THE INTENDED SHAPE OF A GAME ──────────────────────────────────────────
   Four quarters of fifteen minutes, which is 3,600 seconds of game clock.
   The clock model charges each snap the play itself plus, when the clock kept
   running, about twenty-nine seconds of dead ball — so a full game is roughly
   60 snaps and 10 to 12 possessions a side, which is what the bands below
   look for. The phone offers shorter quarters (Quick 8:00, Blitz 5:00); they
   scale the same way because every band here is a rate.

   Run: node tools/games/gridiron_sim.test.js [games]      (default 10000)
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const AU = require(path.join(ROOT, 'games', 'lib', 'gridiron', 'autoplay.js'));
const G = require(path.join(ROOT, 'games', 'lib', 'gridiron', 'engine.js'));
const INV = require(path.join(__dirname, 'gridiron_invariants.js'));

const N = Math.max(200, parseInt(process.argv[2], 10) || 10000);

/* every game in every population goes through the invariants */
const AUDIT = { games: 0, violations: {}, anomalies: {}, teamGames: 0 };
/* VIOLATIONS ARE COUNTED EVERYWHERE, anomalies only in the populations that
   are meant to look like football. The matchup cohorts below are deliberately
   lopsided — an elite rush against a line that cannot block — so counting
   their sack totals as astonishing would be measuring the question rather
   than the answer. */
function audit(r, natural) {
  const c = INV.check(G, r.game, r.box);
  AUDIT.games++;
  c.violations.forEach((v) => {
    const k = v.replace(/-?\d+/g, 'N');
    AUDIT.violations[k] = (AUDIT.violations[k] || 0) + 1;
  });
  if (natural !== false) {
    AUDIT.teamGames += 2;
    c.anomalies.forEach((v) => {
      const k = v.split(':')[0];
      AUDIT.anomalies[k] = (AUDIT.anomalies[k] || 0) + 1;
    });
  }
  return r;
}

let pass = 0, fail = 0;
const failures = [];
function band(name, got, lo, hi, unit) {
  const ok = got >= lo && got <= hi;
  if (ok) pass++; else { fail++; failures.push(name + ' — got ' + got + (unit || '') + ', want ' + lo + '–' + hi + (unit || '')); }
  console.log('  ' + (ok ? '·' : '✗') + ' ' + name.padEnd(34)
    + String(got).padStart(7) + (unit || '') + '   [' + lo + '–' + hi + ']');
}
function chk(name, cond, detail) {
  if (cond) { pass++; console.log('  · ' + name); return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
  console.log('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
const r1 = x => Math.round(x * 10) / 10;
const r2 = x => Math.round(x * 100) / 100;

const SCHEMES = [
  ['power_run', 'three_four'], ['spread', 'four_three'], ['air_raid', 'press_man'],
  ['west_coast', 'zone'], ['pro_style', 'blitz_heavy'], ['option', 'bend_dont_break']
];
const TIERS = ['rookie', 'pro', 'allpro', 'legend'];

function run(games, level) {
  const a = { pts: 0, plays: 0, yards: 0, att: 0, comp: 0, passY: 0, car: 0, rushY: 0, sacks: 0,
    ints: 0, fum: 0, fd: 0, t3a: 0, t3c: 0, t4a: 0, t4c: 0, punts: 0, fgA: 0, fgM: 0,
    drives: 0, expl: 0, top: 0, rzA: 0, rzT: 0, tds: 0 };
  let homeWin = 0, favWin = 0, favN = 0, margin = 0, ot = 0, close = 0, shutouts = 0, ties = 0;
  const scores = [];
  const outcome = {};
  for (let i = 0; i < games; i++) {
    const hs = SCHEMES[i % SCHEMES.length], as = SCHEMES[(i * 3 + 1) % SCHEMES.length];
    const ho = level ? 75 : 68 + (i * 7) % 18, ao = level ? 75 : 68 + (i * 11) % 18;
    const r = audit(AU.simulate({
      seed: (level ? 'L' : 'M') + i, difficulty: TIERS[i % TIERS.length],
      home: { name: 'H', overall: ho, offense: hs[0], defense: hs[1], seed: 'h' + i },
      away: { name: 'A', overall: ao, offense: as[0], defense: as[1], seed: 'a' + i }
    }));
    for (const s of ['home', 'away']) {
      const b = r.box[s], st = r.game.stats[s];
      a.pts += b.score; a.plays += b.plays; a.yards += b.yards; a.att += b.att; a.comp += b.comp;
      a.passY += b.passYards; a.rushY += b.rushYards; a.sacks += b.sacks; a.ints += b.ints;
      a.fum += b.fumblesLost; a.fd += b.firstDowns; a.punts += b.punts; a.drives += b.drives;
      a.expl += b.explosive; a.top += b.top;
      a.car += st.carries; a.t3a += st.thirdAtt; a.t3c += st.thirdConv;
      a.t4a += st.fourthAtt; a.t4c += st.fourthConv;
      a.fgA += st.fgAtt; a.fgM += st.fgMade; a.rzA += st.redzoneAtt; a.rzT += st.redzoneTD;
      scores.push(b.score);
      if (b.score === 0) shutouts++;
    }
    r.game.drives.forEach(d => { outcome[d.outcome] = (outcome[d.outcome] || 0) + 1; });
    const m = Math.abs(r.score.home - r.score.away);
    margin += m;
    if (m <= 8) close++;
    if (m === 0) ties++;
    if (r.score.home > r.score.away) homeWin++;
    if (r.game.ot) ot++;
    if (ho !== ao) {
      favN++;
      const favHome = ho > ao;
      if ((favHome && r.score.home > r.score.away) || (!favHome && r.score.away > r.score.home)) favWin++;
    }
  }
  const t = games * 2, drops = a.att + a.sacks;
  const mean = a.pts / t;
  const sd = Math.sqrt(scores.reduce((s, x) => s + (x - mean) * (x - mean), 0) / scores.length);
  const dtot = Object.keys(outcome).reduce((s, k) => s + outcome[k], 0);
  return {
    games, pointsPerTeam: r1(mean), scoreSD: r1(sd),
    playsPerTeam: r1(a.plays / t), yardsPerTeam: r1(a.yards / t),
    ypp: r2(a.yards / a.plays), compPct: r1(100 * a.comp / a.att),
    ypa: r2(a.passY / a.att), ypc: r2(a.rushY / a.car),
    sackRate: r1(100 * a.sacks / drops), intRate: r2(100 * a.ints / a.att),
    turnoversPerTeam: r2((a.ints + a.fum) / t),
    firstDowns: r1(a.fd / t), thirdPct: r1(100 * a.t3c / a.t3a),
    fourthPct: a.t4a ? r1(100 * a.t4c / a.t4a) : 0,
    puntsPerTeam: r1(a.punts / t), fgPct: r1(100 * a.fgM / a.fgA),
    drivesPerTeam: r1(a.drives / t), explosivePerTeam: r1(a.expl / t),
    redzoneTDPct: r1(100 * a.rzT / Math.max(1, a.rzA)),
    topShare: r1(100 * (a.top / t) / 3600),
    homeWinPct: r1(100 * homeWin / games), favWinPct: favN ? r1(100 * favWin / favN) : null,
    avgMargin: r1(margin / games), closePct: r1(100 * close / games),
    otPct: r2(100 * ot / games), tiePct: r2(100 * ties / games),
    shutoutPct: r2(100 * shutouts / t),
    drive: Object.keys(outcome).sort().reduce((o, k) => (o[k] = r1(100 * outcome[k] / dtot), o), {})
  };
}

console.log('\nGRIDIRON — ' + N + ' games, twice over\n');

const t0 = Date.now();
console.log('LEVEL — two identical sides, where the absolute numbers must be right');
const L = run(N, true);
band('points per team', L.pointsPerTeam, 17, 28);
band('score spread (SD)', L.scoreSD, 7, 14);
band('plays per team', L.playsPerTeam, 55, 72);
band('yards per team', L.yardsPerTeam, 290, 410);
band('yards per play', L.ypp, 4.9, 6.2);
band('completion %', L.compPct, 58, 70, '%');
band('yards per attempt', L.ypa, 6.2, 8.2);
band('yards per carry', L.ypc, 3.9, 5.3);
band('sack rate', L.sackRate, 4.5, 9.0, '%');
band('interception rate', L.intRate, 1.7, 3.6, '%');
band('turnovers per team', L.turnoversPerTeam, 0.9, 2.2);
band('first downs per team', L.firstDowns, 16, 25);
band('third down %', L.thirdPct, 34, 47, '%');
band('punts per team', L.puntsPerTeam, 2.8, 6.0);
band('field goal %', L.fgPct, 72, 90, '%');
band('drives per team', L.drivesPerTeam, 8.5, 13);
band('explosive plays per team', L.explosivePerTeam, 2.5, 8);
band('red zone touchdown %', L.redzoneTDPct, 40, 80, '%');
band('possession share per team', L.topShare, 42, 58, '%');
band('home win %', L.homeWinPct, 50, 62, '%');
band('average margin', L.avgMargin, 10, 18);
band('one-score games', L.closePct, 28, 50, '%');
band('overtime games', L.otPct, 0.3, 9, '%');
band('shutouts', L.shutoutPct, 0, 6, '%');
console.log('  drive outcomes: ' + JSON.stringify(L.drive));
band('drives ending in a touchdown', L.drive.td, 16, 32, '%');
band('drives ending in a punt', L.drive.punt, 30, 52, '%');
band('drives ending on downs', L.drive.downs || 0, 1, 9, '%');
band('drives ending in a safety', L.drive.safety || 0, 0, 1.5, '%');

console.log('\nMIXED — clubs rated 68 to 85, where the shape must be right');
const M2 = run(N, false);
band('points per team', M2.pointsPerTeam, 17, 30);
band('yards per play', M2.ypp, 4.9, 6.4);
band('favourite win %', M2.favWinPct, 62, 88, '%');
band('average margin', M2.avgMargin, 12, 26);
band('one-score games', M2.closePct, 15, 40, '%');
chk('the better team wins more often than the worse one', M2.favWinPct > 60,
    'favourite win rate ' + M2.favWinPct + '%');
chk('but the worse team wins often enough to be worth playing', M2.favWinPct < 90,
    'favourite win rate ' + M2.favWinPct + '%');
chk('a mixed league scores more than a level one', M2.pointsPerTeam >= L.pointsPerTeam - 1);

/* every scheme has to be able to play: none may be strictly dominant, and none
   may be unplayable */
console.log('\nSCHEMES — none dominant, none unplayable');
const per = {};
const each = Math.max(240, Math.floor(N / 10));
SCHEMES.forEach((sc, si) => {
  let w = 0, pts = 0;
  for (let i = 0; i < each; i++) {
    const opp = SCHEMES[(si + 1 + (i % (SCHEMES.length - 1))) % SCHEMES.length];
    const r = audit(AU.simulate({ seed: 'S' + si + '_' + i, difficulty: 'pro',
      home: { name: 'H', overall: 75, offense: sc[0], defense: sc[1], seed: 'h' + i },
      away: { name: 'A', overall: 75, offense: opp[0], defense: opp[1], seed: 'a' + i } }));
    if (r.score.home > r.score.away) w++;
    pts += r.score.home;
  }
  per[sc[0]] = { win: r1(100 * w / each), pts: r1(pts / each) };
});
console.log('  ' + JSON.stringify(per));
Object.keys(per).forEach(k => {
  band(k + ' win rate at home', per[k].win, 30, 75, '%');
  band(k + ' points', per[k].pts, 14, 34);
});

/* ── MATCHUPS ─────────────────────────────────────────────────────────────
   The averages above can be right while both halves of them are wrong. These
   ask whether the RATINGS SEPARATE: give one side elite protection and the
   other an elite rush and the sack rate has to move, in the right direction,
   by an amount a player would notice. If a matchup does not separate, that
   rating exists only in the interface. */
console.log('\nMATCHUPS — the ratings have to separate');

/* a roster built to be good or bad at exactly one thing */
function tuned(base, spec) {
  const R = require(path.join(ROOT, 'games', 'lib', 'gridiron', 'roster.js'));
  const players = R.generate({ seed: base.seed, overall: base.overall,
                               offense: base.offense, defense: base.defense });
  players.forEach((p) => {
    const t = spec[p.position];
    if (!t) return;
    Object.keys(t).forEach((k) => {
      if (p.ratings[k] == null) return;
      p.ratings[k] = Math.max(30, Math.min(99, p.ratings[k] + t[k]));
    });
    const keys = Object.keys(p.ratings);
    p.overall = Math.round(keys.reduce((a, k) => a + p.ratings[k], 0) / keys.length);
  });
  return Object.assign({}, base, { players: players });
}

function cohort(name, games, mk) {
  const a = { pts: 0, att: 0, comp: 0, sacks: 0, drops: 0, car: 0, rushY: 0, passY: 0,
              plays: 0, yards: 0, ints: 0, scrambles: 0, qbRush: 0, wins: 0 };
  for (let i = 0; i < games; i++) {
    const o = mk(i);
    const r = audit(AU.simulate(o), false);
    const st = r.game.stats.home, op = r.game.stats.away;
    a.pts += r.score.home; a.att += st.att; a.comp += st.comp;
    a.sacks += st.sacks; a.drops += st.att + st.sacks;
    a.car += st.carries; a.rushY += st.rushYards; a.passY += st.passYards;
    a.plays += st.plays; a.yards += st.yards; a.ints += st.ints;
    if (r.score.home > r.score.away) a.wins++;
    G.playersOf(r.game, 'home').forEach((p) => {
      if (p.position === 'QB') a.qbRush += p.car;
    });
  }
  const out = {
    name: name, games: games,
    points: r1(a.pts / games),
    sackRateTaken: r1(100 * a.sacks / Math.max(1, a.drops)),
    ypc: r2(a.rushY / Math.max(1, a.car)),
    ypa: r2(a.passY / Math.max(1, a.att)),
    runShare: r1(100 * a.car / Math.max(1, a.plays)),
    qbCarries: r1(a.qbRush / games),
    winPct: r1(100 * a.wins / games)
  };
  console.log('  ' + name.padEnd(30) + JSON.stringify(out));
  return out;
}

const M = Math.max(120, Math.floor(N / 14));
const ELITE_OL = { OL: { pbk: 22, rbk: 18 } };
const WEAK_OL = { OL: { pbk: -22, rbk: -18 } };
const ELITE_RUSH = { DL: { prs: 24, spd: 10 }, LB: { spd: 8 } };
const WEAK_RUSH = { DL: { prs: -24, spd: -10 }, LB: { spd: -8 } };
const MOBILE_QB = { QB: { spd: 26, elu: 20, arm: -6 } };
const POCKET_QB = { QB: { spd: -22, acc: 8, iq: 8 } };

function pair(seedTag, homeSpec, awaySpec, homeScheme, awayScheme) {
  return (i) => ({
    seed: seedTag + i, difficulty: 'pro',
    home: tuned({ name: 'H', overall: 75, offense: homeScheme || 'pro_style',
                  defense: 'four_three', seed: 'h' + i }, homeSpec),
    away: tuned({ name: 'A', overall: 75, offense: awayScheme || 'pro_style',
                  defense: 'four_three', seed: 'a' + i }, awaySpec)
  });
}

const wall = cohort('elite OL vs weak rush', M, pair('X1', ELITE_OL, WEAK_RUSH));
const sieve = cohort('weak OL vs elite rush', M, pair('X2', WEAK_OL, ELITE_RUSH));
const mobile = cohort('mobile QB vs elite rush', M, pair('X3', MOBILE_QB, ELITE_RUSH));
const statue = cohort('pocket QB vs elite rush', M, pair('X4', POCKET_QB, ELITE_RUSH));
const heavy = cohort('run-heavy scheme', M, pair('X5', {}, {}, 'power_run', 'pro_style'));
const airy = cohort('pass-heavy scheme', M, pair('X6', {}, {}, 'air_raid', 'pro_style'));

chk('elite protection takes far fewer sacks than a sieve',
    sieve.sackRateTaken > wall.sackRateTaken * 1.8,
    wall.sackRateTaken + '% vs ' + sieve.sackRateTaken + '%');
band('sack rate behind an elite line', wall.sackRateTaken, 0.5, 5.5, '%');
band('sack rate behind a bad one', sieve.sackRateTaken, 6, 22, '%');
chk('a mobile quarterback takes fewer sacks than a statue',
    mobile.sackRateTaken < statue.sackRateTaken,
    mobile.sackRateTaken + '% vs ' + statue.sackRateTaken + '%');
chk('and he runs it more often',
    mobile.qbCarries > statue.qbCarries + 0.5,
    mobile.qbCarries + ' vs ' + statue.qbCarries + ' carries');
chk('a run-heavy scheme runs it more than a pass-heavy one',
    heavy.runShare > airy.runShare + 8,
    heavy.runShare + '% vs ' + airy.runShare + '%');
band('run-heavy run share', heavy.runShare, 40, 72, '%');
band('pass-heavy run share', airy.runShare, 18, 45, '%');
chk('both schemes are still worth playing',
    heavy.points >= 13 && airy.points >= 13,
    heavy.points + ' vs ' + airy.points);

/* ── PLAY MODE ────────────────────────────────────────────────────────────
   The code path a person on a phone is using. It is a hundred times slower
   than the resolver — twenty-two men at a hundred and twenty ticks a second
   — so the sample is smaller and the bands are wider. What matters is that it
   is the same sport, not that it is the same to two decimal places. */
console.log('\nPLAY MODE — twenty-two men, and the same sport');
const P = Math.max(20, Math.min(140, Math.floor(N / 90)));
const live = { pts: 0, plays: 0, yards: 0, att: 0, comp: 0, passY: 0, car: 0, rushY: 0,
               sacks: 0, ints: 0, fd: 0, t3a: 0, t3c: 0, drives: 0 };
for (let i = 0; i < P; i++) {
  const hs = SCHEMES[i % SCHEMES.length], as = SCHEMES[(i * 3 + 1) % SCHEMES.length];
  const r = audit(AU.simulateLive({
    seed: 'V' + i, difficulty: TIERS[i % TIERS.length],
    home: { name: 'H', overall: 75, offense: hs[0], defense: hs[1], seed: 'h' + i },
    away: { name: 'A', overall: 75, offense: as[0], defense: as[1], seed: 'a' + i }
  }));
  for (const s of ['home', 'away']) {
    const b = r.box[s], st = r.game.stats[s];
    live.pts += b.score; live.plays += b.plays; live.yards += b.yards;
    live.att += b.att; live.comp += b.comp; live.passY += b.passYards;
    live.car += st.carries; live.rushY += b.rushYards; live.sacks += b.sacks;
    live.ints += b.ints; live.fd += b.firstDowns; live.drives += b.drives;
    live.t3a += st.thirdAtt; live.t3c += st.thirdConv;
  }
}
const lt = P * 2, ldrops = live.att + live.sacks;
const L2 = {
  games: P, points: r1(live.pts / lt), plays: r1(live.plays / lt),
  ypp: r2(live.yards / live.plays), compPct: r1(100 * live.comp / live.att),
  ypa: r2(live.passY / live.att), ypc: r2(live.rushY / live.car),
  sackRate: r1(100 * live.sacks / ldrops), intRate: r2(100 * live.ints / live.att),
  firstDowns: r1(live.fd / lt), thirdPct: r1(100 * live.t3c / live.t3a),
  drivesPerTeam: r1(live.drives / lt), runShare: r1(100 * live.car / live.plays)
};
console.log('  ' + JSON.stringify(L2));
band('points per team (live)', L2.points, 14, 32);
band('yards per play (live)', L2.ypp, 4.4, 6.8);
band('completion % (live)', L2.compPct, 55, 75, '%');
band('yards per carry (live)', L2.ypc, 3.0, 5.6);
band('sack rate (live)', L2.sackRate, 2.5, 11, '%');
band('interception rate (live)', L2.intRate, 1.0, 4.5, '%');
band('run share (live)', L2.runShare, 28, 55, '%');
band('drives per team (live)', L2.drivesPerTeam, 8.5, 15);
chk('nobody finishes a live game without throwing it',
    live.att / lt > 12, r1(live.att / lt) + ' attempts a team');
chk('Play Mode scores within a touchdown of Coach Mode',
    Math.abs(L2.points - L.pointsPerTeam) <= 8,
    L2.points + ' vs ' + L.pointsPerTeam);
chk('Play Mode moves the ball at the same rate',
    Math.abs(L2.ypp - L.ypp) <= 1.2, L2.ypp + ' vs ' + L.ypp);

/* ── DETERMINISM ──────────────────────────────────────────────────────────
   Same seed, same rosters, same coaching, same weather, same game — and a
   different seed has to be a different game, or the seed is decoration. */
console.log('\nDETERMINISM — the same seed is the same game');
function fingerprint(o) {
  const r = AU.simulate(o);
  return r.score.home + '-' + r.score.away + '|' + r.game.plays.length + '|'
    + r.game.stats.home.yards + '|' + r.game.stats.away.yards + '|'
    + r.game.plays.map(p => p.yards).join(',');
}
const seedA = { seed: 'D1', difficulty: 'allpro',
  home: { name: 'H', overall: 78, offense: 'pro_style', defense: 'four_three', seed: 'dh' },
  away: { name: 'A', overall: 72, offense: 'air_raid', defense: 'press_man', seed: 'da' },
  weather: { weather: 'rain', wind: 18, temp: 41 } };
const seedB = Object.assign({}, seedA, { seed: 'D2' });
const f1 = fingerprint(seedA), f2 = fingerprint(seedA), f3 = fingerprint(seedB);
chk('the same seed reproduces the game exactly', f1 === f2);
chk('a different seed is a different game', f1 !== f3);
let differ = 0;
for (let i = 0; i < 40; i++) {
  const o = Object.assign({}, seedA, { seed: 'DV' + i });
  if (fingerprint(o) !== f1) differ++;
}
chk('forty different seeds give forty different games', differ === 40, differ + '/40');
/* weather is part of the state, so changing it has to change the game */
const dry = fingerprint(Object.assign({}, seedA, { weather: null }));
chk('the weather is part of the game state', dry !== f1);

/* ── THE AUDIT ────────────────────────────────────────────────────────────
   Everything above went through the invariants. Nothing impossible is
   allowed; astonishing is allowed at a rate. */
console.log('\nAUDIT — ' + AUDIT.games + ' games checked against the invariants');
const vKeys = Object.keys(AUDIT.violations);
if (vKeys.length) {
  vKeys.sort((x, y) => AUDIT.violations[y] - AUDIT.violations[x])
    .forEach(k => console.log('    ' + String(AUDIT.violations[k]).padStart(6) + '  ' + k));
}
chk('no game contradicts itself', vKeys.length === 0,
    vKeys.length + ' kinds of violation over ' + AUDIT.games + ' games');

const ANOM = [
  ['sacks', 1.2, 'nine or more sacks in a game'],
  ['sackRate', 2.5, 'a third of dropbacks sacked'],
  ['negativeYards', 0.2, 'a team with negative total yards'],
  ['yards', 1.5, 'under sixty yards of offence'],
  ['zeroPassGame', 0.3, 'a game with no pass attempt'],
  ['zeroRunGame', 0.5, 'a game with no carry'],
  ['turnovers', 1.5, 'six or more turnovers'],
  ['pointsPerDrive', 3.0, 'points per drive above 4.8'],
  ['score', 2.5, 'sixty points or more'],
  ['blowout', 6.0, 'a forty-five point margin']
];
ANOM.forEach(([k, capPct, label]) => {
  const n = AUDIT.anomalies[k] || 0;
  const rate = r2(100 * n / AUDIT.teamGames);
  const ok = rate <= capPct;
  if (ok) pass++; else { fail++; failures.push('anomaly rate: ' + label + ' — ' + rate + '%, cap ' + capPct + '%'); }
  console.log('  ' + (ok ? '·' : '✗') + ' ' + label.padEnd(34)
    + String(rate).padStart(7) + '%   [max ' + capPct + '%]');
});

/* ── THE REPORT ───────────────────────────────────────────────────────────── */
console.log('\nREPORT');
console.log(JSON.stringify({
  games: { level: L.games, mixed: M2.games, matchup: M * 6, live: P, audited: AUDIT.games },
  level: L, mixed: M2, playMode: L2,
  matchups: { eliteLine: wall, badLine: sieve, mobileQB: mobile, pocketQB: statue,
              runHeavy: heavy, passHeavy: airy },
  schemes: per,
  anomalyRatePct: Object.keys(AUDIT.anomalies).sort().reduce((o, k) => {
    o[k] = r2(100 * AUDIT.anomalies[k] / AUDIT.teamGames); return o;
  }, {}),
  violations: AUDIT.violations
}, null, 1));

console.log('\n' + pass + ' passed, ' + fail + ' failed  (' + Math.round((Date.now() - t0) / 1000) + 's)');
if (fail) {
  console.log('\nFAILURES');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
