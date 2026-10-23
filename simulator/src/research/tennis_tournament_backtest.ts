/* ===========================================================================
   DOES THE TENNIS RATING CALL TOURNAMENTS? — the walk-forward backtest of
   the draw simulation (simulator/src/sports/tennis/module.ts) on every
   completed main draw of the holdout (2025 to the feed's last final).

   For each draw whose tree rebuilds from its results (draw.ts buildTree;
   the refused ones are counted by reason), the ratings are frozen just
   before its first main-draw match (elo.ts walk over every earlier match,
   qualifying included: it was played) and each player's chance to win
   the title and to reach the final, the semifinals and the quarterfinals
   is computed exactly through the tree (no sampling):
        P(i wins node) = P(i wins its slot) x sum_j P(j wins the other slot) x p(i beats j).
   The simulation draws the same tree run by run, so its shares converge to
   these (module tests check it within sampling error).

   Scored against what happened:
     - the champion's log loss, -ln P(champion), against the field-size
       baseline ln(entrants) (every entrant equally likely) and against
       FiveThirtyEight's parameters, with a draw-bootstrap 95% interval of
       each difference (1,000 resamples);
     - the Brier score of every entrant's reach-the-final / semifinal /
       quarterfinal chances, against the same baselines;
     - calibration of the title chance: five bins, the mean chance beside
       the share who won.
   The tournament simulation is published only if, for each tour, the
   champion's log loss beats the field-size baseline with the interval
   entirely below zero (simulator/src/sports/tennis/activation.ts).

   Output: simulator/data/tennis_backtest.json
   Usage: node simulator/src/research/tennis_tournament_backtest.ts
   =========================================================================== */
import fs from 'node:fs';
import { readFeed, loadMatches, walk, emptyState, cloneState, price, ELO_538, TOURS, STUDY_FILE, isPlaceholder, bestOf, dedupeFeed, type TennisEloConfig, type EloState, type FeedMatch, type Tour } from '../sports/tennis/elo.ts';
import { buildTree, entrants, nodes, isMainRound, type DrawMatch, type Node } from '../sports/tennis/draw.ts';
import { streamFor } from '../core/prng.ts';

import { BACKTEST_FILE, BACKTEST_SCHEMA } from '../sports/tennis/activation.ts';
export const HOLD_FROM = Date.parse('2025-01-01T00:00:00Z');
const BOOT = 1000;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** each player's chance to win each node of the tree (exact), and so to reach each round */
export function exactDraw(root: Node, p: (i: string, j: string, n: Node) => number): { win: Map<Node, Map<string, number>>; reach: Map<string, number[]> } {
  const win = new Map<Node, Map<string, number>>(), reach = new Map<string, number[]>();
  const slotDist = (s: Node['slots'][0]): Map<string, number> => s.kind === 'player' ? new Map([[s.id, 1]]) : solve(s.node);
  const solve = (n: Node): Map<string, number> => {
    const A = slotDist(n.slots[0]), B = slotDist(n.slots[1]), out = new Map<string, number>();
    for (const [i, pi] of A) {
      if (!reach.has(i)) reach.set(i, new Array(8).fill(0));
      reach.get(i)![n.round] += pi;
      let s = 0; for (const [j, pj] of B) s += pj * p(i, j, n); out.set(i, (out.get(i) || 0) + pi * s);
    }
    for (const [j, pj] of B) {
      if (!reach.has(j)) reach.set(j, new Array(8).fill(0));
      reach.get(j)![n.round] += pj;
      let s = 0; for (const [i, pi] of A) s += pi * (1 - p(i, j, n)); out.set(j, (out.get(j) || 0) + pj * s);
    }
    win.set(n, out);
    return out;
  };
  const top = solve(root);
  for (const [i, x] of top) reach.get(i)![7] = x;
  return { win, reach };
}

