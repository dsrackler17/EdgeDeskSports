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
   3b The NBA Cup (cup.ts), in the same date order: after the last Cup Night,
      the Group Play standings (a simulated Group Play game's overtime and its
      regulation points drawn from the served model given its margin), the
      knockout field, the
      quarterfinals, the non-advancing clubs' games, the semifinals, the
      quarterfinal losers' games and the Championship. A Cup-dependent game
      the league has scheduled is played as it is; any other is a virtual game
      with its pairing from the run's own Cup (Estimated where the league
      publishes no rule) and its price from the snapshot's schedule-shaped
      rows. Every club ends with 82 regular-season games; the Championship
      counts in no standings.
   4. Standings, division titles, the tiebreakers, places 1-15 (rules.ts).
   5. The play-in and the playoffs, game by game, with the same offsets and
      availability: completed postseason games are kept as played; a game on
      the schedule is priced from its real row; any other from the pair table
      (its Estimated round/game context). Series end at four wins; home court
      follows the regular-season record; the bracket is fixed.
   6. Every outcome the club achieved in the run is marked.

   Streams (core/prng.ts STREAM): strength, games (regular season, the Cup's
   games included), postseason, coin (random drawings), availability, cup
   (overtime and regulation points of simulated Group Play games, the Cup's
   random drawings, the Estimated filler pairings)
   are separate, so a
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
import { cupStandings, quarterfinals, semifinalHost, losersGameHost, fillerGames, groupLabel, type CupStructure, type CupGameResult, type CupStandings } from './cup.ts';
import { CUP_SLOTS, type NbaInputData, type GameModel, type CupSlot } from './inputs.ts';

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
/** the NBA Cup's outcomes, for a season whose Cup the snapshot carries */
export const NBA_CUP_OUTCOMES: OutcomeDef[] = [
  { key: 'cup_win_group', label: 'Win its NBA Cup group', category: 'cup', provenance: 'Research' },
  { key: 'cup_knockout', label: 'Reach the NBA Cup Knockout Rounds (a group winner or the wild card)', category: 'cup', provenance: 'Research' },
  { key: 'cup_semifinal', label: 'Win an NBA Cup quarterfinal', category: 'cup', provenance: 'Research' },
  { key: 'cup_final', label: 'Win an NBA Cup semifinal (reach the Championship)', category: 'cup', provenance: 'Research' },
  { key: 'cup_champion', label: 'Win the NBA Cup', category: 'cup', provenance: 'Research' }
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
  win_title: 'nba_championship',
  cup_win_group: 'nba_cup_group_winner',
  cup_knockout: 'nba_cup_knockout_qualification',
  cup_semifinal: 'nba_cup_quarterfinal_win',
  cup_final: 'nba_cup_championship_appearance',
  cup_champion: 'nba_cup_champion'
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
export const NBA_CUP_SUM_RULES: SumRule[] = [
  { outcome: 'cup_win_group', by: 'cup_group', perGroup: 1 },
  { outcome: 'cup_knockout', by: 'conference', perGroup: 4 },
  { outcome: 'cup_semifinal', by: 'conference', perGroup: 2 },
  { outcome: 'cup_final', by: 'conference', perGroup: 1 },
  { outcome: 'cup_champion', by: 'league', perGroup: 1 }
];

export interface NbaModuleOptions {
  seed: bigint;
  /** override the snapshot's sigma (tests: 0 reproduces the model exactly) */
  sigma?: number;
  /** tests only: replace every game's win probability (fixed-probability fixtures) */
  pHome?: (ev: { phase: 'regular' | 'postseason'; game: string; home: number; away: number; mu: number }) => number;
  /** tests only: sees every simulated game (never changes a result) */
  observe?: (ev: { run: number; phase: 'regular' | 'postseason' | 'cup'; game: string; round?: Round; game_no?: number; home: number; away: number; mu: number; avail_shift: number; margin: number; source?: string }) => void;
}

/** the Cup as the module plays it: the structure, the posted games by pairing, the base schedule's pair counts */
interface CupPlan {
  st: CupStructure;
  groupK: number[];
  isGroup: Uint8Array;
  /** the Cup-dependent games on the schedule: game index by pairing key */
  postedByPair: Map<number, number>;
  postedPer: Int32Array; postedHome: Int32Array;
  /** posted games between two clubs that did not advance across conferences (per run they count against the two) */
  postedK: number[];
  /** base schedule (outside the window) games per pairing */
  basePair: Int32Array;
  prior: Array<[number, number]>;
  virtual: number;
  firstVirtual: number;
  slotMs: Record<CupSlot, number>;
}

export function nbaModule(data: NbaInputData, opt: NbaModuleOptions): SimModule & { dist: NbaGameDist } {
  const rules = rulesFor(data.season);
  const teams = data.teams, T = teams.length;
  const ix: Record<string, number> = {}; teams.forEach((t, i) => { ix[t.code] = i; });
  const games: NbaGame[] = data.games.map((g) => ({ game_id: g.game_id, home: ix[g.home], away: ix[g.away], done: g.done, home_score: g.home_score, away_score: g.away_score }));
  /* the NBA Cup: its virtual games take the last slots of the league's game list, their pairing set per run */
  const cupIn = data.cup || null;
  let cp: CupPlan | null = null;
  if (cupIn) {
    if (cupIn.error) throw new Error('the NBA Cup could not be read off the schedule: ' + cupIn.error);
    const kOf = new Map<string, number>(); data.games.forEach((g, k) => kOf.set(g.game_id, k));
    const groups = cupIn.groups.map((g) => g.map((c) => { if (ix[c] == null) throw new Error('unknown Cup club ' + c); return ix[c]; }));
    const groupOf = new Array(T).fill(-1); groups.forEach((g, i) => g.forEach((t) => { groupOf[t] = i; }));
    const st: CupStructure = { groups, groupOf, groupConf: groups.map((g) => (teams[g[0]].conference === 'East' ? 0 : 1)) };
    const groupK = cupIn.group_games.map((id) => { const k = kOf.get(id); if (k == null) throw new Error('Group Play game ' + id + ' is not on the schedule'); return k; });
    const isGroup = new Uint8Array(data.games.length); for (const k of groupK) isGroup[k] = 1;
    const postedByPair = new Map<number, number>(), postedPer = new Int32Array(T), postedHome = new Int32Array(T), postedK: number[] = [];
    for (const id of cupIn.posted) {
      const k = kOf.get(id); if (k == null) throw new Error('posted Cup game ' + id + ' is not on the schedule');
      const h = games[k].home, a = games[k].away, key = Math.min(h, a) * T + Math.max(h, a);
      if (postedByPair.has(key)) throw new Error('two posted Cup-dependent games between ' + teams[h].code + ' and ' + teams[a].code);
      postedByPair.set(key, k); postedPer[h]++; postedPer[a]++; postedHome[h]++; postedK.push(k);
    }
    const posted = new Set(cupIn.posted);
    const basePair = new Int32Array(T * T);
    data.games.forEach((g, k) => { if (posted.has(g.game_id)) return; const h = games[k].home, a = games[k].away; basePair[h * T + a]++; basePair[a * T + h]++; });
    const per = new Int32Array(T); data.games.forEach((_, k) => { per[games[k].home]++; per[games[k].away]++; });
    for (let t = 0; t < T; t++) if (per[t] - postedPer[t] !== data.config.regular_season_games_per_club - 2 || postedPer[t] > 2) throw new Error(teams[t].code + ': ' + (per[t] - postedPer[t]) + ' games outside the Cup window and ' + postedPer[t] + ' in it (80 and at most 2 expected)');
    const virtual = 30 - cupIn.posted.length;
    const firstVirtual = games.length;
    for (let i = 0; i < virtual; i++) games.push({ game_id: 'cup:virtual:' + i, home: 0, away: 1, done: false, home_score: null, away_score: null });
    const slotMs = Object.fromEntries(CUP_SLOTS.map((k) => [k, Date.parse(cupIn.slot_start[k])])) as Record<CupSlot, number>;
    const lastGroup = Math.max(...groupK.map((k) => Date.parse(data.games[k].start_utc)));
    if (!(lastGroup < slotMs.quarterfinal)) throw new Error('a Group Play game starts after the quarterfinals');
    cp = { st, groupK, isGroup, postedByPair, postedPer, postedHome, postedK, basePair, prior: teams.map((t) => cupIn.prior_record[t.code]), virtual, firstVirtual, slotMs };
  }
  const L = new League(teams, games);
  const base = new Int16Array(L.G);
  data.games.forEach((g, k) => { if (g.done) base[k] = (g.home_score as number) - (g.away_score as number); });
  /* the remaining games in date order (an availability return is counted in club games), the Cup's stages among them */
  const open = data.games.map((g, k) => ({ g, k })).filter((x) => !x.g.done).sort((a, b) => (a.g.start_utc < b.g.start_utc ? -1 : a.g.start_utc > b.g.start_utc ? 1 : a.g.game_id < b.g.game_id ? -1 : 1));
  for (const x of open) if (!x.g.model) throw new Error('remaining game ' + x.g.game_id + ' has no model price');
  type Step = { game: { g: typeof data.games[number]; k: number } } | { cup: CupSlot };
  const timeline: Step[] = open.map((x) => ({ game: x }));
  if (cp) {
    /* a stage runs before the first game that starts after it; stages keep their own order */
    const cpp = cp;
    for (const slot of CUP_SLOTS) {
      const at = timeline.findIndex((s) => 'game' in s && Date.parse(s.game.g.start_utc) > cpp.slotMs[slot]);
      timeline.splice(at < 0 ? timeline.length : at, 0, { cup: slot });
    }
    const order = timeline.filter((s) => 'cup' in s).map((s) => (s as { cup: CupSlot }).cup);
    if (order.join() !== CUP_SLOTS.join()) throw new Error('the Cup stages are out of order: ' + order.join());
  }
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
  const outcomes = cp ? NBA_OUTCOMES.concat(NBA_CUP_OUTCOMES) : NBA_OUTCOMES;
  const O: Record<string, number> = {}; outcomes.forEach((o, i) => { O[o.key] = i; });
  const cupGroupOf = (t: number): Record<string, string> => (cp ? { cup_group: groupLabel(cp.st, teams, cp.st.groupOf[t]) } : {});
  const entities: EntityDef[] = teams.map((t, i) => ({ id: t.code, name: t.name, groups: { conference: t.conference, division: t.division, ...cupGroupOf(i) } }));
  const otRun = new Uint8Array(data.games.length), regH = new Int16Array(data.games.length), regA = new Int16Array(data.games.length), regKnown = new Uint8Array(data.games.length);
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
    /* the regular season, the NBA Cup's stages in their date order */
    const rg = streamFor(opt.seed, run, STREAM.games);
    const rc = cp ? streamFor(opt.seed, run, STREAM.cup) : null;
    const margin = base.slice();
    const playGame = (k: number, h: number, a: number, m: GameModel, phase: 'regular' | 'cup', tag: string, source?: string): number => {
      played[h]++; played[a]++;
      const sft = shiftOf(m, h, a);
      const mu = m.mu + offsets[h] - offsets[a] + sft;
      const u1 = rg.nextOpen(), u2 = rg.nextOpen();
      const p = opt.pHome ? opt.pHome({ phase: 'regular', game: tag, home: h, away: a, mu }) : dist.pHome(mu);
      const mg = dist.drawMargin(mu, u1 < p, u2);
      if (k >= 0) {
        margin[k] = mg;
        if (cp && k < cp.isGroup.length && cp.isGroup[k]) {
          /* a simulated Group Play game: overtime given the margin, then its regulation points (the Cup's points step) */
          const rcx = rc!, uo = rcx.nextOpen(), up = rcx.nextOpen();
          otRun[k] = uo < dist.pOvertime(mu, mg) ? 1 : 0;
          const tot = data.cup!.group_totals && data.cup!.group_totals[L.games[k].game_id];
          if (tot) { const [ph, pa] = dist.regulationPoints(mu, mg, otRun[k] === 1, tot, up); regH[k] = ph; regA[k] = pa; regKnown[k] = 1; } else regKnown[k] = 0;
        }
      }
      if (opt.observe) opt.observe({ run, phase, game: tag, home: h, away: a, mu, avail_shift: sft, margin: mg, ...(source ? { source } : {}) });
      return mg;
    };
    /* the run's Cup */
    let cupSt: CupStandings | null = null, nextV = 0;
    const qfK: number[] = [], sfK: number[] = [], f2: Array<{ home: number; away: number }> = [];
    let champion = -1;
    const cupGame = (h: number, a: number, slot: CupSlot, phase: string): number => {
      const key = Math.min(h, a) * T + Math.max(h, a), pk = cp!.postedByPair.get(key);
      if (pk != null) { marks.diag('cup:' + phase + ':scheduled'); return pk; }
      if (nextV >= cp!.virtual) throw new Error('the run\'s Cup needs more games than the schedule leaves (' + phase + ' ' + teams[h].code + '-' + teams[a].code + ')');
      const k = cp!.firstVirtual + nextV++;
      L.setPair(k, h, a);
      const m = data.cup!.pairs[slot][teams[h].code] && data.cup!.pairs[slot][teams[h].code][teams[a].code];
      if (!m) throw new Error('no NBA Cup price for ' + teams[h].code + '-' + teams[a].code + ' (' + slot + ')');
      marks.diag('cup:' + phase + ':virtual');
      playGame(k, h, a, m, 'cup', 'cup|' + phase + '|' + teams[h].code + '|' + teams[a].code, slot);
      return k;
    };
    const winnerOf = (k: number): number => { if (margin[k] === 0) throw new Error('Cup game ' + L.games[k].game_id + ' has no result when its winner is needed'); return margin[k] > 0 ? L.gHome[k] : L.gAway[k]; };
    const stage = (slot: CupSlot): void => {
      const c = cp!, rcx = rc!;
      if (slot === 'quarterfinal') {
        const res: CupGameResult[] = c.groupK.map((k) => {
          const g = data.games[k], r = g.done ? data.cup!.group_results[g.game_id] : null;
          if (g.done && !r) throw new Error('completed Group Play game ' + g.game_id + ' has no regulation scores');
          if (margin[k] === 0) throw new Error('Group Play game ' + g.game_id + ' has no result at the quarterfinals');
          return { home: L.gHome[k], away: L.gAway[k], margin: margin[k], ot: r ? r.ot : otRun[k] === 1, regHome: r ? r.reg_home : regKnown[k] ? regH[k] : null, regAway: r ? r.reg_away : regKnown[k] ? regA[k] : null };
        });
        cupSt = cupStandings(c.st, T, res, c.prior, { rng: rcx, diag: marks.diag, flag: marks.flag });
        for (const q of quarterfinals(cupSt)) qfK.push(cupGame(q.home, q.away, 'quarterfinal', 'quarterfinal'));
      } else if (slot === 'filler_1') {
        const ko = new Set(cupSt!.seeds.flat());
        const need = new Array(T).fill(0), homeNeed = new Array(T).fill(0);
        for (let t = 0; t < T; t++) if (!ko.has(t)) { need[t] = 2 - c.postedPer[t]; homeNeed[t] = Math.max(0, 1 - c.postedHome[t]); }
        let crossPosted = 0;
        for (const k of c.postedK) { const h = L.gHome[k], a = L.gAway[k]; if (ko.has(h) || ko.has(a)) continue; if (L.conf[h] !== L.conf[a]) crossPosted++; }
        const fg = fillerGames({ others: cupSt!.places.map((p) => p.slice(4)), need, homeNeed, cross: Math.max(0, 2 - crossPosted),
          preferred: (a, b) => c.basePair[a * T + b] === 3, playing: (a, b) => c.postedByPair.has(Math.min(a, b) * T + Math.max(a, b)),
          km: (a, b) => { const [e, w] = L.conf[a] === 0 ? [a, b] : [b, a]; return data.cup!.cross_km[teams[e].code][teams[w].code]; },
          maxKm: data.cup!.format.cross_conference_max_km, rng: rcx, diag: marks.diag });
        for (const g of fg) { if (g.slot === 1) cupGame(g.home, g.away, 'filler_1', 'filler'); else f2.push(g); }
      } else if (slot === 'semifinal') {
        for (const cf of [0, 1]) {
          const w = qfK.filter((k) => L.conf[L.gHome[k]] === cf).map(winnerOf);
          const [h, a] = semifinalHost(cupSt!, cf, w[0], w[1]);
          sfK.push(cupGame(h, a, 'semifinal', 'semifinal'));
        }
      } else if (slot === 'filler_2') {
        for (const g of f2) cupGame(g.home, g.away, 'filler_2', 'filler');
        for (const cf of [0, 1]) {
          const qs = qfK.filter((k) => L.conf[L.gHome[k]] === cf);
          const ls = qs.map((k) => (winnerOf(k) === L.gHome[k] ? L.gAway[k] : L.gHome[k]));
          const hosted = (t: number) => qs.some((k) => L.gHome[k] === t);
          const [h, a] = losersGameHost(cupSt!, cf, ls[0], hosted(ls[0]), ls[1], hosted(ls[1]));
          cupGame(h, a, 'filler_2', 'losers');
        }
      } else {
        const e = winnerOf(sfK[0]), w = winnerOf(sfK[1]);
        const row = data.cup!.championship;
        if (row && (ix[row.home] === e || ix[row.home] === w) && (ix[row.away] === e || ix[row.away] === w)) {
          if (row.done) { champion = (row.home_score as number) > (row.away_score as number) ? ix[row.home] : ix[row.away]; marks.diag('cup:championship:observed'); }
          else { const mg = playGame(-1, ix[row.home], ix[row.away], row.model as GameModel, 'cup', 'cup|championship|' + row.game_id, 'scheduled'); champion = mg > 0 ? ix[row.home] : ix[row.away]; marks.diag('cup:championship:scheduled'); }
        } else {
          if (row) throw new Error('the scheduled NBA Cup Championship (' + row.away + ' at ' + row.home + ') is not the run\'s semifinal winners');
          const m = data.cup!.pairs.championship[teams[e].code] && data.cup!.pairs.championship[teams[e].code][teams[w].code];
          if (!m) throw new Error('no NBA Cup Championship price for ' + teams[e].code + '-' + teams[w].code);
          const mg = playGame(-1, e, w, m, 'cup', 'cup|championship|' + teams[e].code + '|' + teams[w].code, 'championship');
          champion = mg > 0 ? e : w; marks.diag('cup:championship:virtual');
        }
      }
    };
    for (const s of timeline) {
      if ('cup' in s) { stage(s.cup); continue; }
      const { g, k } = s.game;
      playGame(k, L.gHome[k], L.gAway[k], g.model as GameModel, 'regular', g.game_id);
    }
    if (cp) {
      if (nextV !== cp.virtual) throw new Error('the run\'s Cup used ' + nextV + ' of the ' + cp.virtual + ' games the schedule leaves');
      const cnt = new Int32Array(T); for (let k = 0; k < L.G; k++) { cnt[L.gHome[k]]++; cnt[L.gAway[k]]++; }
      for (let t = 0; t < T; t++) if (cnt[t] !== data.config.regular_season_games_per_club) throw new Error(teams[t].code + ' plays ' + cnt[t] + ' regular-season games in run ' + run);
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
    if (cp) {
      const c = cupSt as CupStandings | null;
      if (!c || champion < 0) throw new Error('the run\'s Cup did not finish');
      c.groupOrder.forEach((g) => marks.mark(g[0], O.cup_win_group));
      c.seeds.flat().forEach((t) => marks.mark(t, O.cup_knockout));
      qfK.forEach((k) => marks.mark(winnerOf(k), O.cup_semifinal));
      sfK.forEach((k) => marks.mark(winnerOf(k), O.cup_final));
      marks.mark(champion, O.cup_champion);
    }
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
      if (cp && cupSt) {
        const c = cupSt as CupStandings, g = (k: number) => teams[L.gAway[k]].code + '@' + teams[L.gHome[k]].code + ' ' + (margin[k] > 0 ? 'H' : 'A') + Math.abs(margin[k]);
        marks.trace({ type: 'cup', seeds: c.seeds.map((x) => x.map((t) => teams[t].code)), quarterfinals: qfK.map(g), semifinals: sfK.map(g), champion: teams[champion].code,
          virtual: Array.from({ length: cp.virtual }, (_, i) => g(cp!.firstVirtual + i)) });
      }
      marks.trace({ type: 'returns', players: teams.flatMap((t, i) => tracked[i].map((x, j) => [t.code, x.player_id, Number.isFinite(ret[i][j]) ? ret[i][j] : null])) });
      marks.trace({ type: 'records', wins: teams.map((t, i) => [t.code, st.w[i], st.losses(i)]) });
      marks.trace({ type: 'places', East: cs[0].places.map((t) => teams[t].code), West: cs[1].places.map((t) => teams[t].code) });
      marks.trace({ type: 'play_in', games: post.playIn.map((g) => [g.conference, g.key, teams[g.home].code, teams[g.away].code, teams[g.winner].code, g.observed]) });
      marks.trace({ type: 'series', series: post.series.map((s) => [s.round, teams[s.high].code, teams[s.low].code, teams[s.winner].code, s.games.length, s.games.map((x) => teams[x.home].code + (x.winner === x.home ? 'W' : 'L')).join(' ')]) });
    }
  }
  return {
    sport: 'nba', competition: 'NBA', season: data.season_label,
    entities, outcomes, sumRules: nbaSumRules(rules.play_in).concat(cp ? NBA_CUP_SUM_RULES : []), valueBins: 2 * data.config.regular_season_games_per_club + 1,
    runOne, dist
  };
}
