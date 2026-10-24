/* ===========================================================================
   COLLEGE BASEBALL — one simulated NCAA tournament (format: bracket.ts).

   Every game is priced by the served model from a snapshot (model.ts): the
   two calibrated run expectations for its venue, turned into a win chance by
   the fitted run distribution. The rating uncertainty is drawn ONCE per
   simulated tournament, not per game: each team's strength is shifted by a
   draw from its posterior (its own part, plus its conference's part shared
   by every team of the conference), so a team the model underrates stays
   underrated through all its games. Per game this is the served price
   exactly (the same Gaussian the model integrates over); across games it is
   the correlation the model's uncertainty implies.

   VENUES. A regional host is at home in its games; every other regional
   game is neutral at the host's park; a regional the data shows with no host
   is neutral throughout. A super regional is at its host's park, the host at
   home. Omaha is neutral. The super-regional host, before it is known: the
   national seed if it advanced, else the other regional host, else the
   stronger team by rating (a bid is the committee's call; the proxy is
   checked against every past super regional in the backtest).

   RESULTS SO FAR. A game already played is never simulated: its winner is
   taken from the results (the n-th meeting of two teams is the n-th game
   between them; two teams meet in one round only), and the bracket goes on
   from there.
   =========================================================================== */
import type { Snapshot, TeamState } from './model.ts';
import { expectations, pricePinned } from './model.ts';

export interface Structure {
  /** teams[0] hosts (or is the 1 seed); game 1 is teams[0] v teams[3], game 2 teams[1] v teams[2] */
  pods: Array<{ teams: [string, string, string, string]; host: string | null; park: string | null }>;
  /** super regional k: the winners of pods[k][0] and pods[k][1]; host when known (null: by the proxy; 'neutral': no host) */
  supers: Array<{ pods: [number, number]; host?: string | 'neutral' | null }>;
  /** the two Omaha brackets: each two first-round games between the winners of two supers */
  cws: [[[number, number], [number, number]], [[number, number], [number, number]]];
  /** national seeds by team, when known */
  national?: Record<string, number>;
  /** each team's home park key (for a super it hosts) */
  homePark?: Record<string, string>;
  /** rounds already decided, from the results (each in the order of pods, supers) */
  fixed?: { regional?: string[]; supers?: string[] };
}
export interface Played { a: string; b: string; winner: string }
export interface Outcome { regional: string[]; supers: string[]; omaha: string[]; finalists: string[]; champion: string }

