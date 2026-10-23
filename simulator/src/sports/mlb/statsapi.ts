/* ===========================================================================
   THE LIVE MLB SNAPSHOT, FROM MLB'S STATS API.

     schedule   https://statsapi.mlb.com/api/v1/schedule?sportId=1&season=Y
                &gameType=R,F,D,L,W&hydrate=probablePitcher&startDate&endDate
                every regular-season and postseason game: date (officialDate),
                doubleheader and game number, status, score, series game
                number, and the announced probable starters
     box score  https://statsapi.mlb.com/api/v1/game/<gamePk>/boxscore
                for every completed game: the starting pitcher of each side
                (the first pitcher the box score lists)
     crosswalk  Chadwick Bureau register (people-0..f.csv, raw.githubusercontent.com):
                MLBAM id -> Retrosheet id, so a 2026 starter keeps the rating
                the served model learned for him on 2010-2025 Retrosheet logs;
                an unmapped pitcher is keyed mlbam:<id> (no history: s = 0)

   The schedule has its own grammar, handled here and tested on the REAL 2024
   schedule response committed in the data pack
   (datapack/quant_v1/data/mlb/raw/schedule_2024.json.gz):
     - one game can appear on several dates under one gamePk: a postponed
       game on its original date (status Postponed, rescheduleGameDate) and
       again on its new date; a suspended game on the day it started and the
       day it was resumed (both final, the same officialDate). The game is
       kept once: final if any appearance is final, dated by its officialDate
       (the day its starters started); else the latest scheduled appearance (a
       suspended game still to be resumed: on its resumption day);
       a game that only appears postponed is kept with date_estimated
     - Cancelled games were never played and never will be: dropped, counted
     - doubleHeader Y (traditional) or S (split) with gameNumber 1 / 2
     - spring training, exhibitions and the All-Star Game are ignored
   MLB's API is not reachable from the environment this was built in (the
   egress policy refuses statsapi.mlb.com): this path has never been run
   against the live API; the CI workflow probes it (MLB_SIMULATOR_NOTES.md).
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { MLB_2026, teamsFor, type MlbTeam, type Round } from './config.ts';
import { loadRegularSeason, REPO, dayOf, dateOf, type HistGame } from './history.ts';
import { replay, servedConfig, calibrationFor, type ModelState } from './model_adapter.ts';
import { assemble, finalize, type MlbInputGame, type MlbSnapshot, type StarterRef } from './inputs.ts';
import { sha256Hex } from '../../core/canonical.ts';

export const STATSAPI = 'https://statsapi.mlb.com/api/v1/';
const ROUND_OF: Record<string, Round> = { F: 'WC', D: 'DS', L: 'LCS', W: 'WS' };

export interface ParsedGame extends MlbInputGame { pk: number; probable: { home: { id: number; name: string } | null; away: { id: number; name: string } | null } }
export interface ParsedSchedule { games: ParsedGame[]; dropped: { cancelled: number[]; other_types: number; duplicates: number }; latest_final: string | null }

const finalCode = (s: any) => s && (s.codedGameState === 'F' || s.codedGameState === 'O' || s.abstractGameState === 'Final' && s.codedGameState !== 'D' && s.codedGameState !== 'C');
const postponed = (s: any) => s && (s.codedGameState === 'D' || s.detailedState === 'Postponed');
const cancelled = (s: any) => s && (s.codedGameState === 'C' || s.detailedState === 'Cancelled');

/** the schedule response -> one record per game (pure) */
export function parseSchedule(json: any, teams: MlbTeam[]): ParsedSchedule {
  const byId: Record<number, string> = {}; teams.forEach((t) => { byId[t.statsapi_id] = t.code; });
  const entries = new Map<number, any[]>();
  let other = 0;
  for (const day of json.dates || []) for (const g of day.games || []) {
    if (g.gameType !== 'R' && !ROUND_OF[g.gameType]) { other++; continue; }
    if (!entries.has(g.gamePk)) entries.set(g.gamePk, []);
    entries.get(g.gamePk)!.push(g);
  }
  const games: ParsedGame[] = []; const cancelledPks: number[] = []; let dups = 0, latest: string | null = null;
  for (const [pk, list] of entries) {
    dups += list.length - 1;
    const fin = list.find((g) => finalCode(g.status));
    let g = fin;
    let estimated = false;
    if (!g) {
      if (list.some((x) => cancelled(x.status)) && !list.some((x) => !cancelled(x.status) && !postponed(x.status))) { cancelledPks.push(pk); continue; }
      const live = list.filter((x) => !postponed(x.status) && !cancelled(x.status)).sort((a, b) => (a.gameDate < b.gameDate ? 1 : -1));
      g = live[0] || list.slice().sort((a, b) => (a.gameDate < b.gameDate ? 1 : -1))[0];
      estimated = !live.length;
    }
    const h = byId[g.teams?.home?.team?.id], a = byId[g.teams?.away?.team?.id];
    if (!h || !a) {
      if (ROUND_OF[g.gameType]) continue;           // a postseason placeholder whose clubs are not decided yet
      throw new Error('unknown club in game ' + pk + ': ' + JSON.stringify([g.teams?.home?.team, g.teams?.away?.team]));
    }
    const done = !!fin;
    const pp = (side: 'home' | 'away') => { const p = g.teams[side].probablePitcher; return p && p.id ? { id: Number(p.id), name: String(p.fullName || '') } : null; };
    /* a suspended game still to be resumed keeps its original officialDate on the resumption's entry: it is
       played on the day it resumes (the local date of its start time, UTC - 10 h as the data pack dates games) */
    const date = !done && g.resumedFromDate && g.gameDate ? new Date(Date.parse(g.gameDate) - 10 * 3600e3).toISOString().slice(0, 10) : String(g.officialDate || String(g.gameDate).slice(0, 10));
    if (done && (!latest || date > latest)) latest = date;
    const post = !!ROUND_OF[g.gameType];
    games.push({
      pk, id: 'mlb:' + pk, phase: post ? 'postseason' : 'regular', date, game_no: g.doubleHeader === 'Y' || g.doubleHeader === 'S' ? Number(g.gameNumber) : 0,
      home: h, away: a, status: done ? 'final' : 'scheduled',
      home_score: done ? Number(g.teams.home.score) : null, away_score: done ? Number(g.teams.away.score) : null,
      starters: { home: null, away: null }, round: post ? ROUND_OF[g.gameType] : null, series_game: post ? Number(g.seriesGameNumber) : null,
      date_estimated: estimated, probable: { home: pp('home'), away: pp('away') }
    });
  }
  games.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.game_no - y.game_no || x.pk - y.pk));
  return { games, dropped: { cancelled: cancelledPks.sort((x, y) => x - y), other_types: other, duplicates: dups }, latest_final: latest };
}

