/* ===========================================================================
   edgedesk-sim fetch-sports-data — the feeds the golf and UFC simulations
   read, fetched from somewhere that can reach them (GitHub's runners:
   .github/workflows/simulator-sports-data.yml) and written as committed,
   hashed files under simulator/data/feeds/.

     node simulator/src/cli/fetch_sports_data.ts --what golf|ufc|all [--out simulator/data/feeds]
                                                 [--golf-seasons 2023,2024,2025,2026] [--golf-leagues pga]

   GOLF (ESPN's public golf scoreboard): every event of each season's
   calendar with each player's strokes per round, holes completed in a round
   in progress, the player's status (active / cut / withdrawn / disqualified)
   and finishing position, each round's tee time and playoff flag, and the
   event's own tournament and playoff-format fields as ESPN states them
   (number of rounds, cut round and count, playoff type; scalar fields only);
   and the current scoreboard of each league whole (pruned of hole-by-hole
   detail), so a run can see the field, the round in progress and the
   event's own fields. The parser is simulator/src/sports/golf/espn.ts, the
   one a golf run uses on the live leaderboard.
   UFC (ESPN's public MMA scoreboard, month by month from 2014, and the UFC's
   own rankings page): every bout with its title flag, scheduled rounds, both
   fighters' rank at the time ("C" = champion), winner, method and end round;
   the current official rankings (champion and 1-15 per division).

   Read-only: no credential, nothing logs in or pays. Every request's URL,
   HTTP status and byte count is recorded in fetch_report.json beside the
   data, and each file carries the sha256 of what was read, so a reviewed
   commit can cite exactly what a run used. A feed that does not answer is
   recorded as such; nothing is invented to fill it.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../core/canonical.ts';
/* one parser for the feed and for a golf run's live read (the same record either way) */
import { ESPN, ESPN_WEB, golfEvent, competitionMeta } from '../sports/golf/espn.ts';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require = createRequire(import.meta.url);
const espnUfc = require(path.join(REPO, 'tools', 'ufc', 'espn.js')) as { parseScoreboard: (j: unknown) => Array<Record<string, any>> };

const argv = process.argv.slice(2), opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const WHAT = opt('--what') || 'all';
const OUT = opt('--out') || path.join(REPO, 'simulator', 'data', 'feeds');
const GOLF_SEASONS = (opt('--golf-seasons') || '2023,2024,2025,2026').split(',').map(Number).filter(Boolean);
const GOLF_LEAGUES = (opt('--golf-leagues') || 'pga,lpga,eur').split(',').filter(Boolean);
const CURRENT_LEAGUES = ['pga', 'lpga', 'eur'];
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

type Req = { url: string; status: number | string; bytes: number; ms: number; note?: string };
const report: { started_at: string; finished_at?: string; requests: Req[]; summary: Record<string, unknown> } = { started_at: new Date().toISOString(), requests: [], summary: {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url: string, opts: { accept?: string; ua?: string; tries?: number } = {}): Promise<{ status: number; text: string } | null> {
  const tries = opts.tries || 3;
  for (let i = 0; i < tries; i++) {
    const t0 = Date.now();
    try {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 30000);
      const headers: Record<string, string> = { accept: opts.accept || 'application/json' };
      if (opts.ua) headers['user-agent'] = opts.ua;
      const res = await fetch(url, { headers, redirect: 'follow', signal: ctl.signal });
      const text = await res.text();
      clearTimeout(timer);
      report.requests.push({ url, status: res.status, bytes: text.length, ms: Date.now() - t0 });
      if (res.ok) return { status: res.status, text };
      /* a 4xx is an answer, not a transient failure */
      if (res.status >= 400 && res.status < 500 && res.status !== 429) return { status: res.status, text };
    } catch (e) {
      report.requests.push({ url, status: 'error', bytes: 0, ms: Date.now() - t0, note: String((e as Error).message || e).slice(0, 120) });
    }
    await sleep(1000 * 2 ** i);
  }
  return null;
}
async function fetchJson(url: string): Promise<any | null> {
  const r = await fetchText(url);
  if (!r || r.status !== 200) return null;
  try { return JSON.parse(r.text); } catch (_) { return null; }
}
function writeGz(name: string, doc: unknown) {
  const text = JSON.stringify(doc);
  fs.writeFileSync(path.join(OUT, name), zlib.gzipSync(Buffer.from(text), { level: 9 }));
  return sha256Hex(text);
}
function writeJson(name: string, doc: unknown) {
  const text = JSON.stringify(doc, null, 1);
  fs.writeFileSync(path.join(OUT, name), text + '\n');
  return sha256Hex(text);
}
const str = (v: unknown) => (v == null ? null : String(v));

