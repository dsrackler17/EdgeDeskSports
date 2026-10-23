/* ===========================================================================
   THE GOLF SKILL MODEL — what a player is expected to shoot, relative to the
   field, and how sure the model is.

   DATA. simulator/data/feeds/golf_events.json.gz (ESPN, fetched on GitHub's
   runners by simulator/src/cli/fetch_sports_data.ts): every PGA Tour, LPGA
   and DP World Tour event since 2023, each player's strokes per round.
   cleanEvent keeps an event only if it is individual stroke play (team
   events, match play and the modified-Stableford Barracuda Championship are
   left out, with the reason recorded) and a round only if it is a complete
   18-hole round: its strokes minus its score to par must equal one of the
   event's 18-hole pars (a round abandoned by a withdrawal, a round still in
   progress and a playoff all fail that test and are left out).

   THE MODEL. A complete round's strokes
        y = a_k + theta_p + noise,
   where a_k is the event-round's level (course, set-up and weather: shared
   by everyone in that round) and theta_p the player's skill in strokes per
   round. Fitted point-in-time at the as-of time T from rounds before T only:
     - exponential time decay: a round d days before T has weight
       w = 0.5^(d / half_life_days), so form moves and a player's 2023
       rounds count less than their last month's;
     - shrinkage (empirical Bayes): the penalised least squares
         min sum w (y - a_k - theta_p)^2 + kappa sum_p (theta_p - m_p)^2
       solved by alternating the two closed forms (theta given a, a given
       theta) to convergence. kappa = sigma^2 / tau^2 is the prior's weight
       in rounds: a player with few rounds is pulled toward the prior, a
       player with hundreds is not. The penalty fixes the scale so that the
       prior mean is the AVERAGE PLAYER in the window (every player counted
       once), the classic random-effects prior;
     - but players the window holds few rounds of are measurably worse than
       that average (Monday qualifiers, sponsor invitations, amateurs,
       players from other tours): the prior mean is shifted by
       prior_shift_few strokes for a player with 1..few_max rounds, and an
       unseen player's by prior_shift_new (both measured out of sample by
       golf_skill_study.ts). Skills are then reported relative to the
       round-weighted average (0 = an average round on the tour; negative
       is better);
     - posterior: theta_p ~ N(theta_hat_p, sigma^2 / (n_eff_p + kappa)),
       n_eff = sum of the player's weights;
     - a per-player round sd, shrunk toward the tour's:
         s_p^2 = (nu0 sigma^2 + sum w r^2) / (nu0 + n_eff).
   The tour(s) a fit covers is a parameter: each tour separately, or the
   PGA Tour and the DP World Tour jointly (their fields share hundreds of
   players, so one scale can link them); simulator/src/research/
   golf_skill_study.ts measures which predicts better and fits every
   hyperparameter (simulator/data/golf_skill_study.json).
   =========================================================================== */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const FEEDS = path.join(REPO, 'simulator', 'data', 'feeds');
export const HISTORY_FILE = path.join(FEEDS, 'golf_events.json.gz');
export const CURRENT_FILE = path.join(FEEDS, 'golf_current.json');
export const STUDY_FILE = path.join(REPO, 'simulator', 'data', 'golf_skill_study.json');
export const BACKTEST_FILE = path.join(REPO, 'simulator', 'data', 'golf_backtest.json');
export const DAY = 864e5;

export type Tour = 'pga' | 'lpga' | 'eur';
export const TOURS: Tour[] = ['pga', 'lpga', 'eur'];
export const TOUR_LABEL: Record<Tour, string> = { pga: 'PGA Tour', lpga: 'LPGA Tour', eur: 'DP World Tour' };
export type Status = 'active' | 'cut' | 'wd' | 'dq' | 'mdf';

