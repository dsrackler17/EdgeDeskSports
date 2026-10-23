/* ===========================================================================
   The owned MLB game record, read once for the rules history suite, the
   research studies and the as-of (backtest) snapshots.

   Regular season: mlb/history/data/<season>.csv (Retrosheet game logs;
   2024 from the data pack's StatsAPI table, which has no starters). Two
   defects of that committed 2024 table are handled here and nowhere else:
     - a suspended game resumed on a later date appears twice (once per
       date) under the same StatsAPI gamePk: the copy on the later date is
       dropped, so the game counts once, on its original date (3 games:
       BAL-SLN, TOR-BOS, TEX-CHA);
     - its date is the UTC start time shifted ten hours, not the official
       date; it is kept as is (a doubleheader keeps its game numbers).
   Postseason: simulator/fixtures/mlb_postseason_2012_2025.json (Retrosheet).
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, num } from '../../core/csv.ts';
import { sha256Hex } from '../../core/canonical.ts';
import type { Round } from './config.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.join(HERE, '..', '..', '..', '..');
export const HISTORY_DIR = path.join(REPO, 'mlb', 'history', 'data');
export const POSTSEASON_FIXTURE = path.join(REPO, 'simulator', 'fixtures', 'mlb_postseason_2012_2025.json');

export interface HistGame {
  id: string; season: number; date: string; game_no: number; home: string; away: string;
  hs: number; as: number; outs: number | null; sp_home: string | null; sp_away: string | null; source: string;
}
export interface HistPostGame {
  season: number; round: Round; date: string; series_game: number; home: string; away: string; home_league: string; away_league: string;
  hs: number; as: number; outs: number | null; innings: number; sp_home: string | null; sp_away: string | null;
}

const regCache = new Map<number, { games: HistGame[]; sha256: string; dropped: string[] }>();
export function loadRegularSeason(season: number): { games: HistGame[]; sha256: string; dropped: string[] } {
  const hit = regCache.get(season); if (hit) return hit;
  const file = path.join(HISTORY_DIR, season + '.csv');
  const text = fs.readFileSync(file, 'utf8');
  const seen = new Set<string>(); const dropped: string[] = []; const games: HistGame[] = [];
  for (const r of parseCsv(text)) {
    const src = String(r.source || '');
    if (src.startsWith('pack_statsapi:')) { if (seen.has(src)) { dropped.push(String(r.game_id)); continue; } seen.add(src); }
    games.push({ id: String(r.game_id), season, date: String(r.date), game_no: num(r.game_no) || 0, home: String(r.home), away: String(r.away),
      hs: num(r.hs) as number, as: num(r.as) as number, outs: num(r.outs), sp_home: r.sp_home || null, sp_away: r.sp_away || null, source: src });
  }
  games.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.game_no - b.game_no || (a.id < b.id ? -1 : 1)));
  const out = { games, sha256: sha256Hex(text), dropped };
  regCache.set(season, out);
  return out;
}

let postCache: { games: HistPostGame[]; sha256: string } | null = null;
export function loadPostseason(): { games: HistPostGame[]; sha256: string } {
  if (postCache) return postCache;
  const text = fs.readFileSync(POSTSEASON_FIXTURE, 'utf8');
  const d = JSON.parse(text) as { columns: string[]; games: unknown[][] };
  const games = d.games.map((row) => { const o: any = {}; d.columns.forEach((c, i) => { o[c] = row[i]; }); return o as HistPostGame; });
  postCache = { games, sha256: sha256Hex(text) };
  return postCache;
}

/** day number (UTC days since 1970-01-01) of a YYYY-MM-DD date */
export const dayOf = (date: string): number => Math.floor(Date.parse(date + 'T12:00:00Z') / 864e5);
export const dateOf = (day: number): string => new Date(day * 864e5).toISOString().slice(0, 10);
