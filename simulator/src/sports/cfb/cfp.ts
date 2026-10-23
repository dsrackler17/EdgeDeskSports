/* ===========================================================================
   THE COLLEGE FOOTBALL PLAYOFF: field, seeds, bracket — per season's rules.

   Three rules versions, each from the CFP's own text (config.ts carries the
   source and sha256 of the page read):

   CFP-2026 (collegefootballplayoff.com selection committee protocol and the
     2026-27 format release, read 2026-10-23):
     field  the champions of the ACC, Big Ten, Big 12 and SEC; the highest-
            ranked team (champion or not) from the American, Conference USA,
            MAC, Mountain West, Pac-12 or Sun Belt; Notre Dame if ranked in
            the top 12; then the next highest-ranked teams to 12
     seeds  the four highest-ranked teams are seeds 1-4 (byes); the rest by
            final ranking; an automatic qualifier ranked outside the top 12 is
            seeded at the bottom of the 12, in rank order
   CFP-2025 (the 2025 straight-seeding change): the five highest-ranked
     conference champions + seven at-large; seeds 1-4 the four highest-ranked
     teams; an automatic qualifier outside the top 12 at the bottom
   CFP-2024 (the first 12-team season): the five highest-ranked conference
     champions + seven at-large; seeds 1-4 the four highest-ranked CONFERENCE
     CHAMPIONS; the rest by ranking

   Bracket (all three): first round 5v12, 6v11, 7v10, 8v9 at the higher
   seed's campus; quarterfinals 1 v 8/9, 2 v 7/10, 3 v 6/11, 4 v 5/12 at
   neutral bowl sites; semifinals (1 v 8/9) v (4 v 5/12) and (2 v 7/10) v
   (3 v 6/11); no reseeding; national championship at a neutral site. The
   2026 bowl-path choice by seeds 1-3 picks sites, not opponents, and every
   site from the quarterfinals on is neutral, so it changes no probability.

   The ranking the field is built from is an INPUT here: the committee's real
   final ranking once it exists, the committee proxy's simulated ranking
   (Estimated) before that, or a stated scenario. This module never invents
   one.
   =========================================================================== */

export type CfpRulesId = 'CFP-2024' | 'CFP-2025' | 'CFP-2026';
export interface CfpRules {
  id: CfpRulesId;
  field: 12;
  /** conferences whose champion is an automatic qualifier outright (CFP-2026) */
  champion_bids: string[];
  /** CFP-2026: one bid for the highest-ranked team of these conferences, champion or not */
  best_team_bid: string[];
  /** CFP-2024/2025: the N highest-ranked conference champions */
  top_champions: number;
  /** Notre Dame is in when ranked in the top N (CFP-2026) */
  notre_dame_top: number | null;
  /** who takes seeds 1-4 */
  bye_rule: 'four_highest_ranked' | 'four_highest_ranked_champions';
}

export const CFP_RULES: Record<CfpRulesId, CfpRules> = {
  'CFP-2026': { id: 'CFP-2026', field: 12, champion_bids: ['ACC', 'Big Ten', 'Big 12', 'SEC'],
    best_team_bid: ['American Athletic', 'Conference USA', 'Mid-American', 'Mountain West', 'Pac-12', 'Sun Belt'], top_champions: 0, notre_dame_top: 12, bye_rule: 'four_highest_ranked' },
  'CFP-2025': { id: 'CFP-2025', field: 12, champion_bids: [], best_team_bid: [], top_champions: 5, notre_dame_top: null, bye_rule: 'four_highest_ranked' },
  'CFP-2024': { id: 'CFP-2024', field: 12, champion_bids: [], best_team_bid: [], top_champions: 5, notre_dame_top: null, bye_rule: 'four_highest_ranked_champions' }
};
export function cfpRulesFor(season: number): CfpRules {
  if (season >= 2026) return CFP_RULES['CFP-2026'];
  if (season === 2025) return CFP_RULES['CFP-2025'];
  if (season === 2024) return CFP_RULES['CFP-2024'];
  throw new Error('no 12-team CFP format before 2024 (season ' + season + ')');
}

export interface FieldInput {
  /** every eligible team in committee order, best first (the final ranking; beyond 25 the committee's relative order) */
  order: number[];
  /** team index -> its conference label */
  conference: (t: number) => string;
  /** conference -> its champion (team index); conferences without a champion are absent */
  champions: Map<string, number>;
  /** the Notre Dame team index, or -1 */
  notreDame: number;
}
export interface Field { seeds: number[]; auto: Set<number>; reason: Map<number, string> }

