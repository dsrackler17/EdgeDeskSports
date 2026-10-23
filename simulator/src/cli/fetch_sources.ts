/* ===========================================================================
   edgedesk-sim fetch-sources — read the PRIMARY sources the simulator's
   activation gates name, from somewhere that can reach them (GitHub's
   runners: .github/workflows/simulator-sources.yml), and print them whole.

     node simulator/src/cli/fetch_sources.ts --sport nfl|nhl|nba|mlb [--out simulator/out/sources]

   Read-only. No credential, no database, nothing written outside --out.
   Prints, for each source: the URL asked and the URL answered, the HTTP
   status, the byte count and sha256 of the body, then the page text. A
   person (or a reviewed commit citing this log) compares that text with
   SIMULATOR_NOTES.md §7 and simulator/src/sports/nfl/config.ts; nothing here
   marks anything verified.

   NFL: the tiebreaking procedures and playoff seeding page, the Super Bowl
   LXI site announcement, the rules index (its playoff / rulebook links).
   NHL: the league's tie-breaking procedure and playoff format pages, and from
   its own API the season's format flags, the current standings (alignment,
   points, regulation and regulation-plus-overtime wins, goals) and every
   club's 2026-27 schedule, one line per game.
   NBA: the standings page (its tiebreaker paragraph), the play-in and NBA Cup
   explainers, the 2026-27 schedule release and key dates, and the league's
   2026-27 schedule file, one line per game; each page from nba.com, from
   api-hub.nba.com and as the Internet Archive keeps it (nba.com refuses the
   runners), the schedule release also from pr.nba.com.
   MLB: from the league's own Stats API the 2026 alignment and final
   standings (division, wild-card and league ranks, one line per club) and
   every 2026 postseason game (series, game number, hosts, scores, one line
   per game); the postseason, tiebreaker and extra-inning pages on mlb.com
   (live and as the Internet Archive keeps them), the archive's list of
   mlb.com pages that name them, and the 2026 Official Baseball Rules.
   Kalshi (each sport): every Sports series whose title names the league or
   its championship (with the series' own fee_type / fee_multiplier), every
   open market in them with its FULL settlement rules and their sha256 (the
   hash simulator/src/markets/kalshi.ts computes), and Kalshi's fee schedule.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { kalshiClient } from '../markets/kalshi.ts';
import { sha256Hex } from '../core/canonical.ts';

const a = process.argv.slice(2), get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
const OUT = get('--out') || path.join('simulator', 'out', 'sources');
const SPORT = get('--sport') || 'nfl';
if (!['nfl', 'nhl', 'nba', 'mlb'].includes(SPORT)) { console.error('usage: --sport nfl|nhl|nba|mlb [--out DIR]'); process.exit(2); }
const UA = 'Mozilla/5.0 (compatible; EdgeDesk-Simulator-SourceCheck/0.1; +https://github.com/dsrackler17/EdgeDeskSports)';
fs.mkdirSync(OUT, { recursive: true });

type Page = { id: string; url: string; links?: RegExp; grep?: RegExp; excerpt?: RegExp };
const NFL_PAGES: Page[] = [
  /* the NFL's published tiebreaking procedures (operations.nfl.com/the-rules/nfl-tiebreaking-procedures answered 404 on 2026-10-23) */
  { id: 'nfl_standings_tiebreaking', url: 'https://www.nfl.com/standings/tie-breaking-procedures' },
  /* what changed for 2026: the league's own list of adopted rules, bylaws and resolutions, and the proposals before the vote */
  { id: 'nfl_2026_approved', url: 'https://media.nfl.com/football-information/2026/news/approved-2026-playing-rules--bylaws-and-resolutions' },
  { id: 'nfl_2026_announced', url: 'https://www.nfl.com/news/nfl-announces-new-playing-rules-bylaws-resolutions-for-2026' },
  { id: 'nfl_2026_proposals_pdf', url: 'https://media.nfl.com/content/dam/communications/football-communications/2026/news/2026%20Playing%20Rules,%20Bylaw%20and%20Resolution%20Proposals.pdf' },
  /* the playoff field, seeding and scheduling, from NFL support */
  { id: 'nfl_support_seeding', url: 'https://support.nfl.com/hc/en-us/articles/35869775009556-Standings-Seeding-Rankings' },
  { id: 'nfl_support_playoff_schedule', url: 'https://support.nfl.com/hc/en-us/articles/35869712287508-Schedule' },
  /* Super Bowl LXI: site, and the rule that names the designated home team (it alternates between the conferences) */
  { id: 'nfl_super_bowl_lxi', url: 'https://www.nfl.com/news/sofi-stadium-approved-to-host-super-bowl-lxi-in-2027' },
  { id: 'nfl_super_bowl_home_rule', url: 'https://www.nfl.com/news/bengals-not-rams-are-official-home-team-for-super-bowl-lvi-at-sofi-stadium' }
];
const NHL_PAGES: Page[] = [
  /* the league's own statement of the standings tiebreakers and the playoff format */
  { id: 'nhl_tie_breaking_procedure', url: 'https://www.nhl.com/info/standings-info/tie-breaking-procedure' },
  { id: 'nhl_playoff_format', url: 'https://www.nhl.com/info/standings-info/playoff-format' }
];
/* nba.com and cdn.nba.com answer GitHub's runners 403 (Akamai "Access Denied", run 39957383090, 2026-10-23).
   The league serves the same pages from api-hub.nba.com and its communications site pr.nba.com, and the
   Internet Archive keeps nba.com's pages as published (id_ = the archived bytes, unmodified; the final URL
   names the capture's time). Each is printed under its own id, so a verification cites which copy it read. */
