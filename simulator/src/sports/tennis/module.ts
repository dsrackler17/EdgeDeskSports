/* ===========================================================================
   THE TENNIS DRAW SIMULATION — one singles main draw, from where it stands
   to its champion.

   The draw is its LINES in draw order (inputs.ts: Wikipedia's draw article
   for the order, ESPN for who is on each line and every result): L = 2^k
   lines, a line empty for a bye. The first round's match j is lines 2j and
   2j+1; the winners of matches 2j and 2j+1 of a round meet in match j of
   the next. A round's LEVEL is fixed from the final (draw.ts): Final 6,
   Semifinal 5, Quarterfinal 4, and so on down to the first round at
   7 - k.

   Each run plays every match bottom-up:
     - a match already decided (ESPN: completed, retired or a walkover)
       keeps its winner (Observed);
     - a player facing a bye advances without a match;
     - otherwise the winner is drawn from the served rating (elo.ts price:
       the ratings frozen at the as-of time, best of five in a men's Grand
       Slam main draw) on its own random stream. A simulated match never
       moves a rating.
   Outcomes per player: win the title, reach the final, the semifinals and
   the quarterfinals (a round already reached counts in every run), and win
   their next match (the first match of theirs not yet decided). Sum rules
   after every run: one champion; two finalists, four semifinalists, eight
   quarterfinalists when the draw has those rounds.
   =========================================================================== */
import type { SimModule, EntityDef, OutcomeDef, SumRule, RunMarks } from '../../core/engine.ts';
import { streamFor, STREAM } from '../../core/prng.ts';
import { price, type TennisEloConfig } from './elo.ts';

/** a decided match at (level, index): its winner's line, and whether it was a walkover */
export interface TennisResult { level: number; index: number; winner: string; match_id: string; walkover: boolean; retired: boolean }
export interface TennisPlayer { id: string; name: string; seed: string | null; entry: string | null; rating: number; n: number; line: number; country: string | null }
export interface TennisDraw {
  /** the player id on each line, null = a bye */
  lines: Array<string | null>;
  /** the first round's level (7 - log2(lines)) */
  first_level: number;
  results: TennisResult[];
  bo: 3 | 5;
}

export const OUTCOMES: OutcomeDef[] = [
  { key: 'win_title', label: 'Win the title', category: 'title', provenance: 'Research' },
  { key: 'reach_final', label: 'Reach the final', category: 'round', provenance: 'Research' },
  { key: 'reach_semifinal', label: 'Reach the semifinals', category: 'round', provenance: 'Research' },
  { key: 'reach_quarterfinal', label: 'Reach the quarterfinals', category: 'round', provenance: 'Research' },
  { key: 'win_next_match', label: 'Win their next match', category: 'round', provenance: 'Research' }
];
const LEVEL_OUTCOME: Record<number, string> = { 4: 'reach_quarterfinal', 5: 'reach_semifinal', 6: 'reach_final', 7: 'win_title' };

export interface TennisModuleData { competition: string; season: number; players: TennisPlayer[]; draw: TennisDraw; elo: { config: TennisEloConfig } }

/** the draw's node keys and checks: level l holds L / 2^(l - first + 1) matches */
export function nodeCount(draw: TennisDraw, level: number): number { return draw.lines.length >> (level - draw.first_level + 1); }

