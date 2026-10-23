/* SYNTHETIC tie cases for every conference procedure (rules.ts). Each league
   below is built by hand so that one named step, and only that step, decides
   the case; the expected answer is worked out from the procedure text quoted
   in CFB_SIMULATOR_NOTES.md §5. Synthetic fixtures never feed production data. */
import { kit } from './_kit.ts';
import { synth, filler, type SynthGame } from './_cfb.ts';
import { PROCEDURES } from '../src/sports/cfb/rules.ts';

const T = kit('SYNTHETIC CFB conference tiebreakers');
const W = (h: string, a: string, extra: Partial<SynthGame> = {}): SynthGame => ({ h, a, m: 7, ...extra });   // h beats a
const steps = (tab: any, purpose = 'berth') => tab.decisions.filter((d: any) => d.purpose === purpose).map((d: any) => d.step);

/* --- every procedure ends in a draw, so a tie can never be left unresolved --- */
for (const [id, p] of Object.entries(PROCEDURES)) {
  T.chk(id + ': the two-team and multi-team lists end in a draw', p.two[p.two.length - 1].kind === 'draw' && p.multi[p.multi.length - 1].kind === 'draw');
  if (p.host) T.chk(id + ': the host procedure ends in a draw', p.host[p.host.length - 1].kind === 'draw');
}

