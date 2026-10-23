/* ===========================================================================
   ONE SIMULATED MLB SEASON AND POSTSEASON, FROM THE SNAPSHOT.

   For run r (master seed fixed):
   1. Persistent offsets, drawn once and kept through the regular season AND
      the postseason: theta_t ~ Normal(0, sigma_team^2) per club and
      phi_p ~ Normal(0, sigma_sp^2) per named starter (log runs; calibrated
      in simulator/data/mlb_strength_uncertainty.json).
   2. Rotations: each club's as-of rotation, with each member's departure
      drawn from the measured survival curve (rotation.ts).
   3. Completed games are fixed at their real results. Every remaining
      regular-season game, in date and doubleheader order: the two starters
      (Confirmed where announced, else Projected by the rotation rule with
      the measured spot-start probability), the served model's lambdas moved
      by the offsets, the served win probability recal(P(H > A) + P(level) *
      xi) with the season's xi (the rule in force: the automatic runner),
      one draw. A game never ends tied.
   4. Standings, the tiebreak procedure, division winners and seeds
      (rules.ts).
   5. The postseason, game by game, through the season's bracket and
      series lengths (2-2-1, 2-3-2, the Wild Card Series at the higher seed):
      a completed postseason game is fixed at its result; a scheduled one is
      dated by the schedule, otherwise by the Estimated calendar; starters
      come from the postseason rule on the same rest clock that ran through
      the regular season and every earlier round; a level draw resolves at
      xi_postseason, the home rate measured on extra-inning games played
      under the standard rule (no automatic runner in the postseason).
   6. Every outcome each club achieved is marked.

   Streams (core/prng.ts STREAM): strength (theta), pitcher (phi), rotation
   (departures, spot starts), games, postseason and coin are separate, so a
   change in one never shifts another, and run r depends on (seed, r) only.
   =========================================================================== */
import type { SimModule, RunMarks, OutcomeDef, SumRule, EntityDef } from '../../core/engine.ts';
import { streamFor, STREAM } from '../../core/prng.ts';
import { normalQuantile } from '../../core/normal.ts';
import { Season, Standings, qualify, playPostseason, type RegGame, type SeriesSpec } from './rules.ts';
import type { MlbFormat, Round } from './config.ts';
import { WinTable, calibratedHome } from './model_adapter.ts';
import { RotationState, drawDepartures, projectRegular, projectPostseason, postseasonRotation, recordStart, REPLACEMENT, type GameKind } from './rotation.ts';
import { dayOf } from './history.ts';
import type { MlbInputData, MlbInputGame } from './inputs.ts';

export function mlbOutcomes(f: MlbFormat): OutcomeDef[] {
  const seeds = Array.from({ length: f.playoff_clubs_per_league }, (_, i) => i + 1);
  return [
    { key: 'make_playoffs', label: 'Make postseason', category: 'playoffs', provenance: 'Research' },
    { key: 'win_division', label: 'Win division', category: 'division', provenance: 'Research' },
    ...seeds.map((k): OutcomeDef => ({ key: 'seed_' + k, label: 'Seed ' + k + (k <= f.byes_per_league ? ' (bye)' : ''), category: 'seed', provenance: 'Research' })),
    { key: 'bye', label: 'First-round bye', category: 'seed', provenance: 'Research' },
    { key: 'reach_division_series', label: 'Reach Division Series', category: 'round', provenance: 'Research' },
    { key: 'reach_lcs', label: 'Reach League Championship Series', category: 'round', provenance: 'Research' },
    { key: 'win_pennant', label: 'Win pennant (reach World Series)', category: 'conference', provenance: 'Research' },
    { key: 'win_world_series', label: 'Win World Series', category: 'title', provenance: 'Research' }
  ];
}
/* groups: mlb_league (AL / NL) and division; 'league' in a sum rule is the engine's word for every entity */
export function mlbSumRules(f: MlbFormat): SumRule[] {
  return [
    { outcome: 'win_division', by: 'division', perGroup: 1 },
    { outcome: 'make_playoffs', by: 'mlb_league', perGroup: f.playoff_clubs_per_league },
    ...Array.from({ length: f.playoff_clubs_per_league }, (_, i): SumRule => ({ outcome: 'seed_' + (i + 1), by: 'mlb_league', perGroup: 1 })),
    { outcome: 'bye', by: 'mlb_league', perGroup: f.byes_per_league },
    { outcome: 'reach_division_series', by: 'mlb_league', perGroup: 4 },
    { outcome: 'reach_lcs', by: 'mlb_league', perGroup: 2 },
    { outcome: 'win_pennant', by: 'mlb_league', perGroup: 1 },
    { outcome: 'win_world_series', by: 'league', perGroup: 1 }
  ];
}