export function tennisModule(d: TennisModuleData, opt: { seed: bigint }): SimModule {
  const L = d.draw.lines.length, first = d.draw.first_level;
  if (L < 2 || (L & (L - 1)) !== 0) throw new Error('a draw has a power of two lines, not ' + L);
  if (first !== 7 - Math.log2(L)) throw new Error('first level ' + first + ' does not match ' + L + ' lines');
  const entities: EntityDef[] = d.players.map((p) => ({ id: p.id, name: p.name, groups: { draw: 'main' } }));
  const E = new Map(entities.map((e, i) => [e.id, i]));
  const O = new Map(OUTCOMES.map((o, i) => [o.key, i]));
  const oNext = O.get('win_next_match')!;
  const rating = new Float64Array(entities.length);
  d.players.forEach((p, i) => { rating[i] = p.rating; });
  const lineP = d.draw.lines.map((id) => (id == null ? -1 : E.get(id) ?? -2));
  if (lineP.some((x) => x === -2)) throw new Error('a line names a player who is not an entity');
  /* decided results by node; levels first..6 */
  const levels: number[] = []; for (let l = first; l <= 6; l++) levels.push(l);
  const decided = levels.map((l) => new Int32Array(nodeCount(d.draw, l)).fill(-1));
  for (const r of d.draw.results) {
    const w = E.get(r.winner);
    if (w == null || r.level < first || r.level > 6 || r.index < 0 || r.index >= nodeCount(d.draw, r.level)) throw new Error('result ' + r.match_id + ' is outside the draw');
    decided[r.level - first][r.index] = w;
  }
  const oTitle = O.get('win_title')!;
  const reachAt = levels.map((l) => (LEVEL_OUTCOME[l] ? O.get(LEVEL_OUTCOME[l])! : -1));
  const sumRules: SumRule[] = [{ outcome: 'win_title', by: 'league', perGroup: 1 }];
  if (first <= 6) sumRules.push({ outcome: 'reach_final', by: 'league', perGroup: 2 });
  if (first <= 5) sumRules.push({ outcome: 'reach_semifinal', by: 'league', perGroup: 4 });
  if (first <= 4) sumRules.push({ outcome: 'reach_quarterfinal', by: 'league', perGroup: 8 });
  const cfg = d.elo.config, bo = d.draw.bo;
  /* the first undecided match of every player still in the draw: the level where it is played (found per run, but fixed: it does not depend on the draws) */
  const nextLevel = new Int32Array(entities.length).fill(-1);
  {
    let cur = lineP.slice();
    for (let li = 0; li < levels.length; li++) {
      const nxt: number[] = [];
      for (let j = 0; j < cur.length / 2; j++) {
        const a = cur[2 * j], b = cur[2 * j + 1], w = decided[li][j];
        if (a >= 0 && b >= 0 && w < 0) { if (nextLevel[a] < 0) nextLevel[a] = levels[li]; if (nextLevel[b] < 0) nextLevel[b] = levels[li]; }
        /* a side not yet known (-3) leaves the other's next match at this level too */
        if (w < 0 && ((a >= 0 && b === -3) || (b >= 0 && a === -3))) { const k = a >= 0 ? a : b; if (nextLevel[k] < 0) nextLevel[k] = levels[li]; }
        nxt.push(w >= 0 ? w : a === -1 ? b : b === -1 ? a : -3);
      }
      cur = nxt;
    }
  }
  const work = new Int32Array(L);
  return {
    sport: 'tennis', competition: d.competition, season: String(d.season),
    entities, outcomes: OUTCOMES, sumRules, valueBins: 0,
    runOne(run: number, marks: RunMarks): void {
      const rs = streamFor(opt.seed, run, STREAM.games);
      let n = L;
      for (let i = 0; i < L; i++) work[i] = lineP[i];
      for (let li = 0; li < levels.length; li++) {
        const half = n >> 1;
        for (let j = 0; j < half; j++) {
          const a = work[2 * j], b = work[2 * j + 1];
          if (a >= 0 && reachAt[li] >= 0) marks.mark(a, reachAt[li]);
          if (b >= 0 && reachAt[li] >= 0) marks.mark(b, reachAt[li]);
          let w: number;
          const fixed = decided[li][j];
          if (fixed >= 0) w = fixed;
          else if (a < 0 && b < 0) { w = -1; marks.diag('empty_match'); }
          else if (a < 0) w = b;
          else if (b < 0) w = a;
          else {
            const p = price(cfg, rating[a], rating[b], bo);
            w = rs.nextDouble() < p ? a : b;
            if (nextLevel[w] === levels[li]) marks.mark(w, oNext);
          }
          if (w >= 0 && levels[li] === 6) marks.mark(w, oTitle);
          work[j] = w;
          if (marks.tracing && fixed < 0 && a >= 0 && b >= 0) marks.trace({ ev: 'match', level: levels[li], index: j, a: entities[a].id, b: entities[b].id, winner: entities[w].id });
        }
        n = half;
      }
    }
  };
}

/** each player's exact chance to reach each level (index level; 7 = the title), through the same bracket and prices
    the simulation draws: the check its shares converge to (tests), and the backtest's calculation */
export function exactReach(d: TennisModuleData): Map<string, number[]> {
  const first = d.draw.first_level, cfg = d.elo.config, bo = d.draw.bo;
  const R = new Map(d.players.map((p) => [p.id, p.rating]));
  const dec = new Map(d.draw.results.map((r) => [r.level + ':' + r.index, r.winner]));
  const out = new Map<string, number[]>(d.players.map((p) => [p.id, new Array(8).fill(0)]));
  let cur: Array<Map<string, number>> = d.draw.lines.map((id) => (id == null ? new Map() : new Map([[id, 1]])));
  for (let l = first; l <= 6; l++) {
    const nxt: Array<Map<string, number>> = [];
    for (let j = 0; j < cur.length / 2; j++) {
      const A = cur[2 * j], B = cur[2 * j + 1], m = new Map<string, number>(), w = dec.get(l + ':' + j);
      for (const [i, pi] of A) out.get(i)![l] += pi;
      for (const [i, pi] of B) out.get(i)![l] += pi;
      if (w != null) m.set(w, 1);
      else if (!A.size) for (const [i, pi] of B) m.set(i, pi);
      else if (!B.size) for (const [i, pi] of A) m.set(i, pi);
      else {
        for (const [i, pi] of A) for (const [k, pk] of B) {
          const p = price(cfg, R.get(i)!, R.get(k)!, bo);
          m.set(i, (m.get(i) || 0) + pi * pk * p); m.set(k, (m.get(k) || 0) + pi * pk * (1 - p));
        }
      }
      nxt.push(m);
    }
    cur = nxt;
  }
  for (const [i, pi] of cur[0]) out.get(i)![7] += pi;
  return out;
}