/* ------------------------------------------------------------------ golf */
const ESPN_CORE = 'https://sports.core.api.espn.com/v2/sports/golf/leagues';
const ymd = (iso: string) => iso.slice(0, 10).replace(/-/g, '');

async function golfCalendar(league: string, season: number): Promise<Array<{ id: string; label: string | null; start: string | null; end: string | null }>> {
  const sb = await fetchJson(ESPN + '/' + league + '/scoreboard?dates=' + season);
  const cal = sb && sb.leagues && sb.leagues[0] && Array.isArray(sb.leagues[0].calendar) ? sb.leagues[0].calendar : [];
  const fromSb = cal.map((c: any) => ({ id: str(c.id || (c.event && c.event.id) || (c.$ref && String(c.$ref).match(/events\/(\d+)/)?.[1])), label: str(c.label), start: str(c.startDate), end: str(c.endDate) }))
    .filter((c: any) => c.id && (!c.start || c.start.slice(0, 4) === String(season) || (c.end || '').slice(0, 4) === String(season)));
  if (fromSb.length) return fromSb;
  /* the core API's season list (event references only) */
  const core = await fetchJson(ESPN_CORE + '/' + league + '/seasons/' + season + '/types/2/events?limit=300');
  const items = core && Array.isArray(core.items) ? core.items : [];
  return items.map((x: any) => ({ id: String(x.$ref || '').match(/events\/(\d+)/)?.[1] || null, label: null, start: null, end: null })).filter((x: any) => x.id) as any;
}
async function golfEventById(league: string, id: string, start: string | null) {
  const tries: Array<[string, string]> = [
    ['scoreboard?event', ESPN + '/' + league + '/scoreboard?event=' + id],
    ['leaderboard', ESPN_WEB + '/leaderboard?league=' + league + '&event=' + id]
  ];
  if (start) tries.push(['scoreboard?dates', ESPN + '/' + league + '/scoreboard?dates=' + ymd(start)]);
  for (const [how, url] of tries) {
    const j = await fetchJson(url);
    const evs = j ? (Array.isArray(j.events) ? j.events : j.id != null ? [j] : []) : [];
    const ev = evs.find((e: any) => String(e.id) === id);
    if (ev && ev.competitions && ev.competitions[0] && Array.isArray(ev.competitions[0].competitors) && ev.competitions[0].competitors.length) return golfEvent(ev, league, how);
  }
  return null;
}
async function fetchGolf() {
  const events: any[] = [], missing: any[] = [];
  for (const league of GOLF_LEAGUES) {
    for (const season of GOLF_SEASONS) {
      const cal = await golfCalendar(league, season);
      console.log('golf ' + league + ' ' + season + ': ' + cal.length + ' calendar events');
      for (const c of cal) {
        if (c.start && Date.parse(c.start) > Date.now() + 7 * 864e5) continue;   /* not started: nothing to read yet */
        const ev = await golfEventById(league, c.id, c.start);
        if (ev) { (ev as any).season = season; (ev as any).label = c.label; events.push(ev); }
        else missing.push({ league, season, id: c.id, label: c.label, start: c.start });
        await sleep(120);
      }
    }
  }
  const historyHash = writeGz('golf_events.json.gz', { schema: 'edgedesk_feed_golf_events_v1', fetched_at: new Date().toISOString(), source: 'ESPN public golf scoreboard (' + ESPN + ')', leagues: GOLF_LEAGUES, seasons: GOLF_SEASONS, events, missing });
  /* the current scoreboard of each league, whole except the hole-by-hole detail */
  const current: Record<string, unknown> = {};
  for (const league of CURRENT_LEAGUES) {
    const j = await fetchJson(ESPN + '/' + league + '/scoreboard');
    if (!j) { current[league] = null; continue; }
    const events: any[] = [];
    for (const ev of j.events || []) {
      /* the leaderboard carries each player's status (cut, WD), position, thru and tee time; the scoreboard does not */
      const lb = await fetchJson(ESPN_WEB + '/leaderboard?league=' + league + '&event=' + ev.id);
      const lev = lb ? (Array.isArray(lb.events) ? lb.events : []).find((e: any) => String(e.id) === String(ev.id)) : null;
      const use = lev && lev.competitions && lev.competitions[0] && Array.isArray(lev.competitions[0].competitors) && lev.competitions[0].competitors.length ? lev : ev;
      events.push({ ...golfEvent(use, league, use === lev ? 'leaderboard' : 'scoreboard'), competition: competitionMeta((use.competitions || [])[0]), event_keys: Object.keys(use).sort(),
        leaderboard_competitor_sample: use === lev ? lev.competitions[0].competitors.slice(0, 2) : null });
    }
    /* the next two calendar events: their fields, when ESPN lists them before the first round */
    const cal = (j.leagues || [])[0] && Array.isArray(j.leagues[0].calendar) ? j.leagues[0].calendar : [];
    const now = Date.now(), have = new Set(events.map((e) => e.id));
    const next = cal.filter((c: any) => c.startDate && Date.parse(c.startDate) > now && !have.has(String(c.id))).slice(0, 2);
    const upcoming: any[] = [];
    for (const c of next) {
      const lb = await fetchJson(ESPN_WEB + '/leaderboard?league=' + league + '&event=' + c.id);
      const lev = lb ? (Array.isArray(lb.events) ? lb.events : []).find((e: any) => String(e.id) === String(c.id)) : null;
      upcoming.push(lev ? golfEvent(lev, league, 'leaderboard') : { league, id: String(c.id), name: c.label || null, start: c.startDate || null, competitors: [] });
    }
    current[league] = {
      league: (j.leagues || [])[0] ? { id: j.leagues[0].id, name: j.leagues[0].name, season: j.leagues[0].season, calendar: j.leagues[0].calendar } : null,
      events, upcoming
    };
  }
  const currentHash = writeJson('golf_current.json', { schema: 'edgedesk_feed_golf_current_v1', fetched_at: new Date().toISOString(), source: ESPN + '/<league>/scoreboard', current });
  const n = events.reduce((a, e) => a + e.competitors.length, 0);
  report.summary.golf = { events: events.length, missing: missing.length, player_events: n, history_sha256: historyHash, current_sha256: currentHash,
    by: events.reduce((a: Record<string, number>, e) => { a[e.fetched_by] = (a[e.fetched_by] || 0) + 1; return a; }, {}) };
  console.log('golf: ' + events.length + ' events (' + n + ' player-events), ' + missing.length + ' unread; current: ' + Object.entries(current).map(([k, v]: [string, any]) => k + '=' + (v ? (v.events || []).map((e: any) => e.name + ' [' + e.status + ', ' + e.competitors.length + ']').join(' | ') : 'unread')).join(' · '));
}