const NBA_ARCHIVE = 'https://web.archive.org/web/20261023000000id_/';
/* each with the paragraphs a verification reads, printed again after the summary (the whole text stays above) */
const NBA_RULES = /tie|break|head-to-head|percentage|won-lost|differential|net points|division (winner|leader)|playoff team|play-in|seed|home[- ]court|reseed|best-of-seven|2-2-1-1-1|random|drawing/i;
const NBA_CUP = /standings|count|regular[- ]season|\b8[0-3]\b|Group Play|Knockout|Quarterfinal|Semifinal|Championship|wild card|tiebreak|host|neutral/i;
const NBA_SEASON = /play-in|playoff|Finals|Cup|\b8[0-3]\b|standings|format|regular season (ends|concludes|begins|tips)/i;
const NBA_ARTICLES: Array<[string, string, RegExp]> = [
  /* the standings page carries the league's tiebreaker paragraph */
  ['nba_standings', 'https://www.nba.com/standings', NBA_RULES],
  /* the play-in and NBA Cup explainers, the Cup's questions page */
  ['nba_play_in', 'https://www.nba.com/news/nba-play-in-tournament', NBA_RULES],
  ['nba_cup_101', 'https://www.nba.com/news/nba-cup-101', NBA_CUP],
  ['nba_cup_faq', 'https://www.nba.com/news/nba-cup-frequently-asked-questions', NBA_CUP],
  /* the 2026-27 season as the league announced it: the schedule release and the key dates */
  ['nba_2026_27_schedule_release', 'https://www.nba.com/news/2026-27-nba-regular-season-schedule', NBA_SEASON],
  ['nba_2026_27_key_dates', 'https://www.nba.com/news/key-dates', NBA_SEASON]
];
const NBA_PAGES: Page[] = NBA_ARTICLES.flatMap(([id, url, excerpt]): Page[] => [
  { id, url, excerpt },
  { id: id + '_apihub', url: url.replace('https://www.nba.com/', 'https://api-hub.nba.com/'), excerpt },
  { id: id + '_archive', url: NBA_ARCHIVE + url, excerpt }
]).concat([{ id: 'nba_2026_27_schedule_release_pr', url: 'https://pr.nba.com/2026-27-nba-regular-season-schedule/', excerpt: NBA_SEASON }]);
const EXCERPTS: string[] = [];
/* MLB: the postseason landing page and the official-information page (its links name the rulebook PDFs);
   the explainers for the format, the tiebreakers and the extra-inning runner are found, not guessed: the
   archive's index of mlb.com and mlb.com's own sitemap are searched for them (mlbDiscover). Every page is
   also read as the Internet Archive keeps it, in case mlb.com refuses the runners as nba.com does. */
const MLB_ARCHIVE = 'https://web.archive.org/web/20261023000000id_/';
const MLB_TOPICS = /tie-?break|postseason-format|playoff-format|postseason-bracket|playoff-bracket|automatic-runner|extra-inning|runner-on-second|home-field/i;
const MLB_ARTICLES: Array<[string, string, RegExp?]> = [
  ['mlb_postseason', 'https://www.mlb.com/postseason'],
  ['mlb_official_information', 'https://www.mlb.com/official-information', /\.pdf|rules/i]
];
const mlbPages = (list: Array<[string, string, RegExp?]>): Page[] => list.flatMap(([id, url, links]): Page[] => [
  { id, url, links }, { id: id + '_archive', url: MLB_ARCHIVE + url, links }
]);
/* the rulebook: only its extra-inning and tiebreak lines are printed */
const MLB_RULES_PDF: Page = { id: 'mlb_official_baseball_rules_2026_pdf', url: 'https://mktg.mlbstatic.com/mlb/official-information/2026-official-baseball-rules.pdf',
  grep: /extra inning|runner (on|at|to) second|automatic runner|tie-?break|7\.01|regulation game/i };