/** the main draws of the feed, by (tournament, tour): their matches as the tree reads them (walkovers included: the winner advanced) */
export function feedDraws(rows: FeedMatch[]): Map<string, { tid: string; tour: Tour; name: string; matches: DrawMatch[] }> {
  const out = new Map<string, { tid: string; tour: Tour; name: string; matches: DrawMatch[] }>();
  for (const m of dedupeFeed(rows).rows) {
    if ((m.tour !== 'ATP' && m.tour !== 'WTA') || !isMainRound(m.round) || m.status === 'cancelled') continue;
    const key = m.tid + ':' + m.tour;
    if (!out.has(key)) out.set(key, { tid: m.tid, tour: m.tour as Tour, name: m.tournament, matches: [] });
    const a = isPlaceholder(m.a_id, m.a) ? null : m.tour + ':' + m.a_id, b = isPlaceholder(m.b_id, m.b) ? null : m.tour + ':' + m.b_id;
    out.get(key)!.matches.push({ id: String(m.id), round: String(m.round), a, b, winner: m.winner === 'a' ? a : m.winner === 'b' ? b : null, walkover: m.status === 'walkover', at: Date.parse(m.at || ''), bo: bestOf(m.tour, m.tournament, m.round) });
  }
  return out;
}

export function runBacktest(cfg: TennisEloConfig) {
  const feed = readFeed();
  const { matches } = loadMatches(feed);
  const draws = [...feedDraws(feed.matches).values()];
  const refused: Record<string, number> = {};
  type Case = { tour: Tour; name: string; tid: string; start: number; n: number; champ: string; reach: Map<string, number[]>; reach538: Map<string, number[]>; actual: Map<string, number> };
  const cases: Case[] = [];
  /* the draws in start order, with the rating walked to each start */
  const items = draws.map((d) => ({ d, start: Math.min(...d.matches.map((m) => m.at || Infinity)) })).filter((x) => Number.isFinite(x.start) && x.start >= HOLD_FROM).sort((x, z) => x.start - z.start);
  let S = emptyState(), S538 = emptyState(), i = 0;
  for (const { d, start } of items) {
    const { root, reason } = buildTree(d.matches);
    if (!root || !root.match.winner) { const k = reason || 'no champion yet'; refused[k] = (refused[k] || 0) + 1; continue; }
    let j = i; while (j < matches.length && matches[j].at < start) j++;
    walk(matches.slice(i, j), cfg, S); walk(matches.slice(i, j), ELO_538, S538); i = j;
    const ent = entrants(root);
    if (ent.length < 16) { refused['fewer than 16 entrants'] = (refused['fewer than 16 entrants'] || 0) + 1; continue; }
    const pr = (St: EloState, c: TennisEloConfig) => (a: string, b: string, n: Node) => price(c, St.R.get(a) ?? 1500, St.R.get(b) ?? 1500, n.match.bo || 3);
    const fa = cloneState(S), fb = cloneState(S538);
    const ex = exactDraw(root, pr(fa, cfg)), ex538 = exactDraw(root, pr(fb, ELO_538));
    /* what happened: the deepest round each entrant reached (7 = won) */
    const actual = new Map<string, number>();
    for (const n of nodes(root)) for (const s of [n.match.a, n.match.b]) if (s) actual.set(s, Math.max(actual.get(s) || 0, n.round));
    actual.set(root.match.winner, 7);
    cases.push({ tour: d.tour, name: d.name, tid: d.tid, start, n: ent.length, champ: root.match.winner, reach: ex.reach, reach538: ex538.reach, actual });
  }
  /* scores */
  const LEVELS: Array<[string, number]> = [['win', 7], ['final', 6], ['semifinal', 5], ['quarterfinal', 4]];
  const perCase = (c: Case, which: 'model' | '538' | 'uniform') => {
    const R = which === '538' ? c.reach538 : c.reach;
    const champP = which === 'uniform' ? 1 / c.n : R.get(c.champ)![7];
    const brier: Record<string, number> = {};
    for (const [k, lv] of LEVELS) {
      let s = 0;
      const slots = 2 ** (7 - lv); // players who reach that level
      for (const id of R.keys()) {
        const p = which === 'uniform' ? Math.min(1, slots / c.n) : R.get(id)![lv];
        const y = (c.actual.get(id) || 0) >= lv ? 1 : 0;
        s += (p - y) ** 2;
      }
      brier[k] = s / R.size;
    }
    return { champ_ll: -Math.log(Math.max(1e-12, champP)), brier };
  };
  const boot = (xs: number[], tag: number) => {
    const rs = streamFor(20261023n, tag, 1), out: number[] = [];
    for (let k = 0; k < BOOT; k++) { let s = 0; for (let q = 0; q < xs.length; q++) s += xs[Math.floor(rs.nextDouble() * xs.length)]; out.push(s / xs.length); }
    out.sort((a, b) => a - b);
    return [r6(out[Math.floor(0.025 * BOOT)]), r6(out[Math.ceil(0.975 * BOOT) - 1])];
  };
  const tours: Record<string, any> = {};
  TOURS.forEach((t, ti) => {
    const cs = cases.filter((c) => c.tour === t);
    if (!cs.length) { tours[t] = { draws: 0 }; return; }
    const M = cs.map((c) => perCase(c, 'model')), E = cs.map((c) => perCase(c, '538')), U = cs.map((c) => perCase(c, 'uniform'));
    const mean = (xs: number[]) => r6(xs.reduce((s, x) => s + x, 0) / xs.length);
    const dU = M.map((m, k) => m.champ_ll - U[k].champ_ll), dE = M.map((m, k) => m.champ_ll - E[k].champ_ll);
    const brier: Record<string, any> = {};
    for (const [k] of LEVELS) brier[k] = { model: mean(M.map((m) => m.brier[k])), elo_538: mean(E.map((m) => m.brier[k])), field_size: mean(U.map((m) => m.brier[k])) };
    /* calibration of the title chance */
    const bins = [[0, 0.02], [0.02, 0.05], [0.05, 0.1], [0.1, 0.25], [0.25, 1.01]].map(([a, b]) => ({ from: a, to: Math.min(1, b), n: 0, mean_chance: 0, won: 0 }));
    for (const c of cs) for (const [id, r] of c.reach) { const b = bins.find((x) => r[7] >= x.from && r[7] < x.to)!; b.n++; b.mean_chance += r[7]; b.won += id === c.champ ? 1 : 0; }
    tours[t] = {
      draws: cs.length, entrants_mean: mean(cs.map((c) => c.n)),
      champion_log_loss: { model: mean(M.map((m) => m.champ_ll)), elo_538: mean(E.map((m) => m.champ_ll)), field_size: mean(U.map((m) => m.champ_ll)),
        diff_vs_field_size: { mean: mean(dU), ci95: boot(dU, 100 + ti) }, diff_vs_538: { mean: mean(dE), ci95: boot(dE, 200 + ti) } },
      favourite_won: cs.filter((c) => { let best = '', bp = -1; for (const [id, r] of c.reach) if (r[7] > bp) { bp = r[7]; best = id; } return best === c.champ; }).length,
      champion_chance_median: r6(cs.map((c) => c.reach.get(c.champ)![7]).sort((a, b) => a - b)[Math.floor(cs.length / 2)]),
      brier,
      calibration: bins.map((b) => ({ from: b.from, to: b.to, n: b.n, mean_chance: b.n ? r6(b.mean_chance / b.n) : null, share_won: b.n ? r6(b.won / b.n) : null }))
    };
  });
  return { schema: BACKTEST_SCHEMA, generated_at: new Date().toISOString(), config: cfg, holdout_from: '2025-01-01', draws_scored: cases.length, refused, tours,
    examples: cases.slice(-6).map((c) => ({ tour: c.tour, name: c.name, start: new Date(c.start).toISOString().slice(0, 10), entrants: c.n, champion_chance: r6(c.reach.get(c.champ)![7]) })) };
}

const isMain = !!process.argv[1] && process.argv[1].endsWith('tennis_tournament_backtest.ts');
if (isMain) {
  const study = JSON.parse(fs.readFileSync(STUDY_FILE, 'utf8'));
  const out = runBacktest(study.chosen);
  fs.writeFileSync(BACKTEST_FILE, JSON.stringify(out, null, 1) + '\n');
  for (const t of TOURS) { const x = out.tours[t]; console.log(t + ': ' + x.draws + ' draws; champion log loss ' + (x.champion_log_loss ? x.champion_log_loss.model + ' v field size ' + x.champion_log_loss.field_size + ' (diff ' + x.champion_log_loss.diff_vs_field_size.mean + ' ' + JSON.stringify(x.champion_log_loss.diff_vs_field_size.ci95) + '), v 538 ' + x.champion_log_loss.elo_538 : '-')); }
  console.log('refused: ' + JSON.stringify(out.refused));
}
