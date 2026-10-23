/* ===========================================================================
   One point-in-time replay of the served MLB model over the committed
   record (2010-2025), shared by the three MLB studies.

   Captures, as of the morning of each day asked for: the frozen model state
   (team o/d/park, every pitcher's s, mu, home) the simulator would price
   from that day. The out-of-sample prediction of every game is kept for the
   season calibrations. The result is cached under simulator/.cache keyed by
   the served configuration, the data files and the capture days: a replay
   takes about 90 s.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { replay, servedConfig, calibrationFor, type ModelState, type Calibration } from '../sports/mlb/model_adapter.ts';
import { loadRegularSeason, REPO, dayOf, type HistGame } from '../sports/mlb/history.ts';
import { sha256Hex, hashCanonical } from '../core/canonical.ts';

export const SEASONS_ALL = Array.from({ length: 16 }, (_, i) => 2010 + i);
const CACHE = path.join(REPO, 'simulator', '.cache');

export interface StudyReplay {
  games: HistGame[];
  raw: Map<string, { lh: number; la: number }>;
  captures: Map<number, ModelState>;
  calibration: Record<number, Calibration>;
  served: ReturnType<typeof servedConfig>;
  data_sha256: Record<string, string>;
}

export function studyReplay(captureDays: number[], log: (s: string) => void = () => {}): StudyReplay {
  const served = servedConfig();
  const data_sha256: Record<string, string> = {};
  const games: HistGame[] = [];
  for (const s of SEASONS_ALL) { const r = loadRegularSeason(s); data_sha256['mlb/history/data/' + s + '.csv'] = r.sha256; games.push(...r.games); }
  const key = hashCanonical({ v: 1, config: served.config, data_sha256, captureDays: [...captureDays].sort((a, b) => a - b) }).slice(0, 24);
  const file = path.join(CACHE, 'mlb_replay_' + key + '.json');
  let raw: Map<string, { lh: number; la: number }>, captures: Map<number, ModelState>;
  if (fs.existsSync(file)) {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw = new Map(d.raw); captures = new Map(d.captures);
    log('replay: cached ' + path.relative(REPO, file));
  } else {
    const t = Date.now();
    const r = replay(games, { params: served.config, captureDays });
    raw = r.raw; captures = r.captures;
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ raw: [...raw], captures: [...captures] }));
    log('replay: ' + games.length + ' games, ' + captures.size + ' captures, ' + ((Date.now() - t) / 1000).toFixed(0) + ' s');
  }
  const calibration: Record<number, Calibration> = {};
  for (let s = 2012; s <= 2026; s++) calibration[s] = calibrationFor(s, games, raw);
  return { games, raw, captures, calibration, served, data_sha256 };
}

export const fileSha = (rel: string) => sha256Hex(fs.readFileSync(path.join(REPO, rel)));

/* ---------------- the capture plan every MLB study shares (one cache entry) ---------------- */
export const STUDY_SEASONS = [2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2025];
/** as-of stages: the first game date on which the clubs have played this many games on average */
export const STAGES = [20, 40, 60, 81, 100, 120, 140];
export function stageDays(season: number): Array<{ stage: number; day: number; date: string }> {
  const games = loadRegularSeason(season).games;
  const out: Array<{ stage: number; day: number; date: string }> = [];
  let played = 0, si = 0;
  const dates = [...new Set(games.map((g) => g.date))].sort();
  const perDate = new Map<string, number>(); for (const g of games) perDate.set(g.date, (perDate.get(g.date) || 0) + 1);
  for (const d of dates) {
    while (si < STAGES.length && (2 * played) / 30 >= STAGES[si]) { out.push({ stage: STAGES[si], day: dayOf(d), date: d }); si++; }
    played += perDate.get(d) || 0;
  }
  return out;
}
/** the morning after a season's last regular-season date: what the postseason is priced from */
export function seasonEndDay(season: number): number {
  const games = loadRegularSeason(season).games;
  return dayOf(games[games.length - 1].date) + 1;
}
export function studyCaptureDays(): number[] {
  const days = new Set<number>();
  for (const s of STUDY_SEASONS) for (const x of stageDays(s)) days.add(x.day);
  for (let s = 2012; s <= 2025; s++) if (s !== 2020) days.add(seasonEndDay(s));
  return [...days].sort((a, b) => a - b);
}