const KALSHI_FEE_PAGES: Page[] = [
  /* Kalshi's fee schedule, and the API documentation of fee types, multipliers and rounding */
  { id: 'kalshi_fee_schedule_pdf', url: 'https://kalshi.com/docs/kalshi-fee-schedule.pdf' },
  { id: 'kalshi_docs_fee_rounding', url: 'https://docs.kalshi.com/getting_started/fee_rounding' },
  { id: 'kalshi_docs_series_fee_changes', url: 'https://docs.kalshi.com/api-reference/exchange/get-series-fee-changes' },
  { id: 'kalshi_openapi_fee_lines', url: 'https://docs.kalshi.com/openapi.yaml', grep: /fee/i }
];

/** page text: scripts and styles dropped, block ends as newlines, entities decoded */
export function htmlText(html: string): string {
  const ent: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
  return html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/li|\/h[1-6]|\/div|\/tr|\/section|\/article|\/ol|\/ul)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ent[n.toLowerCase()] ?? m)
    .replace(/[ \t\f\r\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function section(title: string) { console.log('\n' + '='.repeat(100) + '\n== ' + title + '\n' + '='.repeat(100)); }
const SUMMARY: string[] = [];

/** the readable text inside a page's embedded JSON (a client-rendered page ships its copy there, not in the markup) */
export function embeddedText(html: string): string {
  const out: string[] = [];
  for (const m of html.matchAll(/<script\b[^>]*type="application\/(?:ld\+)?json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    let j: unknown; try { j = JSON.parse(m[1]); } catch (_) { continue; }
    const walk = (v: unknown) => {
      if (typeof v === 'string') { if (v.length > 60 && /[a-z] [a-z]/i.test(v)) out.push(/<[a-z][\s\S]*>/i.test(v) ? htmlText(v) : v.trim()); }
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(j);
  }
  return [...new Set(out)].join('\n');
}

async function fetchRaw(url: string, accept: string): Promise<{ res: Response; body: Buffer }> {
  for (let attempt = 0; ; attempt++) {
    /* bounded: the Internet Archive can hold a request for minutes; a page that takes longer fails on its own line */
    const res = await fetch(url, { headers: { 'user-agent': UA, accept }, redirect: 'follow', signal: AbortSignal.timeout(90_000) });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await new Promise((r) => setTimeout(r, 4000 * 2 ** attempt)); continue; }
    return { res, body: Buffer.from(await res.arrayBuffer()) };
  }
}

async function fetchPage(p: Page) {
  section('SOURCE ' + p.id + '  ' + p.url);
  let res: Response, body: Buffer;
  try { ({ res, body } = await fetchRaw(p.url, 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8')); }
  catch (e) { console.log('FETCH FAILED: ' + String((e as Error).message || e)); SUMMARY.push(p.id + ': FETCH FAILED ' + String((e as Error).message || e)); return; }
  const head = 'status ' + res.status + ' · final url ' + res.url + ' · ' + body.length + ' bytes · sha256 ' + sha256Hex(body) + ' · fetched_at ' + new Date().toISOString();
  console.log(head);
  const isPdf = /\.pdf($|\?)/i.test(res.url) || (res.headers.get('content-type') || '').includes('pdf');
  fs.writeFileSync(path.join(OUT, p.id + (isPdf ? '.pdf' : '.html')), body);
  let text = '';
  if (isPdf) {
    try { text = execFileSync('pdftotext', ['-layout', path.join(OUT, p.id + '.pdf'), '-'], { encoding: 'utf8', maxBuffer: 32 << 20 }); }
    catch (e) { console.log('pdftotext unavailable or failed: ' + String((e as Error).message).slice(0, 200)); return; }
  } else {
    const html = body.toString('utf8');
    text = htmlText(html);
    const emb = embeddedText(html);
    if (emb) text += '\n\n-- text inside the page\'s embedded JSON:\n' + emb;
    if (p.links) {
      const links = [...new Set([...html.matchAll(/href="([^"#]+)"/gi)].map((m) => m[1]).filter((h) => p.links!.test(h)))].slice(0, 80);
      console.log('-- links matching ' + p.links + ':\n' + links.map((l) => '  ' + l).join('\n'));
    }
  }
  text = text.split('\n').filter((l) => l.replace(/^[-\s]+/, '').length > 3 && (!p.grep || p.grep.test(l))).join('\n');
  fs.writeFileSync(path.join(OUT, p.id + '.txt'), text);
  SUMMARY.push(p.id + ': ' + head + ' · text ' + text.length + ' chars, sha256 ' + sha256Hex(text));
  console.log('-- text (' + text.length + ' chars, sha256 ' + sha256Hex(text) + '):\n' + text.slice(0, 60000));
  if (p.excerpt && res.ok) {
    const hit = [...new Set(text.split('\n').filter((l) => p.excerpt!.test(l)))];
    EXCERPTS.push('== EXCERPT ' + p.id + '  ' + res.url + '  (text sha256 ' + sha256Hex(text) + '; ' + hit.length + ' paragraphs matching ' + p.excerpt + ')\n' + hit.map((l) => '  ' + l).join('\n'));
  }
}

/** a JSON feed: status, sha256 of the body, the parsed value (null when it is not JSON) */
async function fetchJson(id: string, url: string): Promise<any> {
  try {
    const { res, body } = await fetchRaw(url, 'application/json');
    fs.writeFileSync(path.join(OUT, id + '.json'), body);
    const head = 'status ' + res.status + ' · ' + url + ' · ' + body.length + ' bytes · sha256 ' + sha256Hex(body);
    console.log('FEED ' + id + ' ' + head);
    SUMMARY.push(id + ': ' + head);
    if (!res.ok) return null;
    try { return JSON.parse(body.toString('utf8')); } catch (_) { console.log('  not JSON'); return null; }
  } catch (e) { console.log('FEED ' + id + ' FAILED ' + String((e as Error).message || e)); SUMMARY.push(id + ': FAILED ' + String((e as Error).message || e)); return null; }
}

/* NHL: the league's own API (api-web.nhle.com, the feed nhl.com's standings and schedule pages read) */
const NHL_SEASON_ID = '20262027';
async function nhlApi() {
  section('SOURCE nhl_api  https://api-web.nhle.com/v1 (the NHL\'s public API)');
  const ss = await fetchJson('nhl_standings_season', 'https://api-web.nhle.com/v1/standings-season');
  for (const x of (ss && ss.seasons) || []) if (Number(x.id) >= 20132014) console.log('  SEASONFMT ' + JSON.stringify(x));
  const st = await fetchJson('nhl_standings_now', 'https://api-web.nhle.com/v1/standings/now');
  const rows = (st && st.standings) || [];
  console.log('  standings date ' + (st && st.standingsDateTimeUtc) + ' · ' + rows.length + ' clubs');
  console.log('  (abbrev | conference | division | GP W L OTL PTS | RW ROW | GF GA | wildcardSequence | clinch | seasonId)');
  for (const r of rows) console.log('  STANDING ' + [r.teamAbbrev && r.teamAbbrev.default, r.conferenceName, r.divisionName, [r.gamesPlayed, r.wins, r.losses, r.otLosses, r.points].join(' '),
    [r.regulationWins, r.regulationPlusOtWins].join(' '), [r.goalFor, r.goalAgainst].join(' '), r.wildcardSequence, r.clinchIndicator || '', r.seasonId].join(' | '));
  const clubs = rows.map((r: any) => r.teamAbbrev && r.teamAbbrev.default).filter(Boolean).sort();
  const games = new Map<number, any>();
  for (const c of clubs) {
    const j = await fetchJson('nhl_schedule_' + c, 'https://api-web.nhle.com/v1/club-schedule-season/' + c + '/' + NHL_SEASON_ID);
    for (const g of (j && j.games) || []) games.set(Number(g.id), g);
  }
  const all = [...games.values()].sort((p, q) => String(p.startTimeUTC).localeCompare(String(q.startTimeUTC)) || p.id - q.id);
  const byType: Record<string, number> = {};
  for (const g of all) byType[g.gameType] = (byType[g.gameType] || 0) + 1;
  console.log('\n-- 2026-27 schedule: ' + all.length + ' distinct games by gameType ' + JSON.stringify(byType) + ' (1 preseason, 2 regular season, 3 playoffs)');
  console.log('  (id | date | startTimeUTC | gameType | away | home | gameState | away score | home score | lastPeriodType | neutralSite | venue)');
  const lines: string[] = [];
  for (const g of all) {
    if (Number(g.gameType) === 1) continue;
    const ln = [g.id, g.gameDate, g.startTimeUTC, g.gameType, g.awayTeam && g.awayTeam.abbrev, g.homeTeam && g.homeTeam.abbrev, g.gameState,
      g.awayTeam && g.awayTeam.score != null ? g.awayTeam.score : '', g.homeTeam && g.homeTeam.score != null ? g.homeTeam.score : '',
      (g.gameOutcome && g.gameOutcome.lastPeriodType) || '', g.neutralSite ? 1 : 0, (g.venue && g.venue.default) || ''].join('|');
    lines.push(ln); console.log('  NHLGAME ' + ln);
  }
  fs.writeFileSync(path.join(OUT, 'nhl_schedule_' + NHL_SEASON_ID + '.psv'), lines.join('\n') + '\n');
  SUMMARY.push('nhl schedule: ' + lines.length + ' regular-season and playoff games · sha256 of the lines ' + sha256Hex(lines.join('\n') + '\n'));
}

/* NBA: the league's season schedule file (cdn.nba.com, what nba.com/schedule reads) */
async function nbaApi() {
  const live = 'https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json';
  section('SOURCE nba_schedule  ' + live);
  let j = await fetchJson('nba_schedule', live);
  /* the runners are refused by cdn.nba.com: read the Internet Archive's copy of the same file instead */
  if (!j) { console.log('  live file refused; the archived copy follows'); j = await fetchJson('nba_schedule_archive', NBA_ARCHIVE + live); }
  const ls = (j && j.leagueSchedule) || {};
  console.log('  seasonYear ' + ls.seasonYear + ' · leagueId ' + ls.leagueId);
  const lines: string[] = [];
  const labels: Record<string, number> = {};
  for (const d of ls.gameDates || []) for (const g of d.games || []) {
    const lab = [g.gameLabel, g.gameSubLabel, g.gameSubtype].filter(Boolean).join(' / ');
    labels[lab || '(none)'] = (labels[lab || '(none)'] || 0) + 1;
    const ln = [g.gameId, g.gameDateUTC || g.gameDateEst, g.gameDateTimeUTC, g.weekNumber, g.awayTeam && g.awayTeam.teamTricode, g.homeTeam && g.homeTeam.teamTricode,
      g.gameStatus, g.awayTeam && g.awayTeam.score, g.homeTeam && g.homeTeam.score, lab, g.isNeutral ? 1 : 0, g.arenaName || ''].join('|');
    lines.push(ln);
  }
  console.log('  games by label ' + JSON.stringify(labels));
  console.log('  (gameId | date | dateTimeUTC | week | away | home | status | away score | home score | label | neutral | arena)');
  for (const ln of lines) console.log('  NBAGAME ' + ln);
  fs.writeFileSync(path.join(OUT, 'nba_schedule.psv'), lines.join('\n') + '\n');
  SUMMARY.push('nba schedule: ' + lines.length + ' games · sha256 of the lines ' + sha256Hex(lines.join('\n') + '\n'));
}

/* MLB: the league's Stats API (statsapi.mlb.com, what mlb.com's standings and schedule pages read) */
const MLB_API = 'https://statsapi.mlb.com/api/v1/';
const MLB_SEASON = 2026;
async function mlbApi() {
  section('SOURCE mlb_api  ' + MLB_API + ' (MLB\'s Stats API)');
  const dv = await fetchJson('mlb_divisions', MLB_API + 'divisions?sportId=1&season=' + MLB_SEASON);
  const divName = new Map<number, string>(((dv && dv.divisions) || []).map((d: any) => [Number(d.id), String(d.nameShort || d.name)]));
  const st = await fetchJson('mlb_standings', MLB_API + 'standings?leagueId=103,104&season=' + MLB_SEASON + '&standingsTypes=regularSeason&hydrate=team');
  const league = (id: unknown) => Number(id) === 103 ? 'AL' : Number(id) === 104 ? 'NL' : String(id);
  const clubs: Array<{ abbr: string; lg: string; w: number; l: number; line: string }> = [];
  for (const rec of (st && st.records) || []) for (const t of rec.teamRecords || []) {
    const abbr = String((t.team && (t.team.abbreviation || t.team.name)) || '?');
    const lg = league(rec.league && rec.league.id);
    const line = [abbr, lg, divName.get(Number(rec.division && rec.division.id)) || String(rec.division && rec.division.id), [t.wins, t.losses, t.winningPercentage].join(' '),
      [t.divisionRank, t.wildCardRank, t.leagueRank].join(' '), [t.gamesBack, t.wildCardGamesBack].join(' '), t.clinchIndicator || '', t.divisionChamp ? 1 : 0].join(' | ');
    clubs.push({ abbr, lg, w: Number(t.wins), l: Number(t.losses), line });
  }
  console.log('  ' + clubs.length + ' clubs · (club | league | division | W L pct | divisionRank wildCardRank leagueRank | GB WCGB | clinch | divisionChamp)');
  for (const c of clubs) console.log('  MLBSTANDING ' + c.line);
  /* equal records in a league: the only places a tiebreaker can have decided */
  for (const lg of ['AL', 'NL']) {
    const byRec = new Map<string, string[]>();
    for (const c of clubs.filter((x) => x.lg === lg)) byRec.set(c.w + '-' + c.l, (byRec.get(c.w + '-' + c.l) || []).concat(c.abbr));
    for (const [r, xs] of byRec) if (xs.length > 1) console.log('  MLBTIE ' + lg + ' ' + r + ' ' + xs.join(' '));
  }
  SUMMARY.push('mlb standings: ' + clubs.length + ' clubs');
  /* the 2026 postseason as played and scheduled, one line per game */
  let ps = await fetchJson('mlb_postseason', MLB_API + 'schedule/postseason?sportId=1&season=' + MLB_SEASON + '&hydrate=team');
  let games: any[] = ((ps && ps.dates) || []).flatMap((d: any) => d.games || []);
  if (!games.length) {
    ps = await fetchJson('mlb_postseason_schedule', MLB_API + 'schedule?sportId=1&season=' + MLB_SEASON + '&gameType=F,D,L,W&hydrate=team');
    games = ((ps && ps.dates) || []).flatMap((d: any) => d.games || []);
  }
  if (games[0]) console.log('  fields of a game: ' + JSON.stringify(Object.keys(games[0])) + ' · of a side: ' + JSON.stringify(Object.keys((games[0].teams && games[0].teams.home) || {})));
  console.log('  ' + games.length + ' postseason games · (gamePk | officialDate | gameType | series | game/of | away | home | state | away score | home score | winner | ifNecessary | venue)');
  const ab = (s: any) => (s && s.team && (s.team.abbreviation || s.team.name)) || '';
  const lines: string[] = [];
  for (const g of games) {
    const ln = [g.gamePk, g.officialDate, g.gameType, g.seriesDescription || '', g.seriesGameNumber + '/' + g.gamesInSeries, ab(g.teams && g.teams.away), ab(g.teams && g.teams.home),
      (g.status && g.status.detailedState) || '', g.teams && g.teams.away && g.teams.away.score != null ? g.teams.away.score : '', g.teams && g.teams.home && g.teams.home.score != null ? g.teams.home.score : '',
      g.teams && g.teams.away && g.teams.away.isWinner ? ab(g.teams.away) : g.teams && g.teams.home && g.teams.home.isWinner ? ab(g.teams.home) : '', g.ifNecessary || '', (g.venue && g.venue.name) || ''].join('|');
    lines.push(ln); console.log('  MLBPOSTGAME ' + ln);
  }
  fs.writeFileSync(path.join(OUT, 'mlb_postseason_' + MLB_SEASON + '.psv'), lines.join('\n') + '\n');
  SUMMARY.push('mlb postseason: ' + lines.length + ' games · sha256 of the lines ' + sha256Hex(lines.join('\n') + '\n'));
}

/* mlb.com pages on the postseason format, the tiebreakers and the extra-inning runner, from the archive's
   index of mlb.com (glossary and news) and mlb.com's sitemap; each one found is then read (mlbPages) */
async function mlbDiscover(): Promise<Array<[string, string]>> {
  section('SOURCE mlb_discovery  the mlb.com pages that name the format, the tiebreakers or the extra-inning runner');
  const found = new Set<string>();
  const keep = (u: string) => {
    const m = /^(?:https?:\/\/)?(?:www\.)?mlb\.com(?::\d+)?(\/[^?#\s]*)/i.exec(u.trim());
    if (m && MLB_TOPICS.test(m[1])) found.add('https://www.mlb.com' + m[1].replace(/\/+$/, ''));
  };
  const CDX = 'https://web.archive.org/cdx/search/cdx?collapse=urlkey&fl=original&filter=statuscode:200&matchType=prefix';
  for (const [id, url] of [
    ['mlb_cdx_glossary', CDX + '&url=mlb.com/glossary/&limit=5000'],
    ['mlb_cdx_news', CDX + '&url=mlb.com/news/&from=2022&limit=300&filter=original:.*(tiebreak|postseason-format|playoff-format|automatic-runner|extra-inning|home-field).*']
  ]) {
    try {
      const { res, body } = await fetchRaw(url, 'text/plain');
      const rows = body.toString('utf8').split('\n').filter(Boolean);
      console.log('INDEX ' + id + ' status ' + res.status + ' · ' + rows.length + ' urls');
      for (const r of rows) keep(r);
    } catch (e) { console.log('INDEX ' + id + ' FAILED ' + String((e as Error).message || e)); }
  }
  try {
    const { res, body } = await fetchRaw('https://www.mlb.com/sitemap.xml', 'application/xml,text/xml');
    const locs = [...body.toString('utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    console.log('SITEMAP status ' + res.status + ' · ' + locs.length + ' entries:\n' + locs.slice(0, 120).map((l) => '  ' + l).join('\n'));
    for (const l of locs) keep(l);
  } catch (e) { console.log('SITEMAP FAILED ' + String((e as Error).message || e)); }
  const list = [...found].sort();
  console.log('-- ' + list.length + ' mlb.com pages on these topics:\n' + list.map((u) => '  MLBPAGE ' + u).join('\n'));
  SUMMARY.push('mlb discovery: ' + list.length + ' pages');
  /* the 16 shortest paths first: an explainer's slug is short, a dated game recap's long */
  return list.sort((p, q) => p.length - q.length || p.localeCompare(q)).slice(0, 16)
    .map((u): [string, string] => ['mlb_found_' + u.replace('https://www.mlb.com/', '').replace(/[^a-z0-9]+/gi, '_').slice(0, 70), u]);
}

/* season futures: a series whose title names a champion, conference, division, playoff berth or seed.
   Per-game, per-player and in-season prop series (thousands of markets) are listed by name and count only. */
const FUTURES = /Super Bowl|Stanley Cup|President.?s|champion|conference|AFC|NFC|Eastern|Western|division|Atlantic|Metropolitan|Central|Pacific|playoff|play-in|seed|Finals|NBA Cup|World Series|pennant|American League|National League/i;
const NOT_FUTURES = /game|spread|total|points|yards|touchdown|TD|MVP|player|quarter|half|draft|coach|week|rookie|award|passing|rushing|receiving|sack|score|margin|first|anytime|goal|assist|save|rebound|three|triple|double/i;
const KALSHI_MATCH: Record<string, { match: RegExp; not: RegExp }> = {
  nfl: { match: /\bNFL\b|Super Bowl|Pro Football|American Football Conference|National Football Conference|^KXNFL|^KXSB|^KXAFC$|^KXNFC$/i, not: /NCAA|College|AFCON|Fantasy|NBA|\bFCS\b/i },
  nhl: { match: /\bNHL\b|Stanley Cup|Pro Hockey|National Hockey League|President.?s Trophy|^KXNHL|^KXSTANLEY/i, not: /NCAA|College|AHL|KHL|PWHL|Fantasy|Olympic|World Championship|4 Nations|Four Nations/i },
  nba: { match: /\bNBA\b|Pro Basketball|National Basketball Association|NBA Cup|^KXNBA/i, not: /WNBA|NCAA|College|G League|Fantasy|Olympic|EuroLeague/i },
  mlb: { match: /\bMLB\b|World Series|Pro Baseball|Major League Baseball|American League|National League|^KXMLB/i, not: /NCAA|College|Little League|KBO|NPB|Fantasy|World Baseball Classic|WBC|Caribbean|Softball/i }
};

async function kalshi() {
  section('SOURCE kalshi_api  public REST, no key · ' + SPORT.toUpperCase());
  const c = kalshiClient();
  const { match, not: notThis } = KALSHI_MATCH[SPORT];
  let s: any;
  try { s = await c.get('/series', { category: 'Sports' }); } catch (e) { console.log('KALSHI FAILED: ' + String((e as Error).message || e)); SUMMARY.push('kalshi: FAILED ' + String((e as Error).message || e)); return; }
  const series = ((s && s.series) || []).filter((x: any) => x && x.ticker && (match.test(String(x.title || '')) || match.test(String(x.ticker))) && !notThis.test(String(x.title || '')) && !/GAME$/.test(x.ticker));
  const futures = series.filter((x: any) => FUTURES.test(String(x.title || '')) && !NOT_FUTURES.test(String(x.title || '')));
  console.log('host ' + c.host + ' · ' + ((s && s.series) || []).length + ' Sports series · ' + series.length + ' name the ' + SPORT.toUpperCase() + ' · ' + futures.length + ' look like season futures');
  console.log('-- every ' + SPORT.toUpperCase() + '-named series (ticker | title | fee_type | fee_multiplier):');
  for (const x of series) console.log('  ' + x.ticker + ' | ' + x.title + ' | ' + x.fee_type + ' | ' + x.fee_multiplier + (futures.includes(x) ? '   <- futures' : ''));
  const all: any[] = [];
  for (const x of futures) {
    console.log('\n## SERIES ' + x.ticker + ' | ' + x.title + ' | fee_type ' + x.fee_type + ' | fee_multiplier ' + x.fee_multiplier + ' | frequency ' + x.frequency
      + ' | settlement_sources ' + JSON.stringify(x.settlement_sources || null));
    let cursor = '';
    for (let page = 0; page < 5; page++) {
      let m: any;
      try { m = await c.get('/markets', { series_ticker: x.ticker, status: 'open', limit: 1000, cursor }); } catch (e) { console.log('  markets failed: ' + String((e as Error).message)); break; }
      for (const k of (m && m.markets) || []) {
        const rules_sha256 = k.rules_primary ? sha256Hex(String(k.rules_primary) + '\n' + String(k.rules_secondary || '')) : null;
        all.push({ series_ticker: x.ticker, event_ticker: k.event_ticker, market_ticker: k.ticker, title: k.title, yes_sub_title: k.yes_sub_title, close_time: k.close_time,
          rules_primary: k.rules_primary, rules_secondary: k.rules_secondary || null, rules_sha256, yes_bid: k.yes_bid_dollars, yes_ask: k.yes_ask_dollars, yes_ask_size: k.yes_ask_size_fp });
        console.log('  - ' + k.ticker + ' | event ' + k.event_ticker + ' | ' + (k.yes_sub_title || '') + ' | close ' + k.close_time + ' | bid ' + k.yes_bid_dollars + ' ask ' + k.yes_ask_dollars
          + ' size ' + k.yes_ask_size_fp + ' | rules_sha256 ' + rules_sha256 + ' | RULES: ' + String(k.rules_primary || '').replace(/\s+/g, ' ') + (k.rules_secondary ? ' | RULES2: ' + String(k.rules_secondary).replace(/\s+/g, ' ') : ''));
      }
      cursor = (m && m.cursor) || '';
      if (!cursor) break;
    }
  }
  /* fees can be overridden per event and changed on a schedule: print both for the futures events */
  console.log('\n-- event fee fields (fee_type_override / fee_multiplier_override; absent or null = the series\' own):');
  for (const ev of [...new Set(all.map((k) => k.event_ticker))].sort()) {
    try {
      const e = await c.get('/events/' + encodeURIComponent(ev), {});
      const o = (e && e.event) || e || {};
      const fee = Object.fromEntries(Object.entries(o).filter(([k]) => /fee/i.test(k)));
      console.log('  EVENTFEE ' + ev + ' ' + JSON.stringify(fee));
    } catch (err) { console.log('  EVENTFEE ' + ev + ' FAILED ' + String((err as Error).message).slice(0, 120)); }
  }
  console.log('\n-- scheduled series fee changes touching these series (/series/fee_changes):');
  try {
    const fc = await c.get('/series/fee_changes', { show_historical: 'false' });
    const list = (fc && (fc.series_fee_change_arr || fc.fee_changes || fc.series_fee_changes)) || [];
    const mine = new Set(futures.map((x: any) => x.ticker));
    console.log('  FEECHANGES total ' + (Array.isArray(list) ? list.length : 'n/a') + ' · keys ' + JSON.stringify(Object.keys(fc || {})));
    for (const x of Array.isArray(list) ? list : []) if (mine.has(x.series_ticker)) console.log('  FEECHANGE ' + JSON.stringify(x));
  } catch (err) { console.log('  FEECHANGES FAILED ' + String((err as Error).message).slice(0, 160)); }
  /* the NFL's file keeps the name build_kalshi_mappings.ts was first run on */
  const file = SPORT === 'nfl' ? 'kalshi_candidates.json' : 'kalshi_candidates_' + SPORT + '.json';
  fs.writeFileSync(path.join(OUT, file), JSON.stringify({ fetched_at: new Date().toISOString(), host: c.host, sport: SPORT, series, futures: futures.map((x: any) => x.ticker), markets: all }, null, 1));
  SUMMARY.push('kalshi: host ' + c.host + ' · ' + series.length + ' ' + SPORT.toUpperCase() + '-named series · ' + futures.length + ' futures series · ' + all.length + ' open futures markets');
}

await kalshi();
if (SPORT === 'nhl') await nhlApi();
if (SPORT === 'nba') await nbaApi();
if (SPORT === 'mlb') await mlbApi();
const MLB_PAGES = SPORT === 'mlb' ? mlbPages(MLB_ARTICLES.concat(await mlbDiscover())).concat([MLB_RULES_PDF]) : [];
for (const p of SPORT === 'nfl' ? NFL_PAGES.concat(KALSHI_FEE_PAGES) : SPORT === 'nhl' ? NHL_PAGES : SPORT === 'mlb' ? MLB_PAGES : NBA_PAGES) await fetchPage(p);
section('SUMMARY');
console.log(SUMMARY.join('\n') + '\nwritten to ' + OUT);
if (EXCERPTS.length) { section('EXCERPTS (the paragraphs of each page read above that name the rules; the whole text is above and in the artifact)'); console.log(EXCERPTS.join('\n\n')); }
