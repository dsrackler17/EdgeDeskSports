/* ===========================================================================
   ONE SIMULATED NCAAM TOURNAMENT, FROM THE SNAPSHOT.

   For run r (master seed fixed):
   1. Each entrant draws ONE latent strength offset d_t ~ Normal(0, V_t)
      (margin points; strength stream). It persists through every round of
      the run: a team drawn strong stays strong; a hot shooting night does NOT
      become talent (nothing carries a game result into later games).
   2. Completed games are fixed at their observed winners.
   3. Every open slot, in play order, draws its winner from the forecast
      distribution of basketball/ncaam_forecast/dist.js at the shifted mean:
        P(team a wins) = winProbAt(mu_ab + d_a - d_b, sd_game_ab, calibration)
      sd_game_ab^2 = sd_ab^2 - V_a - V_b: the calibrated single-game variance
      already contains the strength uncertainty, so the per-game part is
      what remains — never counted twice. One uniform per open game (games
      stream), in the fixed slot order.
   4. Advancement is marked from the bracket's own fixed paths: no reseeding.

   Availability sampling and within-tournament drift are OFF (config.ts):
   no owned availability feed exists and no drift has validation evidence.
   =========================================================================== */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SimModule, RunMarks, OutcomeDef, SumRule, EntityDef } from '../../core/engine.ts';
import { streamFor, STREAM } from '../../core/prng.ts';
import { normalQuantile } from '../../core/normal.ts';
import { playOrder, playBracket, slotsPerRound, validateBracket, type Bracket } from './bracket.ts';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const DIST = createRequire(import.meta.url)(path.join(REPO, 'basketball', 'ncaam_forecast', 'dist.js')) as {
  winProbAt: (mu: number, sd: number, cal: unknown) => number; VAR_FLOOR: number;
};

export interface NcaamInputData {
  schema: 'edgedesk_ncaam_sim_inputs_v1';
  season: number;
  competition: string;
  rules_version: string;
  bracket: Bracket;
  /** entity order = team ids sorted; pair tables are row-major over this order */
  teams: Array<{ id: string; name: string; region: string | null; seed: number | null; rating_games: number }>;
  /** calibrated regulation mean and full sd for team i vs team j at a neutral site (i listed first) */
  pairs: { mu: number[]; sd: number[] };
  /** per-team persistent strength variance in margin points^2 (latent draw) */
  strength: { variance: number[]; method: string; source: string; ci95: [number, number] | null };
  /** the subset of the D1-v-D1 calibration winProbAt reads */
  calibration: { kappa: number; ot: { sd: number } };
  model: { model_id: string; version: string; artifact_sha256: string; as_of: string; config_sha256: string };
  config: { drift: { mode: 'off' }; availability: { mode: 'off'; reason: string }; venue: string };
}

const LABEL: Record<string, string> = {
  FF: 'Play in the First Four', R64: 'In the round of 64 (won a First Four game, or entered there)', R32: 'Reach the round of 32 (won a first-round game)',
  S16: 'Reach the Sweet 16', E8: 'Reach the Elite Eight', F4: 'Reach the Final Four', NC: 'Reach the championship game'
};
export const outcomeKey = (round: string) => 'reach_' + round.toLowerCase();

export function ncaamOutcomes(b: Bracket): OutcomeDef[] {
  return b.rounds.map((r): OutcomeDef => ({ key: outcomeKey(r), label: LABEL[r] || 'Reach round ' + r, category: 'round', provenance: 'Research' }))
    .concat([{ key: 'win_title', label: 'Win the national championship', category: 'title', provenance: 'Research' }]);
}

/** exact per-run counts the bracket fixes: 2 entrants per slot of a round, and per region where regional */
export function ncaamSumRules(b: Bracket): SumRule[] {
  const per = slotsPerRound(b); const rules: SumRule[] = [];
  for (const r of b.rounds) rules.push({ outcome: outcomeKey(r), by: 'league', perGroup: 2 * per[r] });
  const regions = [...new Set(Object.values(b.entrants).map((e) => e.region))];
  if (regions.length > 1 && regions.every((x) => x != null)) {
    for (let i = 0; i < b.rounds.length; i++) {
      const r = b.rounds[i]; const slots = b.slots.filter((s) => s.round === r);
      if (slots.every((s) => s.region != null)) {
        const cnt = new Map<string, number>(); for (const s of slots) cnt.set(s.region as string, (cnt.get(s.region as string) || 0) + 1);
        const vals = regions.map((g) => cnt.get(g as string) || 0);
        if (vals.every((v) => v === vals[0]) && vals[0] > 0) rules.push({ outcome: outcomeKey(r), by: 'region', perGroup: 2 * vals[0] });
      } else if (i > 0) {
        /* the first national round: each region sends the winners of its last regional round */
        const prev = b.slots.filter((s) => s.round === b.rounds[i - 1]);
        if (prev.length && prev.every((s) => s.region != null)) {
          const cnt = new Map<string, number>(); for (const s of prev) cnt.set(s.region as string, (cnt.get(s.region as string) || 0) + 1);
          const vals = regions.map((g) => cnt.get(g as string) || 0);
          if (vals.every((v) => v === vals[0])) rules.push({ outcome: outcomeKey(r), by: 'region', perGroup: vals[0] });
        }
      }
    }
  }
  rules.push({ outcome: 'win_title', by: 'league', perGroup: 1 });
  return rules;
}

