/* ===========================================================================
   A TENNIS DRAW AS A TREE — rebuilt from who advanced.

   ESPN's scoreboard lists a draw's matches by time, with no position in the
   draw. But a knockout draw is a tree, and every played match names its two
   players: a player in a round-(k+1) match came from the round-k match they
   won, or entered that round with a bye. So once a draw is complete, its
   whole tree follows from its results (buildTree); the tournament backtest
   (simulator/src/research/tennis_tournament_backtest.ts) replays every
   completed draw from its first round this way.

   Main-draw rounds only (qualifying is a separate draw). ESPN names the
   early rounds up from the first ("Round 1", "Round 2", ...) and the last
   three down from the final ("Quarterfinal", "Semifinal", "Final"), so a
   32 draw is Round 1, Round 2, Quarterfinal, Semifinal, Final and a 128 draw
   has Rounds 1-4 before its quarterfinals. A round's LEVEL is fixed from
   the final: Final 6, Semifinal 5, Quarterfinal 4, the last numbered round
   3, the one before it 2, and so on (a 128 draw's first round is level 0).
   A draw is refused (with the reason) when its rounds do not form one tree:
   a numbered round missing between two others, a match whose player came
   from nowhere and is not a bye, a round with more than twice the matches
   of the next, a player in two matches of one round, no single final.
   =========================================================================== */

const LATE: Record<string, number> = { Quarterfinal: 4, Semifinal: 5, Final: 6 };
export const isMainRound = (r: string | null | undefined) => { const t = String(r || '').trim(); return t in LATE || /^Round \d$/.test(t); };
const numbered = (r: string) => { const m = /^Round (\d)$/.exec(String(r).trim()); return m ? Number(m[1]) : null; };
/** each main round's level in this draw (Final 6 ... the last numbered round 3), or a reason it has none */
export function roundLevels(names: Iterable<string>): { level: Map<string, number>; reason: string | null } {
  const set = new Set([...names].map((x) => String(x).trim()).filter(isMainRound));
  const ks = [...set].map(numbered).filter((k): k is number => k != null).sort((a, b) => a - b);
  const level = new Map<string, number>();
  for (const [n, l] of Object.entries(LATE)) if (set.has(n)) level.set(n, l);
  for (let i = 1; i < ks.length; i++) if (ks[i] !== ks[i - 1] + 1) return { level, reason: 'Round ' + (ks[i - 1] + 1) + ' missing' };
  if (ks.length && ks[0] !== 1) return { level, reason: 'Round 1 missing' };
  const maxK = ks.length ? ks[ks.length - 1] : 0;
  for (const k of ks) level.set('Round ' + k, 3 - (maxK - k));
  return { level, reason: null };
}
export const LEVEL_NAME = (l: number, draw: Map<string, number>) => { for (const [n, x] of draw) if (x === l) return n; return 'level ' + l; };

/** one match of a draw as the tree reads it: its two players (ids; null = not yet known) and its winner if decided */
export interface DrawMatch { id: string; round: string; a: string | null; b: string | null; winner: string | null; walkover?: boolean; at?: number; bo?: 3 | 5 }
/** a node: a match, fed by two slots; a slot is a player who entered here (a bye, or round 1) or the winner of a feeder match */
export interface Node { match: DrawMatch; round: number; slots: [Slot, Slot] }
export type Slot = { kind: 'player'; id: string } | { kind: 'match'; node: Node };

export function buildTree(ms: DrawMatch[]): { root: Node | null; reason: string | null; rounds: number[]; levels: Map<string, number> } {
  const main = ms.filter((m) => isMainRound(m.round));
  const { level, reason: lr } = roundLevels(main.map((m) => m.round));
  const by = new Map<number, DrawMatch[]>();
  for (const m of main) { const k = level.get(m.round.trim())!; (by.get(k) || by.set(k, []).get(k)!).push(m); }
  const rounds = [...by.keys()].sort((x, z) => x - z);
  const fail = (reason: string) => ({ root: null, reason, rounds, levels: level });
  if (lr) return fail(lr);
  if (!rounds.length) return fail('no main-draw round');
  if (rounds[rounds.length - 1] !== 6) return fail('no final');
  if (by.get(6)!.length !== 1) return fail(by.get(6)!.length + ' finals');
  for (let i = 1; i < rounds.length; i++) if (rounds[i] !== rounds[i - 1] + 1) return fail('a round missing below ' + LEVEL_NAME(rounds[i], level));
  for (const k of rounds) {
    const seen = new Set<string>();
    for (const m of by.get(k)!) for (const p of [m.a, m.b]) { if (!p) continue; if (seen.has(p)) return fail('a player twice in ' + LEVEL_NAME(k, level)); seen.add(p); }
    if (k < 6 && by.get(k)!.length > 2 * by.get(k + 1)!.length) return fail('too many matches in ' + LEVEL_NAME(k, level));
  }
  /* the match each player won in each round */
  const wonIn = new Map<string, DrawMatch>();
  for (const k of rounds) for (const m of by.get(k)!) if (m.winner) wonIn.set(k + ':' + m.winner, m);
  const used = new Set<string>();
  let bad: string | null = null;
  const node = (m: DrawMatch, k: number): Node => {
    used.add(m.id);
    const slot = (p: string | null): Slot => {
      if (!p) { bad = bad || 'an undecided player in ' + LEVEL_NAME(k, level); return { kind: 'player', id: '' }; }
      const f = k > rounds[0] ? wonIn.get((k - 1) + ':' + p) : undefined;
      return f ? { kind: 'match', node: node(f, k - 1) } : { kind: 'player', id: p };
    };
    return { match: m, round: k, slots: [slot(m.a), slot(m.b)] };
  };
  const root = node(by.get(6)![0], 6);
  if (bad) return fail(bad);
  const orphans = main.filter((m) => !used.has(m.id));
  if (orphans.length) return fail(orphans.length + ' matches outside the tree (first: ' + orphans[0].round + ' ' + orphans[0].id + ')');
  return { root, reason: null, rounds, levels: level };
}
/** the players who entered the draw (round 1 or a bye), top to bottom */
export function entrants(root: Node): string[] {
  const out: string[] = [];
  const go = (n: Node) => { for (const s of n.slots) if (s.kind === 'player') out.push(s.id); else go(s.node); };
  go(root);
  return out;
}
export function nodes(root: Node): Node[] {
  const out: Node[] = [];
  const go = (n: Node) => { for (const s of n.slots) if (s.kind === 'match') go(s.node); out.push(n); };
  go(root);
  return out;
}
