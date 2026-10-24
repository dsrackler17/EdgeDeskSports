/* ===========================================================================
   DOES THE SERVED MODEL CALL NCAA TOURNAMENTS? — the backtest of the
   college baseball tournament simulation (simulator/src/sports/
   college_baseball/sim.ts) on every tournament the warehouse holds whole.

   For each season whose bracket rebuilds from its games (bracket.ts; the
   others are listed with the reason: 2020 had no tournament, the warehouse
   stops before 2023's), the served model is replayed to the morning of the
   first regional game (model.ts: every earlier game, nothing after) and the
   tournament is simulated 20,000 times from there:
     - each regional's winner: -ln P(winner), against every team equal (ln 4)
       and against the seed lines' past rates (the host, its first opponent
       the 4 seed, the other two; rates from the OTHER seasons);
     - reaching Omaha, every team of the field: the Brier score and the log
       loss, against 8 in 64 and the seed lines;
     - the champion: -ln P(champion), against ln 64 and the seed lines;
   each difference with a bootstrap 95% interval (pods for the regionals,
   seasons for the rest; 2,000 resamples). From the morning Omaha opens (the
   model replayed through the super regionals), the champion among the eight
   against 1 in 8.
   The single games too: every tournament game priced the morning of its date
   (the walk-forward's own out-of-sample predictions, calibrated as the
   betting board is), against a coin.
   And the super-regional host proxy (sim.ts superHost) against each past
   super regional's actual host.

   WINDOWS. The served configuration was chosen on 2014-2022 games
   (college_baseball/config.js WINDOWS.team: SELECTION), checked on 2023-2024
   (VALIDATION) and 2025-2026 (HOLDOUT). Ratings are point-in-time in every
   season; the configuration is in-sample before 2023. Both are reported.

   Output: simulator/data/college_baseball_backtest.json
   Usage: node simulator/src/research/college_baseball_tournament_backtest.ts
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { replay, REPO, LAST_SEASON, pHome, type Snapshot, type Row } from '../sports/college_baseball/model.ts';
import { reconstruct, homeParks, structureOf, type Tournament } from '../sports/college_baseball/bracket.ts';
import { TournamentSim, simulate, type Tally } from '../sports/college_baseball/sim.ts';
import { streamFor, STREAM } from '../core/prng.ts';
import { createRequire } from 'node:module';

export const BACKTEST_FILE = path.join(REPO, 'simulator', 'data', 'college_baseball_backtest.json');
export const BACKTEST_SCHEMA = 'edgedesk_sim_cbase_backtest_v1';
const req = createRequire(import.meta.url);
const TQ = req(path.join(REPO, 'college_baseball', 'lib', 'team_quality.js'));
const CAL = req(path.join(REPO, 'college_baseball', 'lib', 'calibration.js'));
const N = 20000, BOOT = 2000, SEED = 20270601n;
const r4 = (x: number) => Math.round(x * 1e4) / 1e4, r6 = (x: number) => Math.round(x * 1e6) / 1e6;
export const windowOf = (s: number) => (s <= 2022 ? 'SELECTION' : s <= 2024 ? 'VALIDATION' : 'HOLDOUT');

function boot(xs: number[], seed: number): { mean: number; ci95: [number, number] } {
  const r = streamFor(SEED, seed, STREAM.coin); const m: number[] = [];
  for (let b = 0; b < BOOT; b++) { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[Math.floor(r.nextDouble() * xs.length)]; m.push(s / xs.length); }
  m.sort((a, b) => a - b);
  return { mean: r4(xs.reduce((a, b) => a + b, 0) / xs.length), ci95: [r4(m[Math.floor(0.025 * BOOT)]), r4(m[Math.floor(0.975 * BOOT) - 1])] };
}
const ll = (p: number) => -Math.log(Math.min(1 - 1e-9, Math.max(1e-9, p)));
const bll = (p: number, y: number) => (y ? ll(p) : ll(1 - p));
const share = (T: Tally, m: Map<string, number>, id: string) => Math.max(m.get(id) || 0, 0.5) / T.n;
/** the seed line of a team in a rebuilt bracket: 1 = the host (or game 1's first team), 4 = its first opponent, 2 = the other two */
const lineOf = (t: Tournament, id: string) => { for (const p of t.pods) { const i = p.teams.indexOf(id); if (i >= 0) return i === 0 ? 1 : i === 3 ? 4 : 2; } return 0; };

