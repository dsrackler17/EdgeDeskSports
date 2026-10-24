/* ===========================================================================
   DOES THE ROAD TO OMAHA CALL A SEASON BEFORE IT IS PLAYED? — the walk-
   forward backtest of the season simulation (simulator/src/sports/
   college_baseball/road.ts), and the parameters the next season runs with.

   The served model is replayed once (model.ts), keeping each season's
   ratings at five CHECKPOINTS: the preseason (its priors, before a game),
   and 70, 42, 21 and 7 days before the first regional game (the model
   before that date's games); and on Selection Monday (the morning of the
   first regional game). For each season from 2016 whose tournament rebuilds
   (bracket.ts), every parameter is measured on EARLIER seasons only (from
   2014): the move left from each checkpoint to Selection Monday
   (road.ts fitDrift) and the committee proxy (road.ts fitSelection). The
   season is then simulated 5,000 times from each checkpoint. Scored against
   what happened, per Division I team: making the field, hosting a regional,
   reaching Omaha, the title (log loss), against
     - the base rates (64, 16, 8 and 1 of the Division I teams), and
     - last season: the rates, in the earlier seasons, of teams that went as
       far the season before (out, in the field, in Omaha),
   each difference with a season-bootstrap 95% interval (2,000 resamples),
   and the calibration of the field chance in bins.
   Known in advance and used as such: each season's Division I programs and
   which conferences hold an automatic bid.

   The next season's parameters are then measured on every season, 2014 to
   the warehouse's last, and written beside the backtest.

   Output: simulator/data/college_baseball_road.json
   Usage: node simulator/src/research/college_baseball_road_backtest.ts
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { replay, REPO, LAST_SEASON, d1Teams, W, type Snapshot } from '../sports/college_baseball/model.ts';
import { reconstruct, homeParks, type Tournament } from '../sports/college_baseball/bracket.ts';
import { fitDrift, fitSelection, RoadSim, simulateRoad, hasAq, type DriftAt, type SelectParams, type SelectionInput } from '../sports/college_baseball/road.ts';
import { streamFor, STREAM } from '../core/prng.ts';

export const ROAD_FILE = path.join(REPO, 'simulator', 'data', 'college_baseball_road.json');
export const ROAD_SCHEMA = 'edgedesk_sim_cbase_road_v1';
export const CHECKPOINTS: Array<{ checkpoint: string; days: number | null }> = [{ checkpoint: 'preseason', days: null }, { checkpoint: 'd70', days: 70 }, { checkpoint: 'd42', days: 42 }, { checkpoint: 'd21', days: 21 }, { checkpoint: 'd7', days: 7 }];
const N = 5000, BOOT = 2000, SEED = 20270214n, FIRST_TARGET = 2016;
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const bll = (p: number, y: boolean) => -Math.log(Math.min(1 - 1e-6, Math.max(1e-6, y ? p : 1 - p)));
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
function boot(xs: number[], seed: number): { mean: number; ci95: [number, number] } {
  const r = streamFor(SEED, seed, STREAM.coin); const m: number[] = [];
  for (let b = 0; b < BOOT; b++) { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[Math.floor(r.nextDouble() * xs.length)]; m.push(s / xs.length); }
  m.sort((a, b) => a - b);
  return { mean: r4(xs.reduce((a, b) => a + b, 0) / xs.length), ci95: [r4(m[Math.floor(0.025 * BOOT)]), r4(m[Math.floor(0.975 * BOOT) - 1])] };
}

export function selectionInput(season: number, t: Tournament, sel: Snapshot): SelectionInput {
  const hosts = t.pods.filter((p) => p.host).map((p) => p.host!);
  return { season, teams: Object.values(sel.teams), aq: aqOf(t, sel), field: new Set(t.field), hosts: hosts.length === 16 ? new Set(hosts) : null };
}
export const aqOf = (t: Tournament, S: Snapshot) => new Set<string>(t.field.map((id) => S.teams[id] && S.teams[id].conf).filter((c) => !!c && hasAq(c)));

const STAGES = ['out', 'field', 'omaha'] as const;
function stageOf(t: Tournament | undefined, id: string): typeof STAGES[number] { if (!t) return 'out'; if (t.supers.some((s) => s.winner === id)) return 'omaha'; return t.field.includes(id) ? 'field' : 'out'; }
const LEVEL = ['field', 'host', 'omaha', 'champion'] as const;
function actual(t: Tournament, id: string, level: typeof LEVEL[number]): boolean {
  if (level === 'field') return t.field.includes(id);
  if (level === 'host') return t.pods.some((p) => p.host === id);
  if (level === 'omaha') return t.supers.some((s) => s.winner === id);
  return t.cws.champion === id;
}
const keyOf = (s: number, cp: string) => s + ':' + cp;

export function runRoad(o: { n?: number; log?: boolean } = {}) {
  const n = o.n || N;
  const T = new Map<number, Tournament>(); const at: any[] = [];
  for (let s = 2014; s <= LAST_SEASON; s++) {
    const x = reconstruct(s); if (!x.t) continue; T.set(s, x.t);
    for (const c of CHECKPOINTS) at.push({ season: s, date: c.days == null ? s + '-01-01' : addDays(x.t.start, -c.days), teams: null, key: keyOf(s, c.checkpoint) });
    at.push({ season: s, date: x.t.start, teams: null, key: keyOf(s, 'sel') });
  }
  const rp = replay({ through: LAST_SEASON, at, preseason: LAST_SEASON + 1 });
  if (o.log) console.error('replay ' + rp.seconds.toFixed(1) + 's');
  const seasons = [...T.keys()].sort();
  const snap = (k: string) => rp.snapshots.get(k)!;
  let fitStream = 0; const rngF = () => streamFor(SEED, 1000 + fitStream++, STREAM.committee);
  const drifts = (upTo: number): DriftAt[] => {
    const fit = seasons.filter((s) => s < upTo);
    return CHECKPOINTS.map((c) => Object.assign(fitDrift(fit.map((s) => ({ season: s, pre: snap(keyOf(s, c.checkpoint)), sel: snap(keyOf(s, 'sel')) }))), { checkpoint: c.checkpoint, days: c.days == null ? daysOfSeason(upTo) : c.days }));
  };
  /* the preseason checkpoint's distance: from the median first game to the first regional game, in the fitted seasons */
  const daysOfSeason = (upTo: number) => { const xs = seasons.filter((s) => s < upTo).map((s) => Math.round((Date.parse(T.get(s)!.start) - Date.parse(firstGame(s))) / 864e5)).sort((a, b) => a - b); return xs[Math.floor(xs.length / 2)]; };
  const selection = (upTo: number): SelectParams => fitSelection(seasons.filter((s) => s < upTo).map((s) => selectionInput(s, T.get(s)!, snap(keyOf(s, 'sel')))), rngF);
  const per: any[] = []; const calib: Record<string, Array<{ p: number; y: boolean }>> = {};
  for (const S of seasons.filter((s) => s >= FIRST_TARGET)) {
    const D = drifts(S), sel = selection(S); const t = T.get(S)!;
    const prevSeason = seasons.filter((s) => s < S).pop()!; const prev = T.get(prevSeason);
    const parks = homeParks(prevSeason, '9999-12-31'); const aq = aqOf(t, snap(keyOf(S, 'sel')));
    /* last season's stage rates, from the earlier seasons' pairs */
    const rates: Record<string, Record<string, [number, number]>> = {};
    for (const s of seasons.filter((x) => x < S && x > seasons[0])) {
      const p0 = T.get(seasons[seasons.indexOf(s) - 1]); const ts = T.get(s)!;
      for (const id of d1Teams(s)) { const st = stageOf(p0, id); for (const l of LEVEL) { rates[l] = rates[l] || {}; const k = rates[l][st] = rates[l][st] || [0, 0]; k[1]++; if (actual(ts, id, l)) k[0]++; } }
    }
    const row: any = { season: S, prev_season: prevSeason, selection: sel, checkpoints: {} };
    for (const c of CHECKPOINTS) {
      const cur = snap(keyOf(S, c.checkpoint)); const ids = d1Teams(S).filter((id) => cur.teams[id]);
      const sim = new RoadSim(cur, ids, aq, { drift: D.find((x) => x.checkpoint === c.checkpoint)!, select: sel }, parks);
      const tal = simulateRoad(sim, n, streamFor(SEED, S * 10 + CHECKPOINTS.indexOf(c), STREAM.postseason));
      const cr: any = { teams: ids.length, levels: {} };
      for (const l of LEVEL) {
        const base = ({ field: 64, host: 16, omaha: 8, champion: 1 } as const)[l] / ids.length;
        let m = 0, b = 0, ly = 0;
        for (const id of ids) {
          const y = actual(t, id, l); const pm = (tal.counts[l].get(id) || 0) / n;
          const k = (rates[l] || {})[stageOf(prev, id)] || [0, 0]; const pl = (k[0] + 0.5) / (k[1] + 1);
          m += bll(pm, y); b += bll(base, y); ly += bll(pl, y);
          if (l === 'field') (calib[c.checkpoint] = calib[c.checkpoint] || []).push({ p: pm, y });
        }
        cr.levels[l] = { model: r4(m / ids.length), base_rate: r4(b / ids.length), last_season: r4(ly / ids.length) };
      }
      const champ = t.cws.champion; const order = ids.slice().sort((a, b) => (tal.counts.champion.get(b) || 0) - (tal.counts.champion.get(a) || 0));
      cr.champion = { name: t.names[champ], p: r4((tal.counts.champion.get(champ) || 0) / n), rank: order.indexOf(champ) + 1 };
      cr.favourites = order.slice(0, 3).map((id) => ({ name: cur.teams[id].name, p: r4((tal.counts.champion.get(id) || 0) / n) }));
      cr.top64_in_field = ids.slice().sort((a, b) => (tal.counts.field.get(b) || 0) - (tal.counts.field.get(a) || 0)).slice(0, 64).filter((id) => t.field.includes(id)).length;
      row.checkpoints[c.checkpoint] = cr;
      if (o.log) console.error(S + ' ' + c.checkpoint + ': field ' + cr.levels.field.model + ' (last season ' + cr.levels.field.last_season + ') omaha ' + cr.levels.omaha.model + ' champion ' + cr.champion.name + ' ' + (100 * cr.champion.p).toFixed(1) + '% (rank ' + cr.champion.rank + '), top 64 in field ' + cr.top64_in_field);
    }
    row.drift = D;
    per.push(row);
  }
  const summary: any = {};
  CHECKPOINTS.forEach((c, ci) => {
    const lv: any = {};
    LEVEL.forEach((l, i) => {
      const xs = per.map((x) => x.checkpoints[c.checkpoint].levels[l]);
      const mean = (k: string) => r4(xs.reduce((a, x) => a + x[k], 0) / xs.length);
      lv[l] = { model: mean('model'), base_rate: mean('base_rate'), last_season: mean('last_season'), diff_vs_base_rate: boot(xs.map((x) => x.model - x.base_rate), 100 * ci + i), diff_vs_last_season: boot(xs.map((x) => x.model - x.last_season), 100 * ci + 10 + i) };
    });
    const cal = calib[c.checkpoint] || [];
    const bins = [[0, 0.05], [0.05, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 0.95], [0.95, 1.01]].map(([lo, hi]) => { const xs = cal.filter((x) => x.p >= lo && x.p < hi); return { bin: lo + '-' + Math.min(1, hi), n: xs.length, mean_chance: xs.length ? r4(xs.reduce((a, x) => a + x.p, 0) / xs.length) : null, made_field: xs.length ? r4(xs.filter((x) => x.y).length / xs.length) : null }; });
    summary[c.checkpoint] = { days: c.days, levels: lv, field_calibration: bins, top64_in_field: r4(per.reduce((a, x) => a + x.checkpoints[c.checkpoint].top64_in_field, 0) / per.length) };
  });
  const next = LAST_SEASON + 1; const last = seasons[seasons.length - 1];
  const pre = snap('preseason:' + next);
  return {
    schema: ROAD_SCHEMA, generated_at: new Date().toISOString(), model_version: rp.version, sims_per_checkpoint: n, seasons_fitted: seasons, targets: per.map((x) => x.season),
    checkpoints: CHECKPOINTS, summary, per_season: per,
    next: { season: next, drift: drifts(next), select: selection(next), aq_conferences: [...aqOf(T.get(last)!, snap(keyOf(last, 'sel')))].sort(), calibration: pre.cal, teams: Object.keys(pre.teams).length }
  };
}
function firstGame(s: number): string { return W.results(s, s).reduce((m: string, g: any) => (g.date < m ? g.date : m), s + '-12-31'); }

if (import.meta.url === 'file://' + process.argv[1]) {
  const out = runRoad({ log: true });
  fs.writeFileSync(ROAD_FILE, JSON.stringify(out, null, 1) + '\n');
  for (const c of CHECKPOINTS) console.error(c.checkpoint + ' ' + JSON.stringify(Object.fromEntries(Object.entries(out.summary[c.checkpoint].levels).map(([k, v]: any) => [k, [v.model, v.base_rate, v.last_season, v.diff_vs_last_season.ci95]]))));
  console.error('calibration preseason ' + JSON.stringify(out.summary.preseason.field_calibration));
  console.error('next ' + JSON.stringify({ drift: out.next.drift.map((d: any) => [d.checkpoint, d.days, d.slope, d.team_sd, d.conf_sd]), select: out.next.select }));
  console.error('wrote ' + ROAD_FILE);
}
