/* MLB starting pitchers: rest, doubleheader sequencing, rotation progression across dates and postseason
   rounds, departures, spot starts, Confirmed vs Projected labels — first on SYNTHETIC rotations (by hand),
   then on every game of simulated seasons from the committed 2025 snapshots. */
import { kit } from './_kit.ts';
import { RotationState, pickRegular, pickPostseason, postseasonRotation, recordStart, drawDepartures, projectRegular, projectPostseason, rotationAt, lastStarts, REPLACEMENT, type RotationParams } from '../src/sports/mlb/rotation.ts';
import { mlbModule } from '../src/sports/mlb/module.ts';
import { runRange } from '../src/core/engine.ts';
import { Xoshiro128 } from '../src/core/prng.ts';
import { mlbFixture } from './_mlb_fixture.ts';

const K = kit('MLB rotations: rest, doubleheaders, progression, labels');
const P: RotationParams = { min_rest_days: 5, short_rest_days: 4, postseason_rotation_size: 4, p_spot: { single: 0, dh1: 0, dh2: 0, postseason: 0 }, spot_takes_turn: true, postseason_spot_takes_turn: true, survival: [1] };
const D0 = 20000;
const five = () => new RotationState(['A', 'B', 'C', 'D', 'E'], [0.10, 0.05, 0.00, -0.02, 0.08], [D0 - 5, D0 - 4, D0 - 3, D0 - 2, D0 - 1]);