/** the starting pitcher of each side of a box score: the first pitcher it lists (pure) */
export function boxscoreStarters(box: any): { home: { id: number; name: string } | null; away: { id: number; name: string } | null } {
  const side = (s: 'home' | 'away') => {
    const t = box && box.teams && box.teams[s];
    const id = t && Array.isArray(t.pitchers) && t.pitchers.length ? Number(t.pitchers[0]) : null;
    if (id == null) return null;
    const pl = t.players && t.players['ID' + id];
    return { id, name: pl && pl.person ? String(pl.person.fullName || '') : '' };
  };
  return { home: side('home'), away: side('away') };
}

/** Chadwick register rows -> MLBAM id to Retrosheet id */
export function crosswalk(csvTexts: string[]): Record<number, string> {
  const out: Record<number, string> = {};
  for (const text of csvTexts) {
    const lines = text.split(/\r?\n/); const head = lines[0].split(',');
    const im = head.indexOf('key_mlbam'), ir = head.indexOf('key_retro');
    if (im < 0 || ir < 0) throw new Error('register file without key_mlbam/key_retro');
    for (let i = 1; i < lines.length; i++) { const f = lines[i].split(','); if (f[im] && f[ir]) out[Number(f[im])] = f[ir]; }
  }
  return out;
}

export interface LiveOptions { offline?: boolean; season?: number; asOf?: string; fetchText?: (url: string) => Promise<string> }
const CACHE = path.join(REPO, 'simulator', '.cache', 'feeds');

/** a cached fetcher with bounded retries (transient errors only); every feed's sha256 is recorded */
export function cachedFetcher(offline: boolean, feeds: Array<{ url: string; sha256: string; bytes: number }>, immutable: (u: string) => boolean) {
  return async (u: string): Promise<string> => {
    const key = path.join(CACHE, u.replace(/[^a-z0-9.]+/gi, '_').slice(-160));
    let text: string | null = null;
    if (fs.existsSync(key) && (offline || immutable(u))) text = fs.readFileSync(key, 'utf8');
    else if (offline) throw new Error('offline and not cached: ' + u);
    else {
      let last: unknown = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const r = await fetch(u, { redirect: 'follow' });
          if (r.status === 404 || r.status === 403) throw Object.assign(new Error('HTTP ' + r.status + ' ' + u), { permanent: true });
          if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + u);
          text = await r.text(); last = null; break;
        } catch (e) { last = e; if ((e as any).permanent) break; await new Promise((res) => setTimeout(res, 1000 * Math.pow(2, attempt))); }
      }
      if (last) throw last;
      fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(key, text as string);
    }
    feeds.push({ url: u, sha256: sha256Hex(text as string), bytes: (text as string).length });
    return text as string;
  };
}

