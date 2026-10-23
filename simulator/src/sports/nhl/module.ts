/* ===========================================================================
   ONE SIMULATED NHL SEASON, FROM THE SNAPSHOT.

   For run r (master seed fixed):
   1. Each club draws ONE strength offset d ~ Normal(0, σ²) on the log goal
      rate (σ: simulator/data/nhl_strength_uncertainty.json at the as-of games
      played). It persists through every remaining game AND the postseason.
   2. Completed games are fixed exactly as played: winner, and whether in
      regulation, overtime or the shootout. Every remaining game is drawn from
      the served distribution at the offset rates (model_adapter.ts): home or
      away, in regulation, overtime or the shootout.
   3. Standings: 2 points a win, 1 an overtime or shootout loss; RW, ROW and
      wins; the tiebreakers, the division top three, the wild cards and the
      fixed bracket (rules.ts). A tie that reaches goal differential draws the
      remaining games' scores from the same distribution, conditional on how
      each game ended (separate stream, so it never moves a result).
   4. The postseason, series by series and game by game, 2-2-1-1-1 from the
      club with home ice, with the same offsets: a 60-minute tie goes to
      sudden-death overtime (never a shootout). Completed playoff games and
      series are kept as played; a series continues from its actual state.
   5. Every outcome the club achieved is marked. Regular-season honours
      (division, best record in the conference, the Presidents' Trophy) are
      separate outcomes from the playoff conference title and the Cup.

   Streams (core/prng.ts STREAM): strength, games, postseason, coin, overtime
   and points are separate, so drawing (or not drawing) scores never shifts a
   game result, and the result of run r depends on nothing but (seed, r).
   =========================================================================== */
import type { SimModule, RunMarks, OutcomeDef, SumRule, EntityDef } from '../../core/engine.ts';
import { streamFor, STREAM } from '../../core/prng.ts';
import { normalQuantile } from '../../core/normal.ts';
import {
  NhlLeague, NhlStandings, nhlRulesFor, playPostseason, resultCode,
  HOME_REG, HOME_OT, HOME_SO, AWAY_REG, AWAY_OT, AWAY_SO, type ObservedPlayoffGame, type ScheduledPlayoffGame, type GameGoals, type PlayoffGameSpec
} from './rules.ts';
import { OutcomeTable, tieSplit, offsetRates, drawRegScore, type RegProbs, type TieSplit } from './model_adapter.ts';
import { dayNum } from './history.ts';
import type { NhlInputData } from './inputs.ts';

export const NHL_OUTCOMES: OutcomeDef[] = [
  { key: 'win_division', label: 'Win division (regular season, D1)', category: 'division', provenance: 'Research' },
  { key: 'conference_best_record', label: 'Best regular-season record in the conference (top seed)', category: 'regular_season', provenance: 'Research' },
  { key: 'presidents_trophy', label: 'Presidents\' Trophy (best regular-season record)', category: 'regular_season', provenance: 'Research' },
  { key: 'make_playoffs', label: 'Make playoffs', category: 'playoffs', provenance: 'Research' },
  { key: 'bracket_d2', label: 'Division 2nd (D2)', category: 'seed', provenance: 'Research' },
  { key: 'bracket_d3', label: 'Division 3rd (D3)', category: 'seed', provenance: 'Research' },
  { key: 'bracket_wc1', label: 'First wild card (WC1)', category: 'seed', provenance: 'Research' },
  { key: 'bracket_wc2', label: 'Second wild card (WC2)', category: 'seed', provenance: 'Research' },
  { key: 'reach_round_2', label: 'Reach round 2', category: 'round', provenance: 'Research' },
  { key: 'reach_conference_final', label: 'Reach conference final', category: 'round', provenance: 'Research' },
  { key: 'win_conference', label: 'Win conference (playoffs: reach the Stanley Cup Final)', category: 'conference', provenance: 'Research' },
  { key: 'win_stanley_cup', label: 'Win the Stanley Cup', category: 'title', provenance: 'Research' }
];
export const NHL_SUM_RULES: SumRule[] = [
  { outcome: 'win_division', by: 'division', perGroup: 1 },
  { outcome: 'conference_best_record', by: 'conference', perGroup: 1 },
  { outcome: 'presidents_trophy', by: 'league', perGroup: 1 },
  { outcome: 'make_playoffs', by: 'conference', perGroup: 8 },
  { outcome: 'bracket_d2', by: 'division', perGroup: 1 },
  { outcome: 'bracket_d3', by: 'division', perGroup: 1 },
  { outcome: 'bracket_wc1', by: 'conference', perGroup: 1 },
  { outcome: 'bracket_wc2', by: 'conference', perGroup: 1 },
  { outcome: 'reach_round_2', by: 'conference', perGroup: 4 },
  { outcome: 'reach_conference_final', by: 'conference', perGroup: 2 },
  { outcome: 'win_conference', by: 'conference', perGroup: 1 },
  { outcome: 'win_stanley_cup', by: 'league', perGroup: 1 }
];