export function runBacktest(o: { n?: number; log?: boolean } = {}) {
  const n = o.n || N;
  const seasons: number[] = []; const refused: Array<{ season: number; reason: string }> = []; const T = new Map<number, Tournament>();
  for (let s = 2014; s <= LAST_SEASON; s++) { const x = reconstruct(s); if (x.t) { T.set(s, x.t); seasons.push(s); } else refused.push({ season: s, reason: s === 2020 ? 'no tournament (the 2020 season was cancelled)' : x.reason! }); }
  const at: any[] = [];
  for (const s of seasons) {
    const t = T.get(s)!;
    at.push({ season: s, date: t.start, teams: t.field, key: s + ':start' });
    at.push({ season: s, date: t.cws.games[0].date, teams: t.field, key: s + ':omaha' });
  }
  const rp = replay({ through: LAST_SEASON, at });
  if (o.log) console.error('replay ' + rp.seconds.toFixed(1) + 's, model ' + rp.version);
  /* seed-line rates, each season's from the others */
  const lineRate = (except: number, level: 'regional' | 'omaha' | 'champion') => {
    const k = { 1: [0, 0], 2: [0, 0], 4: [0, 0] } as Record<number, [number, number]>;
    for (const s of seasons) { if (s === except) continue; const t = T.get(s)!;
      const won = level === 'regional' ? new Set(t.pods.map((p) => p.winner)) : level === 'omaha' ? new Set(t.supers.map((x) => x.winner)) : new Set([t.cws.champion]);
      for (const id of t.field) { const l = lineOf(t, id); k[l][1]++; if (won.has(id)) k[l][0]++; } }
    return (l: number) => (k[l][0] + 0.5) / (k[l][1] + 1);
  };
  const per: any[] = []; const pods: Array<{ m: number; u: number; sl: number }> = []; const hostChecks: any[] = [];
  const rowsBy = new Map<string, Row>(rp.rows.map((x) => [x.game_id, x]));
  const gameRows: Array<{ season: number; p: number; y: number; round: string }> = [];
  for (const s of seasons) {
    const t = T.get(s)!; const S = rp.snapshots.get(s + ':start')!; const So = rp.snapshots.get(s + ':omaha')!;
    const hp = homeParks(s, t.start);
    const sim = new TournamentSim(S, structureOf(t, hp));
    const tal = simulate(sim, n, streamFor(SEED, s, STREAM.postseason));
    const rate = { regional: lineRate(s, 'regional'), omaha: lineRate(s, 'omaha'), champion: lineRate(s, 'champion') };
    /* regionals */
    for (const p of t.pods) {
      const tot = p.teams.reduce((a, id) => a + rate.regional(lineOf(t, id)), 0);
      pods.push({ m: ll(share(tal, tal.regional, p.winner)), u: Math.log(4), sl: ll(rate.regional(lineOf(t, p.winner)) / tot) });
    }
    /* Omaha */
    const om = new Set(t.supers.map((x) => x.winner));
    let bm = 0, bu = 0, bs = 0, lm = 0, lu = 0, ls = 0; const totO = t.field.reduce((a, id) => a + rate.omaha(lineOf(t, id)), 0);
    for (const id of t.field) {
      const y = om.has(id) ? 1 : 0; const pm = share(tal, tal.omaha, id), pu = 8 / 64, ps = 8 * rate.omaha(lineOf(t, id)) / totO;
      bm += (pm - y) ** 2; bu += (pu - y) ** 2; bs += (ps - y) ** 2; lm += bll(pm, y); lu += bll(pu, y); ls += bll(ps, y);
    }
    const totC = t.field.reduce((a, id) => a + rate.champion(lineOf(t, id)), 0);
    /* Omaha open: the eight, the model through the super regionals */
    const simO = new TournamentSim(So, Object.assign(structureOf(t, hp), { fixed: { regional: t.pods.map((p) => p.winner), supers: t.supers.map((x) => x.winner) } }));
    const talO = simulate(simO, n, streamFor(SEED, s, STREAM.postseason + 100));
    /* the super-regional host proxy against each actual host */
    for (let k = 0; k < t.supers.length; k++) {
      const x = t.supers[k]; if (!x.host) continue;
      const a = t.pods[x.pods[0]].winner, b = t.pods[x.pods[1]].winner;
      hostChecks.push({ season: s, proxy: sim.superHost(k, a, b), actual: x.host });
    }
    /* single games, the morning of each date */
    const rounds: Array<[string, any[]]> = [['regional', t.pods.flatMap((p) => p.games)], ['super', t.supers.flatMap((x) => x.games)], ['omaha', t.cws.games]];
    for (const [round, gs] of rounds) for (const g of gs) {
      const x = rowsBy.get(g.game_id); if (!x) continue;
      const [lh, la] = CAL.apply(x.lh, x.la, S.cal, !!x.neutral);
      gameRows.push({ season: s, p: TQ.integrate(lh, la, x.sd, pHome), y: x.y, round });
    }
    const top = [...t.field].sort((a, b) => share(tal, tal.champion, b) - share(tal, tal.champion, a)).slice(0, 5);
    per.push({
      season: s, window: windowOf(s), start: t.start, champion: { id: t.cws.champion, name: t.names[t.cws.champion], p: r4(share(tal, tal.champion, t.cws.champion)), rank: [...t.field].sort((a, b) => share(tal, tal.champion, b) - share(tal, tal.champion, a)).indexOf(t.cws.champion) + 1, p_omaha_open: r4(share(talO, talO.champion, t.cws.champion)) },
      favourites: top.map((id) => ({ id, name: t.names[id], p: r4(share(tal, tal.champion, id)) })),
      omaha: [...om].map((id) => ({ id, name: t.names[id], p: r4(share(tal, tal.omaha, id)) })),
      champion_log_loss: { model: r4(ll(share(tal, tal.champion, t.cws.champion))), uniform: r4(Math.log(64)), seed_lines: r4(ll(rate.champion(lineOf(t, t.cws.champion)) / totC)) },
      champion_log_loss_omaha_open: { model: r4(ll(share(talO, talO.champion, t.cws.champion))), uniform: r4(Math.log(8)) },
      omaha_brier: { model: r6(bm / 64), uniform: r6(bu / 64), seed_lines: r6(bs / 64) }, omaha_log_loss: { model: r6(lm / 64), uniform: r6(lu / 64), seed_lines: r6(ls / 64) },
      calibration: S.cal, hosts_rebuilt: t.pods.filter((p) => p.host).length
    });
    if (o.log) console.error(s + ': champion ' + t.names[t.cws.champion] + ' ' + (100 * share(tal, tal.champion, t.cws.champion)).toFixed(1) + '% (rank ' + per[per.length - 1].champion.rank + '), favourite ' + t.names[top[0]] + ' ' + (100 * share(tal, tal.champion, top[0])).toFixed(1) + '%');
  }
  const diff = (a: number[], b: number[]) => a.map((x, i) => x - b[i]);
  const col = (k: string, f: string) => per.map((x) => x[k][f]);
  const games = (rows: typeof gameRows) => {
    const m = rows.map((x) => bll(x.p, x.y)), c = rows.map(() => Math.log(2));
    const fav = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 1.01]].map(([lo, hi]) => { const xs = rows.filter((x) => Math.max(x.p, 1 - x.p) >= lo && Math.max(x.p, 1 - x.p) < hi); return { bin: lo + '-' + Math.min(hi, 1), n: xs.length, mean_chance: xs.length ? r4(xs.reduce((a, x) => a + Math.max(x.p, 1 - x.p), 0) / xs.length) : null, favourite_won: xs.length ? r4(xs.filter((x) => (x.p >= 0.5 ? x.y === 1 : x.y === 0)).length / xs.length) : null }; });
    return { n: rows.length, log_loss: r4(m.reduce((a, b) => a + b, 0) / m.length), vs_coin: boot(diff(m, c), 7), favourites: fav };
  };
  const hold = (w: string[]) => per.filter((x) => w.includes(x.window));
  const out = {
    schema: BACKTEST_SCHEMA, generated_at: new Date().toISOString(), model_version: rp.version, sims_per_tournament: n,
    seasons, refused,
    windows: { SELECTION: '2014-2022: the served configuration was chosen on these seasons\' games', VALIDATION: '2023-2024', HOLDOUT: '2025-2026' },
    regional_winner_log_loss: { pods: pods.length, model: r4(pods.reduce((a, x) => a + x.m, 0) / pods.length), uniform: r4(Math.log(4)), seed_lines: r4(pods.reduce((a, x) => a + x.sl, 0) / pods.length),
      diff_vs_uniform: boot(pods.map((x) => x.m - x.u), 1), diff_vs_seed_lines: boot(pods.map((x) => x.m - x.sl), 2) },
    omaha: { brier: { model: r6(col('omaha_brier', 'model').reduce((a, b) => a + b, 0) / per.length), uniform: r6(col('omaha_brier', 'uniform').reduce((a, b) => a + b, 0) / per.length), seed_lines: r6(col('omaha_brier', 'seed_lines').reduce((a, b) => a + b, 0) / per.length) },
      log_loss_diff_vs_uniform: boot(diff(col('omaha_log_loss', 'model'), col('omaha_log_loss', 'uniform')), 3), log_loss_diff_vs_seed_lines: boot(diff(col('omaha_log_loss', 'model'), col('omaha_log_loss', 'seed_lines')), 4) },
    champion: { log_loss: { model: r4(col('champion_log_loss', 'model').reduce((a, b) => a + b, 0) / per.length), uniform: r4(Math.log(64)), seed_lines: r4(col('champion_log_loss', 'seed_lines').reduce((a, b) => a + b, 0) / per.length) },
      diff_vs_uniform: boot(diff(col('champion_log_loss', 'model'), col('champion_log_loss', 'uniform')), 5), diff_vs_seed_lines: boot(diff(col('champion_log_loss', 'model'), col('champion_log_loss', 'seed_lines')), 6),
      omaha_open: { model: r4(col('champion_log_loss_omaha_open', 'model').reduce((a, b) => a + b, 0) / per.length), uniform: r4(Math.log(8)), diff_vs_uniform: boot(diff(col('champion_log_loss_omaha_open', 'model'), col('champion_log_loss_omaha_open', 'uniform')), 8) },
      holdout_validation: hold(['VALIDATION', 'HOLDOUT']).map((x) => ({ season: x.season, champion: x.champion.name, p: x.champion.p, rank: x.champion.rank })) },
    games: Object.assign(games(gameRows), { holdout: games(gameRows.filter((x) => windowOf(x.season) === 'HOLDOUT')), by_round: Object.fromEntries(['regional', 'super', 'omaha'].map((rd) => [rd, games(gameRows.filter((x) => x.round === rd))])) }),
    super_host_proxy: { n: hostChecks.length, agree: hostChecks.filter((x) => x.proxy === x.actual).length, share: r4(hostChecks.filter((x) => x.proxy === x.actual).length / Math.max(1, hostChecks.length)) },
    per_season: per
  };
  return out;
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const out = runBacktest({ log: true });
  fs.writeFileSync(BACKTEST_FILE, JSON.stringify(out, null, 1) + '\n');
  console.error('regionals: model ' + out.regional_winner_log_loss.model + ' vs uniform ' + out.regional_winner_log_loss.uniform + ' vs seed lines ' + out.regional_winner_log_loss.seed_lines + ' ' + JSON.stringify(out.regional_winner_log_loss.diff_vs_seed_lines));
  console.error('omaha brier ' + JSON.stringify(out.omaha));
  console.error('champion ' + JSON.stringify(out.champion.log_loss) + ' ' + JSON.stringify(out.champion.diff_vs_uniform) + ' seed ' + JSON.stringify(out.champion.diff_vs_seed_lines) + ' omaha open ' + JSON.stringify(out.champion.omaha_open));
  console.error('games ' + JSON.stringify({ n: out.games.n, ll: out.games.log_loss, coin: out.games.vs_coin, fav: out.games.favourites }));
  console.error('host proxy ' + JSON.stringify(out.super_host_proxy));
  console.error('wrote ' + BACKTEST_FILE);
}
