/* ===========================================================================
   FINALS THE SCHEDULE FEED HAS NOT CAUGHT UP ON.

   The season feed (cfbfastR-data's schedule CSV) is refreshed in batches. On
   2026-10-23 at 19:55 UTC it still listed every week-8 game from Tuesday to
   Thursday as unplayed, so the published run simulated James Madison at App
   State, which App State had won 34-31 in overtime the night before, and kept
   James Madison unbeaten.

   So before the replay, every feed game that has kicked off and is not
   completed is looked up on ESPN's public scoreboard: the read the slate
   already makes (tools/slate/espn.js), one US-Eastern day per request, the
   FBS group (80) and, for a game it does not list, the FCS group (81). A game
   is taken as final only when
     - ESPN's event id is the feed's game_id,
     - ESPN's two team ids are the feed's home_id and away_id (the scores are
       assigned by team id, so a neutral site's home/away labels cannot swap
       them), and
     - ESPN calls it final with two integer, unequal scores.
   Nothing is inferred. A game ESPN reports postponed or canceled stays as
   scheduled and is listed. A game that kicked off more than LAG_HOURS before
   the snapshot (a game with no kickoff time yet: LAG_HOURS after its day ends)
   and neither source settles is listed as unresolved, and the input gate
   results.current holds publication (validate.ts).

   What enters the hashed inputs is only what is stable from night to night
   (the finals taken, the games not played, the unresolved ones); each ESPN
   read's url, time and sha256 go to the snapshot's meta.feeds.
   =========================================================================== */
import { createRequire } from 'node:module';
import path from 'node:path';
import { REPO, type FeedGame } from './engine_adapter.ts';
import { sha256Hex } from '../../core/canonical.ts';

const require = createRequire(import.meta.url);
const ESPN = require(path.join(REPO, 'tools', 'slate', 'espn.js'));

/** a game this long after kickoff should be over (overtime included) */
export const LAG_HOURS = 6;
const FEEDS = [
  { sport: 'cfb', key: 'cfb:football/college-football', path: 'football/college-football', groups: '80', league: 'FBS', limit: 300 },
  { sport: 'cfb', key: 'cfb:football/college-football:fcs', path: 'football/college-football', groups: '81', league: 'FCS', limit: 300 }
];
const MAX_DAYS = 21;

export interface FinalTaken { game_id: string; kickoff: string; home: string; away: string; home_points: number; away_points: number; detail: string | null }
export interface GameListed { game_id: string; kickoff: string; home: string; away: string; status: string }
export interface ResultsOverlay {
  source: string;
  /** false: no lookup was made (an offline build); results.current then only warns */
  checked: boolean;
  lag_hours: number;
  applied: FinalTaken[];
  not_played: GameListed[];
  unresolved: GameListed[];
}
export interface FinalsRead { url: string; sha256: string; bytes: number; ok: boolean; error?: string }
type FetchLike = (url: string, init?: any) => Promise<Response>;

const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);

/**
 * Settle, in place, the feed games that kicked off by `now` and are not completed.
 * `rows` are the season feed's rows (their objects are the ones the replay reads).
 */
