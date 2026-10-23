/* ===========================================================================
   THE WNBA INPUT SNAPSHOT — everything a postseason simulation reads,
   captured once, validated, frozen and hashed BEFORE the first simulated
   series.

   Where every number comes from:
     schedule, results   basketball/data/wnba/<season>.csv (sportsdataverse
                         wehoop, ESPN; Observed), refreshed from the source
                         first unless --offline (basketball/ingest.js, the
                         basketball pipeline's own reader): every playoff
                         game played, and every one still scheduled with its
                         host ("if necessary" games included)
     series              grouped from the playoff games by the two clubs;
                         the round is the clubs' number of earlier series;
                         a decided series' winner and length are Observed;
                         an open series' length is measured from the games
                         the schedule lists for it (config.ts series_format)
     game model          the served basketball walk-forward replayed over
                         every committed season (model_adapter.ts replay):
                         each played playoff game's point-in-time pre-game
                         probability (the reader's Model Health tab), and
                         every remaining game priced from the ratings after
                         the last final, with the season's calibration
     served check        the replay's ratings against basketball/params/
                         wnba_live.json (what priced the published board):
                         equal when both hold the same finals
     shared offset       simulator/data/wnba_strength_uncertainty.json: tau,
                         carved out of the served margin sd
   The snapshot's `data` is canonical and content-hashed (input_hash); `meta`
   carries what does not change a result. No network or database call
   happens after this returns.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { hashCanonical, sha256Hex } from '../../core/canonical.ts';
import { REPO, BB, bbModules, replay, priceFromRatings, codeIdentity, type Calibration, type Forecast } from './model_adapter.ts';
import { WNBA_2026 } from './config.ts';

export const WNBA_INPUT_SCHEMA = 'edgedesk_sim_wnba_input_v1';
const STUDY = path.join(REPO, 'simulator', 'data', 'wnba_strength_uncertainty.json');

export interface SeriesGame { game_id: string; n: number; start_utc: string; home: string; away: string; status: 'FINAL' | 'SCHEDULED'; hs: number | null; as: number | null; ot: number | null;
  /** the served model's point-in-time pre-game P(home win) (null when the replay holds no forecast for it) */
  p_home_pregame: number | null }
export interface WnbaSeries {
  key: string; round: number; teams: [string, string];
  /** games in the series' schedule (played + scheduled); wins needed = ceil(best_of / 2) */
  best_of: number; wins_needed: number;
  wins: Record<string, number>; winner: string | null; games: SeriesGame[];
}
export interface RemainingGame { game_id: string; series: string; n: number; start_utc: string; home: string; away: string;
  /** the ratings' margin and the served calibrated P(home win) from the end-state ratings */
  m: number; p_home: number; margin_mu: number }
export interface WnbaInputData {
  sport: 'wnba'; season: number; competition: string; as_of: string;
  teams: Array<{ id: string; name: string; record: { w: number; l: number } }>;
  series: WnbaSeries[];
  remaining: RemainingGame[];
  rounds: number;
  strength: { tau_points: number; ci95: number[]; sd_margin: number; conditional_sd: number; study_sha256: string; holdout_tau_points: number; source: string };
  model: { model_version: string; params: Record<string, unknown>; calibration: Calibration; ratings_through: string | null;
    served: { file: string; generated_at: string | null; last_game_date: string | null; same_finals: boolean; max_rating_diff: number | null } };
  code: Record<string, string>;
  config: { rules_version: string; series_format: string; home_court: string };
  /** the served model's own record (point-in-time forecasts, outcomes Observed): the reader's Model Health tab */
  health: { windows: Array<HealthWindow>; playoff_calibration: Array<{ bin: string; n: number; mean_p: number; won: number }> };
}
export interface HealthWindow { label: string; n: number; brier: number | null; log_loss: number | null; accuracy: number | null; coin_log_loss: number; home_rate_log_loss: number | null }
export interface WnbaSnapshot { schema: string; input_hash: string; data: WnbaInputData; meta: { built_at: string; builder: string; refresh: unknown; feeds: Array<{ name: string; sha256: string }> } }

