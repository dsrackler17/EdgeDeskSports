/* ===========================================================================
   ONE SIMULATED NBA SEASON, FROM THE SNAPSHOT.

   For run r (master seed fixed):
   1. Each club draws ONE strength offset d_t ~ Normal(0, sigma^2) (points of
      margin; sigma: the as-of point's calibrated value,
      simulator/data/nba_strength_uncertainty.json). It persists through every
      remaining game, the play-in and the playoffs of the run.
   2. Each tracked absence draws ONE return game from its distribution
      (availability.ts; the availability stream). From that game of his club
      on he is in the projected rotation; the shift of the game's mean is the
      served player model's (the subset table: minutes redistributed, impact
      from his own RAPM) through the served pricing path's own slopes.
   3. Completed games are fixed at their real scores. Every remaining game,
      in date order, is drawn from the served model at
      mu + d_home - d_away + availability shift: the winner with the model's
      exact P(home win) at that mean, then the margin from the model's final
      margin distribution given the winner (overtime included; no ties).
   4. Standings, division titles, the tiebreakers, places 1-15 (rules.ts).
   5. The play-in and the playoffs, game by game, with the same offsets and
      availability: completed postseason games are kept as played; a game on
      the schedule is priced from its real row; any other from the pair table
      (its Estimated round/game context). Series end at four wins; home court
      follows the regular-season record; the bracket is fixed.
   6. Every outcome the club achieved in the run is marked.

   Streams (core/prng.ts STREAM): strength, games (regular season),
   postseason, coin (random drawings), availability are separate, so a
   tiebreak or a return draw never shifts a game result, and the result of
   run r depends on nothing but (seed, r).
   =========================================================================== */
import type { SimModule, RunMarks, OutcomeDef, SumRule, EntityDef } from '../../core/engine.ts';
import { streamFor, STREAM } from '../../core/prng.ts';
import { normalQuantile } from '../../core/normal.ts';
import { AvailabilityPlan } from '../../core/hooks.ts';
import { League, Standings, seedConferences, playPostseason, rulesFor, type NbaGame, type PlayedGame, type PostseasonGameReq, type Round } from './rules.ts';
import { contextKey } from './postseason_context.ts';
import { NbaGameDist } from './game_dist.ts';
import type { NbaInputData, GameModel } from './inputs.ts';

export const PLACES = 15;
export const NBA_OUTCOMES: OutcomeDef[] = [
  { key: 'win_division', label: 'Win division (regular season)', category: 'division', provenance: 'Research' },
  ...Array.from({ length: PLACES }, (_, i): OutcomeDef => ({ key: 'finish_' + (i + 1), label: i === 0 ? 'Regular-season conference first place' : 'Finish ' + (i + 1) + ' in the conference (regular season)', category: 'seed', provenance: 'Research' })),
  { key: 'play_in', label: 'Play in the play-in tournament (places 7-10)', category: 'playoffs', provenance: 'Research' },
  { key: 'make_playoffs', label: 'Qualify for the playoffs (after the play-in)', category: 'playoffs', provenance: 'Research' },
  ...Array.from({ length: 8 }, (_, i): OutcomeDef => ({ key: 'seed_' + (i + 1), label: 'Playoff seed ' + (i + 1), category: 'seed', provenance: 'Research' })),
  { key: 'reach_conference_semifinals', label: 'Win the first round', category: 'round', provenance: 'Research' },
  { key: 'reach_conference_finals', label: 'Win the conference semifinals', category: 'round', provenance: 'Research' },
  { key: 'win_conference', label: 'Win the conference finals (conference playoff champion; reach the NBA Finals)', category: 'conference', provenance: 'Research' },
  { key: 'win_title', label: 'Win the NBA Finals (NBA champion)', category: 'title', provenance: 'Research' }
];
/** what each outcome settles on: two outcomes never share one, so no futures market can map to two */
export const NBA_OUTCOME_SEMANTICS: Record<string, string> = {
  win_division: 'regular_season_division_title',
  finish_1: 'regular_season_conference_first_place',
  ...Object.fromEntries(Array.from({ length: PLACES - 1 }, (_, i) => ['finish_' + (i + 2), 'regular_season_conference_place_' + (i + 2)])),
  play_in: 'play_in_tournament_participation',
  make_playoffs: 'playoff_qualification_after_play_in',
  ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['seed_' + (i + 1), 'playoff_seed_' + (i + 1) + '_after_play_in'])),
  reach_conference_semifinals: 'win_first_round_series',
  reach_conference_finals: 'win_conference_semifinal_series',
  win_conference: 'conference_playoff_championship',
  win_title: 'nba_championship'
};
export function nbaSumRules(playIn: boolean): SumRule[] {
  return [
    { outcome: 'win_division', by: 'division', perGroup: 1 },
    ...Array.from({ length: PLACES }, (_, i): SumRule => ({ outcome: 'finish_' + (i + 1), by: 'conference', perGroup: 1 })),
    { outcome: 'play_in', by: 'conference', perGroup: playIn ? 4 : 0 },
    { outcome: 'make_playoffs', by: 'conference', perGroup: 8 },
    ...Array.from({ length: 8 }, (_, i): SumRule => ({ outcome: 'seed_' + (i + 1), by: 'conference', perGroup: 1 })),
    { outcome: 'reach_conference_semifinals', by: 'conference', perGroup: 4 },
    { outcome: 'reach_conference_finals', by: 'conference', perGroup: 2 },
    { outcome: 'win_conference', by: 'conference', perGroup: 1 },
    { outcome: 'win_title', by: 'league', perGroup: 1 }
  ];
}

