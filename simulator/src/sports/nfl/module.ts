/* ===========================================================================
   ONE SIMULATED NFL SEASON, FROM THE SNAPSHOT.

   For run r (master seed fixed):
   1. Each club draws ONE strength offset d_t ~ Normal(0, sigma^2) (sigma: the
      as-of week's calibrated value, simulator/data/nfl_strength_uncertainty.json).
      It persists through every remaining game AND the postseason of the run.
   2. Completed games are fixed at their real scores. Every remaining game is
      drawn from the served model's distribution at fair + d_home - d_away
      (model_adapter.ts): a win, a loss or the model's own tie mass.
   3. Standings, the division and wild card tiebreakers and the seeds
      (rules.ts). A tie that reaches the points rankings draws scores from the
      Estimated points model (points_model.ts); one that reaches net
      touchdowns, an input no model here produces, is flagged and resolved by
      the seeded coin toss — and counted.
   4. The postseason, game by game, from the postseason pair table with the
      same offsets. A postseason game cannot end tied: a draw of the model's
      tie mass is resolved by a fair seeded draw, the convention of the
      model's own two-way win probability (P(win) + P(tie)/2).
   5. Every outcome the club achieved in the run is marked.

   Streams (core/prng.ts STREAM): strength, games, postseason, coin, overtime
   and points are separate, so drawing (or not drawing) scores never shifts a
   game result, and the result of run r depends on nothing but (seed, r).
   =========================================================================== */
import type { SimModule, RunMarks, OutcomeDef, SumRule, EntityDef } from '../../core/engine.ts';
import { streamFor, STREAM } from '../../core/prng.ts';
import { normalQuantile } from '../../core/normal.ts';
import { League, Standings, seedConferences, playPostseason, rulesFor, NFL_TB_2020, type NflGame, type PlayoffGame, type RulesVersion } from './rules.ts';
import { MarginCache, drawMargin, withMarginTable } from './model_adapter.ts';
import { PointsModel } from './points_model.ts';
import type { NflInputData } from './inputs.ts';

/* The outcome list and the per-run sum rules follow the rules version: 7
   seeds per conference since 2020, 6 before (the backtest replays both). */
const seedNumbers = (r: RulesVersion) => Array.from({ length: r.playoff_clubs_per_conference }, (_, i) => i + 1);
export function nflOutcomes(r: RulesVersion): OutcomeDef[] {
  return [
    { key: 'make_playoffs', label: 'Make playoffs', category: 'playoffs', provenance: 'Research' },
    { key: 'win_division', label: 'Win division', category: 'division', provenance: 'Research' },
    ...seedNumbers(r).map((k): OutcomeDef => ({ key: 'seed_' + k, label: 'Seed ' + k + (k <= r.byes_per_conference ? ' (bye)' : ''), category: 'seed', provenance: 'Research' })),
    { key: 'reach_divisional', label: 'Reach divisional round', category: 'round', provenance: 'Research' },
    { key: 'reach_conference_final', label: 'Reach conference championship', category: 'round', provenance: 'Research' },
    { key: 'win_conference', label: 'Win conference (reach Super Bowl)', category: 'conference', provenance: 'Research' },
    { key: 'win_super_bowl', label: 'Win Super Bowl', category: 'title', provenance: 'Research' }
  ];
}
export function nflSumRules(r: RulesVersion): SumRule[] {
  return [
    { outcome: 'win_division', by: 'division', perGroup: 1 },
    { outcome: 'make_playoffs', by: 'conference', perGroup: r.playoff_clubs_per_conference },
    ...seedNumbers(r).map((k): SumRule => ({ outcome: 'seed_' + k, by: 'conference', perGroup: 1 })),
    { outcome: 'reach_divisional', by: 'conference', perGroup: 4 },
    { outcome: 'reach_conference_final', by: 'conference', perGroup: 2 },
    { outcome: 'win_conference', by: 'conference', perGroup: 1 },
    { outcome: 'win_super_bowl', by: 'league', perGroup: 1 }
  ];
}
export const NFL_OUTCOMES: OutcomeDef[] = nflOutcomes(NFL_TB_2020);
export const NFL_SUM_RULES: SumRule[] = nflSumRules(NFL_TB_2020);