export async function buildMlbLiveSnapshot(opt: LiveOptions = {}): Promise<MlbSnapshot> {
  const cfg = MLB_2026; const season = opt.season ?? cfg.season;
  if (season !== cfg.season) throw new Error('no live MLB season config for ' + season);
  const teams = teamsFor(season);
  const feeds: Array<{ url: string; sha256: string; bytes: number }> = [];
  const get = opt.fetchText || cachedFetcher(!!opt.offline, feeds, (u) => /\/boxscore$/.test(u) || /chadwickbureau\/register/.test(u));
  const schedUrl = STATSAPI + 'schedule?sportId=1&season=' + season + '&gameType=R,F,D,L,W&hydrate=probablePitcher&startDate=' + season + '-03-01&endDate=' + season + '-11-30';
  const sched = parseSchedule(JSON.parse(await get(schedUrl)), teams);
  const asOf = opt.asOf || dateOf(dayOf(new Date().toISOString().slice(0, 10)));
  const asDay = dayOf(asOf);
  /* the crosswalk, then every completed game's starters from its box score */
  const reg: string[] = [];
  for (const h of '0123456789abcdef') reg.push(await get('https://raw.githubusercontent.com/chadwickbureau/register/master/data/people-' + h + '.csv'));
  const xw = crosswalk(reg);
  const key = (id: number) => xw[id] || 'mlbam:' + id;
  const names: Record<string, string> = JSON.parse(fs.readFileSync(path.join(REPO, 'mlb', 'history', 'data', 'pitchers.json'), 'utf8'));
  const games: MlbInputGame[] = [];
  const notes: string[] = [];
  /* box scores, eight at a time (a completed game's box score never changes: cached) */
  const boxes = new Map<number, ReturnType<typeof boxscoreStarters>>();
  const need = sched.games.filter((g) => g.status === 'final' && dayOf(g.date) < asDay).map((g) => g.pk);
  for (let i = 0; i < need.length; i += 8) {
    const part = need.slice(i, i + 8);
    const got = await Promise.all(part.map((pk) => get(STATSAPI + 'game/' + pk + '/boxscore')));
    part.forEach((pk, j) => boxes.set(pk, boxscoreStarters(JSON.parse(got[j]))));
  }
  for (const g of sched.games) {
    let home: StarterRef | null = null, away: StarterRef | null = null;
    const isFinal = g.status === 'final' && dayOf(g.date) < asDay;
    if (isFinal) {
      const sp = boxes.get(g.pk) as ReturnType<typeof boxscoreStarters>;
      if (sp.home) { home = { id: key(sp.home.id), status: 'Observed' }; if (sp.home.name && !names[home.id]) names[home.id] = sp.home.name; }
      if (sp.away) { away = { id: key(sp.away.id), status: 'Observed' }; if (sp.away.name && !names[away.id]) names[away.id] = sp.away.name; }
    } else {
      if (g.probable.home) { home = { id: key(g.probable.home.id), status: 'Confirmed' }; if (!names[home.id]) names[home.id] = g.probable.home.name; }
      if (g.probable.away) { away = { id: key(g.probable.away.id), status: 'Confirmed' }; if (!names[away.id]) names[away.id] = g.probable.away.name; }
    }
    games.push({ id: g.id, phase: g.phase, date: g.date, game_no: g.game_no, home: g.home, away: g.away, round: g.round, series_game: g.series_game, date_estimated: g.date_estimated, status: isFinal ? 'final' : 'scheduled', home_score: isFinal ? g.home_score : null, away_score: isFinal ? g.away_score : null, starters: { home, away } });
  }
  if (sched.dropped.cancelled.length) notes.push(sched.dropped.cancelled.length + ' cancelled games were never played and are not simulated: ' + sched.dropped.cancelled.join(', '));
  if (games.some((x) => x.date_estimated)) notes.push('Postponed games without a new date are simulated after the last scheduled date: ' + games.filter((x) => x.date_estimated).map((x) => x.id).join(', '));
  /* the served model through the as-of morning: 2010-2025 committed logs, then this season's completed regular-season games */
  const hist: HistGame[] = []; for (let s = 2010; s < season; s++) hist.push(...loadRegularSeason(s).games);
  for (const x of games) if (x.phase === 'regular' && x.status === 'final') hist.push({ id: x.id, season, date: x.date, game_no: x.game_no, home: x.home, away: x.away, hs: x.home_score as number, as: x.away_score as number, outs: null, sp_home: x.starters.home ? x.starters.home.id : null, sp_away: x.starters.away ? x.starters.away.id : null, source: 'statsapi' });
  hist.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.game_no - b.game_no));
  const lastReg = games.filter((x) => x.phase === 'regular').reduce((m, x) => (x.date > m ? x.date : m), '0000-00-00');
  const stop = Math.min(asDay, dayOf(lastReg) + 1);
  const r = replay(hist, { params: servedConfig().config, stopAt: stop });
  const calibration = calibrationFor(season, hist, r.raw);
  notes.push('Live ' + season + ' snapshot as of the morning of ' + asOf + ' from MLB\'s Stats API; starters of completed games from the box scores, of scheduled games the announced probables (Confirmed); later starters are projected in the run.');
  const data = assemble({ season, mode: 'live', asOf, config: cfg, teams, games, state: r.final as ModelState, calibration, fitAsOf: dateOf(stop), names, notes });
  return finalize(data, { feeds, offline: !!opt.offline, builder: 'simulator/src/sports/mlb/statsapi.ts buildMlbLiveSnapshot' });
}