/* 1 Big 12: a clean table, then a perfect three-way cycle */
{
  const s = synth('Big 12', 'B12-2024', ['A', 'B', 'C', 'D'], [W('A', 'B'), W('A', 'C'), W('A', 'D'), W('B', 'C'), W('B', 'D'), W('C', 'D')]);
  const tab = s.table(), p = tab.participants();
  T.eq('Big 12: an outright leader and an outright second need no tiebreak (A 3-0, B 2-1)', s.names(p.seeds), ['A', 'B']);
  T.eq('Big 12: and no step was used', tab.decisions.length, 0);
}
{
  const s = synth('Big 12', 'B12-2024', ['A', 'B', 'C', 'D'], [W('A', 'B'), W('A', 'C'), W('A', 'D'), W('B', 'C'), W('B', 'D', { m: -7 }), W('C', 'D')]);
  /* A 3-0; B, C, D 1-2 in a cycle (B beat C, C beat D, D beat B): identical in every record step and in schedule strength */
  const tab = s.table(), p = tab.participants();
  T.eq('Big 12: the outright leader is seed 1', s.names(p.seeds)[0], 'A');
  T.eq('Big 12: a perfect three-way cycle for second (equal surrogate) is settled only by the coin toss', steps(tab), ['draw']);
}
{
  const s = synth('Big 12', 'B12-2024', ['A', 'B', 'C', 'D'], [W('A', 'C'), W('A', 'D'), W('B', 'A'), W('B', 'C', { m: -7 }), W('B', 'D'), W('C', 'D')]);
  /* A 2-1 (beat C, D; lost B), B 2-1 (beat A, D; lost C), C 2-1 (beat B, D; lost A), D 0-3: three tied for first */
  const tab = s.table(), p = tab.participants();
  T.chk('Big 12 three tied for first (a cycle): both berths decided by the procedure', s.names(p.seeds).length === 2 && p.decided_by.some((d) => /3-team tie/.test(d)), p);
}
{
  const s = synth('Big 12', 'B12-2024', ['A', 'B', 'C', 'D', 'E'], [W('A', 'B'), W('C', 'A'), W('B', 'C'), W('A', 'D'), W('B', 'D'), W('C', 'D'), W('A', 'E'), W('B', 'E'), W('C', 'E'), W('D', 'E'),
    /* non-conference: A 2 wins, B 1, C 0 (step e decides A) */ { h: 'A', a: 'X1', m: 10, conf: false, fcs: true }, { h: 'A', a: 'X2', m: 10, conf: false, fcs: true }, { h: 'B', a: 'X3', m: 10, conf: false, fcs: true }]);
  const tab = s.table(), p = tab.participants();
  T.eq('Big 12 three-way cycle, identical common opponents and schedule: total wins in a 12-game season (one FCS win counted) separates... A and B tie on it (one FCS win each counted), C is out; then A v B head-to-head', s.names(p.seeds), ['A', 'B']);
  T.chk('Big 12: step e counted only one FCS win for A (2 played)', tab.totalWins12(s.ix.get('A')!) === tab.totalWins12(s.ix.get('B')!) && tab.totalWins12(s.ix.get('A')!) === 4, [tab.totalWins12(0), tab.totalWins12(1), tab.totalWins12(2)]);
  T.chk('Big 12: the subset {A, B} restarted with the two-team list (head-to-head)', steps(tab, 'seed').concat(steps(tab)).includes('total_wins_12') && steps(tab, 'seed').concat(steps(tab)).includes('h2h'), steps(tab, 'seed').concat(steps(tab)));
}
{
  /* not all played: a team that beat each of the other tied teams advances (Big 12 a.1) */
  const f = filler('B', 1, 0, 'b'), g = filler('C', 1, 0, 'c');
  const s = synth('Big 12', 'B12-2024', ['A', 'B', 'C', ...f.teams, ...g.teams, 'Z'], [W('A', 'B'), W('A', 'C'), W('B', 'Z'), W('C', 'Z'), W('Z', 'A'), ...f.games, ...g.games]);
  /* A 2-1, B 2-1 (beat Fb0, Z; lost to A), C 2-1 (beat Fc0, Z; lost to A); B and C never met */
  const tab = s.table(), p = tab.participants();
  T.eq('Big 12 three-way, not all played: A beat both others and takes a berth first', s.names(p.seeds)[0], 'A');
  T.chk('Big 12: the sweep step decided it', steps(tab).includes('h2h_sweep'), steps(tab));
}
/* 2 common opponents (Big 12 b) */
{
  const s = synth('Big 12', 'B12-2024', ['A', 'B', 'C', 'D', 'E', 'F'], [W('A', 'C'), W('A', 'D'), W('E', 'A'), W('B', 'C'), W('D', 'B'), W('B', 'F'), W('C', 'E'), W('F', 'E')]);
  /* A 2-1 (beat C, D; lost E); B 2-1 (beat C, F; lost D); E 1-2, F 1-1, C 1-2, D 1-1. A and B never met;
     their common conference opponents are C and D: A 2-0, B 1-1 -> A first */
  const tab = s.table(), p = tab.participants();
  T.eq('Big 12 two-team tie for first, no head-to-head: common conference opponents decide (A 2-0 v C, D; B 1-1)', s.names(p.seeds), ['A', 'B']);
  T.eq('Big 12: the seed order came from the common-opponents step', steps(tab, 'seed'), ['common_pct']);
}
/* 3 ACC 2026: alternate numbers of conference games */
{
  const fa = filler('A', 6, 1, 'a'), fb = filler('B', 7, 1, 'b'), fd = filler('D', 7, 1, 'd');
  const s = synth('ACC', 'ACC-2026', ['A', 'B', 'D', ...fa.teams, ...fb.teams, ...fd.teams], [W('A', 'B'), W('A', 'D'), W('B', 'D'), ...fa.games, ...fb.games, ...fd.games]);
  /* A 8-1 (9 games): 6-1 + beat B + beat D; B 8-2 (10 games): 7-1 + lost A + beat D; D 7-3 */
  const tab = s.table(), p = tab.participants();
  T.eq('ACC: the outright best percentage is placed', s.names(p.seeds)[0], 'A');
}
{
  /* B 8-1 (9 games), D 8-1 (9 games), A 7-1 (8 games, the same losses): A is a TIED TEAM under the 2026 definition */
  const fa = filler('A', 5, 1, 'a'), fb = filler('B', 7, 0, 'b'), fd = filler('D', 7, 0, 'd');
  const s = synth('ACC', 'ACC-2026', ['A', 'B', 'D', ...fa.teams, ...fb.teams, ...fd.teams], [W('A', 'B'), W('A', 'D'), W('B', 'D'), ...fa.games, ...fb.games, ...fd.games]);
  const tab = s.table();
  const wl = (n: string) => [tab.w.get(s.ix.get(n)!), tab.l.get(s.ix.get(n)!)];
  T.eq('ACC fixture records: A 7-1, B 8-1, D 7-2', [wl('A'), wl('B'), wl('D')], [[7, 1], [8, 1], [7, 2]]);
  const tied = s.names(tab.accTied(s.L.confs[0].members.filter((t) => s.L.teams[t].ccg_eligible)));
  T.chk('ACC tied-team definition: B (8-1, best) plus A (7-1, eight games, the same one loss)', tied.includes('B') && tied.includes('A') && !tied.includes('D'), tied);
  const p = tab.participants();
  T.eq('ACC: with only two tied teams for two places both go; A beat B so A is seed 1', s.names(p.seeds), ['A', 'B']);
}
{
  /* three tied, not all common opponents: C lost to both A and B (removed), A and B never met -> Team Success Ranking (Estimated surrogate) */
  const fa = filler('A', 5, 1, 'a'), fb = filler('B', 5, 1, 'b'), fc = filler('C', 7, 0, 'c');
  const s = synth('ACC', 'ACC-2026', ['A', 'B', 'C', ...fa.teams, ...fb.teams, ...fc.teams], [W('A', 'C'), W('B', 'C'), ...fa.games, ...fb.games, ...fc.games], { surrogate: { A: 3, B: 9, C: 50 } });
  /* A 6-1, B 6-1, C 7-2 (9 games): C has an alternate number of games? all 9 or 8: A 7 games, B 7, C 9 -> C alternate with the same 2 losses? no: A,B have 1 loss */
  const tab = s.table(), p = tab.participants();
  T.chk('ACC: A and B (6-1) take both places; C is not tied (7-2 shares neither their wins nor their losses)', s.names(p.seeds).sort().join() === 'A,B', s.names(p.seeds));
  T.eq('ACC two-team seed order without head-to-head: the Team Success Ranking (Estimated surrogate) — B', s.names(p.seeds)[0], 'B');
  T.chk('ACC: the surrogate decision is recorded as a seed decision (both were in)', steps(tab, 'seed').includes('metric') && !steps(tab).includes('metric'), { seed: steps(tab, 'seed'), berth: steps(tab) });
}
{
  const fa = filler('A', 5, 1, 'a'), fb = filler('B', 5, 1, 'b'), fc = filler('C', 6, 0, 'c'), fd = filler('D', 7, 0, 'd');
  const s = synth('ACC', 'ACC-2026', ['A', 'B', 'C', 'D', ...fa.teams, ...fb.teams, ...fc.teams, ...fd.teams], [W('A', 'C'), W('B', 'C'), W('D', 'A'), W('D', 'B', { m: -7 }), ...fa.games, ...fb.games, ...fc.games, ...fd.games], { surrogate: { A: 1, B: 2, C: 99, D: 0 } });
  /* D 8-1 (beat A, lost to B) best; A 6-2, B 7-1?  B: 5-1 + beat C + beat D = 7-1; A: 5-1 + beat C + lost D = 6-2; C: 6-0 + lost A + lost B = 6-2 */
  const tab = s.table(), p = tab.participants();
  /* D 8-1 (nine games: beat A, lost B); B 7-1 (eight games, the same one loss: TIED with D); A 6-2; C 6-2 */
  T.eq('ACC: D (8-1, nine games) and B (7-1, eight games, the same one loss) are the Top Two; B won head-to-head, so B is seed 1', s.names(p.seeds), ['B', 'D']);
}
/* 4 MAC: the SportSource step comes BEFORE order of finish */
{
  const s = synth('Mid-American', 'MAC-2025', ['A', 'B', 'C', 'D', 'E'], [W('A', 'C'), W('B', 'C'), W('D', 'A'), W('D', 'B'), W('A', 'E'), W('B', 'E'), W('C', 'D')], { surrogate: { A: 1, B: 4 } });
  /* A 2-1, B 2-1, never met, identical common opponents and results; C 1-2, D 2-1! -> three tied at 2-1 */
  const tab = s.table(), p = tab.participants();
  /* A, B, D tied at 2-1; A and B never met, D beat both: D takes the first berth (sweep); A v B: no head-to-head,
     identical common opponents (C, D, E: 2-1 each) -> the SportSource Team Rating Score (Estimated surrogate): B */
  T.eq('MAC: D sweeps the three-way tie, then the SportSource step (before order of finish) picks B over A', s.names(p.seeds), ['D', 'B']);
  T.eq('MAC: the berths were decided by the sweep, then the Estimated SportSource surrogate', steps(tab), ['h2h_sweep', 'metric']);
}
/* 5 Sun Belt: divisions, the ineligible champion, the host */
{
  const teams: Array<[string, string]> = [['E1', 'East'], ['E2', 'East'], ['E3', 'East'], ['W1', 'West'], ['W2', 'West'], ['W3', 'West']];
  const games = [W('E1', 'E2'), W('E1', 'E3'), W('E2', 'E3'), W('W1', 'W2'), W('W1', 'W3'), W('W2', 'W3'), W('W1', 'E1')];
  const s = synth('Sun Belt', 'SBC-DIV', teams, games);
  const p = s.table().participants();
  T.eq('Sun Belt: one champion per division; the better conference record hosts (W1 3-0 v E1 2-1)', s.names(p.seeds), ['W1', 'E1']);
  const s2 = synth('Sun Belt', 'SBC-DIV', teams, games, { ineligible: ['E1'] });
  T.eq('Sun Belt: an ineligible division champion yields to the next team (E2), whose games still count', s2.names(s2.table().participants().seeds), ['W1', 'E2']);
  const s3 = synth('Sun Belt', 'SBC-DIV', teams, [W('E1', 'E2'), W('E1', 'E3'), W('E2', 'E3'), W('W1', 'W2'), W('W1', 'W3'), W('W2', 'W3'), W('E1', 'W2'), W('W1', 'E2')], { surrogate: { E1: 1, W1: 6 } });
  const t3 = s3.table(), p3 = t3.participants();
  T.eq('Sun Belt host tie (both 3-0, never met): the CFP-ranking / computer-composite step (Estimated surrogate) picks the host, W1', s3.names(p3.seeds), ['W1', 'E1']);
  T.chk('Sun Belt: the host decision is recorded as a seed decision, by the Estimated ranking', steps(t3, 'seed').includes('metric') && steps(t3).length === 0, t3.decisions);
}
/* 6 eligibility in a two-slot conference: the ineligible leader's games count, it takes no slot */
{
  const s = synth('Big 12', 'B12-2024', ['X', 'A', 'B', 'C'], [W('X', 'A'), W('X', 'B'), W('X', 'C'), W('A', 'B'), W('A', 'C'), W('B', 'C')], { ineligible: ['X'] });
  const tab = s.table(), p = tab.participants();
  T.eq('ineligible X (3-0) takes no place; A (2-1) and B (1-2) do', s.names(p.seeds), ['A', 'B']);
  T.chk('ineligible X\'s games still count in A\'s record (2-1, including the loss to X)', tab.w.get(s.ix.get('A')!) === 2 && tab.l.get(s.ix.get('A')!) === 1);
}
/* 7 SEC: capped relative scoring margin (offense capped at 42, defense at 48), Estimated scores */
{
  const g = (h: string, a: string, hp: number, ap: number): SynthGame => ({ h, a, m: hp - ap, hp, ap });
  const s = synth('SEC', 'SEC-2024', ['A', 'B', 'C', 'D'], [g('A', 'C', 70, 0), g('B', 'C', 40, 10), g('A', 'D', 40, 38), g('B', 'D', 30, 20), g('C', 'D', 21, 20), g('D', 'A', 0, 0 + 0 + 1)]);
  /* careful: D v A home margin -1 -> A beat D twice? use distinct: */
  const tab = s.table();
  T.chk('SEC capped margin: A\'s 70-0 counts as 42-0', tab.cappedMargin(s.ix.get('A')!, s.R.points()!) === (42 - 0) + (40 - 38) + (1 - 0), tab.cappedMargin(s.ix.get('A')!, s.R.points()!));
}
{
  const g = (h: string, a: string, hp: number, ap: number): SynthGame => ({ h, a, m: hp - ap, hp, ap });
  const s = synth('SEC', 'SEC-2024', ['A', 'B', 'C', 'D'], [g('A', 'C', 63, 0), g('B', 'C', 42, 3), g('D', 'A', 24, 21), g('D', 'B', 24, 21), g('C', 'D', 10, 3)]);
  /* A 1-1, B 1-1, C 1-2, D 2-1: D first; A and B tied for second, never met; common opponents C, D identical (1-1);
     next common / SOS identical; capped margin: A 42-0 + 21-24 = 39, B 39-0... B 42-3 + 21-24 = 36 -> A (raw: A 60 v B 36, same order) */
  const tab = s.table(), p = tab.participants();
  T.eq('SEC: the capped relative scoring margin decides a tie the record steps cannot', s.names(p.seeds), ['D', 'A']);
  T.chk('SEC: recorded as a berth decided by Estimated scores', steps(tab).includes('scoring_margin'), tab.decisions);
}
/* 8 the draw: a perfect tie is a fair seeded draw */
{
  let a = 0; const N = 2000;
  for (let i = 0; i < N; i++) {
    const s = synth('Big 12', 'B12-2024', ['A', 'B', 'C'], [W('C', 'A', { m: -7 }), W('C', 'B', { m: -7 })], { surrogate: { A: 5, B: 5 }, seed: BigInt(i + 1) });
    /* A and B 1-0, never met, identical in every step through the (equal) SportSource surrogate: the coin toss */
    const tab = s.table(), p = tab.participants();
    if (s.names(p.seeds)[0] === 'A') a++;
  }
  T.near('a perfect two-team tie is a fair coin (A first in ' + a + ' of ' + N + ')', a / N, 0.5, 4 * Math.sqrt(0.25 / N));
}
/* 9 exact fractions: 2-1 and 4-2 are one group */
{
  const fa = filler('A', 2, 1, 'a'), fb = filler('B', 4, 2, 'b');
  const s = synth('Big 12', 'B12-2024', ['A', 'B', ...fa.teams, ...fb.teams], [...fa.games, ...fb.games]);
  const grp = s.table().groups([s.ix.get('A')!, s.ix.get('B')!])[0];
  T.eq('win percentages compared as exact fractions: 2/3 and 4/6 are tied', s.names(grp).sort(), ['A', 'B']);
}
process.exitCode = T.done();