export interface NcaamModuleOptions {
  seed: bigint;
  /** override every team's strength variance (tests and the backtest's V = 0 arm) */
  strengthVariance?: number;
  /** tests only: observes each simulated open game */
  observe?: (ev: { run: number; slot: string; a: string; b: string; p: number; winner: string; offset: number }) => void;
}

export function ncaamModule(data: NcaamInputData, opt: NcaamModuleOptions): SimModule {
  const errs = validateBracket(data.bracket);
  if (errs.length) throw new Error('invalid bracket: ' + errs.slice(0, 5).join('; '));
  if (data.config.drift.mode !== 'off') throw new Error('within-tournament drift is not validated: config.drift.mode must be off');
  if (data.config.availability.mode !== 'off') throw new Error('availability sampling has no owned source for college basketball: config.availability.mode must be off');
  const n = data.teams.length; const ix = new Map(data.teams.map((t, i) => [t.id, i]));
  for (const id of Object.keys(data.bracket.entrants)) if (!ix.has(id)) throw new Error('bracket entrant ' + id + ' has no team row');
  if (data.pairs.mu.length !== n * n || data.pairs.sd.length !== n * n) throw new Error('pair tables must be ' + n + ' x ' + n);
  const V = data.teams.map((_, i) => (opt.strengthVariance != null ? opt.strengthVariance : data.strength.variance[i]));
  if (V.some((v) => !(v >= 0 && v < 100))) throw new Error('strength variance out of range');
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) {
    const sd = data.pairs.sd[i * n + j], mu = data.pairs.mu[i * n + j];
    if (!(Number.isFinite(mu) && sd > 0)) throw new Error('pair ' + data.teams[i].id + '-' + data.teams[j].id + ' has no forecast');
    if (sd * sd - V[i] - V[j] < DIST.VAR_FLOOR) throw new Error('strength variance exceeds the game variance for ' + data.teams[i].id + '-' + data.teams[j].id);
  }
  const outcomes = ncaamOutcomes(data.bracket), sumRules = ncaamSumRules(data.bracket);
  const O: Record<string, number> = {}; outcomes.forEach((o, i) => { O[o.key] = i; });
  const entities: EntityDef[] = data.teams.map((t) => ({ id: t.id, name: t.name, groups: { region: t.region || 'national' } }));
  const order = playOrder(data.bracket);
  const cal = data.calibration;
  const offsets = new Float64Array(n); const wins = new Int32Array(n);
  function runOne(run: number, marks: RunMarks): void {
    /* 1 persistent latent strength: one uniform per team, always (stable streams) */
    const rs = streamFor(opt.seed, run, STREAM.strength);
    for (let t = 0; t < n; t++) { const z = normalQuantile(rs.nextOpen()); offsets[t] = V[t] > 0 ? Math.sqrt(V[t]) * z : 0; }
    wins.fill(0);
    /* 2-3 the bracket, game by game */
    const rg = streamFor(opt.seed, run, STREAM.postseason);
    const res = playBracket(data.bracket, order, (s, a, b) => {
      const i = ix.get(a) as number, j = ix.get(b) as number;
      const mu = data.pairs.mu[i * n + j] + offsets[i] - offsets[j];
      const sdFull = data.pairs.sd[i * n + j];
      const sdGame = Math.sqrt(sdFull * sdFull - V[i] - V[j]);
      const p = DIST.winProbAt(mu, sdGame, cal);
      const winner = rg.nextOpen() < p ? a : b;
      if (opt.observe) opt.observe({ run, slot: s.id, a, b, p, winner, offset: offsets[i] - offsets[j] });
      return { winner, p };
    });
    /* 4 advancement along the fixed paths */
    for (const g of res.games) {
      const h = ix.get(g.home) as number, a = ix.get(g.away) as number, w = ix.get(g.winner) as number;
      marks.mark(h, O[outcomeKey(g.round)]); marks.mark(a, O[outcomeKey(g.round)]);
      wins[w]++;
      if (!g.fixed) marks.diag('games:simulated'); else marks.diag('games:fixed');
    }
    marks.mark(ix.get(res.champion) as number, O.win_title);
    for (let t = 0; t < n; t++) marks.value(t, 2 * wins[t]);
    if (marks.tracing) {
      marks.trace({ type: 'offsets', offsets: data.teams.map((t, i) => [t.id, Math.round(offsets[i] * 1000) / 1000]) });
      marks.trace({ type: 'games', games: res.games.map((g) => [g.slot, g.home, g.away, g.winner, g.fixed ? 'fixed' : Math.round((g.p_home as number) * 1e4) / 1e4]) });
    }
  }
  return {
    sport: 'ncaam', competition: data.competition, season: String(data.season),
    entities, outcomes, sumRules, valueBins: 2 * data.bracket.rounds.length + 1, runOne
  };
}