export interface NbaModuleOptions {
  seed: bigint;
  /** override the snapshot's sigma (tests: 0 reproduces the model exactly) */
  sigma?: number;
  /** tests only: replace every game's win probability (fixed-probability fixtures) */
  pHome?: (ev: { phase: 'regular' | 'postseason'; game: string; home: number; away: number; mu: number }) => number;
  /** tests only: sees every simulated game (never changes a result) */
  observe?: (ev: { run: number; phase: 'regular' | 'postseason'; game: string; round?: Round; game_no?: number; home: number; away: number; mu: number; avail_shift: number; margin: number; source?: string }) => void;
}

export function nbaModule(data: NbaInputData, opt: NbaModuleOptions): SimModule & { dist: NbaGameDist } {
  const rules = rulesFor(data.season);
  const teams = data.teams, T = teams.length;
  const ix: Record<string, number> = {}; teams.forEach((t, i) => { ix[t.code] = i; });
  const games: NbaGame[] = data.games.map((g) => ({ game_id: g.game_id, home: ix[g.home], away: ix[g.away], done: g.done, home_score: g.home_score, away_score: g.away_score }));
  const L = new League(teams, games);
  const base = new Int16Array(L.G);
  data.games.forEach((g, k) => { if (g.done) base[k] = (g.home_score as number) - (g.away_score as number); });
  /* the remaining games in date order (an availability return is counted in club games) */
  const open = data.games.map((g, k) => ({ g, k })).filter((x) => !x.g.done).sort((a, b) => (a.g.start_utc < b.g.start_utc ? -1 : a.g.start_utc > b.g.start_utc ? 1 : a.g.game_id < b.g.game_id ? -1 : 1));
  for (const x of open) if (!x.g.model) throw new Error('remaining game ' + x.g.game_id + ' has no model price');
  const sigma = opt.sigma != null ? opt.sigma : (data.strength ? data.strength.sigma_points : NaN);
  if (!(sigma >= 0 && sigma < 15)) throw new Error('strength sigma out of range or missing: ' + sigma + ' (simulator/data/nba_strength_uncertainty.json)');
  if (data.config.drift.mode !== 'off') throw new Error('within-season strength drift is not validated: config.drift.mode must be off');
  const dist = new NbaGameDist(data.model);
  /* postseason: observed games, scheduled rows by pairing */
  const observed: PlayedGame[] = data.postseason_rows.filter((g) => g.done).sort((a, b) => (a.start_utc < b.start_utc ? -1 : 1))
    .map((g) => ({ stage: g.stage, home: ix[g.home], away: ix[g.away], winner: (g.home_score as number) > (g.away_score as number) ? ix[g.home] : ix[g.away], game_id: g.game_id }));
  const rowsByPair = new Map<string, typeof data.postseason_rows>();
  for (const g of data.postseason_rows.slice().sort((a, b) => (a.start_utc < b.start_utc ? -1 : 1))) {
    const k = g.stage + '|' + [g.home, g.away].sort().join('|'); const a = rowsByPair.get(k); if (a) a.push(g); else rowsByPair.set(k, [g]);
  }
  /* availability */
  const av = data.availability;
  const tracked = teams.map((t) => (av.mode === 'return_hazards' && av.teams[t.code] ? av.teams[t.code].tracked : []));
  const subsets = teams.map((t) => av.teams[t.code] ? av.teams[t.code].subsets : { net: [0], full: [0] });
  const injuries = teams.flatMap((t, i) => tracked[i].map((x) => ({ player_id: t.code + ':' + x.player_id, team: t.code, dist: x.dist })));
  const O: Record<string, number> = {}; NBA_OUTCOMES.forEach((o, i) => { O[o.key] = i; });
  const entities: EntityDef[] = teams.map((t) => ({ id: t.code, name: t.name, groups: { conference: t.conference, division: t.division } }));
  const offsets = new Float64Array(T);
  const played = new Int32Array(T);

  function runOne(run: number, marks: RunMarks): void {
    const rs = streamFor(opt.seed, run, STREAM.strength);
    for (let t = 0; t < T; t++) offsets[t] = sigma === 0 ? 0 : sigma * normalQuantile(rs.nextOpen());
    const plan = new AvailabilityPlan(injuries, streamFor(opt.seed, run, STREAM.availability));
    const ret = tracked.map((list, t) => list.map((x) => plan.returnPeriod(teams[t].code + ':' + x.player_id) as number));
    played.fill(0);
    const mask = (t: number): number => { const j = played[t]; let m = 0; const r = ret[t]; for (let i = 0; i < r.length; i++) if (j >= r[i]) m |= 1 << i; return m; };
    const shiftOf = (m: GameModel, h: number, a: number): number => {
      if (av.mode !== 'return_hazards') return 0;
      const mh = mask(h), ma = mask(a);
      if (mh === 0 && ma === 0) return 0;
      const sh = subsets[h], sa = subsets[a];
      const dnh = sh.net[mh] - sh.net[0], dfh = sh.full[mh] - sh.full[0], dna = sa.net[ma] - sa.net[0], dfa = sa.full[ma] - sa.full[0];
      return m.s_plr * m.pace * (dnh - dna) / 100 + m.s_adj * m.pace * ((dnh - dfh) - (dna - dfa)) / 100;
    };
    /* the regular season */
    const rg = streamFor(opt.seed, run, STREAM.games);
    const margin = base.slice();
    for (const { g, k } of open) {
      const h = L.gHome[k], a = L.gAway[k];
      played[h]++; played[a]++;
      const m = g.model as GameModel, sft = shiftOf(m, h, a);
      const mu = m.mu + offsets[h] - offsets[a] + sft;
      const u1 = rg.nextOpen(), u2 = rg.nextOpen();
      const p = opt.pHome ? opt.pHome({ phase: 'regular', game: g.game_id, home: h, away: a, mu }) : dist.pHome(mu);
      margin[k] = dist.drawMargin(mu, u1 < p, u2);
      if (opt.observe) opt.observe({ run, phase: 'regular', game: g.game_id, home: h, away: a, mu, avail_shift: sft, margin: margin[k] });
    }
    /* standings */
    const ctx = { rng: streamFor(opt.seed, run, STREAM.coin), diag: marks.diag, flag: marks.flag, trace: marks.trace };
    const st = new Standings(L, margin, ctx, rules);
    st.decideDivisions();
    const cs = seedConferences(st);
    st.divisionWinners.forEach((t) => marks.mark(t, O.win_division));
    for (const c of cs) {
      c.places.forEach((t, i) => marks.mark(t, O['finish_' + (i + 1)]));
      c.playIn.forEach((t) => marks.mark(t, O.play_in));
    }
    for (let t = 0; t < T; t++) marks.value(t, 2 * st.w[t]);
    /* the postseason */
    const rp = streamFor(opt.seed, run, STREAM.postseason);
    const resolve = (q: PostseasonGameReq): number => {
      const hc = teams[q.home].code, ac = teams[q.away].code;
      const stage = q.round === 'play_in' ? 'play_in' : 'playoffs';
      const rows = rowsByPair.get(stage + '|' + [hc, ac].sort().join('|')) || [];
      const row = rows[q.round === 'play_in' ? 0 : q.game_no - 1];
      let m: GameModel, source: string;
      if (row && !row.done && row.home === hc && row.model) { m = row.model; source = 'scheduled'; marks.diag('postseason:scheduled_row'); }
      else {
        const e = data.postseason_pairs[contextKey(q.round, q.key, q.game_no)];
        const x = e && e[hc] && e[hc][ac];
        if (!x) throw new Error('no postseason pair ' + hc + '-' + ac + ' (' + contextKey(q.round, q.key, q.game_no) + ')');
        m = x; source = 'estimated_context'; marks.diag('postseason:estimated_context');
      }
      played[q.home]++; played[q.away]++;
      const sft = shiftOf(m, q.home, q.away);
      const mu = m.mu + offsets[q.home] - offsets[q.away] + sft;
      const u1 = rp.nextOpen(), u2 = rp.nextOpen();
      const p = opt.pHome ? opt.pHome({ phase: 'postseason', game: contextKey(q.round, q.key, q.game_no), home: q.home, away: q.away, mu }) : dist.pHome(mu);
      const mg = dist.drawMargin(mu, u1 < p, u2);
      if (opt.observe) opt.observe({ run, phase: 'postseason', game: contextKey(q.round, q.key, q.game_no), round: q.round, game_no: q.game_no, home: q.home, away: q.away, mu, avail_shift: sft, margin: mg, source });
      return mg > 0 ? q.home : q.away;
    };
    /* completed postseason games were played before the as-of time: they never move the return clock
       (a return period counts the club's games after the snapshot) */
    const post = playPostseason(st, cs, resolve, observed);
    post.seeds.forEach((s) => s.forEach((t, i) => { marks.mark(t, O.make_playoffs); marks.mark(t, O['seed_' + (i + 1)]); }));
    post.reached.conference_semifinals.forEach((t) => marks.mark(t, O.reach_conference_semifinals));
    post.reached.conference_finals.forEach((t) => marks.mark(t, O.reach_conference_finals));
    post.conferenceChampions.forEach((t) => marks.mark(t, O.win_conference));
    marks.mark(post.champion, O.win_title);
    if (marks.tracing) {
      marks.trace({ type: 'offsets', sigma, offsets: teams.map((t, i) => [t.code, Math.round(offsets[i] * 1000) / 1000]) });
      marks.trace({ type: 'returns', players: teams.flatMap((t, i) => tracked[i].map((x, j) => [t.code, x.player_id, Number.isFinite(ret[i][j]) ? ret[i][j] : null])) });
      marks.trace({ type: 'records', wins: teams.map((t, i) => [t.code, st.w[i], st.losses(i)]) });
      marks.trace({ type: 'places', East: cs[0].places.map((t) => teams[t].code), West: cs[1].places.map((t) => teams[t].code) });
      marks.trace({ type: 'play_in', games: post.playIn.map((g) => [g.conference, g.key, teams[g.home].code, teams[g.away].code, teams[g.winner].code, g.observed]) });
      marks.trace({ type: 'series', series: post.series.map((s) => [s.round, teams[s.high].code, teams[s.low].code, teams[s.winner].code, s.games.length, s.games.map((x) => teams[x.home].code + (x.winner === x.home ? 'W' : 'L')).join(' ')]) });
    }
  }
  return {
    sport: 'nba', competition: 'NBA', season: data.season_label,
    entities, outcomes: NBA_OUTCOMES, sumRules: nbaSumRules(rules.play_in), valueBins: 2 * data.config.regular_season_games_per_club + 1,
    runOne, dist
  };
}