/* the as-of rotation */
{
  const starts = [{ day: 1, game_no: 0, pitcher: 'A' }, { day: 2, game_no: 0, pitcher: 'B' }, { day: 3, game_no: 0, pitcher: 'X' }, { day: 4, game_no: 0, pitcher: 'C' }, { day: 5, game_no: 0, pitcher: 'D' }, { day: 6, game_no: 0, pitcher: 'E' }, { day: 7, game_no: 0, pitcher: 'A' }];
  K.eq('rotation: the last five distinct starters, most recent first', rotationAt(starts), ['A', 'E', 'D', 'C', 'X']);
  K.eq('last start of each', lastStarts(starts), { A: 7, B: 2, X: 3, C: 4, D: 5, E: 6 });
}
/* rest: a member is rested only after min_rest_days calendar days */
{
  const st = five();
  K.eq('the next start goes to the oldest rested member', st.ids[pickRegular(st, D0, P)], 'A');
  recordStart(st, 0, D0);
  K.chk('A, who started today, is not rested for 4 more days', [1, 2, 3, 4].every((k) => { const x = five(); recordStart(x, 0, D0); for (let i = 1; i < 5; i++) recordStart(x, i, D0 + k); return pickRegular(x, D0 + k, P) === REPLACEMENT; }));
  const x = five(); x.last.set([D0, D0 + 1, D0 + 2, D0 + 3, D0 + 4]);
  K.eq('on the fifth day after his start (4 days of rest) A is rested again', x.ids[pickRegular(x, D0 + 5, P)], 'A');
  K.eq('with nobody rested, a replacement starts', pickRegular(x, D0 + 4, P), REPLACEMENT);
}
/* progression: five games on five dates cycle the rotation in order, and it repeats */
{
  const st = five(); const seq: string[] = [];
  for (let d = 0; d < 10; d++) { const s = pickRegular(st, D0 + d, P); seq.push(s === REPLACEMENT ? 'R' : st.ids[s]); recordStart(st, s, D0 + d); }
  K.eq('ten consecutive dates: A B C D E A B C D E', seq.join(''), 'ABCDEABCDE');
  /* an off day: the cycle continues (the fifth starter keeps his turn) and everyone gets an extra day */
  const y = five(); const seq2: string[] = [];
  for (const d of [0, 1, 3, 4, 5, 6, 7]) { const s = pickRegular(y, D0 + d, P); seq2.push(y.ids[s]); recordStart(y, s, D0 + d); }
  K.eq('with an off day on day 2: A B C D E A B', seq2.join(''), 'ABCDEAB');
}
/* doubleheaders: game 1 and game 2 on one date never share a starter; game 2 falls to a replacement unless a member is rested */
{
  const st = five();
  const g1 = pickRegular(st, D0, P); recordStart(st, g1, D0);
  const g2 = pickRegular(st, D0, P);
  K.eq('doubleheader after a normal turn: game 1 A; game 2 a replacement (B, the next in turn, has only three days of rest)', [st.ids[g1], g2 === REPLACEMENT ? 'R' : st.ids[g2]], ['A', 'R']);
  const z = new RotationState(['A', 'B', 'C', 'D', 'E'], [0, 0, 0, 0, 0], [D0 - 4, D0 - 3, D0 - 2, D0 - 1, D0 - 6]);
  const h1 = pickRegular(z, D0, P); recordStart(z, h1, D0); const h2 = pickRegular(z, D0, P); recordStart(z, h2, D0);
  K.eq('doubleheader with one rested member: game 1 E (the only one rested), game 2 a replacement', [z.ids[h1], h2], ['E', REPLACEMENT]);
  const w = new RotationState(['A', 'B', 'C', 'D', 'E'], [0, 0, 0, 0, 0], [D0 - 9, D0 - 8, D0 - 7, D0 - 6, D0 - 5]);
  const a1 = pickRegular(w, D0, P); recordStart(w, a1, D0); const a2 = pickRegular(w, D0, P); recordStart(w, a2, D0);
  K.eq('doubleheader after off days: two different rested members, in rotation order', [w.ids[a1], w.ids[a2]], ['A', 'B']);
  K.chk('the next day neither doubleheader starter is rested', [a1, a2].every((i) => D0 + 1 - w.last[i] < 5));
}
/* the postseason: best rested by s; the rest clock runs across rounds; a vacancy is filled before short rest */
{
  const st = five();
  const rot = postseasonRotation(st, P);
  K.eq('postseason rotation: the four best by s (A .10, E .08, B .05, C .00; D out)', rot.map((i) => st.ids[i]), ['A', 'E', 'B', 'C']);
  const days = [D0 + 2, D0 + 3, D0 + 5, D0 + 6, D0 + 8, D0 + 12, D0 + 13];   // a series, then the next round after three off days
  const seq: string[] = [];
  for (const d of days) { const p = pickPostseason(st, rot, d, P); seq.push(p.slot === REPLACEMENT ? 'R' : st.ids[p.slot] + (p.short ? '*' : '')); recordStart(st, p.slot, d); }
  /* +2: A (7 days) is the best rested; +3: A and E (4 days) are not, B is; +5: E (6 days) outranks C; +6: only C;
     +8: A again (6 days); +12 after the off days: A has 4 days, E 7; +13: A (5 days) */
  K.eq('best rested by s, every date against each member\'s last start, across the off days between rounds', seq, ['A', 'B', 'E', 'C', 'A', 'E', 'A']);
  const v = new RotationState(['A', 'B', 'C'], [0.1, 0.05, 0], [D0 - 1, D0 - 2, D0 - 3]);
  const r3 = postseasonRotation(v, P);
  K.eq('three members left: a vacant fourth slot is a replacement before anyone goes on short rest', pickPostseason(v, r3, D0 + 1, P), { slot: REPLACEMENT, short: false });
  const u = new RotationState(['A', 'B', 'C', 'D'], [0.1, 0.05, 0, -0.01], [D0 - 1, D0 - 2, D0 - 3, D0 - 4]);
  K.eq('four members, none rested: the most rested on short rest (four days)', pickPostseason(u, postseasonRotation(u, P), D0 + 0, P), { slot: 3, short: true });
  K.eq('four members, the most rested at three days: a replacement (never on three days\' rest)', pickPostseason(u, postseasonRotation(u, P), D0 - 1, P).slot, REPLACEMENT);
}
/* departures: P(member present for club game k) = survival[k-1] */
{
  const S = [1, 0.9, 0.8, 0.8, 0.5];
  const Q: RotationParams = { ...P, survival: S };
  const n = 40000, present = new Array(7).fill(0);
  const rng = new Xoshiro128(11, 22, 33, 44);
  for (let i = 0; i < n; i++) {
    const st = new RotationState(['A'], [0], [0]); drawDepartures(st, Q, rng);
    for (let k = 1; k <= 7; k++) { st.games = k - 1; if (st.present(0)) present[k - 1]++; }
  }
  const got = present.map((c) => c / n);
  K.chk('departures reproduce the survival curve (and its last value beyond the table)', [1, 0.9, 0.8, 0.8, 0.5, 0.5, 0.5].every((v, k) => Math.abs(got[k] - v) < 0.01), got);
}
/* spot starts: a regular-season spot takes the member's turn (the order is kept); the postseason convention is its own */
{
  const Q: RotationParams = { ...P, p_spot: { single: 1, dh1: 1, dh2: 1, postseason: 1 }, spot_takes_turn: true, postseason_spot_takes_turn: false };
  const st = five(); const rng = new Xoshiro128(1, 2, 3, 4);
  K.eq('a spot start is a replacement', projectRegular(st, D0, 'single', Q, rng), REPLACEMENT);
  K.eq('... and it took A\'s turn (A\'s clock moved, B is next)', [st.last[0], st.ids[pickRegular(st, D0 + 1, P)]], [D0, 'B']);
  const pq = five(); const rot = postseasonRotation(pq, Q);
  K.eq('a postseason spot start (opener, bullpen game) is a replacement', projectPostseason(pq, rot, D0 + 2, Q, rng).slot, REPLACEMENT);
  K.eq('... and, with postseason_spot_takes_turn false, no member\'s clock moved', Array.from(pq.last), [D0 - 5, D0 - 4, D0 - 3, D0 - 2, D0 - 1]);
}

