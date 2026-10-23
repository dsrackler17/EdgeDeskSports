/* ===========================================================================
   ONE SIMULATED COLLEGE FOOTBALL SEASON, FROM THE SNAPSHOT.

   Three kinds of uncertainty, kept apart and drawn from separate streams:

   1. GAME RESULTS (Research). Each FBS team draws ONE strength offset
      d_t ~ Normal(0, tau^2) per run, kept through the regular season, the
      conference title game and the playoff. Every unplayed game's home
      margin is fair + d_home - d_away + e, e ~ Normal(0, sigma^2 - k tau^2),
      so each game keeps the engine's own calibrated distribution
      Normal(fair, sigma^2) while a team's games share its error
      (simulator/data/cfb_strength_uncertainty.json). Completed games are
      fixed at their real scores. FCS opponents are the engine's single
      floor rating and carry no offset.
   2. CONFERENCE QUALIFICATION (rules). Standings and each conference's
      published tiebreaker (rules.ts, sources in config.ts) pick the title-
      game participants; an external ranking a procedure names is resolved by
      an Estimated surrogate and every run that reaches one is counted, per
      conference. A title game already in the feed fixes its participants
      (and its result when played).
   3. COMMITTEE SELECTION AND SEEDING (Estimated). Only when the committee
      proxy passed its pre-registered validation (committee.ts,
      simulator/data/cfb_committee_proxy.json): the final ranking is a
      Plackett-Luce draw on the simulated resume, with the proxy's parameters
      drawn per run from its season bootstrap. Once the real bracket is
      announced (cfb_cfp_bracket.json status 'observed') the proxy is never
      used: the field and seeds are Observed and only the games are
      simulated, completed playoff games fixed from the feed. A 'scenario'
      bracket produces outputs labelled CONDITIONAL on its stated
      assumptions. Without any of the three, no CFP or national-title
      probability is produced at all.

   Streams (core/prng.ts STREAM): strength 1, games 2, postseason 3, coin 4,
   points 6, committee 11.
   =========================================================================== */
import type { SimModule, RunMarks, OutcomeDef, SumRule, EntityDef } from '../../core/engine.ts';
import { streamFor, STREAM } from '../../core/prng.ts';
import { normalQuantile } from '../../core/normal.ts';
import { CfbLeague, ConfTable, type SeasonResults, type CfbGame } from './rules.ts';
import { CFP_RULES, selectField, playBracket, type CfpRules } from './cfp.ts';
import { resumes, scores, noisyOrder, type ProxyFit } from './committee.ts';
import { cfbFacts, isCfbVerified } from './config.ts';
import type { CfbInputData } from './inputs.ts';

export type CfpMode = 'proxy' | 'observed' | 'scenario' | 'off';
const POWER_2026 = ['ACC', 'Big Ten', 'Big 12', 'SEC'];

export function cfpMode(data: CfbInputData): { mode: CfpMode; reason: string; proxy: { K: number; fit: ProxyFit; boot: number[][] } | null } {
  const b = data.cfp_bracket;
  if (b && b.status === 'observed') return { mode: 'observed', reason: 'the announced bracket (' + (b.source_url || '') + ')', proxy: null };
  if (b && b.status === 'scenario') return { mode: 'scenario', reason: 'a stated scenario: ' + b.label, proxy: null };
  const c = data.committee;
  if (!c || !c.by_as_of_week) return { mode: 'off', reason: 'no committee proxy file', proxy: null };
  const weeks = Object.keys(c.by_as_of_week).map(Number).sort((x, y) => x - y);
  const K = weeks.filter((w) => w <= data.as_of_week).pop() ?? weeks[0];
  const e = c.by_as_of_week[K];
  if (!e.decision || e.decision.defensible !== true) return { mode: 'off', reason: 'the committee proxy failed its pre-registered validation at as-of week ' + K, proxy: null };
  if (c.engine_model_version !== data.model.model_version) return { mode: 'off', reason: 'the committee proxy was fitted on ratings of ' + c.engine_model_version + ', not ' + data.model.model_version, proxy: null };
  return { mode: 'proxy', reason: 'committee proxy (' + e.chosen + ', as-of week ' + K + ')', proxy: { K, fit: e.fit, boot: e.bootstrap_beta } };
}

