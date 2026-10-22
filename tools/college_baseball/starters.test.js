#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The projected starter's quality from the schools' own box scores
   (college_baseball/lib/starters.js), on a synthetic league whose truth is
   known: twelve teams, weekend series, each staff with a Friday ace, a
   Saturday arm and a weak Sunday arm. Checks:
     - one person however the scorer writes him, never across teams;
     - the weights and the projection are fitted on the burn-in only;
     - the ace's Friday lowers his staff's runs, the Sunday arm raises them;
     - a game's own box never moves its own number (the actual starter is oracle);
     - a team whose recent games are not boxed has no number, and its
       team-season does not count toward coverage;
     - a game after the record (the live board) is priced from everything before it;
     - platoon: the projected starter's hand against the opposing nine's
       usual bats (earlier games only), hands from the box or, by name, the
       school's roster, and none where neither gives one.

   Run: node tools/college_baseball/starters.test.js
   =========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const SP = require(path.join(ROOT, 'college_baseball/lib/starters.js'));
const K = require(path.join(ROOT, 'college_baseball/ingest/common.js'));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); } };

/* ------------------------------------------------------------ people */
{
  const rows = [['1', 'Luke Matta'], ['1', 'Matta, Luke'], ['1', 'L. MATTA'], ['1', 'Kyle Montgomery'], ['1', 'K. Montgomer'], ['1', 'Montgomery'],
    ['2', 'Luke Matta'], ['1', 'John Smith'], ['1', 'Will Smith'], ['1', 'Smith'], ['1', 'Juan De La Cruz'], ['1', 'De La Cruz, Juan']].map(([team_id, name]) => ({ team_id, name }));
  SP.identities(rows);
  const id = (i) => rows[i].person_id;
  ok('one person however the scorer writes the name (full, "Last, First", initial and capitals)', id(0) === id(1) && id(1) === id(2) && id(0) === 'sb:1:matta|l');
  ok('a name cut at the field width, or given without an initial, joins the one full name it can be', id(3) === id(4) && id(4) === id(5) && id(3) === 'sb:1:montgomery|k');
  ok('the same name on another team is another person (nothing joins people across schools)', id(6) === 'sb:2:matta|l' && id(6) !== id(0));
  ok('two pitchers of one last name stay two, and a bare last name between them joins neither', id(7) !== id(8) && id(9) !== id(7) && id(9) !== id(8));
  ok('a compound last name, either way round', id(10) === id(11));
}

