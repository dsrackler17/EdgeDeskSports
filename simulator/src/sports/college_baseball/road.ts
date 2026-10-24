/* ===========================================================================
   COLLEGE BASEBALL — the ROAD TO OMAHA: a season not yet scheduled,
   simulated from its preseason ratings to a champion.

   No schedule of the season exists before it is played, so the season is
   not simulated game by game. Three measured steps take the preseason
   ratings (the served model's priors: model.ts, at the season's start) to
   the tournament (sim.ts):

   1. THE SEASON. Each team's rating on Selection Monday is drawn around its
      preseason rating, as past seasons moved:
          net(selection) = mean + slope x (net(preseason) - mean) + conference draw + team draw
      slope and the two sds measured on past seasons (the replayed model's
      preseason against its Selection-Monday rating). Offence and defence
      move by half the change each.
   2. THE COMMITTEE, a proxy (it never sees these ratings; it sees records
      and metrics the ratings summarise). Each conference with an automatic
      bid sends one team, its tournament's winner, drawn with chances in
      proportion to exp(k x net) (k measured on the one-bid conferences,
      whose sole team in the field is certainly the winner); the at-large
      bids go to the best of the rest by net plus a selection noise (sd tau,
      measured on past fields); the sixteen hosts are the best of the field
      by net plus a hosting noise (sd tau_host, measured on past hosts), the
      first eight of them the national seeds. The regionals follow the
      S-curve (host k with 2 seed 33-k, 3 seed 32+k, 4 seed 65-k, by the
      same noisy order), the supers pair national seed k with host 17-k, and
      Omaha's brackets hold seeds 1, 8, 4, 5 and 2, 7, 3, 6. Geography,
      which moves real 2-4 seeds between regionals, is not modelled.
   3. THE TOURNAMENT, priced by the served model from the drawn ratings,
      with the posterior sds the model has on a Selection Monday (measured).
   =========================================================================== */
import type { Snapshot, TeamState } from './model.ts';
import { TournamentSim, type Structure, type Rng } from './sim.ts';

export interface DriftParams { slope: number; conf_sd: number; team_sd: number; end_sd_team: number; end_sd_conf: number; seasons: number[] }
/** the season's move from a checkpoint: days before the first regional game (the preseason: before the season's first game) */
export interface DriftAt extends DriftParams { checkpoint: string; days: number }
export interface SelectParams { k: number; tau: number; tau_host: number; seasons: number[] }
export interface RoadParams { drift: DriftParams; select: SelectParams }