export interface Rng { nextDouble(): number }
function gauss(r: Rng): number { let u = r.nextDouble(); while (u <= 0) u = r.nextDouble(); const v = r.nextDouble(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

export class TournamentSim {
  S: Snapshot; st: Structure; private cache = new Map<string, [number, number]>();
  private played = new Map<string, string[]>();
  private draws = new Map<string, number>();
  private used = new Map<string, number>();
  constructor(S: Snapshot, st: Structure, played: Played[] = []) {
    this.S = S; this.st = st;
    for (const p of played) { const k = key(p.a, p.b); if (!this.played.has(k)) this.played.set(k, []); this.played.get(k)!.push(p.winner); }
    for (const p of st.pods) for (const t of p.teams) if (!S.teams[t]) throw new Error('college baseball: no rating for ' + t);
  }
  team(id: string): TeamState { return this.S.teams[id]; }
  private park(k: string | null | undefined): number { return k && this.S.parks[k] != null ? this.S.parks[k] : 0; }
  /** calibrated expectations (home h, away a) at a venue, cached */
  private exp(h: string, a: string, neutral: boolean, park: string | null | undefined): [number, number] {
    const k = h + '|' + a + '|' + (neutral ? 'n' : 'h') + '|' + (park || '');
    let e = this.cache.get(k);
    if (!e) { const x = expectations(this.S, this.team(h), this.team(a), { neutral, park: this.park(park) }); e = [x.lh, x.la]; this.cache.set(k, e); }
    return e;
  }
  /** the strength draws of one simulated tournament */
  private drawStrength(r: Rng) {
    this.draws.clear(); const conf = new Map<string, number>();
    for (const p of this.st.pods) for (const id of p.teams) {
      const t = this.team(id); if (!conf.has(t.conf)) conf.set(t.conf, gauss(r));
      this.draws.set(id, t.sd_team * gauss(r) + t.sd_conf * conf.get(t.conf)!);
    }
  }
  /** P(h beats a) at a venue, with this tournament's strength draws */
  pWin(h: string, a: string, neutral: boolean, park: string | null | undefined): number {
    const [lh, la] = this.exp(h, a, neutral, park);
    return pricePinned(lh, la, (this.draws.get(h) || 0) - (this.draws.get(a) || 0));
  }
  private game(r: Rng, h: string, a: string, neutral: boolean, park: string | null | undefined): [string, string] {
    const k = key(h, a); const list = this.played.get(k); const n = this.used.get(k) || 0;
    if (list && n < list.length) { this.used.set(k, n + 1); const w = list[n]; return w === h ? [h, a] : [a, h]; }
    return r.nextDouble() < this.pWin(h, a, neutral, park) ? [h, a] : [a, h];
  }
  /** four-team double elimination; venue(x, y) gives [home, away, neutral, park] */
  private double(r: Rng, g1: [string, string], g2: [string, string], venue: (x: string, y: string) => [string, string, boolean, string | null]): string {
    const play = (x: string, y: string) => { const v = venue(x, y); return this.game(r, v[0], v[1], v[2], v[3]); };
    const [w1, l1] = play(g1[0], g1[1]); const [w2, l2] = play(g2[0], g2[1]);
    const [w3] = play(l1, l2); const [w4, l4] = play(w1, w2);
    const [w5] = play(l4, w3); const [w6] = play(w4, w5);
    if (w6 === w4) return w4;
    return play(w4, w5)[0];
  }
  private series(r: Rng, x: string, y: string, venue: (x: string, y: string) => [string, string, boolean, string | null]): string {
    let wx = 0, wy = 0;
    while (wx < 2 && wy < 2) { const v = venue(x, y); const [w] = this.game(r, v[0], v[1], v[2], v[3]); if (w === x) wx++; else wy++; }
    return wx === 2 ? x : y;
  }
  /** who hosts a super regional between x (from pod px) and y (from pod py) */
  superHost(k: number, x: string, y: string): string | null {
    const sp = this.st.supers[k];
    if (sp.host === 'neutral') return null;
    if (sp.host && (sp.host === x || sp.host === y)) return sp.host;
    const nat = this.st.national || {};
    const isHost = (t: string) => this.st.pods.some((p) => p.host === t);
    const net = (t: string) => this.team(t).off + this.team(t).def;
    const rank = (t: string): [number, number] => [nat[t] ? 0 : isHost(t) ? 1 : 2, nat[t] ? nat[t] : -net(t)];
    const a = rank(x), b = rank(y);
    return a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]) ? x : y;
  }
  run(r: Rng): Outcome {
    this.used.clear(); this.drawStrength(r);
    const fx = this.st.fixed || {};
    const regional = fx.regional || this.st.pods.map((p) => {
      const venue = (x: string, y: string): [string, string, boolean, string | null] => {
        if (p.host && (x === p.host || y === p.host)) return x === p.host ? [x, y, false, p.park] : [y, x, false, p.park];
        return [x, y, true, p.park];
      };
      return this.double(r, [p.teams[0], p.teams[3]], [p.teams[1], p.teams[2]], venue);
    });
    const supers = fx.supers || this.st.supers.map((sp, k) => {
      const x = regional[sp.pods[0]], y = regional[sp.pods[1]];
      const host = this.superHost(k, x, y);
      const park = host ? (this.st.homePark || {})[host] || null : null;
      const venue = (a: string, b: string): [string, string, boolean, string | null] => (host ? (a === host ? [a, b, false, park] : [b, a, false, park]) : [a, b, true, null]);
      return this.series(r, x, y, venue);
    });
    const neutral = (a: string, b: string): [string, string, boolean, string | null] => [a, b, true, null];
    const finalists = this.st.cws.map((br) => this.double(r, [supers[br[0][0]], supers[br[0][1]]], [supers[br[1][0]], supers[br[1][1]]], neutral));
    const champion = this.series(r, finalists[0], finalists[1], neutral);
    return { regional, supers, omaha: supers, finalists, champion };
  }
}
function key(a: string, b: string): string { return a < b ? a + '|' + b : b + '|' + a; }

export interface Tally { n: number; regional: Map<string, number>; omaha: Map<string, number>; finalist: Map<string, number>; champion: Map<string, number> }
/** n simulated tournaments, counted per team */
export function simulate(sim: TournamentSim, n: number, rng: Rng): Tally {
  const T: Tally = { n, regional: new Map(), omaha: new Map(), finalist: new Map(), champion: new Map() };
  const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) || 0) + 1);
  for (let i = 0; i < n; i++) {
    const o = sim.run(rng);
    for (const t of o.regional) inc(T.regional, t);
    for (const t of o.omaha) inc(T.omaha, t);
    for (const t of o.finalists) inc(T.finalist, t);
    inc(T.champion, o.champion);
  }
  return T;
}