/** a score to par as ESPN displays it ("-4", "E", "+2"; "-" = not played) */
export function toPar(s: string | null | undefined): number | null {
  if (s == null || s === '-' || s === '') return null;
  if (s === 'E') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export interface HistRound { r: number; strokes: number; complete: boolean; par_played: number | null }
export interface HistPlayer { id: string; name: string; country: string | null; status: Status; rounds: HistRound[]; playoff: boolean; position: string | null; sort_order: number | null }
export interface HistEvent {
  key: string; league: Tour; season: number; id: string; name: string; start: number; start_iso: string; course: string | null; par: number | null;
  /** the 18-hole pars seen in the event (more than one on a multi-course event) */
  full_pars: number[];
  /** regulation rounds completed by the field (a weather-shortened event has fewer than scheduled) */
  n_rounds: number;
  players: HistPlayer[];
  /** players in a playoff (a linescore after the last regulation round), and the winner (position 1) */
  playoff: string[]; winner: string | null;
  excluded: string | null;
  tournament: Record<string, unknown> | null;
}

/** an 18-hole par is a value of (strokes - score to par) that at least 5% of an event's rounds share, 54 or more */
export function fullPars(rounds: Array<{ strokes: number | null; to_par: string | null }>): number[] {
  const n: Record<number, number> = {};
  let tot = 0;
  for (const r of rounds) { const t = toPar(r.to_par); if (r.strokes != null && r.strokes > 0 && t != null) { n[r.strokes - t] = (n[r.strokes - t] || 0) + 1; tot++; } }
  return Object.entries(n).filter(([p, c]) => Number(p) >= 54 && c >= 0.05 * tot).map(([p]) => Number(p)).sort((a, b) => a - b);
}

/** one feed event -> a cleaned history event (excluded events keep their reason and no rounds) */
export function cleanEvent(e: any): HistEvent {
  const league = e.league as Tour, comps: any[] = e.competitors || [];
  const start = Date.parse(e.start || '');
  const base: HistEvent = { key: league + ':' + e.id, league, season: e.season, id: String(e.id), name: String(e.name || e.label || e.id), start, start_iso: e.start, course: e.course || null, par: e.par ?? null,
    full_pars: [], n_rounds: 0, players: [], playoff: [], winner: null, excluded: null, tournament: e.tournament || null };
  const all = comps.flatMap((c) => c.rounds || []);
  const vals = all.filter((r: any) => r.strokes > 0).map((r: any) => r.strokes).sort((a: number, b: number) => a - b);
  if (comps.length < 10) return { ...base, excluded: 'fewer than 10 competitors (a team match or exhibition)' };
  if (comps.some((c) => /\//.test(String(c.name)))) return { ...base, excluded: 'team event (competitors are pairs)' };
  if (!vals.length || vals[Math.floor(vals.length / 2)] < 50) return { ...base, excluded: 'not stroke play (round values are points: modified Stableford)' };
  if (!Number.isFinite(start)) return { ...base, excluded: 'no start date' };
  const pars = fullPars(all);
  if (!pars.length) return { ...base, excluded: 'no 18-hole par could be read from the rounds' };
  const players: HistPlayer[] = comps.map((c) => ({
    id: String(c.id), name: String(c.name), country: c.country || null, status: c.status as Status, playoff: false, position: c.position || null, sort_order: c.sort_order ?? null,
    rounds: (c.rounds || []).filter((r: any) => r.strokes != null && r.strokes > 0).map((r: any) => {
      const t = toPar(r.to_par), pp = t == null ? null : r.strokes - t;
      /* complete: the round's own par is an 18-hole par; without a score to par, a plausible 18-hole total */
      return { r: r.r, strokes: r.strokes, par_played: pp, complete: pp != null ? pars.includes(pp) && r.is_playoff !== true : r.strokes >= 55 };
    })
  }));
  const n_rounds = Math.max(0, ...players.map((p) => p.rounds.filter((r) => r.complete).reduce((m, r) => Math.max(m, r.r), 0)));
  /* a playoff: a linescore after the last regulation round, or one ESPN flags */
  const playoff = players.filter((p) => p.rounds.some((r) => r.r > n_rounds && !r.complete) || comps.find((c) => String(c.id) === p.id)?.rounds?.some((r: any) => r.is_playoff === true)).map((p) => p.id);
  for (const p of players) p.playoff = playoff.includes(p.id);
  const w = players.find((p) => p.position === '1' && (p.status === 'active' || p.status === 'mdf')) || null;
  return { ...base, full_pars: pars, n_rounds, players, playoff, winner: e.status === 'STATUS_FINAL' && w ? w.id : null };
}

export interface History { fetched_at: string; sha256: string; events: HistEvent[]; excluded: Array<{ key: string; name: string; reason: string }>; missing: unknown[] }
let HIST: History | null = null;
/** every FINAL event of the history feed, cleaned (an event still in progress is the current event's business, not history's) */
export function loadHistory(file: string = HISTORY_FILE): History {
  if (HIST && file === HISTORY_FILE) return HIST;
  const buf = fs.readFileSync(file);
  const text = zlib.gunzipSync(buf).toString('utf8');
  const doc = JSON.parse(text);
  if (doc.schema !== 'edgedesk_feed_golf_events_v1') throw new Error('not a golf events feed: ' + doc.schema);
  const events: HistEvent[] = [], excluded: History['excluded'] = [];
  for (const raw of doc.events) {
    if (raw.status !== 'STATUS_FINAL') continue;
    const e = cleanEvent(raw);
    if (e.excluded) excluded.push({ key: e.key, name: e.name, reason: e.excluded }); else events.push(e);
  }
  events.sort((a, b) => a.start - b.start || (a.key < b.key ? -1 : 1));
  const h: History = { fetched_at: doc.fetched_at, sha256: sha256OfText(text), events, excluded, missing: doc.missing || [] };
  if (file === HISTORY_FILE) HIST = h;
  return h;
}
function sha256OfText(t: string): string { return createHash('sha256').update(t).digest('hex'); }

/* ------------------------------------------------------------------ rounds */
/** every complete round of the given tours, as flat arrays (fit input): player, event-round, strokes, day */
export interface RoundTable {
  players: string[]; pidx: Map<string, number>;
  keys: string[];
  p: Int32Array; k: Int32Array; y: Float64Array; t: Float64Array; ev: Int32Array;
  /** the round number within its event (1..4) */
  rn: Int8Array;
  events: HistEvent[];
}
export function roundTable(events: HistEvent[]): RoundTable {
  const players: string[] = [], pidx = new Map<string, number>(), keys: string[] = [];
  const P: number[] = [], K: number[] = [], Y: number[] = [], T: number[] = [], EV: number[] = [], RN: number[] = [];
  events.forEach((e, ei) => {
    const kOf = new Map<number, number>();
    for (const pl of e.players) for (const r of pl.rounds) {
      if (!r.complete || r.r > e.n_rounds) continue;
      let pi = pidx.get(pl.id); if (pi == null) { pi = players.length; players.push(pl.id); pidx.set(pl.id, pi); }
      let ki = kOf.get(r.r); if (ki == null) { ki = keys.length; keys.push(e.key + ':' + r.r); kOf.set(r.r, ki); }
      P.push(pi); K.push(ki); Y.push(r.strokes); T.push((e.start + (r.r - 1) * DAY) / DAY); EV.push(ei); RN.push(r.r);
    }
  });
  return { players, pidx, keys, p: Int32Array.from(P), k: Int32Array.from(K), y: Float64Array.from(Y), t: Float64Array.from(T), ev: Int32Array.from(EV), rn: Int8Array.from(RN), events };
}

/* ------------------------------------------------------------------ the fit */
export interface SkillParams {
  half_life_days: number;
  /** the prior's weight in rounds: sigma^2 / tau^2 */
  kappa: number;
  /** the per-player sd's prior weight in rounds (Infinity: one sd for the tour) */
  nu0: number;
  /** rounds older than this are not read at all */
  window_days: number;
  /** the prior's mean shift, in strokes, for a player with 1..few_max rounds in the window, and for one with none
      (measured: such players score worse than the average player; golf_skill_study.ts) */
  prior_shift_few?: number; prior_shift_new?: number; few_max?: number;
}
export interface PlayerSkill { id: string; theta: number; n_eff: number; n_rounds: number; var_post: number; sd_round: number; last_day: number }
export interface SkillFit {
  as_of_day: number; params: SkillParams;
  players: Map<string, PlayerSkill>;
  /** the prior (an unseen player): mean and sd, relative to the round-weighted average */
  prior_mean: number; prior_sd: number;
  /** the pooled in-sample round sd (weighted residuals) */
  sigma: number;
  rounds_used: number; iterations: number;
  /** round levels a_k of the rounds read (strokes of a 0-skill player), for the course-level estimate */
  level: Map<string, number>;
}

/** the penalised least-squares fit at day T (rounds with t < T only); `warm` starts theta from an earlier fit */
export function fitSkills(tab: RoundTable, asOfDay: number, prm: SkillParams, warm?: Float64Array): SkillFit & { theta_raw: Float64Array } {
  const N = tab.y.length, NP = tab.players.length, NK = tab.keys.length;
  const use: number[] = [];
  for (let i = 0; i < N; i++) { const age = asOfDay - tab.t[i]; if (age > 0 && age <= prm.window_days) use.push(i); }
  const w = new Float64Array(N), lam = Math.LN2 / prm.half_life_days;
  for (const i of use) w[i] = Math.exp(-lam * (asOfDay - tab.t[i]));
  const theta = warm && warm.length === NP ? Float64Array.from(warm) : new Float64Array(NP);
  const a = new Float64Array(NK), cnt = new Float64Array(NK), num = new Float64Array(NP), den = new Float64Array(NP);
  /* each player's prior mean: the average player, shifted for a player the window holds few rounds of */
  const nraw = new Float64Array(NP), m = new Float64Array(NP), fewMax = prm.few_max ?? 24, shift = prm.prior_shift_few ?? 0;
  for (const i of use) nraw[tab.p[i]]++;
  if (shift) for (let p = 0; p < NP; p++) if (nraw[p] > 0 && nraw[p] <= fewMax) m[p] = shift;
  let it = 0;
  for (; it < 500; it++) {
    a.fill(0); cnt.fill(0);
    for (const i of use) { a[tab.k[i]] += tab.y[i] - theta[tab.p[i]]; cnt[tab.k[i]]++; }
    for (let k = 0; k < NK; k++) if (cnt[k]) a[k] /= cnt[k];
    num.fill(0); den.fill(prm.kappa);
    for (const i of use) { num[tab.p[i]] += w[i] * (tab.y[i] - a[tab.k[i]]); den[tab.p[i]] += w[i]; }
    let d = 0;
    for (let p = 0; p < NP; p++) { const v = (num[p] + prm.kappa * m[p]) / den[p]; d = Math.max(d, Math.abs(v - theta[p])); theta[p] = v; }
    if (d < 1e-6) break;
  }
  /* residuals, per-player weights and the round-weighted centre */
  const neff = new Float64Array(NP), nr = new Float64Array(NP), rss = new Float64Array(NP), last = new Float64Array(NP).fill(-Infinity);
  let sw = 0, swr = 0, cw = 0, cs = 0;
  for (const i of use) {
    const p = tab.p[i], r = tab.y[i] - a[tab.k[i]] - theta[p];
    neff[p] += w[i]; nr[p]++; rss[p] += w[i] * r * r; sw += w[i]; swr += w[i] * r * r;
    cw += w[i]; cs += w[i] * theta[p];
    if (tab.t[i] > last[p]) last[p] = tab.t[i];
  }
  const sigma2 = sw ? swr / sw : 9, c = cw ? cs / cw : 0;
  /* tau^2 = sigma^2 / kappa: the prior sd of a player's skill */
  const players = new Map<string, PlayerSkill>();
  for (let p = 0; p < NP; p++) {
    if (!nr[p]) continue;
    const s2 = Number.isFinite(prm.nu0) ? (prm.nu0 * sigma2 + rss[p]) / (prm.nu0 + neff[p]) : sigma2;
    players.set(tab.players[p], { id: tab.players[p], theta: theta[p] - c, n_eff: neff[p], n_rounds: nr[p], var_post: sigma2 / (neff[p] + prm.kappa), sd_round: Math.sqrt(s2), last_day: last[p] });
  }
  const level = new Map<string, number>();
  for (let k = 0; k < NK; k++) if (cnt[k]) level.set(tab.keys[k], a[k] + c);
  return { as_of_day: asOfDay, params: prm, players, prior_mean: (prm.prior_shift_new ?? 0) - c, prior_sd: Math.sqrt(sigma2 / prm.kappa), sigma: Math.sqrt(sigma2), rounds_used: use.length, iterations: it, level, theta_raw: theta };
}

/** a player's pre-event skill: fitted, or the prior for a player the window has never seen */
export function skillOf(fit: SkillFit, id: string): { theta: number; var_post: number; sd_round: number; n_eff: number; n_rounds: number; on_prior: boolean } {
  const s = fit.players.get(id);
  if (s) return { theta: s.theta, var_post: s.var_post, sd_round: s.sd_round, n_eff: s.n_eff, n_rounds: s.n_rounds, on_prior: false };
  return { theta: fit.prior_mean, var_post: fit.prior_sd * fit.prior_sd, sd_round: fit.sigma, n_eff: 0, n_rounds: 0, on_prior: true };
}

/** the tours each tour's fit reads (the study's choice: separate, or the PGA Tour and DP World Tour together) */
export function fitTours(tour: Tour, joint: Tour[][]): Tour[] {
  for (const g of joint) if (g.includes(tour)) return g;
  return [tour];
}