/** group a season's playoff games into series (by the two clubs), in order of each series' first game */
export function groupSeries(games: Array<{ game_id: string; type: string; start_utc: string; home_id: string; away_id: string; status: string; hs: number | null; as: number | null; ot: number | null }>,
  pregame: Map<string, number>): WnbaSeries[] {
  const by = new Map<string, typeof games>();
  for (const g of games) if (g.type === 'P') { const k = [g.home_id, g.away_id].sort().join('-'); (by.get(k) || by.set(k, []).get(k)!).push(g); }
  const list = [...by.entries()].map(([key, gs]) => {
    gs.sort((a, b) => (a.start_utc < b.start_utc ? -1 : a.start_utc > b.start_utc ? 1 : a.game_id < b.game_id ? -1 : 1));
    const teams = key.split('-') as [string, string];
    const wins: Record<string, number> = { [teams[0]]: 0, [teams[1]]: 0 };
    const sg: SeriesGame[] = gs.map((g, i) => {
      if (g.status === 'FINAL') wins[(g.hs as number) > (g.as as number) ? g.home_id : g.away_id]++;
      return { game_id: g.game_id, n: i + 1, start_utc: g.start_utc, home: g.home_id, away: g.away_id, status: g.status as 'FINAL' | 'SCHEDULED', hs: g.hs, as: g.as, ot: g.ot,
        p_home_pregame: pregame.has(g.game_id) ? Math.round((pregame.get(g.game_id) as number) * 1e6) / 1e6 : null };
    });
    const open = sg.some((g) => g.status === 'SCHEDULED');
    const best_of = open ? sg.length : 2 * Math.max(wins[teams[0]], wins[teams[1]]) - 1;
    const wins_needed = Math.ceil(best_of / 2);
    const winner = wins[teams[0]] >= wins_needed ? teams[0] : wins[teams[1]] >= wins_needed ? teams[1] : null;
    return { key, round: 0, teams, best_of, wins_needed, wins, winner, games: sg };
  });
  list.sort((a, b) => (a.games[0].start_utc < b.games[0].start_utc ? -1 : 1));
  /* a series' round: one more than the number of earlier series either club played in this postseason */
  const played = new Map<string, number>();
  for (const s of list) {
    s.round = 1 + Math.max(played.get(s.teams[0]) || 0, played.get(s.teams[1]) || 0);
    for (const t of s.teams) played.set(t, (played.get(t) || 0) + 1);
  }
  return list;
}

export async function buildWnbaSnapshot(opt: { offline?: boolean; season?: number } = {}): Promise<WnbaSnapshot> {
  const season = opt.season || WNBA_2026.season;
  const { I } = bbModules();
  /* 1 the schedule and results, fresh from the source unless offline (the basketball pipeline's own reader) */
  let refresh: unknown = { offline: true };
  if (!opt.offline) {
    const r = await I.ingest('wnba', season, {});
    refresh = r.error || r.not_published ? { error: r.error || 'not published' } : { source: r.source, changed: r.changed, stats: r.stats };
    if ((refresh as any).error) throw Object.assign(new Error('the WNBA schedule could not be refreshed: ' + JSON.stringify((refresh as any).error) + ' (use --offline to run from the committed file)'), { exitCode: 2 });
  }
  /* 2 the served model, replayed over every season */
  const R = replay(season);
  const cur = R.games.filter((g) => g.season === season);
  const pregame = new Map(R.forecasts.filter((f) => f.season === season && f.type === 'P').map((f) => [f.id, f.p_home]));
  const series = groupSeries(cur as any, pregame);
  const cal = R.cal[season] as Calibration;
  const remaining: RemainingGame[] = [];
  for (const s of series) for (const g of s.games) if (g.status === 'SCHEDULED') {
    const pr = priceFromRatings(R.ratings, cal, g.home, g.away, false);
    remaining.push({ game_id: g.game_id, series: s.key, n: g.n, start_utc: g.start_utc, home: g.home, away: g.away, m: round6(pr.m), p_home: round6(pr.p_home), margin_mu: round6(pr.margin_mu) });
  }
  /* 3 the clubs: every club with a playoff game, with its regular-season record */
  const names = JSON.parse(fs.readFileSync(path.join(BB, 'data', 'wnba', 'teams.json'), 'utf8')) as Record<string, string>;
  const ids = [...new Set(series.flatMap((s) => s.teams))].sort();
  const teams = ids.map((id) => {
    let w = 0, l = 0;
    for (const g of cur) if (g.type === 'R' && g.status === 'FINAL' && (g.home_id === id || g.away_id === id)) { const won = (g.home_id === id) === ((g.hs as number) > (g.as as number)); if (won) w++; else l++; }
    return { id, name: names[id] || id, record: { w, l } };
  });
  /* 4 the shared offset (study) and the served file check */
  const study = JSON.parse(fs.readFileSync(STUDY, 'utf8'));
  const tau = study.production.tau_points as number, sd = cal.sd_margin;
  const livePath = path.join(BB, 'params', 'wnba_live.json');
  const live = JSON.parse(fs.readFileSync(livePath, 'utf8'));
  const lastFinal = cur.filter((g) => g.status === 'FINAL').map((g) => g.date).sort().pop() || null;
  let maxDiff: number | null = 0;
  for (const [id, t] of Object.entries(live.ratings.teams as Record<string, { o: number; d: number }>)) {
    const r = R.ratings.teams[id];
    if (!r) { maxDiff = null; break; }
    maxDiff = Math.max(maxDiff, Math.abs(r.o - t.o), Math.abs(r.d - t.d));
  }
  const versions = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'model-loop', 'wnba', 'versions.json'), 'utf8'));
  const data: WnbaInputData = {
    sport: 'wnba', season, competition: WNBA_2026.competition, as_of: lastFinal || '',
    teams, series, remaining, rounds: Math.max(0, ...series.map((s) => s.round)),
    strength: { tau_points: tau, ci95: study.production.ci95, sd_margin: round6(sd), conditional_sd: round6(Math.sqrt(Math.max(0, sd * sd - tau * tau))), study_sha256: sha256Hex(fs.readFileSync(STUDY)),
      holdout_tau_points: study.holdout_2025.tau_points, source: 'simulator/data/wnba_strength_uncertainty.json' },
    model: { model_version: 'edgedesk_bb_points_v1:wnba@' + versions.current + '+' + cal.version, params: R.params, calibration: { version: cal.version, intercept: cal.intercept, win: cal.win, margin: cal.margin, sd_margin: cal.sd_margin, n: cal.n },
      ratings_through: lastFinal,
      served: { file: 'basketball/params/wnba_live.json', generated_at: live.generated_at || null, last_game_date: live.last_game_date || null, same_finals: live.last_game_date === lastFinal, max_rating_diff: maxDiff == null ? null : round6(maxDiff) } },
    code: codeIdentity(),
    config: { rules_version: WNBA_2026.rules_version, series_format: WNBA_2026.series_format.value, home_court: WNBA_2026.home_court.value },
    health: { windows: [], playoff_calibration: [] }
  };
  data.health = health(R.forecasts, season);
  const feed = path.join(BB, 'data', 'wnba', season + '.csv');
  return { schema: WNBA_INPUT_SCHEMA, input_hash: hashCanonical(data), data,
    meta: { built_at: new Date().toISOString(), builder: 'simulator/src/sports/wnba/inputs.ts', refresh, feeds: [{ name: 'basketball/data/wnba/' + season + '.csv', sha256: sha256Hex(fs.readFileSync(feed)) }] } };
}
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** the served model's record on played games: Brier, log loss and accuracy of its pre-game P(home win), beside a
    coin and the home-win rate of the seasons before (what a forecast with no team information would say) */
