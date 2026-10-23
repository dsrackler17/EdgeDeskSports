/* ===========================================================================
   Build simulator/fixtures/mlb_postseason_2012_2025.json — the REAL MLB
   postseason record the rules engine, the series state machine and the
   postseason rotation study are tested against.

   Source (public, keyless): the Retrosheet postseason game logs as mirrored
   by chadwickbureau/retrosheet (gamelog/GLWC.TXT, GLDV.TXT, GLLC.TXT,
   GLWS.TXT). Terms: "The information used here was obtained free of charge
   from and is copyrighted by Retrosheet. Interested parties may contact
   Retrosheet at www.retrosheet.org."

   Every game of 2012-2025 is kept: date, round, game number in the series,
   visiting and home club (the franchise keys mlb/history/ingest.js uses:
   FLO -> MIA, ATH -> OAK), leagues, the final score, length in outs, the
   number of innings (from the visiting line score), the park and both
   starting pitchers. The regular-season games come from the committed
   mlb/history/data/<season>.csv (the same Retrosheet logs; 2024 from the
   data pack's StatsAPI table, without starters).

     node simulator/src/research/build_mlb_history_fixture.ts [--dir DIR_WITH_LOCAL_COPIES]
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsvRows } from '../core/csv.ts';
import { sha256Hex } from '../core/canonical.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MLB_POSTSEASON_FIXTURE = path.join(HERE, '..', '..', 'fixtures', 'mlb_postseason_2012_2025.json');
const BASE = 'https://raw.githubusercontent.com/chadwickbureau/retrosheet/master/gamelog/';
const FILES: Array<[string, 'WC' | 'DS' | 'LCS' | 'WS']> = [['GLWC.TXT', 'WC'], ['GLDV.TXT', 'DS'], ['GLLC.TXT', 'LCS'], ['GLWS.TXT', 'WS']];
const FRANCHISE: Record<string, string> = { FLO: 'MIA', ATH: 'OAK' };
const fk = (c: string) => FRANCHISE[c] || c;
export const RETROSHEET_TERMS = 'The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at www.retrosheet.org.';

/** innings in a Retrosheet line score: one character per inning, "(nn)" for ten or more runs */
export function lineInnings(line: string): number {
  let n = 0;
  for (let i = 0; i < line.length; i++) { if (line[i] === '(') { i = line.indexOf(')', i); if (i < 0) throw new Error('bad line score ' + line); } n++; }
  return n;
}

export interface PostseasonRow {
  season: number; round: 'WC' | 'DS' | 'LCS' | 'WS'; date: string; series_game: number;
  away: string; away_league: string; home: string; home_league: string; as: number; hs: number;
  outs: number | null; innings: number; park: string; sp_away: string | null; sp_home: string | null;
}

export function parsePostseasonLog(text: string, round: PostseasonRow['round'], first: number, last: number): PostseasonRow[] {
  const out: PostseasonRow[] = [];
  for (const f of parseCsvRows(text)) {
    if (f.length < 105) continue;
    const season = Number(f[0].slice(0, 4));
    if (!(season >= first && season <= last)) continue;
    if (f[14]) throw new Error('forfeit in a postseason log: ' + f[0]);
    out.push({
      season, round, date: f[0].slice(0, 4) + '-' + f[0].slice(4, 6) + '-' + f[0].slice(6, 8), series_game: Number(f[5]),
      away: fk(f[3]), away_league: f[4], home: fk(f[6]), home_league: f[7], as: Number(f[9]), hs: Number(f[10]),
      outs: f[11] ? Number(f[11]) : null, innings: lineInnings(f[19]), park: f[16], sp_away: f[101] || null, sp_home: f[103] || null
    });
  }
  return out;
}

async function main() {
  const i = process.argv.indexOf('--dir'); const dir = i > 0 ? process.argv[i + 1] : null;
  const rows: PostseasonRow[] = []; const sources: Array<{ url: string; sha256: string; bytes: number }> = [];
  for (const [file, round] of FILES) {
    let text: string;
    if (dir) text = fs.readFileSync(path.join(dir, file), 'utf8');
    else { const r = await fetch(BASE + file); if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + BASE + file); text = await r.text(); }
    sources.push({ url: BASE + file, sha256: sha256Hex(text), bytes: text.length });
    rows.push(...parsePostseasonLog(text, round, 2012, 2025));
  }
  const order = { WC: 0, DS: 1, LCS: 2, WS: 3 };
  rows.sort((a, b) => a.season - b.season || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || order[a.round] - order[b.round] || (a.home < b.home ? -1 : 1));
  const doc = {
    schema: 'edgedesk_sim_mlb_postseason_fixture_v1',
    built_at: new Date().toISOString(),
    provenance: 'Observed: Retrosheet postseason game logs (chadwickbureau/retrosheet mirror). ' + RETROSHEET_TERMS,
    seasons: [2012, 2025],
    sources,
    columns: ['season', 'round', 'date', 'series_game', 'away', 'away_league', 'home', 'home_league', 'as', 'hs', 'outs', 'innings', 'park', 'sp_away', 'sp_home'],
    games: rows.map((r) => [r.season, r.round, r.date, r.series_game, r.away, r.away_league, r.home, r.home_league, r.as, r.hs, r.outs, r.innings, r.park, r.sp_away, r.sp_home])
  };
  fs.writeFileSync(MLB_POSTSEASON_FIXTURE, JSON.stringify(doc, null, 0).replace(/\],\[/g, '],\n[') + '\n');
  console.log('wrote ' + path.relative(process.cwd(), MLB_POSTSEASON_FIXTURE) + ': ' + rows.length + ' postseason games 2012-2025');
}

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