/* ---- the simulator itself, on the committed 2025 snapshots ---- */
{
  const snap = mlbFixture('aug');
  const d = snap.data;
  const remDH = d.games.filter((g) => g.status === 'scheduled' && g.phase === 'regular' && g.game_no > 0).length;
  K.chk('the mid-season fixture has doubleheaders left to play (non-vacuous)', remDH >= 2, remDH);
  const events: any[] = [];
  const m = mlbModule(d, { seed: 7n, observe: (e) => events.push(e) });
  runRange(m, { start: 0, end: 60 });
  /* order: dates never go backwards in the regular season; a doubleheader's game 1 is played before game 2 */
  let orderOk = true, dhOk = true, restOk = true, postRestOk = true, labelsOk = true, noTie = true;
  const asLast: Record<string, number> = {};
  for (const c of Object.values(d.rotation.clubs)) c.members.forEach((p, i) => { asLast[p] = Date.parse(c.last_start[i] + 'T12:00:00Z') / 864e5; });
  const byRun = new Map<number, any[]>(); for (const e of events) { if (!byRun.has(e.run)) byRun.set(e.run, []); byRun.get(e.run)!.push(e); }
  const gameNo: Record<string, number> = {}; d.games.forEach((g) => { gameNo[g.id] = g.game_no; });
  for (const [, evs] of byRun) {
    const last: Record<string, number> = { ...asLast };
    let prevReg = '';
    const dayStarters = new Map<string, string[]>();
    for (const e of evs) {
      const day = Date.parse(e.date + 'T12:00:00Z') / 864e5;
      if (e.phase === 'regular') { if (e.date < prevReg) orderOk = false; prevReg = e.date; }
      if (!['Confirmed', 'Projected'].includes(e.label_home) || !['Confirmed', 'Projected'].includes(e.label_away)) labelsOk = false;
      if (e.winner !== e.home && e.winner !== e.away) noTie = false;
      for (const [club, sp] of [[e.home, e.sp_home], [e.away, e.sp_away]]) {
        if (sp === 'REPLACEMENT') continue;
        if (last[sp] != null) { const rest = day - last[sp]; if (e.phase === 'regular' && rest < 5) restOk = false; if (e.phase === 'postseason' && rest < 4) postRestOk = false; }
        last[sp] = day;
        const k = club + e.date; const arr = dayStarters.get(k) || []; if (arr.includes(sp)) dhOk = false; arr.push(sp); dayStarters.set(k, arr);
      }
    }
  }
  K.chk('regular-season games are played in date order', orderOk);
  K.chk('no named starter starts twice on one date (doubleheaders get two different starters or a replacement)', dhOk);
  K.chk('every regular-season named start comes after at least four days of rest, counted from the as-of last start', restOk);
  K.chk('every postseason named start comes after at least three full days (four calendar days), the clock carried across the regular season and every round', postRestOk);
  K.chk('every simulated starter is labelled Confirmed or Projected', labelsOk);
  K.chk('no simulated game ends tied', noTie);
  const dh = events.filter((e) => e.phase === 'regular' && gameNo[e.game] === 2);
  const dhRepl = dh.filter((e) => e.sp_home === 'REPLACEMENT' || e.sp_away === 'REPLACEMENT').length;
  K.chk('doubleheader second games are often started by a replacement (the rest clock and the measured spot rate)', dh.length > 0 && dhRepl / dh.length > 0.2, { dh: dh.length, replacement: dhRepl });
  /* a projected start is never one certain name */
  const firstGame = new Map<string, Set<string>>();
  for (const e of events) if (e.phase === 'regular' && e.label_home === 'Projected') { const s = firstGame.get(e.game) || new Set(); s.add(e.sp_home); firstGame.set(e.game, s); }
  const multi = [...firstGame.values()].filter((s) => s.size >= 2).length;
  K.chk('across runs, almost every projected start has more than one possible starter', multi / firstGame.size > 0.9, { games: firstGame.size, multi });
}
{
  const snap = mlbFixture('ws');
  const d = snap.data;
  const g3 = d.games.find((g) => g.phase === 'postseason' && g.round === 'WS' && g.series_game === 3)!;
  K.eq('the World Series game 3 starters are stored Confirmed (announced)', [g3.starters.home, g3.starters.away], [{ id: 'glast001', status: 'Confirmed' }, { id: 'schem001', status: 'Confirmed' }]);
  const evs: any[] = [];
  runRange(mlbModule(d, { seed: 3n, observe: (e) => evs.push(e) }), { start: 0, end: 300 });
  const ws3 = evs.filter((e) => e.game === 'WS-G3'), later = evs.filter((e) => /^WS-G[4-7]$/.test(e.game));
  K.chk('game 3 uses the announced starters in every run, labelled Confirmed', ws3.length === 300 && ws3.every((e) => e.sp_home === 'glast001' && e.sp_away === 'schem001' && e.label_home === 'Confirmed' && e.label_away === 'Confirmed'));
  K.chk('games 4-7 are Projected, and each has more than one possible starter', later.every((e) => e.label_home === 'Projected') && ['WS-G4', 'WS-G5'].every((k) => new Set(later.filter((e) => e.game === k).map((e) => e.sp_home)).size >= 2));
  K.chk('Glasnow (game 3, Oct 27) never starts again before Nov 1 (4 days of rest at the earliest: game 7)', later.filter((e) => e.sp_home === 'glast001' || e.sp_away === 'glast001').every((e) => e.date >= '2025-10-31'));
}
process.exit(K.done());