/* ------------------------------------------------------------------ UFC */
function ufcBoutRow(b: Record<string, any>, ev: Record<string, any>) {
  return {
    bout_id: b.provider_bout_id, event_id: ev.provider_event_id, event: ev.name, date: b.scheduled_at || ev.scheduled_at,
    weight_class: b.weight_class, is_title: !!b.is_title, is_main: !!b.is_main, rounds: b.scheduled_rounds, order: b.bout_order, segment: b.card_segment,
    a_id: b.red_provider_id, a: b.red_name, a_rank: b.red_rank, a_record: b.red_record,
    b_id: b.blue_provider_id, b: b.blue_name, b_rank: b.blue_rank, b_record: b.blue_record,
    status: b.status, winner: b.winner_corner === 'red' ? 'a' : b.winner_corner === 'blue' ? 'b' : b.winner_corner,
    method: b.method, method_detail: b.method_detail, end_round: b.end_round, end_time: b.end_time
  };
}
async function fetchUfc() {
  const rows: any[] = [], months: string[] = [], unread: string[] = [];
  const now = new Date();
  for (let y = 2014; y <= now.getUTCFullYear() + (now.getUTCMonth() === 11 ? 1 : 0); y++) {
    for (let m = 1; m <= 12; m++) {
      const key = y + String(m).padStart(2, '0');
      if (Date.UTC(y, m - 1, 1) > now.getTime() + 62 * 864e5) continue;
      const j = await fetchJson('https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates=' + key + '&limit=1000');
      if (!j) { unread.push(key); continue; }
      months.push(key);
      for (const ev of espnUfc.parseScoreboard(j)) for (const b of ev.bouts) rows.push(ufcBoutRow(b, ev));
      await sleep(100);
    }
  }
  const seen = new Set<string>();
  const bouts = rows.filter((r) => (seen.has(r.bout_id) ? false : (seen.add(r.bout_id), true))).sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.bout_id).localeCompare(String(b.bout_id)));
  const boutsHash = writeGz('ufc_bouts.json.gz', { schema: 'edgedesk_feed_ufc_bouts_v1', fetched_at: new Date().toISOString(), source: 'ESPN public MMA scoreboard, month by month (tools/ufc/espn.js parseScoreboard)', months, unread, bouts });
  /* the UFC's own rankings page: champion and 1-15 per division */
  const page = await fetchText('https://www.ufc.com/rankings', { accept: 'text/html', ua: BROWSER_UA });
  let rankings: unknown = null, pageSha: string | null = null;
  if (page && page.status === 200) {
    pageSha = sha256Hex(page.text);
    fs.writeFileSync(path.join(OUT, 'ufc_rankings.html.gz'), zlib.gzipSync(Buffer.from(page.text), { level: 9 }));
    rankings = parseUfcRankings(page.text);
  }
  /* the champions' history (every title fight and reign by division), as Wikipedia's list keeps it: a
     secondary source, saved whole and parsed in the repository so a parser change needs no refetch */
  const wiki = await fetchText('https://en.wikipedia.org/wiki/List_of_UFC_champions', { accept: 'text/html', ua: BROWSER_UA });
  if (wiki && wiki.status === 200) fs.writeFileSync(path.join(OUT, 'ufc_champions_wikipedia.html.gz'), zlib.gzipSync(Buffer.from(wiki.text), { level: 9 }));
  /* raw samples of ESPN's own documents for the current and next month and the next cards' fight centres,
     so fields the parser does not read (title flags, ranks, methods) are visible in the repository */
  const samples: Record<string, unknown> = {};
  for (const k of [0, 1]) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1)), key = d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0');
    samples['scoreboard_' + key] = await fetchJson('https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates=' + key + '&limit=1000');
  }
  const upcomingEvents = [...new Set(bouts.filter((b) => b.status === 'scheduled').map((b) => b.event_id))].slice(0, 3);
  for (const id of upcomingEvents) samples['fightcenter_' + id] = await fetchJson('https://site.web.api.espn.com/apis/site/v2/sports/mma/ufc/fightcenter/' + id + '?region=us&lang=en');
  writeGz('ufc_espn_samples.json.gz', { schema: 'edgedesk_feed_ufc_samples_v1', fetched_at: new Date().toISOString(), samples });
  const rankHash = writeJson('ufc_rankings.json', { schema: 'edgedesk_feed_ufc_rankings_v1', fetched_at: new Date().toISOString(), url: 'https://www.ufc.com/rankings', http_status: page ? page.status : null, page_sha256: pageSha, divisions: rankings });
  const titles = bouts.filter((b) => b.is_title);
  report.summary.ufc = { bouts: bouts.length, title_bouts: titles.length, months: months.length, unread, rankings_divisions: Array.isArray(rankings) ? rankings.length : 0, bouts_sha256: boutsHash, rankings_sha256: rankHash };
  console.log('ufc: ' + bouts.length + ' bouts (' + titles.length + ' title bouts) from ' + months.length + ' months; unread ' + (unread.join(',') || 'none') + '; rankings ' + (Array.isArray(rankings) ? rankings.length + ' divisions' : 'unread (' + (page ? page.status : 'no answer') + ')'));
  if (Array.isArray(rankings)) for (const d of rankings as any[]) console.log('  ' + d.division + ': C ' + (d.champion ? d.champion.name : '—') + ' · ' + d.ranked.slice(0, 5).map((r: any) => r.rank + ' ' + r.name).join(', '));
}
/** ufc.com/rankings: one view-grouping per division; its header names the division, the champion sits
    in a caption block, the ranked fighters in table rows (rank cell, then the name link) */