export function cfbOutcomes(mode: CfpMode, conditional?: string): OutcomeDef[] {
  const conf: OutcomeDef[] = [
    { key: 'ccg_appearance', label: 'Reach conference title game', category: 'conference', provenance: 'Research' },
    { key: 'ccg_seed_1', label: 'Title game No. 1 seed (host where hosted)', category: 'conference', provenance: 'Research' },
    { key: 'conf_champion', label: 'Win conference', category: 'conference', provenance: 'Research' }
  ];
  if (mode === 'off') return conf;
  const sel: OutcomeDef['provenance'] = mode === 'proxy' ? 'Estimated' : mode === 'observed' ? 'Observed' : 'Research';
  const play: OutcomeDef['provenance'] = mode === 'proxy' ? 'Estimated' : 'Research';
  const c: { conditional_on?: string } = mode === 'scenario' ? { conditional_on: conditional || 'a stated bracket scenario' } : {};
  const cfp: OutcomeDef[] = [
    { key: 'cfp_field', label: 'Make the CFP', category: 'playoffs', provenance: sel, ...c },
    { key: 'cfp_bye', label: 'Top-4 seed (bye)', category: 'seed', provenance: sel, ...c },
    { key: 'cfp_host_first_round', label: 'Seeds 5-8 (host a first-round game)', category: 'seed', provenance: sel, ...c },
    ...Array.from({ length: 12 }, (_, i): OutcomeDef => ({ key: 'cfp_seed_' + (i + 1), label: 'CFP seed ' + (i + 1), category: 'seed', provenance: sel, ...c })),
    { key: 'reach_qf', label: 'Reach the quarterfinals', category: 'round', provenance: play, ...c },
    { key: 'reach_sf', label: 'Reach the semifinals', category: 'round', provenance: play, ...c },
    { key: 'reach_final', label: 'Reach the national championship game', category: 'round', provenance: play, ...c },
    { key: 'national_champion', label: 'Win the national championship', category: 'title', provenance: play, ...c }
  ];
  return conf.concat(cfp);
}
export function cfbSumRules(mode: CfpMode): SumRule[] {
  const r: SumRule[] = [
    { outcome: 'ccg_appearance', by: 'ccg', perGroup: 2, skip: ['none'] },
    { outcome: 'ccg_seed_1', by: 'ccg', perGroup: 1, skip: ['none'] },
    { outcome: 'conf_champion', by: 'ccg', perGroup: 1, skip: ['none'] }
  ];
  if (mode === 'off') return r;
  return r.concat([
    { outcome: 'cfp_field', by: 'league', perGroup: 12 }, { outcome: 'cfp_bye', by: 'league', perGroup: 4 }, { outcome: 'cfp_host_first_round', by: 'league', perGroup: 4 },
    ...Array.from({ length: 12 }, (_, i): SumRule => ({ outcome: 'cfp_seed_' + (i + 1), by: 'league', perGroup: 1 })),
    { outcome: 'reach_qf', by: 'league', perGroup: 8 }, { outcome: 'reach_sf', by: 'league', perGroup: 4 },
    { outcome: 'reach_final', by: 'league', perGroup: 2 }, { outcome: 'national_champion', by: 'league', perGroup: 1 }
  ]);
}

export interface CfbModuleOptions {
  seed: bigint;
  /** override the snapshot's tau (tests: 0 = independent games at the engine's own probabilities) */
  tau?: number;
  /** tests only: force the CFP mode */
  mode?: CfpMode;
  /** tests only: see every simulated game (never changes a result) */
  observe?: (ev: { run: number; phase: 'regular' | 'ccg' | 'cfp'; game: string; home: number; away: number; margin: number }) => void;
}

