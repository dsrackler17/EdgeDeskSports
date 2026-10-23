/* ===========================================================================
   Mathematical title-game status from the CURRENT standings: sound
   SUFFICIENT conditions only (a team marked clinched is in under every
   outcome of every remaining game; one marked eliminated is out under every
   outcome), never a guess. Everything else is 'alive'.

     eliminated  at least `slots` other eligible teams are guaranteed a better
                 conference win percentage than this team's best case
                 (they lose out, it wins out, and the comparison is strict)
     clinched    fewer than `slots` other eligible teams can reach this team's
                 worst case (ties counted against it)
   The ACC's 2026 tied-team definition makes a team with an alternate number
   of conference games tied without an equal percentage, so for the ACC only
   'ineligible' is asserted. Slots: two per conference, one per Sun Belt
   division.
   =========================================================================== */
import type { CfbInputData } from './inputs.ts';

export type CcgStatus = 'clinched' | 'eliminated' | 'ineligible' | 'alive' | 'no_title_game';
export function cfbMathStatus(d: CfbInputData): Record<string, { ccg: CcgStatus }> {
  const out: Record<string, { ccg: CcgStatus }> = {};
  const rules = new Map(d.config.conferences.map((c) => [c.conference, c]));
  const w = new Array(d.teams.length).fill(0), l = new Array(d.teams.length).fill(0), rem = new Array(d.teams.length).fill(0);
  for (const g of d.games) {
    if (!g.conf || !g.ccg_counts) continue;
    if (!g.done) { rem[g.home]++; rem[g.away]++; continue; }
    const hw = (g.home_points as number) > (g.away_points as number);
    w[hw ? g.home : g.away]++; l[hw ? g.away : g.home]++;
  }
  d.teams.forEach((t, i) => {
    const rule = rules.get(t.conference);
    if (!rule) { out[t.id] = { ccg: 'no_title_game' }; return; }
    if (!t.ccg_eligible) { out[t.id] = { ccg: 'ineligible' }; return; }
    if (rule.procedure === 'ACC-2026') { out[t.id] = { ccg: 'alive' }; return; }
    const divisional = rule.procedure === 'SBC-DIV', slots = divisional ? 1 : 2;
    const rivals = d.teams.map((u, j) => j).filter((j) => j !== i && d.teams[j].conference === t.conference && d.teams[j].ccg_eligible && (!divisional || d.teams[j].division === t.division));
    const n = (j: number) => w[j] + l[j] + rem[j];
    /* fractions compared exactly: a/b > c/e  <=>  a e > c b */
    const gt = (a: number, b: number, c: number, e: number) => a * e > c * b;
    const ge = (a: number, b: number, c: number, e: number) => a * e >= c * b;
    const best = [w[i] + rem[i], n(i)], worst = [w[i], n(i)];
    const surelyAbove = rivals.filter((j) => n(j) > 0 && n(i) > 0 && gt(w[j], n(j), best[0], best[1])).length;
    const canReach = rivals.filter((j) => n(j) === 0 || n(i) === 0 || ge(w[j] + rem[j], n(j), worst[0], worst[1])).length;
    out[t.id] = { ccg: surelyAbove >= slots ? 'eliminated' : canReach < slots ? 'clinched' : 'alive' };
  });
  return out;
}