export async function overlayFinals(rows: FeedGame[], o: { now: number; offline: boolean; fetch?: FetchLike; retries?: number }): Promise<{ overlay: ResultsOverlay; reads: FinalsRead[] }> {
  const overlay: ResultsOverlay = { source: 'ESPN public scoreboard (site.api.espn.com), FBS group 80 then FCS group 81, one US-Eastern day per request; matched by event id and both team ids',
    checked: !o.offline, lag_hours: LAG_HOURS, applied: [], not_played: [], unresolved: [] };
  const reads: FinalsRead[] = [];
  const started = rows.filter((g) => !g.completed && g.kick > 0 && g.kick <= o.now).sort((a, b) => (a.kick - b.kick) || a.game_id.localeCompare(b.game_id));
  /* a game with no kickoff time yet is dated midnight Eastern: it is only overdue once its whole day has passed */
  const overdue = (g: FeedGame) => g.kick + (g.time_tbd ? 24 * 3600e3 : 0) <= o.now - LAG_HOURS * 3600e3;
  const listed = (g: FeedGame, status: string): GameListed => ({ game_id: g.game_id, kickoff: g.start_date, home: g.home, away: g.away, status });
  if (o.offline || !started.length) {
    for (const g of started) if (overdue(g)) overlay.unresolved.push(listed(g, o.offline ? 'not looked up (offline build)' : 'not final'));
    return { overlay, reads };
  }
  /* the plain request tools/slate/espn.js makes, with its text kept for the record */
  const base: FetchLike = o.fetch || ((u, i) => fetch(u, i));
  const texts = new Map<string, string>();
  const capture: FetchLike = async (url, init) => {
    const r = await base(url, init);
    const text = await r.text();
    texts.set(url, text);
    return new Response([204, 205, 304].includes(r.status) ? null : text, { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  const events = new Map<string, any>();
  const failed = new Map<string, string>();
  async function readDay(feed: (typeof FEEDS)[number], day: string): Promise<void> {
    let r: any = null;
    for (let attempt = 1; attempt <= (o.retries ?? 3); attempt++) {
      r = await ESPN.readDay(feed, day, { fetch: capture, now: o.now, timeoutMs: 20000 });
      if (r.ok || (r.status >= 400 && r.status < 500)) break;
      if (attempt < (o.retries ?? 3)) await new Promise((res) => setTimeout(res, 1000 * 2 ** (attempt - 1)));
    }
    const text = texts.get(r.url) || '';
    reads.push({ url: r.url, sha256: sha256Hex(text), bytes: Buffer.byteLength(text), ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
    if (!r.ok) { failed.set(feed.groups + ':' + day, r.error); return; }
    for (const e of r.events) if (!events.has(e.provider_id)) events.set(e.provider_id, e);
  }
  const dayOf = (g: FeedGame) => ESPN.etDay(g.kick) as string;
  const days = [...new Set(started.map(dayOf))].sort().slice(-MAX_DAYS);
  for (const d of days) await readDay(FEEDS[0], d);
  /* the FCS group, only for the days with a started game the FBS scoreboard did not list */
  const missing = [...new Set(started.filter((g) => days.includes(dayOf(g)) && !events.has(g.game_id)).map(dayOf))];
  for (const d of missing) await readDay(FEEDS[1], d);

  for (const g of started) {
    const e = events.get(g.game_id);
    const why = (s: string) => { if (overdue(g)) overlay.unresolved.push(listed(g, s)); };
    if (!e) { why(failed.has('80:' + dayOf(g)) ? 'ESPN read failed: ' + failed.get('80:' + dayOf(g)) : days.includes(dayOf(g)) ? 'not on ESPN\'s scoreboard for its day' : 'older than the ' + MAX_DAYS + ' days looked up'); continue; }
    if (e.status === 'POSTPONED' || e.status === 'CANCELED') { overlay.not_played.push(listed(g, e.status + (e.status_detail ? ' (' + e.status_detail + ')' : ''))); continue; }
    if (e.status !== 'FINAL') { why('ESPN status ' + e.status + (e.status_detail ? ' (' + e.status_detail + ')' : '')); continue; }
    const byId = new Map<string, any>([[String(e.home.id), e.home], [String(e.away.id), e.away]]);
    const h = g.home_id != null ? byId.get(g.home_id) : undefined, a = g.away_id != null ? byId.get(g.away_id) : undefined;
    if (!h || !a || h === a) { why('ESPN team ids ' + e.away.id + ' @ ' + e.home.id + ' are not the feed\'s ' + g.away_id + ' @ ' + g.home_id); continue; }
    if (!isInt(h.score) || !isInt(a.score) || h.score === a.score) { why('ESPN final without two integer, unequal scores (' + a.score + '-' + h.score + ')'); continue; }
    g.completed = true; g.home_points = h.score; g.away_points = a.score;
    overlay.applied.push({ game_id: g.game_id, kickoff: g.start_date, home: g.home, away: g.away, home_points: h.score, away_points: a.score, detail: e.status_detail || null });
  }
  return { overlay, reads };
}

/** one line per final, for the run log and the snapshot notes */
export function describeFinals(x: ResultsOverlay): string {
  return x.applied.map((f) => f.away + ' ' + f.away_points + ' @ ' + f.home + ' ' + f.home_points + (f.detail && f.detail !== 'Final' ? ' (' + f.detail + ')' : '')).join('; ');
}