export interface GameProbs { reg: RegProbs; split: TieSplit }
export interface NhlModuleOptions {
  seed: bigint;
  /** override the snapshot's sigma (tests: 0 reproduces the model exactly) */
  sigma?: number;
  /** tests only: fixed probabilities for a game (regular season: its index; playoffs: 'playoff') */
  override?: (game: number | 'playoff', home: number, away: number) => GameProbs | null;
  /** tests only: sees every simulated game (never changes a result) */
  observe?: (ev: { run: number; phase: 'regular' | 'postseason'; game: number | string; home: number; away: number; offset: number; result: string }) => void;
}

export function nhlModule(data: NhlInputData, opt: NhlModuleOptions): SimModule & { table: OutcomeTable } {
  const rules = nhlRulesFor(data.season);
  const teams = data.teams;
  const ix: Record<string, number> = {}; teams.forEach((t, i) => { ix[t.code] = i; });
  const L = new NhlLeague(teams, data.games.map((g) => ({ home: ix[g.home], away: ix[g.away], day: dayNum(g.date) })));
  const base = new Int8Array(L.G).fill(-1);
  const baseGoals: GameGoals = { home: new Int16Array(L.G), away: new Int16Array(L.G) };
  const openIdx: number[] = [], lamH: number[] = [], lamA: number[] = [];
  data.games.forEach((g, k) => {
    if (g.done) { base[k] = resultCode(g.decided as string, (g.home_score as number) > (g.away_score as number)); baseGoals.home[k] = g.home_score as number; baseGoals.away[k] = g.away_score as number; }
    else { if (!g.model) throw new Error('remaining game ' + g.game_id + ' has no price'); openIdx.push(k); lamH.push(g.model.lam_home); lamA.push(g.model.lam_away); }
  });
  const sigma = opt.sigma != null ? opt.sigma : data.strength.sigma;
  if (!(sigma >= 0 && sigma < 0.5)) throw new Error('strength sigma out of range: ' + sigma);
  if (data.config.drift.mode !== 'off') throw new Error('within-season strength drift is not validated: config.drift.mode must be off');
  if (data.config.availability.mode !== 'confirmed_starters_only') throw new Error('availability: only confirmed starters with provenance are supported');
  const dp = data.model.dist;
  const table = new OutcomeTable(dp);
  const pairs = data.postseason_pairs;
  const observed: ObservedPlayoffGame[] = data.playoffs.filter((p) => p.done).map((p) => ({
    a: ix[p.home], b: ix[p.away], home: ix[p.home], winner: (p.home_score as number) > (p.away_score as number) ? ix[p.home] : ix[p.away], ot: p.decided === 'OT', day: dayNum(p.date)
  }));
  const scheduled: ScheduledPlayoffGame[] = data.playoffs.filter((p) => !p.done && p.game != null).map((p) => ({ a: ix[p.home], b: ix[p.away], home: ix[p.home], game: p.game as number }));
  const O: Record<string, number> = {}; NHL_OUTCOMES.forEach((o, i) => { O[o.key] = i; });
  const entities: EntityDef[] = teams.map((t) => ({ id: t.code, name: t.name, groups: { conference: t.conference, division: t.division } }));
  const N = data.config.regular_season_games_per_club;

  const offsets = new Float64Array(L.T);
  let clampedSeen = 0;
  const probsOf = (lh: number, la: number, exact: boolean, playoff: boolean): GameProbs => ({ reg: table.probs(lh, la, exact), split: tieSplit(dp, lh, la, playoff) });
  function runOne(run: number, marks: RunMarks): void {
    /* 1 persistent offsets */
    const rs = streamFor(opt.seed, run, STREAM.strength);
    for (let t = 0; t < L.T; t++) offsets[t] = sigma === 0 ? 0 : sigma * normalQuantile(rs.nextOpen());
    /* 2 the regular season */
    const rg = streamFor(opt.seed, run, STREAM.games);
    const results = base.slice();
    const rates = new Float64Array(2 * openIdx.length);
    let ties = 0, ots = 0, sos = 0;
    for (let j = 0; j < openIdx.length; j++) {
      const k = openIdx[j], h = L.gHome[k], a = L.gAway[k];
      const [lh, la] = offsetRates(lamH[j], lamA[j], offsets[h], offsets[a]);
      rates[2 * j] = lh; rates[2 * j + 1] = la;
      const p = (opt.override && opt.override(k, h, a)) || probsOf(lh, la, offsets[h] === offsets[a], false);
      const u = rg.nextDouble(), v = rg.nextDouble();
      let r: number;
      if (u < p.reg.home) r = HOME_REG;
      else if (u < p.reg.home + p.reg.away) r = AWAY_REG;
      else {
        ties++;
        const s = p.split;
        r = v < s.ot_home ? HOME_OT : v < s.ot_home + s.ot_away ? AWAY_OT : v < s.ot_home + s.ot_away + s.so_home ? HOME_SO : AWAY_SO;
        if (r === HOME_OT || r === AWAY_OT) ots++; else sos++;
      }
      results[k] = r;
      if (opt.observe) opt.observe({ run, phase: 'regular', game: k, home: h, away: a, offset: offsets[h] - offsets[a], result: ['HOME_REG', 'HOME_OT', 'HOME_SO', 'AWAY_REG', 'AWAY_OT', 'AWAY_SO'][r] });
    }
    marks.diag('regular:games', openIdx.length); marks.diag('regular:ties_at_60', ties); marks.diag('regular:overtime', ots); marks.diag('regular:shootout', sos);
    /* 3 standings; scores only when a tie reaches goal differential */
    const goals = (): GameGoals => {
      const rp = streamFor(opt.seed, run, STREAM.points);
      const g: GameGoals = { home: baseGoals.home.slice(), away: baseGoals.away.slice() };
      for (let j = 0; j < openIdx.length; j++) {
        const k = openIdx[j], r = results[k];
        const m = table.matrix(rates[2 * j], rates[2 * j + 1], offsets[L.gHome[k]] === offsets[L.gAway[k]]);
        const cls = r === HOME_REG ? 0 : r === AWAY_REG ? 1 : 2;
        const [h, a] = drawRegScore(m, cls as 0 | 1 | 2, rp.nextDouble());
        g.home[k] = h + (r === HOME_OT || r === HOME_SO ? 1 : 0); g.away[k] = a + (r === AWAY_OT || r === AWAY_SO ? 1 : 0);
      }
      marks.diag('points:drawn');
      return g;
    };
    const ctx = { rng: streamFor(opt.seed, run, STREAM.coin), diag: marks.diag, flag: marks.flag, trace: marks.trace };
    const st = new NhlStandings(L, rules, results, goals, ctx);
    for (let t = 0; t < L.T; t++) marks.value(t, st.pts[t]);
    const all = teams.map((_, i) => i);
    marks.mark(st.rankTop(all, 1, 'Presidents\' Trophy')[0], O.presidents_trophy);
    /* 4 the postseason */
    const rp = streamFor(opt.seed, run, STREAM.postseason), ro = streamFor(opt.seed, run, STREAM.overtime);
    const resolve = (g: PlayoffGameSpec) => {
      const hc = teams[g.home].code, ac = teams[g.away].code;
      const e = pairs[hc] && pairs[hc][ac];
      if (!e) throw new Error('no playoff pair ' + hc + '-' + ac);
      const [lh, la] = offsetRates(e[0], e[1], offsets[g.home], offsets[g.away]);
      const p = (opt.override && opt.override('playoff', g.home, g.away)) || probsOf(lh, la, offsets[g.home] === offsets[g.away], true);
      const u = rp.nextDouble();
      let winner: number, ot = false;
      if (u < p.reg.home) winner = g.home;
      else if (u < p.reg.home + p.reg.away) winner = g.away;
      else { ot = true; winner = ro.nextDouble() < p.split.ot_home / (p.split.ot_home + p.split.ot_away) ? g.home : g.away; marks.diag('postseason:overtime'); }
      marks.diag('postseason:games');
      if (opt.observe) opt.observe({ run, phase: 'postseason', game: 'r' + g.round + 'g' + g.game, home: g.home, away: g.away, offset: offsets[g.home] - offsets[g.away], result: (winner === g.home ? 'HOME' : 'AWAY') + (ot ? '_OT' : '_REG') });
      return { winner, ot };
    };
    const post = playPostseason(st, resolve, { observed, scheduled, diag: marks.diag });
    for (const b of post.brackets) {
      marks.mark(b.first, O.conference_best_record);
      for (const d of Object.keys(b.divisionTop)) {
        const [d1, d2, d3] = b.divisionTop[d];
        marks.mark(d1, O.win_division); marks.mark(d2, O.bracket_d2); marks.mark(d3, O.bracket_d3);
      }
      marks.mark(b.wildCards[0], O.bracket_wc1); marks.mark(b.wildCards[1], O.bracket_wc2);
      b.pos.forEach((_, t) => marks.mark(t, O.make_playoffs));
    }
    post.reached.round2.forEach((t) => marks.mark(t, O.reach_round_2));
    post.reached.conferenceFinal.forEach((t) => marks.mark(t, O.reach_conference_final));
    post.reached.final.forEach((t) => marks.mark(t, O.win_conference));
    marks.mark(post.champion, O.win_stanley_cup);
    if (table.clamped !== clampedSeen) { marks.diag('model:lambda_clamped', table.clamped - clampedSeen); clampedSeen = table.clamped; }
    if (marks.tracing) {
      marks.trace({ type: 'offsets', sigma, offsets: teams.map((t, i) => [t.code, Math.round(offsets[i] * 10000) / 10000]) });
      marks.trace({ type: 'standings', clubs: teams.map((t, i) => [t.code, st.pts[i], st.w[i], st.l[i], st.otl[i], st.rw[i], st.row[i]]) });
      marks.trace({ type: 'bracket', conferences: post.brackets.map((b) => ({ conference: b.conference, round1: b.round1.map(([x, y]) => teams[x].code + '-' + teams[y].code), top_division: b.topDivision })) });
      marks.trace({ type: 'series', series: post.series.map((s) => [s.round, teams[s.hi].code, teams[s.lo].code, teams[s.winner].code, s.games.length, s.games.filter((x) => x.observed).length]) });
    }
  }
  return {
    sport: 'nhl', competition: 'NHL', season: data.season_label,
    entities, outcomes: NHL_OUTCOMES, sumRules: NHL_SUM_RULES, valueBins: 2 * N + 1,
    value: { key: 'points', label: 'regular-season points', divisor: 1 },
    runOne, table
  };
}