export function health(fc: Forecast[], season: number): WnbaInputData['health'] {
  const ll = (p: number, y: number) => -Math.log(Math.min(1 - 1e-12, Math.max(1e-12, y ? p : 1 - p)));
  const homeRate = (s: number) => { const prior = fc.filter((f) => f.season >= s - 3 && f.season < s && !f.neutral); return prior.length ? prior.reduce((a, f) => a + f.y.hw, 0) / prior.length : null; };
  const win = (label: string, rows: Forecast[]): HealthWindow => {
    if (!rows.length) return { label, n: 0, brier: null, log_loss: null, accuracy: null, coin_log_loss: Math.LN2, home_rate_log_loss: null };
    let b = 0, l = 0, acc = 0, lh = 0, nh = 0;
    for (const f of rows) {
      b += (f.p_home - f.y.hw) ** 2; l += ll(f.p_home, f.y.hw); acc += (f.p_home >= 0.5 ? 1 : 0) === f.y.hw ? 1 : 0;
      const h = f.neutral ? 0.5 : homeRate(f.season); if (h != null) { lh += ll(h, f.y.hw); nh++; }
    }
    const n = rows.length;
    return { label, n, brier: round6(b / n), log_loss: round6(l / n), accuracy: round6(acc / n), coin_log_loss: round6(Math.LN2), home_rate_log_loss: nh ? round6(lh / nh) : null };
  };
  const po = fc.filter((f) => f.type === 'P' && f.season >= 2010 && f.season < season);
  const bins: WnbaInputData['health']['playoff_calibration'] = [];
  for (const [lo, hi] of [[0, 0.35], [0.35, 0.45], [0.45, 0.55], [0.55, 0.65], [0.65, 1.0001]]) {
    const r = po.filter((f) => f.p_home >= lo && f.p_home < hi);
    if (r.length) bins.push({ bin: lo.toFixed(2) + '-' + Math.min(1, hi).toFixed(2), n: r.length, mean_p: round6(r.reduce((a, f) => a + f.p_home, 0) / r.length), won: round6(r.reduce((a, f) => a + f.y.hw, 0) / r.length) });
  }
  return {
    windows: [
      win(season + ' playoffs', fc.filter((f) => f.type === 'P' && f.season === season)),
      win(season + ' regular season', fc.filter((f) => f.type === 'R' && f.season === season)),
      win('playoffs 2010-' + (season - 1), po),
      win('regular seasons 2010-' + (season - 1), fc.filter((f) => f.type === 'R' && f.season >= 2010 && f.season < season))
    ],
    playoff_calibration: bins
  };
}

export function writeWnbaSnapshot(file: string, snap: WnbaSnapshot): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(snap));
}
export function readWnbaSnapshot(file: string): WnbaSnapshot {
  const snap = JSON.parse(fs.readFileSync(file, 'utf8')) as WnbaSnapshot;
  if (snap.schema !== WNBA_INPUT_SCHEMA) throw new Error('not a WNBA input snapshot: ' + snap.schema);
  const h = hashCanonical(snap.data);
  if (h !== snap.input_hash) throw new Error('snapshot content hash mismatch: the file was changed after it was built (' + h + ' != ' + snap.input_hash + ')');
  return snap;
}