/* ------------------------------------------------------------ a synthetic league */
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const binom = (n, p) => { let k = 0; for (let i = 0; i < n; i++) if (rnd() < p) k++; return k; };
const TEAMS = Array.from({ length: 12 }, (_, i) => String(101 + i));
const ARMS = { fri: { name: 'Adam Fridayson', throws: 'L', k: 0.32, bb: 0.05, h: 0.15 }, sat: { name: 'Sam Saturn', k: 0.21, bb: 0.09, h: 0.23 }, sun: { name: 'Stu Sundance', k: 0.12, bb: 0.15, h: 0.31 } };
const PEN = [{ name: 'Rob Relief', k: 0.22, bb: 0.1, h: 0.22 }, { name: 'Ray Bullen', k: 0.2, bb: 0.11, h: 0.23 }, { name: 'Pat Closer', k: 0.24, bb: 0.09, h: 0.21 }];
function line(arm, bf) {
  const k = binom(bf, arm.k), bb = binom(bf, arm.bb), h = binom(bf, arm.h), hb = binom(bf, 0.02);
  const outs = Math.max(0, bf - bb - h - hb);
  return { arm, bf, k, bb, h, hb, outs };
}
function staff(slot) {
  const st = line(ARMS[slot], 20 + Math.floor(rnd() * 8));
  const pen = [line(PEN[Math.floor(rnd() * 3)], 5 + Math.floor(rnd() * 4)), line(PEN[Math.floor(rnd() * 3)], 4 + Math.floor(rnd() * 4))];
  const all = [st, ...pen];
  const sum = (f) => all.reduce((a, x) => a + x[f], 0);
  const runs = Math.max(0, Math.round(-0.12 * sum('bf') + 0.6 * (sum('bb') + sum('hb')) + 0.8 * sum('h') + (rnd() - 0.5) * 2));
  return { all, runs };
}
const row = (l, r) => [l.arm.name, l.arm.throws || 'R', l.outs, l.bf, l.k, l.bb, l.h, r, null, null, r, null, l.hb];
/* half the league bats left-heavy, half right-heavy */
const NINE = (t) => (+t <= 106 ? 'LLLLLLSRR' : 'RRRRRRRSL').split('').map((b, i) => [i + 1, 'Bat' + 'abcdefghi'[i] + ' Hitter' + 'abcdefghi'[i], 'X', b, null]);
/* team 108's boxes carry no hands (an older site); its roster lists them */
const NOHANDS = '108';
const bare = (t, pitchers, lineup) => (t === NOHANDS ? { pitchers: pitchers.map((r) => Object.assign([], r, { 1: null })), lineup: lineup.map((l) => Object.assign([], l, { 3: null })) } : { pitchers, lineup });
function season(s, firstFriday, weeks, skipBoxesOf) {
  const games = []; const files = new Map();
  for (let w = 0; w < weeks; w++) {
    /* a round robin: week w pairs team i with team (i + w + 1) mod 12 for the first six */
    const order = TEAMS.slice(); const used = new Set(); const pairs = [];
    for (let i = 0; i < 12; i++) { if (used.has(order[i])) continue; for (let d = 1; d < 12; d++) { const j = order[(i + w + d) % 12]; if (!used.has(j) && j !== order[i]) { pairs.push(w % 2 ? [j, order[i]] : [order[i], j]); used.add(order[i]); used.add(j); break; } } }
    ['fri', 'sat', 'sun'].forEach((slot, di) => {
      const date = K.addDays(firstFriday, 7 * w + di);
      for (const [h, a] of pairs) {
        const H = staff(slot), A = staff(slot);
        let hr = A.runs, ar = H.runs; if (hr === ar) hr++;
        const id = 'g' + s + '_' + w + '_' + slot + '_' + h;
        games.push({ game_id: id, season: s, date, home_id: h, away_id: a, home_runs: hr, away_runs: ar, status: 'FINAL', start_time_local: '' });
        if (skipBoxesOf && (h === skipBoxesOf || a === skipBoxesOf)) continue;
        const box = { game_key: id, school: 'school' + h, url: 'https://example.edu/box/' + id, platform: 'sidearm', date, doubleheader_game: 0,
          home: Object.assign({ code: h, runs: hr }, bare(h, H.all.map((l, i) => row(l, i ? 0 : ar)), NINE(h))), away: Object.assign({ code: a, runs: ar }, bare(a, A.all.map((l, i) => row(l, i ? 0 : hr)), NINE(a))) };
        if (!files.has(h)) files.set(h, []); files.get(h).push(box);
      }
    });
  }
  return { games, files };
}
const S13 = season(2013, '2013-02-15', 15);
const S14 = season(2014, '2014-02-14', 15, '112');
const gamesOf = (s) => (s === 2013 ? S13.games : s === 2014 ? S14.games : []);
function writeBoxes(dir, mutate) {
  for (const [s, S] of [[2013, S13], [2014, S14]]) {
    fs.mkdirSync(path.join(dir, String(s)), { recursive: true });
    for (const [h, boxes] of S.files) fs.writeFileSync(path.join(dir, String(s), 'school' + h + '.jsonl.gz'), zlib.gzipSync(boxes.map((b) => JSON.stringify(mutate ? mutate(b) : b)).join('\n') + '\n'));
  }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cbstarters-'));
const d1 = path.join(tmp, 'a'); writeBoxes(d1);
const rostersDir = path.join(tmp, 'rosters');
for (const s of [2013, 2014]) {
  fs.mkdirSync(path.join(rostersDir, String(s)), { recursive: true });
  const players = [...Object.values(ARMS), ...PEN].map((x) => ({ name: x.name, throws: x.throws || 'R', bats: 'R' })).concat(NINE(NOHANDS).map((l) => ({ name: l[1], bats: l[3], throws: 'R' })));
  fs.writeFileSync(path.join(rostersDir, String(s), 'school' + NOHANDS + '.json'), JSON.stringify({ players }));
}
const OPTS = { until: 2014, gamesOf, boxDir: d1, rostersDir, schoolsOf: (t) => ['school' + t] };
const L = SP.load(OPTS);

ok('the weights are fitted on the burn-in (2013) and have no home-run term', L.fitted.fit_season === 2013 && L.fitted.linear_weights && L.fitted.linear_weights.hr === 0 && L.fitted.linear_weights.n === 2 * S13.games.length);
const lw = L.fitted.linear_weights;
ok('the weights recover the league\'s: a hit costs more than a walk, an out saves', lw.h_non_hr > lw.bb_hbp && lw.bb_hbp > 0 && lw.per_bf < 0 && Math.abs(lw.h_non_hr - 0.8) < 0.15 && Math.abs(lw.bb_hbp - 0.6) < 0.2, lw);
ok('the projection logit is fitted on the burn-in\'s covered team-seasons', L.fitted.projection && L.fitted.projection.n >= 500, L.fitted.projection);

/* the rotation, read from earlier weeks only */
const sideQ = (g, team) => { const v = L.of(g); return team === g.home_id ? v.h : v.a; };
const late = S14.games.filter((g) => g.date >= '2014-03-21');
const bySlot = { fri: [], sat: [], sun: [] };
for (const g of late) { const slot = g.game_id.split('_')[2]; for (const t of [g.home_id, g.away_id]) { if (t === '112') continue; const q = sideQ(g, t); if (q != null) bySlot[slot].push(q); } }
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
/* a side whose last 28 days are all boxed: it did not face the twelfth team (whose games are not held) in them */
const faced112 = (t, date) => S14.games.some((x) => x.date < date && x.date >= K.addDays(date, -28) && ((x.home_id === t && x.away_id === '112') || (x.away_id === t && x.home_id === '112')));
const clean = []; const short = [];
for (const g of late) for (const t of [g.home_id, g.away_id]) { if (t === '112') continue; (faced112(t, g.date) ? short : clean).push(sideQ(g, t)); }
ok('once the rotation is seen, every staff-game whose last 28 days are boxed has a number', clean.length > 150 && clean.every((q) => q != null), clean.filter((q) => q == null).length);
ok('one whose last 28 days are short of 80% boxed has none (priced as before)', short.length > 0 && short.some((q) => q == null), short.filter((q) => q == null).length + '/' + short.length);
ok('the Friday ace lowers his staff\'s runs, the Sunday arm raises them', mean(bySlot.fri) < -0.03 && mean(bySlot.sun) > 0.03 && mean(bySlot.fri) < mean(bySlot.sat) && mean(bySlot.sat) < mean(bySlot.sun), { fri: mean(bySlot.fri), sat: mean(bySlot.sat), sun: mean(bySlot.sun) });
const firstWeekend = S14.games.filter((g) => g.date <= '2014-02-16');
ok('the first weekend of a season has no number (no boxed games in the last 28 days)', firstWeekend.every((g) => L.of(g).h == null && L.of(g).a == null));

/* the team whose 2014 boxes are not held */
const t12 = late.filter((g) => g.home_id === '112' || g.away_id === '112');
ok('a team whose recent games are not boxed has no number; its opponent keeps its own', t12.length > 0 && t12.every((g) => sideQ(g, '112') == null) && t12.some((g) => sideQ(g, g.home_id === '112' ? g.away_id : g.home_id) != null));
const pairs = TEAMS.map((t) => [2014, t]);
const boxedShare = (t) => { const gs = S14.games.filter((g) => g.home_id === t || g.away_id === t); return gs.filter((g) => g.home_id !== '112' && g.away_id !== '112').length / gs.length; };
const expected = TEAMS.filter((t) => boxedShare(t) >= 0.8).length / 12;
ok('coverage counts the team-seasons with 80% of their contests boxed (never the team whose boxes are not held)', Math.abs(L.coverage(pairs) - expected) < 1e-9 && expected < 1 && L.coverage([[2014, '112']]) === 0 && L.coverage([[2013, '101']]) === 1, [L.coverage(pairs), expected]);

/* platoon: the projected starter's hand against the opposing nine's usual bats */
const pb = L.fitted.platoon_base;
ok('the league\'s platoon advantage is measured on the burn-in\'s nines', pb && Math.abs(pb.R - 0.5) < 0.02 && Math.abs(pb.L - (3 / 9 + 8 / 9) / 2) < 0.02, pb);
const plOf = (g, t) => { const v = L.platoon(g); return t === g.home_id ? v.h : v.a; };
const lefty = (t) => +t <= 106;
const cell = { fri_L: [], fri_R: [], sat_L: [], sat_R: [] };
for (const g of late) for (const [t, o] of [[g.home_id, g.away_id], [g.away_id, g.home_id]]) {
  const slot = g.game_id.split('_')[2]; if (slot === 'sun' || t === '112' || o === '112') continue;
  const x = plOf(g, t); if (x != null) cell[slot + '_' + (lefty(o) ? 'L' : 'R')].push(x);
}
ok('the lefty ace against a left-heavy nine: the nine is at a disadvantage (fewer runs); against a right-heavy one, the opposite', cell.fri_L.length > 10 && cell.fri_R.length > 10 && mean(cell.fri_L) < -0.05 && mean(cell.fri_R) > 0.05, { L: mean(cell.fri_L), R: mean(cell.fri_R) });
ok('a right-hander the other way round', cell.sat_L.length > 10 && mean(cell.sat_L) > 0.05 && mean(cell.sat_R) < -0.05, { L: mean(cell.sat_L), R: mean(cell.sat_R) });
const g111 = late.filter((g) => (g.home_id === NOHANDS || g.away_id === NOHANDS) && g.home_id !== '112' && g.away_id !== '112');
ok('a school whose boxes carry no hands takes them from its roster, by name: its staff and its nine both have a platoon number', g111.some((g) => plOf(g, NOHANDS) != null) && g111.some((g) => plOf(g, g.home_id === NOHANDS ? g.away_id : g.home_id) != null));
const LN = SP.load(Object.assign({}, OPTS, { rostersDir: path.join(tmp, 'none') }));
ok('...and without the roster it has none (nothing stands in for a hand we do not hold)', g111.every((g) => { const v = LN.platoon(g); return (g.home_id === NOHANDS ? v.h : v.a) == null; }));
ok('hand coverage counts the team-seasons whose starters\' hands and opposing nines\' bats are known for 80% of contests', L.handCoverage([[2014, '101']]) === 1 && L.handCoverage([[2014, '112']]) === 0 && LN.handCoverage([[2014, NOHANDS]]) === 0 && L.handCoverage([[2014, NOHANDS]]) === 1);

/* the actual starter is oracle: rewrite one game's own box (another, far better starter) and its own number does not move */
{
  const target = late.find((g) => g.home_id === '101' && g.game_id.includes('_sun_'));
  const d2 = path.join(tmp, 'b');
  const flip = (l) => l.map((x) => Object.assign([], x, { 3: x[3] === 'L' ? 'R' : 'L' }));
  writeBoxes(d2, (b) => (b.game_key === target.game_id ? Object.assign({}, b, { home: Object.assign({}, b.home, { pitchers: [['Zed Phenom', 'L', 27, 28, 20, 0, 1, 0, null, null, 0, null, 0]], lineup: flip(b.home.lineup) }), away: Object.assign({}, b.away, { lineup: flip(b.away.lineup) }) }) : b));
  const L2 = SP.load(Object.assign({}, OPTS, { boxDir: d2 }));
  const a = L.of(target), b = L2.of(target);
  ok('a game\'s own box never moves its own number (its actual starter is never an input)', a.h != null && a.h === b.h && a.a === b.a, { a, b });
  const pa = L.platoon(target), pb2 = L2.platoon(target);
  ok('...nor its own platoon number (its actual lineups and starter are never inputs)', pa.h != null && pa.a != null && pa.h === pb2.h && pa.a === pb2.a, { pa, pb2 });
  const next = S14.games.filter((g) => g.date > target.date && (g.home_id === '101' || g.away_id === '101'));
  ok('...it enters only the games after it', next.some((g) => sideQ(g, '101') !== (g.home_id === '101' ? L2.of(g).h : L2.of(g).a)));
}

/* the live board: a game after the record, priced as of its date */
{
  const last = S14.games[S14.games.length - 1].date;
  const g = { game_id: 'live1', season: 2014, date: K.addDays(last, 5), home_id: '101', away_id: '112' };
  const v = L.of(g);
  ok('a game after the record is priced from everything before it (and a team with no boxes has no number)', v.h != null && v.a == null, v);
  ok('a game before the state\'s date that the record does not hold has none (the state never runs backwards)', L.of({ game_id: 'old', season: 2014, date: '2014-03-01', home_id: '101', away_id: '102' }).h == null);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log((fail === 0 ? 'ALL GREEN' : 'FAILED') + ' college baseball starters — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