export interface MlbModuleOptions {
  seed: bigint;
  /** override the snapshot's sigmas (tests: 0 reproduces the frozen model exactly) */
  sigma?: number; sigmaSp?: number;
  /** tests only: sees every simulated game (never changes a result) */
  observe?: (ev: { run: number; phase: 'regular' | 'postseason'; game: string; date: string; home: string; away: string; sp_home: string; sp_away: string; label_home: string; label_away: string; p_home: number; winner: string; short_rest: boolean[] }) => void;
  /** tests only: replace the served win probability (fixed-probability fixtures) */
  pHome?: (ctx: { phase: 'regular' | 'postseason'; home: string; away: string; p: number }) => number;
  /** keep the starter distribution of the next N regular-season games per club (default 3) */
  starterHorizon?: number;
}

const kindOf = (g: MlbInputGame): GameKind => (g.game_no === 1 ? 'dh1' : g.game_no === 2 ? 'dh2' : 'single');

export function mlbModule(data: MlbInputData, opt: MlbModuleOptions): SimModule {
  const fmt = data.format;
  if (fmt.id !== 'MLB-2022') throw new Error('the MLB module simulates the MLB-2022 format (2022 onward); ' + fmt.id + ' needs tiebreaker games');
  if (data.config.drift.mode !== 'off') throw new Error('within-season strength drift is not validated: config.drift.mode must be off');
  if (data.config.availability.mode !== 'off') throw new Error('availability sampling is not supported for MLB: config.availability.mode must be off');
  if (data.config.bullpen.mode !== 'off') throw new Error('bullpen usage is not modelled (no owned bullpen data): config.bullpen.mode must be off');
  const teams = data.teams, T = teams.length;
  const ix: Record<string, number> = {}; teams.forEach((t, i) => { ix[t.code] = i; });
  const reg = data.games.filter((g) => g.phase === 'regular');
  const S = new Season(teams, reg.map((g): RegGame => ({ home: ix[g.home], away: ix[g.away], day: dayOf(g.date), game_no: g.game_no })));
  const baseWin = new Int8Array(S.G);
  reg.forEach((g, k) => { if (g.status === 'final') baseWin[k] = (g.home_score as number) > (g.away_score as number) ? 1 : (g.home_score as number) < (g.away_score as number) ? -1 : 0; });
  const lastRegDay = dayOf(data.last_regular_date);
  const open = reg.map((g, k) => k).filter((k) => reg[k].status !== 'final');
  const openDay = Int32Array.from(open.map((k) => (reg[k].date_estimated ? lastRegDay + 1 : dayOf(reg[k].date))));
  const order = open.map((_, j) => j).sort((a, b) => openDay[a] - openDay[b] || reg[open[a]].game_no - reg[open[b]].game_no || (reg[open[a]].id < reg[open[b]].id ? -1 : 1));

  /* the model */
  const M = data.model.state, cal = data.model.calibration;
  const tab = new WinTable(cal.r);
  const base = (h: number, a: number): [number, number] => {
    const th = M.teams[teams[h].code] || { o: 0, d: 0, k: 0 }, ta = M.teams[teams[a].code] || { o: 0, d: 0, k: 0 };
    return [M.mu + M.home + th.o - ta.d + th.k, M.mu + ta.o - th.d + th.k];
  };
  const sOf = (id: string) => (M.pitchers[id] != null ? M.pitchers[id] : 0);
  const sigma = opt.sigma != null ? opt.sigma : data.strength.sigma_team;
  const sigmaSp = opt.sigmaSp != null ? opt.sigmaSp : data.strength.sigma_sp;
  if (!(sigma >= 0 && sigma < 1) || !(sigmaSp >= 0 && sigmaSp < 1)) throw new Error('strength sigma out of range: ' + sigma + ' / ' + sigmaSp);
  const xiReg = cal.xi, xiPost = data.model.xi_postseason, recal = cal.recal, sRepl = data.model.replacement_s;
  const P = data.rotation.params;

  /* named starters: every rotation member and every announced or observed starter of a game still to be played */
  const named = new Set<string>();
  for (const c of Object.values(data.rotation.clubs)) c.members.forEach((m) => named.add(m));
  for (const g of data.games) if (g.status !== 'final') for (const s of [g.starters.home, g.starters.away]) if (s) named.add(s.id);
  const pitchers = [...named].sort(); const pix: Record<string, number> = {}; pitchers.forEach((p, i) => { pix[p] = i; });
  const phi = new Float64Array(pitchers.length);

  /* rotations */
  const rot = teams.map((t) => { const c = data.rotation.clubs[t.code] || { members: [], last_start: [], s: [] }; const last = c.last_start.map((d) => dayOf(d)); return { st: new RotationState(c.members, c.s, last), last0: Float64Array.from(last) }; });
  const memberPhi = (t: number, slot: number) => phi[pix[rot[t].st.ids[slot]]];

  /* the postseason games the snapshot knows: completed (fixed) and scheduled (dated, maybe with confirmed starters) */
  const pairKey = (round: string, a: string, b: string, k: number) => round + '|' + (a < b ? a + '-' + b : b + '-' + a) + '|' + k;
  const known = new Map<string, MlbInputGame>();
  for (const g of data.games) if (g.phase === 'postseason') known.set(pairKey(g.round as string, g.home, g.away, g.series_game as number), g);
  const tmpl = data.postseason_calendar.template;
  const templateDay = (round: Round, league: string, k: number): number => {
    const arr = round === 'WC' ? tmpl.WC : round === 'WS' ? tmpl.WS : (tmpl[round] as any)[league];
    return lastRegDay + arr[Math.min(k, arr.length) - 1];
  };

  const outcomes = mlbOutcomes(fmt), sumRules = mlbSumRules(fmt);
  const O: Record<string, number> = {}; outcomes.forEach((o, i) => { O[o.key] = i; });
  const entities: EntityDef[] = teams.map((t) => ({ id: t.code, name: t.name, groups: { mlb_league: t.league, division: t.division } }));
  const horizon = opt.starterHorizon != null ? opt.starterHorizon : 3;
  const watchReg = new Set<number>();
  { const seen = new Array(T).fill(0); for (const j of order) { const g = reg[open[j]]; const h = ix[g.home], a = ix[g.away]; if (seen[h] < horizon || seen[a] < horizon) watchReg.add(j); seen[h]++; seen[a]++; } }
  const maxGames = Math.max(...teams.map((_, t) => reg.filter((g) => ix[g.home] === t || ix[g.away] === t).length));

  const theta = new Float64Array(T), out = new Float64Array(2);
  function runOne(run: number, marks: RunMarks): void {
    /* 1 persistent offsets */
    const rs = streamFor(opt.seed, run, STREAM.strength), rpz = streamFor(opt.seed, run, STREAM.pitcher);
    for (let t = 0; t < T; t++) theta[t] = sigma === 0 ? 0 : sigma * normalQuantile(rs.nextOpen());
    for (let i = 0; i < phi.length; i++) phi[i] = sigmaSp === 0 ? 0 : sigmaSp * normalQuantile(rpz.nextOpen());
    /* 2 rotations */
    const rr = streamFor(opt.seed, run, STREAM.rotation);
    for (const x of rot) { x.st.reset(x.last0); drawDepartures(x.st, P, rr); }
    const price = (h: number, a: number, sH: number, fH: number, sA: number, fA: number, xi: number, phase: 'regular' | 'postseason'): number => {
      const [bh, ba] = base(h, a), dth = (theta[h] - theta[a]) / 2;
      tab.at(Math.exp(bh + dth - sA - fA), Math.exp(ba - dth - sH - fH), out);
      const p = calibratedHome(out[0], out[1], xi, recal);
      return opt.pHome ? opt.pHome({ phase, home: teams[h].code, away: teams[a].code, p }) : p;
    };
    /* one club's starter for a game still to be played */
    const starter = (t: number, g: MlbInputGame | null, side: 'home' | 'away', day: number, phase: 'regular' | 'postseason', kind: GameKind) => {
      const x = rot[t].st;
      const conf = g ? g.starters[side] : null;
      if (conf) {
        const slot = x.slotOf(conf.id); recordStart(x, slot, day);
        return { id: conf.id, s: sOf(conf.id), f: phi[pix[conf.id]] || 0, label: 'Confirmed', short: false };
      }
      if (phase === 'regular') {
        const slot = projectRegular(x, day, kind, P, rr);
        if (slot === REPLACEMENT) { marks.diag('regular:replacement_starts'); return { id: 'REPLACEMENT', s: sRepl, f: 0, label: 'Projected', short: false }; }
        return { id: x.ids[slot], s: x.s[slot], f: memberPhi(t, slot), label: 'Projected', short: false };
      }
      const pr = postRot[t] || (postRot[t] = postseasonRotation(x, P));
      const pick = projectPostseason(x, pr, day, P, rr);
      if (pick.slot === REPLACEMENT) { marks.diag('postseason:replacement_starts'); return { id: 'REPLACEMENT', s: sRepl, f: 0, label: 'Projected', short: false }; }
      if (pick.short) marks.diag('postseason:short_rest_starts');
      return { id: x.ids[pick.slot], s: x.s[pick.slot], f: memberPhi(t, pick.slot), label: 'Projected', short: pick.short };
    };
    const postRot: Array<number[] | undefined> = new Array(T);

    /* 3 the regular season */
    const rg = streamFor(opt.seed, run, STREAM.games);
    const win = baseWin.slice();
    for (const j of order) {
      const k = open[j], g = reg[k], h = S.gHome[k], a = S.gAway[k], day = openDay[j], kind = kindOf(g);
      const sh = starter(h, g, 'home', day, 'regular', kind), sa = starter(a, g, 'away', day, 'regular', kind);
      rot[h].st.games++; rot[a].st.games++;
      const p = price(h, a, sh.s, sh.f, sa.s, sa.f, xiReg, 'regular');
      win[k] = rg.nextDouble() < p ? 1 : -1;
      if (watchReg.has(j)) { marks.diag('starter|' + g.id + '|' + g.home + '|' + sh.id + '|' + sh.label); marks.diag('starter|' + g.id + '|' + g.away + '|' + sa.id + '|' + sa.label); }
      if (opt.observe) opt.observe({ run, phase: 'regular', game: g.id, date: g.date, home: g.home, away: g.away, sp_home: sh.id, sp_away: sa.id, label_home: sh.label, label_away: sa.label, p_home: p, winner: win[k] > 0 ? g.home : g.away, short_rest: [false, false] });
    }
    /* 4 standings and seeds */
    const st = new Standings(S, win, { rng: streamFor(opt.seed, run, STREAM.coin), diag: marks.diag, flag: marks.flag, trace: marks.trace });
    const seeds = qualify(st, fmt);
    for (const L of seeds) {
      L.divisionWinners.forEach((t) => marks.mark(t, O.win_division));
      L.seeds.forEach((t, i) => { marks.mark(t, O.make_playoffs); marks.mark(t, O['seed_' + (i + 1)]); if (i < fmt.byes_per_league) marks.mark(t, O.bye); });
    }
    for (let t = 0; t < T; t++) marks.value(t, 2 * st.w[t]);
    /* 5 the postseason */
    const rp = streamFor(opt.seed, run, STREAM.postseason);
    const lastDay: Record<string, number> = {};
    const play = (spec: SeriesSpec, k: number, home: number, away: number): number => {
      const hc = teams[home].code, ac = teams[away].code;
      const g = known.get(pairKey(spec.round, hc, ac, k)) || null;
      if (g && g.home !== hc) throw new Error('the bracket puts game ' + k + ' of ' + spec.id + ' at ' + hc + ' but the schedule has it at ' + g.home + ' (' + g.id + ')');
      if (g && g.status === 'final') {
        marks.diag('postseason:games_fixed');
        lastDay[spec.id] = dayOf(g.date);
        return (g.home_score as number) > (g.away_score as number) ? home : away;
      }
      let day = g ? dayOf(g.date) : templateDay(spec.round, spec.league, k);
      if (lastDay[spec.id] != null && day <= lastDay[spec.id]) day = lastDay[spec.id] + 1;   // a calendar never runs backwards inside a series
      lastDay[spec.id] = day;
      const sh = starter(home, g, 'home', day, 'postseason', 'single'), sa = starter(away, g, 'away', day, 'postseason', 'single');
      rot[home].st.games++; rot[away].st.games++;
      const p = price(home, away, sh.s, sh.f, sa.s, sa.f, xiPost, 'postseason');
      const w = rp.nextDouble() < p ? home : away;
      marks.diag('postseason:games_simulated');
      const key = spec.id + '-G' + k;
      marks.diag('starter|' + key + '|' + hc + '|' + sh.id + '|' + sh.label); marks.diag('starter|' + key + '|' + ac + '|' + sa.id + '|' + sa.label);
      if (opt.observe) opt.observe({ run, phase: 'postseason', game: key, date: new Date(day * 864e5).toISOString().slice(0, 10), home: hc, away: ac, sp_home: sh.id, sp_away: sa.id, label_home: sh.label, label_away: sa.label, p_home: p, winner: teams[w].code, short_rest: [sh.short, sa.short] });
      if (marks.tracing) marks.trace({ type: 'postseason_game', game: key, home: hc, away: ac, starters: [sh.id + ' (' + sh.label + ')', sa.id + ' (' + sa.label + ')'], p_home: Math.round(p * 1e4) / 1e4, winner: teams[w].code });
      return w;
    };
    const post = playPostseason(st, fmt, seeds, play);
    post.reachedDS.forEach((t) => marks.mark(t, O.reach_division_series));
    post.reachedLCS.forEach((t) => marks.mark(t, O.reach_lcs));
    post.pennant.forEach((t) => marks.mark(t, O.win_pennant));
    marks.mark(post.champion, O.win_world_series);
    if (marks.tracing) {
      marks.trace({ type: 'offsets', sigma_team: sigma, sigma_sp: sigmaSp, theta: teams.map((t, i) => [t.code, Math.round(theta[i] * 1e4) / 1e4]) });
      marks.trace({ type: 'records', wins: teams.map((t, i) => [t.code, st.w[i] + '-' + st.l[i]]) });
      marks.trace({ type: 'seeds', AL: seeds[0].seeds.map((t) => teams[t].code), NL: seeds[1].seeds.map((t) => teams[t].code) });
      marks.trace({ type: 'postseason', series: post.series.map((s) => [s.spec.id, teams[s.spec.higher].code, teams[s.spec.lower].code, teams[s.winner].code, s.games]) });
    }
  }
  return { sport: 'mlb', competition: 'MLB', season: String(data.season), entities, outcomes, sumRules, valueBins: 2 * maxGames + 1, runOne };
}