export function cfbModule(data: CfbInputData, opt: CfbModuleOptions): SimModule & { league: CfbLeague; mode: CfpMode; modeReason: string } {
  const procs: Record<string, string> = {};
  for (const c of data.config.conferences) procs[c.conference] = c.procedure;
  const L = new CfbLeague(data.teams, data.games as CfbGame[], procs);
  const T = L.T, G = L.G;
  const tau = opt.tau != null ? opt.tau : data.strength.tau_points;
  if (!(tau >= 0 && tau < 12)) throw new Error('strength tau out of range: ' + tau);
  const cm = cfpMode(data);
  const mode: CfpMode = opt.mode || cm.mode;
  if (mode === 'proxy' && !cm.proxy) throw new Error('CFP mode proxy requested without a validated proxy: ' + cm.reason);
  const outcomes = cfbOutcomes(mode, mode === 'scenario' ? data.cfp_bracket.label + ' — assumptions: ' + data.cfp_bracket.assumptions.join('; ') : undefined);
  const sumRules = cfbSumRules(mode);
  const O: Record<string, number> = {}; outcomes.forEach((o, i) => { O[o.key] = i; });
  const ccgConfs = new Set(L.confs.map((c) => c.name));
  const entities: EntityDef[] = data.teams.map((t) => ({ id: t.id, name: t.name, groups: { conference: t.conference, ccg: ccgConfs.has(t.conference) ? t.conference : 'none', division: t.division || '-' } }));
  const verified = new Map(cfbFacts(data.config).map(([k, f]) => [k, isCfbVerified(f)]));
  const unverifiedElig = data.config.eligibility.filter((e) => !isCfbVerified(e.fact)).map((e) => ({ team: data.teams.findIndex((t) => t.name === e.team), name: e.team }));
  const site = new Map(data.config.conferences.map((c) => [c.conference, c.ccg_site]));
  /* per-game constants */
  const open: number[] = [], fair = new Float64Array(G), sd = new Float64Array(G), total = new Float64Array(G), base = new Float64Array(G);
  data.games.forEach((g, k) => {
    if (g.done) { base[k] = (g.home_points as number) - (g.away_points as number); if (base[k] === 0) throw new Error('a completed game ended tied: ' + g.game_id); return; }
    const m = g.model!;
    const v = m.sigma * m.sigma - m.k * tau * tau;
    if (!(v > 0)) throw new Error('tau ' + tau + ' leaves no game noise in ' + g.game_id + ' (sigma ' + m.sigma + ')');
    open.push(k); fair[k] = m.fair; sd[k] = Math.sqrt(v); total[k] = m.total == null ? NaN : m.total;
  });
  const P = data.pairs, sigT = data.model.sigma_total;
  const pairSd = (s: number) => { const v = s * s - 2 * tau * tau; if (!(v > 0)) throw new Error('tau leaves no noise in a postseason pair'); return Math.sqrt(v); };
  /* observed postseason games from the feed */
  const ccgObserved = new Map<string, (typeof data.postseason_feed)[number]>();
  for (const g of data.postseason_feed) if (g.kind === 'ccg' && g.conference) ccgObserved.set(g.conference, g);
  const cfpObserved = new Map<string, (typeof data.postseason_feed)[number]>();
  for (const g of data.postseason_feed) if (g.kind === 'cfp' && g.done) cfpObserved.set(Math.min(g.home, g.away) + ':' + Math.max(g.home, g.away), g);
  const ix = new Map(data.teams.map((t, i) => [t.name, i]));
  const bracketSeeds = (mode === 'observed' || mode === 'scenario') ? data.cfp_bracket.seeds.map((n) => { const i = ix.get(n); if (i == null) throw new Error('bracket team not in the feed: ' + n); return i; }) : null;
  const rules: CfpRules = CFP_RULES[data.config.cfp.rules];
  const power = new Uint8Array(T); data.teams.forEach((t, i) => { power[i] = POWER_2026.includes(t.conference) || t.name === 'Notre Dame' ? 1 : 0; });
  const rating = data.teams.map((t) => t.rating);
  const fcsRating = data.model.fcs_rating;
  const selGames = data.games.map((g, k) => ({ g, k })).filter((x) => x.g.before_selection);
  const maxGames = Math.max(...L.teamGames.map((a) => a.length));
  const offsets = new Float64Array(T), margin = new Float64Array(G);

  function runOne(run: number, marks: RunMarks): void {
    /* 1 offsets, 2 the regular season */
    const rs = streamFor(opt.seed, run, STREAM.strength);
    for (let t = 0; t < T; t++) offsets[t] = tau === 0 ? 0 : tau * normalQuantile(rs.nextOpen());
    const rg = streamFor(opt.seed, run, STREAM.games);
    margin.set(base);
    for (const k of open) {
      const g = data.games[k], d = (g.home >= 0 ? offsets[g.home] : 0) - (g.away >= 0 ? offsets[g.away] : 0);
      let m = fair[k] + d + sd[k] * normalQuantile(rg.nextOpen());
      if (m === 0) m = 1e-9;
      margin[k] = m;
      if (opt.observe) opt.observe({ run, phase: 'regular', game: g.game_id, home: g.home, away: g.away, margin: m });
    }
    /* Estimated scores, drawn only when a tiebreak asks (the SEC's capped scoring margin) */
    let pts: { home: Float64Array; away: Float64Array } | null | undefined;
    const R: SeasonResults = {
      margin,
      points: () => {
        if (pts !== undefined) return pts;
        const rp = streamFor(opt.seed, run, STREAM.points), home = new Float64Array(G), away = new Float64Array(G);
        for (let k = 0; k < G; k++) {
          const g = data.games[k];
          if (g.done) { home[k] = g.home_points as number; away[k] = g.away_points as number; continue; }
          /* only conference games feed a scoring-margin step; a non-conference game (an FCS opponent has no scoring profile) is never read */
          if (!g.conf) continue;
          if (!Number.isFinite(total[k])) { pts = null; return null; }
          const m = margin[k], tot = Math.max(Math.abs(m), total[k] + sigT * normalQuantile(rp.nextOpen()));
          home[k] = (tot + m) / 2; away[k] = (tot - m) / 2;
        }
        marks.diag('points:drawn');
        pts = { home, away };
        return pts;
      },
      surrogate: (t: number) => rating[t] + offsets[t]
    };
    const ctx = { rng: streamFor(opt.seed, run, STREAM.coin), diag: marks.diag, flag: marks.flag, trace: marks.trace };
    /* 3 conference title games */
    const rp = streamFor(opt.seed, run, STREAM.postseason);
    const champions = new Map<string, number>();
    const ccgGames: Array<{ h: number; a: number; m: number }> = [];
    for (let ci = 0; ci < L.confs.length; ci++) {
      const c = L.confs[ci], obs = ccgObserved.get(c.name);
      let seeds: number[];
      if (obs) { seeds = obs.neutral ? [obs.home, obs.away] : [obs.home, obs.away]; marks.diag('ccg_observed:' + c.name); }
      else {
        const tab = new ConfTable(L, ci, R, ctx);
        const p = tab.participants();
        seeds = p.seeds;
        /* counted when they decided a BERTH, or the host of a title game the No. 1 seed hosts (a neutral-site seed order changes nothing) */
        const hosted = site.get(c.name) === 'home_of_seed_1';
        const mattered = tab.decisions.filter((x) => x.purpose === 'berth' || hosted);
        if (mattered.some((x) => x.step === 'metric')) marks.flag('ccg_metric:' + c.name);
        if (mattered.some((x) => x.step === 'draw')) marks.flag('ccg_draw:' + c.name);
        if (mattered.some((x) => x.step === 'scoring_margin')) marks.flag('ccg_estimated_points:' + c.name);
        if (tab.pointsUnavailable) marks.flag('ccg_points_unavailable:' + c.name);
        if (mattered.length && !verified.get(c.name)) marks.flag('ccg_unverified_rule:' + c.name);
        /* how often an unverified eligibility assumption would have changed the berths */
        for (const u of unverifiedElig) {
          if (u.team < 0 || L.confOf[u.team] !== ci) continue;
          const team = L.teams[u.team], was = team.ccg_eligible;
          team.ccg_eligible = !was;
          const alt = new ConfTable(L, ci, R, { ...ctx, rng: streamFor(opt.seed, run, STREAM.coin + 100) }).participants().seeds;
          team.ccg_eligible = was;
          if (alt.slice().sort().join() !== seeds.slice().sort().join()) marks.flag('eligibility_sensitive:' + u.name);
        }
        if (marks.tracing) marks.trace({ type: 'ccg_participants', conference: c.name, seeds: seeds.map((t) => L.teams[t].name), decided_by: p.decided_by, estimated: tab.estimated });
      }
      const [h, a] = seeds;
      marks.mark(h, O.ccg_appearance); marks.mark(a, O.ccg_appearance); marks.mark(h, O.ccg_seed_1);
      let m: number;
      if (obs && obs.done) m = (obs.home_points as number) - (obs.away_points as number);
      else {
        const neutral = obs ? obs.neutral : site.get(c.name) !== 'home_of_seed_1';
        const ii = h * T + a;
        const f = neutral ? P.neutral_fair[ii] : P.home_fair[ii], s = neutral ? P.neutral_sigma[ii] : P.home_sigma[ii];
        m = f + offsets[h] - offsets[a] + pairSd(s) * normalQuantile(rp.nextOpen());
        if (m === 0) m = 1e-9;
        if (opt.observe) opt.observe({ run, phase: 'ccg', game: c.name, home: h, away: a, margin: m });
      }
      const w = m > 0 ? h : a;
      champions.set(c.name, w);
      marks.mark(w, O.conf_champion);
      ccgGames.push({ h, a, m });
    }
    /* regular-season wins (the value histogram, x2 as the shared results expect) */
    for (let t = 0; t < T; t++) {
      let w = 0;
      for (const k of L.teamGames[t]) { const g = L.games[k]; if (g.home === t ? margin[k] > 0 : margin[k] < 0) w++; }
      marks.value(t, 2 * w);
    }
    if (mode === 'off') return;
    /* 4 the field: observed / scenario bracket, or the committee proxy (Estimated) */
    let seeds: number[];
    if (bracketSeeds) seeds = bracketSeeds;
    else {
      const rc = streamFor(opt.seed, run, STREAM.committee), px = cm.proxy!;
      const beta = px.boot.length ? px.boot[rc.nextInt(px.boot.length)] : px.fit.beta;
      const champ = new Uint8Array(T); for (const w of champions.values()) champ[w] = 1;
      const games = selGames.map(({ g, k }) => ({ h: g.home, a: g.away, m: margin[k] })).concat(ccgGames);
      const s = scores(resumes({ T, rating, fcsRating, power, champion: champ, games }), px.fit, beta);
      const order = noisyOrder(s, (t) => L.teams[t].cfp_eligible, () => rc.nextOpen());
      seeds = selectField(rules, { order, conference: (t) => L.teams[t].conference, champions, notreDame: data.notre_dame }).seeds;
      if (marks.tracing) marks.trace({ type: 'committee_top25', order: order.slice(0, 25).map((t) => L.teams[t].name) });
    }
    seeds.forEach((t, i) => { marks.mark(t, O.cfp_field); marks.mark(t, O['cfp_seed_' + (i + 1)]); if (i < 4) marks.mark(t, O.cfp_bye); else if (i < 8) marks.mark(t, O.cfp_host_first_round); });
    /* 5 the bracket: completed playoff games from the feed, the rest simulated */
    const br = playBracket(seeds, (home, away, neutral, round, slot) => {
      const ob = cfpObserved.get(Math.min(home, away) + ':' + Math.max(home, away));
      if (ob) return { winner: (ob.home_points as number) > (ob.away_points as number) ? ob.home : ob.away, observed: true };
      const ii = home * T + away, f = neutral ? P.neutral_fair[ii] : P.home_fair[ii], s = neutral ? P.neutral_sigma[ii] : P.home_sigma[ii];
      let m = f + offsets[home] - offsets[away] + pairSd(s) * normalQuantile(rp.nextOpen());
      if (m === 0) m = 1e-9;
      if (opt.observe) opt.observe({ run, phase: 'cfp', game: round + ':' + slot, home, away, margin: m });
      return { winner: m > 0 ? home : away, observed: false };
    });
    br.reached_qf.forEach((t) => marks.mark(t, O.reach_qf));
    br.reached_sf.forEach((t) => marks.mark(t, O.reach_sf));
    br.reached_final.forEach((t) => marks.mark(t, O.reach_final));
    marks.mark(br.champion, O.national_champion);
    if (marks.tracing) marks.trace({ type: 'cfp', seeds: seeds.map((t) => L.teams[t].name), games: br.games.map((g) => [g.slot, L.teams[g.home].name, L.teams[g.away].name, L.teams[g.winner].name, g.observed]) });
  }
  return { sport: 'cfb', competition: data.competition, season: String(data.season), entities, outcomes, sumRules, valueBins: 2 * maxGames + 1, runOne, league: L, mode, modeReason: cm.reason };
}
