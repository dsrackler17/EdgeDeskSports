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

   Run: node tools/games/gridiron_sim.test.js [games]      (default 10000)
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const AU = require(path.join(ROOT, 'games', 'lib', 'gridiron', 'autoplay.js'));

const N = Math.max(200, parseInt(process.argv[2], 10) || 10000);

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
    const r = AU.simulate({
      seed: (level ? 'L' : 'M') + i, difficulty: TIERS[i % TIERS.length],
      home: { name: 'H', overall: ho, offense: hs[0], defense: hs[1], seed: 'h' + i },
      away: { name: 'A', overall: ao, offense: as[0], defense: as[1], seed: 'a' + i }
    });
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
const M = run(N, false);
band('points per team', M.pointsPerTeam, 17, 30);
band('yards per play', M.ypp, 4.9, 6.4);
band('favourite win %', M.favWinPct, 62, 88, '%');
band('average margin', M.avgMargin, 12, 26);
band('one-score games', M.closePct, 15, 40, '%');
chk('the better team wins more often than the worse one', M.favWinPct > 60,
    'favourite win rate ' + M.favWinPct + '%');
chk('but the worse team wins often enough to be worth playing', M.favWinPct < 90,
    'favourite win rate ' + M.favWinPct + '%');
chk('a mixed league scores more than a level one', M.pointsPerTeam >= L.pointsPerTeam - 1);

/* every scheme has to be able to play: none may be strictly dominant, and none
   may be unplayable */
console.log('\nSCHEMES — none dominant, none unplayable');
const per = {};
const each = Math.max(240, Math.floor(N / 10));
SCHEMES.forEach((sc, si) => {
  let w = 0, pts = 0;
  for (let i = 0; i < each; i++) {
    const opp = SCHEMES[(si + 1 + (i % (SCHEMES.length - 1))) % SCHEMES.length];
    const r = AU.simulate({ seed: 'S' + si + '_' + i, difficulty: 'pro',
      home: { name: 'H', overall: 75, offense: sc[0], defense: sc[1], seed: 'h' + i },
      away: { name: 'A', overall: 75, offense: opp[0], defense: opp[1], seed: 'a' + i } });
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

console.log('\n' + pass + ' passed, ' + fail + ' failed  (' + Math.round((Date.now() - t0) / 1000) + 's)');
if (fail) {
  console.log('\nFAILURES');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
