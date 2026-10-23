/* ===========================================================================
   THE WNBA POSTSEASON SIMULATION — one simulated run = the rest of the
   playoffs, game by game.

   Every played playoff game is kept as played (Observed). The series still
   being played is simulated at the hosts the schedule names, from the
   served model's price of each game, until a club reaches the wins it needs.

   THE SHARED OFFSET. Whatever is wrong with the two clubs' ratings is wrong
   in every game of their series at once, so one offset delta ~ N(0, tau^2)
   (points of final margin, in favour of the series' first club) is drawn per
   run and kept for the whole series (simulator/data/wnba_strength_
   uncertainty.json). It is carved OUT of the served distribution, never
   added to it: with the served P(home) = Phi(z) and the calibration's margin
   sd sigma, a game is won at home with probability
        Phi((z sigma + delta_home) / s),   s = sqrt(sigma^2 - tau^2),
   whose average over delta is exactly Phi(z): every game keeps the served
   probability (the board's), and only the games' dependence changes.

   Outcomes per club: the rounds it reaches (Observed once decided), the
   title, the title in exactly k games, and each remaining game won. Sum
   rules (checked after every run): one champion; two finalists; four
   semifinalists (as the bracket holds them).
   =========================================================================== */
import type { SimModule, EntityDef, OutcomeDef, SumRule, RunMarks } from '../../core/engine.ts';
import { streamFor, STREAM } from '../../core/prng.ts';
import { normalQuantile, normalCdf } from '../../core/normal.ts';
import type { WnbaInputData, WnbaSeries } from './inputs.ts';

export const ROUND_KEYS: Record<number, string> = { 2: 'reach_semifinals', 3: 'reach_finals' };
const ROUND_LABEL: Record<string, string> = { reach_semifinals: 'Reach the semifinals', reach_finals: 'Reach the Finals' };

/** the open series (at most one: run.ts gates it) and the final round's series */
export function seriesState(d: WnbaInputData): { open: WnbaSeries | null; final: WnbaSeries | null } {
  const open = d.series.find((s) => s.winner == null) || null;
  const final = d.series.find((s) => s.round === d.rounds) || null;
  return { open, final };
}