function gauss(r: Rng): number { let u = r.nextDouble(); while (u <= 0) u = r.nextDouble(); const v = r.nextDouble(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const net = (t: TeamState) => t.off + t.def;
const med = (xs: number[]) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
export const hasAq = (conf: string) => !!conf && !/^none_/.test(conf) && !/independent/i.test(conf);

/* ------------------------------------------------------------ measuring the season */
/** slope and sds of the preseason-to-Selection-Monday move, pooled over seasons */
export function fitDrift(pairs: Array<{ season: number; pre: Snapshot; sel: Snapshot }>): DriftParams {
  let sxy = 0, sxx = 0; const res: Array<{ season: number; conf: string; r: number }> = []; const sdT: number[] = [], sdC: number[] = [];
  const prep = pairs.map((p) => {
    const ids = Object.keys(p.sel.teams).filter((id) => p.pre.teams[id]);
    const pre = ids.map((id) => net(p.pre.teams[id])), sel = ids.map((id) => net(p.sel.teams[id]));
    const mp = pre.reduce((a, b) => a + b, 0) / pre.length, ms = sel.reduce((a, b) => a + b, 0) / sel.length;
    for (let i = 0; i < ids.length; i++) { sxy += (pre[i] - mp) * (sel[i] - ms); sxx += (pre[i] - mp) ** 2; }
    for (const id of ids) { sdT.push(p.sel.teams[id].sd_team); sdC.push(p.sel.teams[id].sd_conf); }
    return { p, ids, pre, sel, mp, ms };
  });
  const slope = sxy / sxx;
  for (const x of prep) x.ids.forEach((id, i) => res.push({ season: x.p.season, conf: x.p.sel.teams[id].conf, r: x.sel[i] - x.ms - slope * (x.pre[i] - x.mp) }));
  /* conference part by the method of moments: the variance of conference means beyond what team draws explain */
  const by = new Map<string, number[]>(); for (const x of res) { const k = x.season + '|' + x.conf; if (!by.has(k)) by.set(k, []); by.get(k)!.push(x.r); }
  let within = 0, nW = 0, between = 0, nB = 0, invN = 0;
  for (const [k, xs] of by) { if (/\|none_/.test(k) || xs.length < 4) continue; const m = xs.reduce((a, b) => a + b, 0) / xs.length; between += m * m; nB++; invN += 1 / xs.length; for (const x of xs) { within += (x - m) ** 2; nW++; } }
  const vw = within / Math.max(1, nW - nB); const vb = Math.max(0, between / nB - vw * invN / nB);
  return { slope: r5(slope), conf_sd: r5(Math.sqrt(vb)), team_sd: r5(Math.sqrt(vw)), end_sd_team: r5(med(sdT)), end_sd_conf: r5(med(sdC)), seasons: pairs.map((p) => p.season) };
}
const r5 = (x: number) => Math.round(x * 1e5) / 1e5;

/** the move left from a date `days` before the first regional game: interpolated between the measured checkpoints
    (slopes linearly, sds in variance); the preseason checkpoint before the season's first game */
export function driftAt(cps: DriftAt[], days: number, preseason: boolean): DriftParams {
  const pre = cps.find((c) => c.checkpoint === 'preseason');
  if (preseason && pre) return pre;
  const xs = cps.filter((c) => c.checkpoint !== 'preseason').sort((a, b) => b.days - a.days);
  if (!xs.length) return pre!;
  if (days >= xs[0].days) return xs[0];
  if (days <= xs[xs.length - 1].days) return xs[xs.length - 1];
  let i = 0; while (xs[i + 1].days > days) i++;
  const a = xs[i], b = xs[i + 1], w = (a.days - days) / (a.days - b.days);
  const lin = (x: number, y: number) => x + w * (y - x), vr = (x: number, y: number) => Math.sqrt(lin(x * x, y * y));
  return { slope: lin(a.slope, b.slope), conf_sd: vr(a.conf_sd, b.conf_sd), team_sd: vr(a.team_sd, b.team_sd), end_sd_team: lin(a.end_sd_team, b.end_sd_team), end_sd_conf: lin(a.end_sd_conf, b.end_sd_conf), seasons: a.seasons };
}

/* ------------------------------------------------------------ the committee proxy */
export interface SelectionInput { season: number; teams: TeamState[]; aq: Set<string>; field: Set<string>; hosts: Set<string> | null }
function draw(teams: TeamState[], ratings: Map<string, number>, aq: Set<string>, p: { k: number; tau: number; tau_host: number }, r: Rng) {
  const byConf = new Map<string, TeamState[]>(); for (const t of teams) if (aq.has(t.conf)) { if (!byConf.has(t.conf)) byConf.set(t.conf, []); byConf.get(t.conf)!.push(t); }
  const field = new Set<string>(); const auto = new Set<string>();
  for (const [, ts] of [...byConf.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const w = ts.map((t) => Math.exp(p.k * ratings.get(t.id)!)); const tot = w.reduce((a, b) => a + b, 0);
    let u = r.nextDouble() * tot, i = 0; while (i < ts.length - 1 && u >= w[i]) { u -= w[i]; i++; }
    field.add(ts[i].id); auto.add(ts[i].id);
  }
  const score = new Map<string, number>(); for (const t of teams) score.set(t.id, ratings.get(t.id)! + p.tau * gauss(r));
  const rest = teams.filter((t) => !field.has(t.id)).sort((a, b) => score.get(b.id)! - score.get(a.id)!);
  for (const t of rest.slice(0, 64 - field.size)) field.add(t.id);
  const hs = new Map<string, number>(); for (const id of field) hs.set(id, ratings.get(id)! + p.tau_host * gauss(r));
  const byHost = [...field].sort((a, b) => hs.get(b)! - hs.get(a)!);
  return { field, auto, hosts: byHost.slice(0, 16), others: byHost.slice(16).sort((a, b) => score.get(b)! - score.get(a)!) };
}

/** k by exact likelihood on the one-bid conferences; tau and tau_host by the simulated likelihood of past fields and hosts */
export function fitSelection(xs: SelectionInput[], rng: () => Rng, sims = 600): SelectParams {
  const rating = (t: TeamState) => net(t);
  let bestK = 0, bestL = -Infinity;
  for (let k = 0; k <= 40; k += 0.5) {
    let L = 0;
    for (const x of xs) {
      const by = new Map<string, TeamState[]>(); for (const t of x.teams) if (x.aq.has(t.conf)) { if (!by.has(t.conf)) by.set(t.conf, []); by.get(t.conf)!.push(t); }
      for (const ts of by.values()) {
        const inF = ts.filter((t) => x.field.has(t.id)); if (inF.length !== 1 || ts.length < 2) continue;
        const m = Math.max(...ts.map((t) => k * rating(t)));
        L += k * rating(inF[0]) - m - Math.log(ts.reduce((a, t) => a + Math.exp(k * rating(t) - m), 0));
      }
    }
    if (L > bestL) { bestL = L; bestK = k; }
  }
  const bll = (p: number, y: boolean) => -Math.log(Math.min(1 - 1e-4, Math.max(1e-4, y ? p : 1 - p)));
  const grid = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.10, 0.12, 0.15, 0.20];
  let bestT = grid[0], bestTL = Infinity;
  for (const tau of grid) {
    let L = 0;
    for (const x of xs) {
      const ratings = new Map(x.teams.map((t) => [t.id, rating(t)])); const cnt = new Map<string, number>(); const r = rng();
      for (let i = 0; i < sims; i++) for (const id of draw(x.teams, ratings, x.aq, { k: bestK, tau, tau_host: 0 }, r).field) cnt.set(id, (cnt.get(id) || 0) + 1);
      for (const t of x.teams) L += bll((cnt.get(t.id) || 0) / sims, x.field.has(t.id));
    }
    if (L < bestTL) { bestTL = L; bestT = tau; }
  }
  let bestH = grid[0], bestHL = Infinity;
  for (const tau_host of grid) {
    let L = 0;
    for (const x of xs) {
      if (!x.hosts) continue;
      const fieldTeams = x.teams.filter((t) => x.field.has(t.id)); const r = rng(); const cnt = new Map<string, number>();
      for (let i = 0; i < sims; i++) { const hs = fieldTeams.map((t) => [t.id, rating(t) + tau_host * gauss(r)] as [string, number]).sort((a, b) => b[1] - a[1]); for (const [id] of hs.slice(0, 16)) cnt.set(id, (cnt.get(id) || 0) + 1); }
      for (const t of fieldTeams) L += bll((cnt.get(t.id) || 0) / sims, x.hosts.has(t.id));
    }
    if (L < bestHL) { bestHL = L; bestH = tau_host; }
  }
  return { k: bestK, tau: bestT, tau_host: bestH, seasons: xs.map((x) => x.season) };
}

/* ------------------------------------------------------------ one simulated season */
export interface RoadOutcome { field: Set<string>; auto: Set<string>; hosts: string[]; national: string[]; regional: string[]; omaha: string[]; finalists: string[]; champion: string }
export class RoadSim {
  pre: Snapshot; teams: TeamState[]; aq: Set<string>; P: RoadParams; homePark: Record<string, string>; mean: number;
  constructor(pre: Snapshot, teamIds: string[], aq: Set<string>, P: RoadParams, homePark: Record<string, string>) {
    this.pre = pre; this.teams = teamIds.filter((id) => pre.teams[id]).map((id) => pre.teams[id]); this.aq = aq; this.P = P; this.homePark = homePark;
    this.mean = this.teams.reduce((a, t) => a + net(t), 0) / this.teams.length;
  }
  /** one season: the move (rd), the committee (rc) and the tournament (rg), each on its own stream when given */
  run(rd: Rng, rc: Rng = rd, rg: Rng = rd): RoadOutcome {
    const d = this.P.drift; const r = rd; const conf = new Map<string, number>(); const ratings = new Map<string, number>(); const moved: Record<string, TeamState> = {};
    for (const t of this.teams) {
      if (!conf.has(t.conf)) conf.set(t.conf, /^none_/.test(t.conf) ? 0 : d.conf_sd * gauss(r));
      const x = this.mean + d.slope * (net(t) - this.mean) + conf.get(t.conf)! + d.team_sd * gauss(r);
      ratings.set(t.id, x); const ch = (x - net(t)) / 2;
      moved[t.id] = { id: t.id, name: t.name, conf: t.conf, off: t.off + ch, def: t.def + ch, sd_team: d.end_sd_team, sd_conf: /^none_/.test(t.conf) ? 0 : d.end_sd_conf, info: 0 };
    }
    const s = draw(this.teams, ratings, this.aq, this.P.select, rc);
    const seed = [...s.hosts, ...s.others];          // overall seeds 1-64
    const pods: Structure['pods'] = [];
    for (let k = 1; k <= 16; k++) { const h = seed[k - 1]; pods.push({ teams: [h, seed[33 - k - 1], seed[32 + k - 1], seed[65 - k - 1]], host: h, park: this.homePark[h] || null }); }
    const supers: Structure['supers'] = []; for (let k = 1; k <= 8; k++) supers.push({ pods: [k - 1, 16 - k] });
    const national: Record<string, number> = {}; for (let k = 1; k <= 8; k++) national[seed[k - 1]] = k;
    const snap: Snapshot = Object.assign({}, this.pre, { teams: moved });
    const sim = new TournamentSim(snap, { pods, supers, cws: [[[0, 7], [3, 4]], [[1, 6], [2, 5]]], national, homePark: this.homePark });
    const o = sim.run(rg);
    return { field: s.field, auto: s.auto, hosts: s.hosts, national: s.hosts.slice(0, 8), regional: o.regional, omaha: o.omaha, finalists: o.finalists, champion: o.champion };
  }
}

export const LEVELS = ['field', 'host', 'national', 'regional', 'omaha', 'finalist', 'champion'] as const;
export type Level = typeof LEVELS[number];
export interface RoadTally { n: number; counts: Record<Level, Map<string, number>>; auto: Map<string, number> }
export function simulateRoad(sim: RoadSim, n: number, r: Rng): RoadTally {
  const counts = Object.fromEntries(LEVELS.map((l) => [l, new Map<string, number>()])) as Record<Level, Map<string, number>>; const auto = new Map<string, number>();
  const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) || 0) + 1);
  for (let i = 0; i < n; i++) {
    const o = sim.run(r);
    for (const t of o.field) inc(counts.field, t); for (const t of o.auto) inc(auto, t);
    for (const t of o.hosts) inc(counts.host, t); for (const t of o.national) inc(counts.national, t);
    for (const t of o.regional) inc(counts.regional, t); for (const t of o.omaha) inc(counts.omaha, t);
    for (const t of o.finalists) inc(counts.finalist, t); inc(counts.champion, o.champion);
  }
  return { n, counts, auto };
}