export function parseUfcRankings(html: string) {
  const strip = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#039;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  const blocks = html.split(/<div class="view-grouping">/).slice(1);
  const out: Array<{ division: string; champion: { name: string; slug: string | null } | null; interim: { name: string; slug: string | null } | null; ranked: Array<{ rank: number; name: string; slug: string | null; change: string | null }> }> = [];
  for (const b of blocks) {
    const head = b.match(/<div class="view-grouping-header">([\s\S]*?)<\/div>/);
    if (!head) continue;
    const division = strip(head[1]);
    const caption = b.match(/<caption>([\s\S]*?)<\/caption>/);
    let champion = null, interim = null;
    if (caption) {
      const names = [...caption[1].matchAll(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({ name: strip(m[2]), slug: (m[1].match(/athlete\/([^/?#"]+)/) || [])[1] || null })).filter((x) => x.name);
      champion = names[0] || null;
      if (/interim/i.test(caption[1]) && names[1]) interim = names[1];
    }
    const ranked: Array<{ rank: number; name: string; slug: string | null; change: string | null }> = [];
    for (const row of b.split(/<tr[\s>]/).slice(1)) {
      const rk = row.match(/views-field-weight-class-rank[^>]*>([\s\S]*?)<\/td>/);
      const nm = row.match(/views-field-title[^>]*>[\s\S]*?<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
      if (!rk || !nm) continue;
      const rank = Number(strip(rk[1]));
      const ch = row.match(/views-field-weight-class-rank-change[^>]*>([\s\S]*?)<\/td>/);
      if (Number.isInteger(rank)) ranked.push({ rank, name: strip(nm[2]), slug: (nm[1].match(/athlete\/([^/?#"]+)/) || [])[1] || null, change: ch ? strip(ch[1]) || null : null });
    }
    out.push({ division, champion, interim, ranked });
  }
  return out;
}

/* ------------------------------------------------------------------ main */
const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  (async () => {
    if (!['golf', 'ufc', 'all'].includes(WHAT)) { console.error('usage: --what golf|ufc|all [--out DIR]'); process.exit(2); }
    fs.mkdirSync(OUT, { recursive: true });
    if (WHAT === 'golf' || WHAT === 'all') await fetchGolf();
    if (WHAT === 'ufc' || WHAT === 'all') await fetchUfc();
    report.finished_at = new Date().toISOString();
    const byStatus = report.requests.reduce((a: Record<string, number>, r) => { a[String(r.status)] = (a[String(r.status)] || 0) + 1; return a; }, {});
    report.summary.requests = byStatus;
    fs.writeFileSync(path.join(OUT, 'fetch_report_' + WHAT + '.json'), JSON.stringify(report, null, 1) + '\n');
    console.log('requests by status: ' + JSON.stringify(byStatus));
  })().catch((e) => { console.error(e); process.exit(1); });
}