export function wnbaModule(d: WnbaInputData, opt: { seed: bigint; tau?: number }): SimModule {
  const entities: EntityDef[] = d.teams.map((t) => ({ id: t.id, name: t.name, groups: { league: 'WNBA' } }));
  const E = new Map(entities.map((e, i) => [e.id, i]));
  const st = seriesState(d), open = st.open;
  if (!st.final) throw new Error('no final-round series in the snapshot');
  const final: WnbaSeries = st.final;
  const roundDecided = (r: number) => d.series.filter((s) => s.round === r).every((s) => s.winner != null);
  const outcomes: OutcomeDef[] = [];
  for (let r = 2; r <= d.rounds; r++) {
    const key = ROUND_KEYS[r] || 'reach_round_' + r;
    /* a round whose clubs are all known is Observed: every club in it got there by played games */
    outcomes.push({ key, label: ROUND_LABEL[key] || 'Reach round ' + r, category: 'round', provenance: d.series.some((s) => s.round === r) && roundDecided(r - 1) ? 'Observed' : 'Research' });
  }
  outcomes.push({ key: 'win_title', label: 'Win the WNBA title', category: 'title', provenance: final.winner != null ? 'Observed' : 'Research' });
  for (let k = final.wins_needed; k <= final.best_of; k++) outcomes.push({ key: 'title_in_' + k, label: 'Win the title in ' + k + ' games', category: 'title', provenance: final.winner != null ? 'Observed' : 'Research' });
  const remaining = d.remaining.slice().sort((a, b) => a.n - b.n);
  for (const g of remaining) outcomes.push({ key: 'win_game_' + g.n, label: 'Win game ' + g.n + (open && open.round === d.rounds ? ' of the Finals' : ''), category: 'playoffs', provenance: 'Research' });
  const O = new Map(outcomes.map((o, i) => [o.key, i]));
  const sumRules: SumRule[] = [{ outcome: 'win_title', by: 'league', perGroup: 1 }];
  for (let r = 2; r <= d.rounds; r++) {
    const n = 2 * d.series.filter((s) => s.round === r).length;
    if (n) sumRules.push({ outcome: ROUND_KEYS[r] || 'reach_round_' + r, by: 'league', perGroup: n });
  }
  const tau = opt.tau != null ? opt.tau : d.strength.tau_points, sigma = d.strength.sd_margin;
  if (!(tau >= 0 && tau < sigma)) throw new Error('the shared offset tau (' + tau + ') must be below the served margin sd (' + sigma + ')');
  const s = Math.sqrt(sigma * sigma - tau * tau);
  /* each remaining game's served z (P(home) = Phi(z)), once */
  const z = remaining.map((g) => normalQuantile(g.p_home));

  function runOne(run: number, marks: RunMarks): void {
    const rs = streamFor(opt.seed, run, STREAM.strength), rg = streamFor(opt.seed, run, STREAM.postseason);
    const delta = tau > 0 ? tau * normalQuantile(rs.nextOpen()) : 0;
    /* rounds reached: every club in a round's series reached it */
    for (const sr of d.series) if (sr.round >= 2) for (const t of sr.teams) marks.mark(E.get(t)!, O.get(ROUND_KEYS[sr.round] || 'reach_round_' + sr.round)!);
    let champion = final.winner, games = final.winner ? final.games.filter((g) => g.status === 'FINAL').length : 0;
    /* the finalists' Finals wins at the end of this run (as played when the Finals are decided) */
    let finalWins: Record<string, number> = { ...final.wins };
    if (open) {
      const wins: Record<string, number> = { ...open.wins };
      let played = open.games.filter((g) => g.status === 'FINAL').length;
      const a = open.teams[0];
      if (marks.tracing) marks.trace({ ev: 'start', delta_points: Math.round(delta * 1000) / 1000, wins: { ...wins } });
      for (let i = 0; i < remaining.length; i++) {
        const g = remaining[i];
        if (wins[open.teams[0]] >= open.wins_needed || wins[open.teams[1]] >= open.wins_needed) break;
        const dh = g.home === a ? delta : -delta;
        const p = normalCdf((z[i] * sigma + dh) / s);
        const homeWins = rg.nextDouble() < p;
        const w = homeWins ? g.home : g.away;
        wins[w]++; played++;
        marks.mark(E.get(w)!, O.get('win_game_' + g.n)!);
        marks.diag('game_' + g.n + '_played');
        if (homeWins) marks.diag('game_' + g.n + '_home_win');
        if (marks.tracing) marks.trace({ ev: 'game', n: g.n, home: g.home, away: g.away, p_home: Math.round(p * 1e4) / 1e4, winner: w });
      }
      const w = wins[open.teams[0]] >= open.wins_needed ? open.teams[0] : open.teams[1];
      if (wins[w] < open.wins_needed) throw new Error('run ' + run + ': the series ended without a winner');
      if (open.key === final.key) { champion = w; games = played; finalWins = wins; }
    }
    if (!champion) throw new Error('run ' + run + ': no champion');
    marks.mark(E.get(champion)!, O.get('win_title')!);
    marks.mark(E.get(champion)!, O.get('title_in_' + games)!);
    for (const e of d.teams) marks.value(E.get(e.id)!, final.teams.includes(e.id) ? Math.min(7, finalWins[e.id] || 0) : 0);
    if (marks.tracing) marks.trace({ ev: 'champion', club: champion, games });
  }
  return { sport: 'wnba', competition: d.competition, season: String(d.season), entities, outcomes, sumRules, valueBins: 8,
    value: { key: 'finals_wins', label: 'Finals games won', divisor: 1 }, runOne };
}