export function selectField(r: CfpRules, x: FieldInput): Field {
  const rank = new Map<number, number>(); x.order.forEach((t, i) => rank.set(t, i + 1));
  const auto = new Set<number>(), reason = new Map<number, string>();
  const add = (t: number, why: string) => { if (!auto.has(t)) { auto.add(t); reason.set(t, why); } };
  for (const c of r.champion_bids) { const t = x.champions.get(c); if (t != null && rank.has(t)) add(t, c + ' champion'); }
  if (r.best_team_bid.length) {
    const best = x.order.find((t) => r.best_team_bid.includes(x.conference(t)));
    if (best != null) add(best, 'highest-ranked team of ' + r.best_team_bid.join('/'));
  }
  if (r.top_champions) {
    const champs = new Set(x.champions.values());
    x.order.filter((t) => champs.has(t)).slice(0, r.top_champions).forEach((t) => add(t, 'top-' + r.top_champions + ' conference champion'));
  }
  if (r.notre_dame_top != null && x.notreDame >= 0 && (rank.get(x.notreDame) || Infinity) <= r.notre_dame_top) add(x.notreDame, 'Notre Dame in the top ' + r.notre_dame_top);
  if (auto.size > r.field) throw new Error('more automatic qualifiers than places');
  const field = new Set(auto);
  for (const t of x.order) { if (field.size >= r.field) break; if (!field.has(t)) { field.add(t); reason.set(t, 'at-large'); } }
  if (field.size !== r.field) throw new Error('could not fill the ' + r.field + '-team field (' + field.size + ' eligible teams)');
  /* seeds */
  const byRank = [...field].sort((a, b) => rank.get(a)! - rank.get(b)!);
  let top: number[];
  if (r.bye_rule === 'four_highest_ranked') top = byRank.slice(0, 4);
  else { const champs = new Set(x.champions.values()); top = byRank.filter((t) => champs.has(t) && auto.has(t)).slice(0, 4); }
  const rest = byRank.filter((t) => !top.includes(t));
  /* an automatic qualifier ranked outside the top 12 goes to the bottom, in rank order */
  const inside = rest.filter((t) => rank.get(t)! <= 12 || !auto.has(t)), outside = rest.filter((t) => rank.get(t)! > 12 && auto.has(t));
  const seeds = top.concat(inside, outside);
  if (seeds.length !== 12 || new Set(seeds).size !== 12) throw new Error('seeding produced ' + seeds.length + ' distinct teams');
  return { seeds, auto, reason };
}

export interface BracketGame { round: 'first_round' | 'quarterfinal' | 'semifinal' | 'final'; slot: string; home: number; away: number; neutral: boolean; winner: number; observed: boolean }
export interface BracketResult { games: BracketGame[]; reached_qf: number[]; reached_sf: number[]; reached_final: number[]; champion: number }

/** play the fixed bracket; `play(home, away, neutral, round, slot)` returns the winner (an observed result where one exists) */
export function playBracket(seeds: number[], play: (home: number, away: number, neutral: boolean, round: BracketGame['round'], slot: string) => { winner: number; observed: boolean }): BracketResult {
  if (seeds.length !== 12) throw new Error('a 12-team bracket needs 12 seeds');
  const s = (k: number) => seeds[k - 1];
  const games: BracketGame[] = [];
  const g = (round: BracketGame['round'], slot: string, home: number, away: number, neutral: boolean) => {
    const r = play(home, away, neutral, round, slot);
    if (r.winner !== home && r.winner !== away) throw new Error('bracket winner is not a participant (' + slot + ')');
    games.push({ round, slot, home, away, neutral, winner: r.winner, observed: r.observed });
    return r.winner;
  };
  const w89 = g('first_round', '8v9', s(8), s(9), false), w710 = g('first_round', '7v10', s(7), s(10), false);
  const w611 = g('first_round', '6v11', s(6), s(11), false), w512 = g('first_round', '5v12', s(5), s(12), false);
  const q1 = g('quarterfinal', '1v8/9', s(1), w89, true), q2 = g('quarterfinal', '2v7/10', s(2), w710, true);
  const q3 = g('quarterfinal', '3v6/11', s(3), w611, true), q4 = g('quarterfinal', '4v5/12', s(4), w512, true);
  /* the semifinal "home" side is the better seed: the engine prices a neutral site, so it only orients the margin */
  const better = (a: number, b: number) => (seeds.indexOf(a) < seeds.indexOf(b) ? [a, b] : [b, a]);
  const [h1, a1] = better(q1, q4), [h2, a2] = better(q2, q3);
  const f1 = g('semifinal', '(1)v(4)', h1, a1, true), f2 = g('semifinal', '(2)v(3)', h2, a2, true);
  const [hf, af] = better(f1, f2);
  const champion = g('final', 'final', hf, af, true);
  return { games, reached_qf: [s(1), s(2), s(3), s(4), w89, w710, w611, w512], reached_sf: [q1, q2, q3, q4], reached_final: [f1, f2], champion };
}