export interface NflModuleOptions {
  seed: bigint;
  /** override the snapshot's sigma (tests: 0 reproduces the model exactly) */
  sigma?: number;
  /** override every remaining game's model (tests: fixed-probability fixtures) */
  gameDist?: (g: number, centre: number, offset: number) => { cdf: Float64Array };
  /** tests only: sees every simulated game's draw (never changes a result) */
  observe?: (ev: { run: number; phase: 'regular' | 'postseason'; game: number | string; home: number; away: number; offset: number; margin: number }) => void;
}

export function nflModule(data: NflInputData, opt: NflModuleOptions): SimModule & { cache: MarginCache; restore: () => void } {
  const rules = rulesFor(data.season);
  const teams = data.teams;
  const ix: Record<string, number> = {}; teams.forEach((t, i) => { ix[t.code] = i; });
  const games: NflGame[] = data.games.map((g) => ({ game_id: g.game_id, week: g.week, home: ix[g.home], away: ix[g.away], done: g.done,
    home_score: g.home_score, away_score: g.away_score, home_td: null, away_td: null }));
  const L = new League(teams, games);
  const openIdx: number[] = [], fair: number[] = [], total: number[] = [];
  data.games.forEach((g, k) => { if (!g.done) { openIdx.push(k); fair.push((g.model as any).fair_margin); total.push((g.model as any).fair_total); } });
  const baseMargin = new Int16Array(L.G);
  data.games.forEach((g, k) => { if (g.done) baseMargin[k] = (g.home_score as number) - (g.away_score as number); });
  const sigma = opt.sigma != null ? opt.sigma : data.strength.sigma_points;
  if (!(sigma >= 0 && sigma < 20)) throw new Error('strength sigma out of range: ' + sigma);
  const restore = withMarginTable(data.model.margin_pmf_by_spread);
  const cache = new MarginCache();
  /* the Estimated scores for points-ranking tiebreaks; a backtest without a
     point-in-time points model passes null, and such a tie is then flagged
     unsupported and resolved by the seeded coin toss */
  const points = data.points_model ? new PointsModel(data.points_model.live) : null;
  const pairs = data.postseason_pairs;
  const sbHome = data.config.super_bowl.value.designated_home;
  const outcomes = nflOutcomes(rules), sumRules = nflSumRules(rules);
  const O: Record<string, number> = {}; outcomes.forEach((o, i) => { O[o.key] = i; });
  const entities: EntityDef[] = teams.map((t) => ({ id: t.code, name: t.name, groups: { conference: t.conference, division: t.division } }));
  if (data.config.drift.mode !== 'off') throw new Error('within-season strength drift is not validated: config.drift.mode must be off');
  if (data.config.availability.mode !== 'off') throw new Error('availability sampling is not supported for the NFL: config.availability.mode must be off');

  const offsets = new Float64Array(L.T);
  function runOne(run: number, marks: RunMarks): void {
    /* 1 persistent offsets */
    const rs = streamFor(opt.seed, run, STREAM.strength);
    for (let t = 0; t < L.T; t++) offsets[t] = sigma === 0 ? 0 : sigma * normalQuantile(rs.nextOpen());
    /* 2 the regular season */
    const rg = streamFor(opt.seed, run, STREAM.games);
    const margin = baseMargin.slice();
    for (let j = 0; j < openIdx.length; j++) {
      const k = openIdx[j], d = offsets[L.gHome[k]] - offsets[L.gAway[k]];
      const dist = opt.gameDist ? opt.gameDist(k, fair[j], d) : cache.at(fair[j], d);
      margin[k] = drawMargin(dist as any, rg.nextOpen());
      if (opt.observe) opt.observe({ run, phase: 'regular', game: k, home: L.gHome[k], away: L.gAway[k], offset: d, margin: margin[k] });
    }
    /* 3 standings, tiebreakers, seeds */
    let pts: { home: Int16Array; away: Int16Array } | null | undefined;
    const pointsFn = () => {
      if (pts !== undefined) return pts;
      if (!points) { pts = null; marks.diag('points:no_model'); return null; }
      const rp = streamFor(opt.seed, run, STREAM.points);
      const home = new Int16Array(L.G), away = new Int16Array(L.G);
      data.games.forEach((g, k) => { if (g.done) { home[k] = g.home_score as number; away[k] = g.away_score as number; } });
      for (let j = 0; j < openIdx.length; j++) {
        const k = openIdx[j], d = offsets[L.gHome[k]] - offsets[L.gAway[k]];
        const s = points.drawGivenMargin(fair[j] + d, total[j], margin[k], rp);
        if (!s) { pts = null; marks.diag('points:unavailable'); return null; }
        home[k] = s[0]; away[k] = s[1];
      }
      marks.diag('points:drawn');
      pts = { home, away };
      return pts;
    };
    const ctx = { rng: streamFor(opt.seed, run, STREAM.coin), diag: marks.diag, flag: marks.flag, trace: marks.trace };
    const st = new Standings(L, { margin, points: pointsFn, touchdowns: () => null }, ctx);
    const seeds = seedConferences(st, rules);
    for (const c of seeds) {
      c.divisionWinners.forEach((t) => marks.mark(t, O.win_division));
      c.seeds.forEach((t, k) => { marks.mark(t, O.make_playoffs); marks.mark(t, O['seed_' + (k + 1)]); });
    }
    for (let t = 0; t < L.T; t++) marks.value(t, st.w2[t]);
    /* 4 the postseason */
    const rp = streamFor(opt.seed, run, STREAM.postseason), ro = streamFor(opt.seed, run, STREAM.overtime);
    const resolve = (g: PlayoffGame): number => {
      const hc = teams[g.home].code, ac = teams[g.away].code;
      const tab = g.round === 'super_bowl' ? pairs.super_bowl : (g.round === 'divisional' && g.homeBye ? pairs.home_off_bye : pairs.default);
      const e = tab[hc] && tab[hc][ac];
      if (!e) throw new Error('no postseason pair ' + hc + '-' + ac + ' (' + g.round + ')');
      const d = offsets[g.home] - offsets[g.away];
      const m = drawMargin(cache.at(e.m, d), rp.nextOpen());
      if (opt.observe) opt.observe({ run, phase: 'postseason', game: g.round, home: g.home, away: g.away, offset: d, margin: m });
      if (m !== 0) return m > 0 ? g.home : g.away;
      marks.diag('postseason:tie_mass_resolved');
      const w = ro.nextDouble() < 0.5 ? g.home : g.away;
      marks.trace({ type: 'postseason_tie_mass', round: g.round, home: hc, away: ac, winner: teams[w].code });
      return w;
    };
    const post = playPostseason(seeds, rules, resolve, sbHome);
    post.reached.divisional.forEach((t) => marks.mark(t, O.reach_divisional));
    post.reached.conference.forEach((t) => marks.mark(t, O.reach_conference_final));
    post.conferenceChampions.forEach((t) => marks.mark(t, O.win_conference));
    marks.mark(post.champion, O.win_super_bowl);
    if (marks.tracing) {
      marks.trace({ type: 'offsets', sigma, offsets: teams.map((t, i) => [t.code, Math.round(offsets[i] * 1000) / 1000]) });
      marks.trace({ type: 'records', w2: teams.map((t, i) => [t.code, st.w2[i]]) });
      marks.trace({ type: 'seeds', AFC: seeds[0].seeds.map((t) => teams[t].code), NFC: seeds[1].seeds.map((t) => teams[t].code) });
      marks.trace({ type: 'postseason', games: post.games.map((g) => [g.round, teams[g.home].code, teams[g.away].code, teams[g.winner].code]) });
    }
  }
  return {
    sport: 'nfl', competition: 'NFL', season: String(data.season),
    entities, outcomes, sumRules, valueBins: 2 * data.config.regular_season_games_per_club + 1,
    runOne, cache, restore
  };
}
