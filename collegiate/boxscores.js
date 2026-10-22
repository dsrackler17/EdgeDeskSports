'use strict';
/* ===========================================================================
   EdgeDesk collegiate — a baseball box score, read from a school's own site.

   A SIDEARM box score page carries the whole game in its Nuxt data
   (pinia.boxscore): both teams with their NCAA team codes (the ids our
   college baseball record uses), the line score, every pitcher in order of
   appearance with innings, batters faced, strikeouts, walks and pitches,
   every starting batter with lineup spot, position and bats, each player's
   throwing hand, and the game's venue, attendance, scheduled innings,
   doubleheader flag and weather as the official scorer wrote it.

   SIDEARM's older sites render the same scorer's file as tables: the line
   score (visitor first, home second), each team's batters (a substitute
   indented under the starter he replaced) and pitchers (in order of
   appearance), and the game's details (date, attendance, site, weather).
   They name no team codes and no hands. The codes come from the schedule
   row that links the box: the school's own registry id and the opponent's
   website, an exact join (a box whose opponent joins to no registry school
   with a baseball id is a miss). The school's own players link to its
   roster, so each keeps the roster's name slug: the hands are the roster's
   (college_baseball/ingest/school_box.js joins them by that slug).

   Kept: what a model can use. The starter of each side is the pitcher with
   order of appearance 1. Weather is kept as written and split only where
   it reads plainly ("69, Mostly Cloudy, N 24 MPH" or "61 / Sunny / Winds
   ENE @ 3" -> 61 F, Sunny, wind ENE 3); anything else stays as written,
   never guessed.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { nuxtData } = require('./nuxt');

const DATA = path.join(__dirname, 'data');
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } };

const num = (v) => { if (v === '' || v == null) return null; const n = +v; return Number.isFinite(n) ? n : null; };
/* innings pitched "4.1" = 4 innings and 1 out = 13 outs; a ".3" or worse is not an innings value */
function outsOf(ip) {
  const m = String(ip == null ? '' : ip).match(/^(\d+)(?:\.([012]))?$/);
  return m ? +m[1] * 3 + (+m[2] || 0) : null;
}
/* "Last, First" (and "Last,First") read as "First Last" */
const flip = (n) => (n && /,/.test(n) ? n.split(',').map((s) => s.trim()).filter(Boolean).reverse().join(' ') : n || null);
const nameOf = (p) => flip(p.playerFirstLastName || p.checkName || p.name || null);
const hand = (h) => (/^[LRS]$/.test(String(h || '').toUpperCase()) ? String(h).toUpperCase() : /^B$/i.test(String(h || '')) ? 'S' : null);

/* the school's own name for a player: the slug of the link to his roster page ("/sports/baseball/roster/luke-harrison/15090").
   Only the school's own players are linked; the slug is the site's and stays across seasons (the trailing id does not) */
const slugOf = (html) => { const m = String(html || '').match(/\/sports\/[^'"\s]*\/roster\/([a-z0-9-]+)\/\d+/i); return m ? m[1].toLowerCase() : null; };
const WIND = 'N|NE|E|SE|S|SW|W|NW|NNE|ENE|ESE|SSE|SSW|WSW|WNW|NNW|L-R|R-L|IN|OUT|CALM';
function weather(w) {
  const raw = w && String(w).trim() && String(w).trim() !== '0' ? String(w).trim() : null;
  if (!raw) return { raw: null, temp_f: null, sky: null, wind_dir: null, wind_mph: null };
  /* parts split at , ; or /: the temperature is the part that is only a number of degrees, wherever it stands
     ("69, Mostly Cloudy", "Overcast, 53 deg."); the sky the first other part with no wind or number in it, and only
     beside a temperature (free text such as "Nice day for baseball" stays as written) */
  const parts = raw.split(/\s*[,;/]\s*/).map((s) => s.trim()).filter(Boolean);
  const isTemp = (x) => /^(-?\d{1,3})\s*(?:°\s*F?|deg\.?|degrees|F)?$/i.test(x);
  const tp = parts.find(isTemp);
  const t = tp ? +tp.match(/-?\d{1,3}/)[0] : null;
  /* a direction then its speed: "N 24 MPH", "Winds ENE @ 3", "NW at 11 mph" */
  const wind = raw.match(new RegExp('\\b(' + WIND + ')\\b[^,;/\\d]*?(?:@|\\bat\\b)?\\s*(\\d{1,2})\\s*(?:MPH)?\\b', 'i'));
  const skyPart = parts.find((x) => !isTemp(x) && !/mph|wind|@|\d/i.test(x));
  const sky = t != null && skyPart ? skyPart : null;
  return { raw, temp_f: t, sky, wind_dir: wind ? wind[1].toUpperCase() : null, wind_mph: wind ? +wind[2] : null };
}

function team(t) {
  const players = t.players || [];
  const pitchers = players.filter((p) => p.pitching).map((p) => ({ order: num(p.pitching.orderOfAppearance), name: nameOf(p), roster_player_id: p.rosterPlayerId || null, slug: slugOf(p.playerUrl),
    throws: hand(p.throws), outs: outsOf(p.pitching.inningsPitched), bf: num(p.pitching.battersFaced), k: num(p.pitching.strikeouts), bb: num(p.pitching.walksAllowed),
    h: num(p.pitching.hitsAllowed), r: num(p.pitching.runsAllowed), er: num(p.pitching.earnedRunsAllowed), hr: num(p.pitching.homerunsAllowed), hb: num(p.pitching.hitBatters), pitches: num(p.pitching.pitches),
    started: p.pitching.gamesStarted === '1' }))
    .sort((a, b) => (a.order == null ? 99 : a.order) - (b.order == null ? 99 : b.order));
  const lineup = players.filter((p) => p.gameStarted === '1' && num(p.spot) >= 1 && num(p.spot) <= 9).map((p) => ({ spot: num(p.spot), name: nameOf(p), roster_player_id: p.rosterPlayerId || null, slug: slugOf(p.playerUrl), pos: p.position || null, bats: hand(p.bats) }))
    .sort((a, b) => a.spot - b.spot);
  const ss = t.scoringSummary || {};
  const line = String(ss.scoreByInnings || '').split(',').filter((x) => x !== '').map((x) => (x === 'X' || x === 'x' ? null : num(x)));
  return { code: t.code ? String(t.code) : null, name: t.name || null, runs: num(t.score != null ? t.score : ss.runs), hits: num(ss.hits), errors: num(ss.errors), line,
    starter: pitchers.find((p) => p.order === 1) || pitchers.find((p) => p.started) || null, pitchers, lineup };
}

/* SIDEARM: one game, or null when the page carries no box score */
function sidearmBoxscore(data) {
  const store = data && data.pinia && data.pinia.boxscore && data.pinia.boxscore.boxscore;
  if (!store || typeof store !== 'object') return null;
  const b = Object.values(store).find((x) => x && x.homeTeam && x.visitingTeam);
  if (!b) return null;
  const v = b.venue || {};
  const m = String(v.date || b.gameDate || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return {
    platform: 'sidearm', date: m ? m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0') : null,
    neutral: !!(v.isNeutral || b.isNeutral), conference: !!(v.isALeagueGame || b.isALeagueGame), scheduled_innings: num(v.scheduledInnings),
    doubleheader_game: num(v.doubleHeaderGame) || 0, attendance: num(String(v.attendance || '').replace(/,/g, '')), stadium: v.stadium || null, location: v.location || null,
    weather: weather(v.weather), home: team(b.homeTeam), away: team(b.visitingTeam),
  };
}

/* ---------------------------------------------------- SIDEARM (older sites) */
const text = (s) => String(s == null ? '' : s).replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;|&#8217;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const cells = (tr) => [...tr.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => m[1]);
const bodyRows = (tb) => { const b = (tb.match(/<tbody[\s\S]*?<\/tbody>/) || [tb])[0]; return [...b.matchAll(/<tr\b[\s\S]*?<\/tr>/g)].map((m) => m[0]); };
const headCols = (tb) => cells((tb.match(/<thead[\s\S]*?<\/thead>/) || [''])[0]).map((c) => text(c).toUpperCase());
/* a team's name as a table names it, to tell which team a table is ("Dayton 6", "Lipscomb University - Pitching Stats") */
const key = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

function legacyBatters(tb) {
  const cols = headCols(tb);
  const at = (c) => cols.indexOf(c);
  const out = [];
  for (const tr of bodyRows(tb)) {
    const cs = cells(tr);
    if (cs.length < 3) continue;
    /* the cell repeats the position for small screens (span.mobile-jersey-number): not part of the name */
    const cell = cs[1].replace(/<span[^>]*mobile-jersey-number[^>]*>[\s\S]*?<\/span>/g, '');
    const nm = (cell.match(/<a[^>]*>([\s\S]*?)<\/a>/) || [])[1];
    const name = flip(text(nm != null ? nm : cell));
    if (!name || /^totals?$/i.test(name)) continue;
    /* a substitute is indented (leading non-breaking spaces) under the player he replaced */
    const sub = /^\s*(?:&nbsp;)+/.test(cs[1]);
    out.push({ name, slug: slugOf(cs[1]), pos: text(cs[0]).toUpperCase() || null, sub, ab: num(text(cs[at('AB')] || '')) });
  }
  return out;
}
function legacyPitchers(tb) {
  const cols = headCols(tb);
  const at = (c) => cols.indexOf(c);
  const out = [];
  for (const tr of bodyRows(tb)) {
    const cs = cells(tr);
    const raw = text(cs[0] || '');
    if (!raw || /^totals?$/i.test(raw)) continue;
    const nm = (cs[0].match(/<a[^>]*>([\s\S]*?)<\/a>/) || [])[1];
    const name = flip(text(nm != null ? nm : cs[0]).replace(/\s*\((?:[WLS]|BS)\b[^)]*\)\s*$/, '').trim());
    const v = (c) => (at(c) >= 0 ? text(cs[at(c)] || '') : '');
    out.push({ order: out.length + 1, name, slug: slugOf(cs[0]), throws: null, outs: outsOf(v('IP')), bf: num(v('BF')), k: num(v('SO')), bb: num(v('BB')), h: num(v('H')),
      r: num(v('R')), er: num(v('ER')), hr: null, hb: num(v('HBP')), pitches: num(v('NP')), started: out.length === 0 });
  }
  return out;
}

function sidearmLegacyBoxscore(html) {
  const h = String(html || '');
  const tables = [...h.matchAll(/<table\b[\s\S]*?<\/table>/g)].map((m) => m[0]);
  const capOf = (tb) => text((tb.match(/<caption[^>]*>([\s\S]*?)<\/caption>/) || [])[1] || '');
  const lineTb = tables.find((tb) => /Score By Innings/i.test(capOf(tb)));
  if (!lineTb) return null;
  /* the line: visitor first, home second; each row names the team (an abbreviation, then the name) */
  const lineCols = headCols(lineTb);
  const sides = bodyRows(lineTb).map((tr) => {
    const cs = cells(tr);
    const spans = [...(cs[0] || '').matchAll(/<span class="hide-on-(x-large|large-down)">([\s\S]*?)<\/span>/g)];
    const nm = (spans.find((s) => s[1] === 'large-down') || [])[2];
    const abbr = (spans.find((s) => s[1] === 'x-large') || [])[2];
    const vals = cs.slice(1).map((c) => text(c));
    const rIdx = lineCols.indexOf('R') - 1;
    const line = vals.slice(0, rIdx).map((x) => (/^x$/i.test(x) ? null : num(x)));
    return { name: text(nm != null ? nm : cs[0]).replace(/^Winner\s+/i, '') || null, abbr: abbr ? text(abbr) : null, line, runs: num(vals[rIdx]), hits: num(vals[rIdx + 1]), errors: num(vals[rIdx + 2]) };
  });
  if (sides.length !== 2 || sides.some((s) => s.runs == null)) return null;
  const batTbs = tables.filter((tb) => headCols(tb).includes('LOB') && !/Composite/i.test(capOf(tb)));
  const pitTbs = tables.filter((tb) => /Pitching Stats/i.test(capOf(tb)));
  const forSide = (list, s, strip) => list.find((tb) => { const c = key(capOf(tb).replace(strip, '')); return c === key(s.name) || c === key(s.abbr); });
  const build = (s) => {
    const bt = forSide(batTbs, s, /\s*\d+\s*$/);
    const pt = forSide(pitTbs, s, /\s*-\s*Pitching Stats\s*$/i);
    const batters = bt ? legacyBatters(bt) : [];
    const pitchers = pt ? legacyPitchers(pt) : [];
    const lineup = batters.filter((b) => !b.sub).slice(0, 9).map((b, i) => ({ spot: i + 1, name: b.name, slug: b.slug, pos: b.pos, bats: null }));
    return { code: null, name: s.name, abbr: s.abbr, runs: s.runs, hits: s.hits, errors: s.errors, line: s.line, starter: pitchers[0] || null, pitchers, lineup,
      own: batters.some((b) => b.slug) || pitchers.some((p) => p.slug) };
  };
  const away = build(sides[0]); const home = build(sides[1]);
  const gd = (h.match(/<aside class="game-details">([\s\S]*?)<\/aside>/) || [])[1] || '';
  const dd = (label) => { const m = gd.match(new RegExp('<dt>\\s*' + label + '\\s*</dt>\\s*<dd>([\\s\\S]*?)</dd>', 'i')); return m ? text(m[1]) || null : null; };
  const dm = String(dd('Date') || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return {
    platform: 'sidearm_legacy', date: dm ? dm[3] + '-' + dm[1].padStart(2, '0') + '-' + dm[2].padStart(2, '0') : null,
    neutral: null, conference: null, scheduled_innings: null, doubleheader_game: 0, attendance: num(String(dd('Attendance') || '').replace(/,/g, '')),
    stadium: null, location: dd('Site'), weather: weather(dd('Weather')), home, away,
    /* which side is the school whose site this is: the one whose players link to its roster */
    own_side: home.own && !away.own ? 'home' : away.own && !home.own ? 'away' : null,
  };
}

function parseBoxscore(html) {
  const data = nuxtData(html);
  if (data) return sidearmBoxscore(data);
  return sidearmLegacyBoxscore(html);
}


/* ===========================================================================
   Collecting box scores: every final game with a box score in the schedules
   the collector holds (collegiate/data/schedules/<sport>/<season>/), read
   ONCE: from the home school's site when both schools' schedules are held
   (on a neutral site, the school whose id sorts first), else from the one
   school that lists it. Each read is kept compact (what a model uses), one
   line per game in collegiate/data/boxscores/<sport>/<season>/<school>.jsonl.gz.
   A per-host cap per run keeps a backfill to a few reads a minute per
   school; later runs continue where this one stopped.
   =========================================================================== */

/* the platforms whose box scores are read (WMT's sit on wmt.games behind an API that is not public: not read) */
const READ = new Set(['sidearm', 'sidearm_legacy']);

function compact(x) {
  /* [name, throws, outs, bf, k, bb, h, er, pitches, roster slug, r, hr, hbp] and [spot, name, pos, bats, roster slug]: the slug only
     where the page links the player to the school's roster (the school's own players, on both generations): the roster's hands
     and a person across games and seasons. hr is null on SIDEARM's older boxes, which do not list it */
  const pit = (p) => [p.name, p.throws, p.outs, p.bf, p.k, p.bb, p.h, p.er, p.pitches, p.slug || null, p.r == null ? null : p.r, p.hr == null ? null : p.hr, p.hb == null ? null : p.hb];
  const side = (t) => ({ code: t.code, name: t.name, runs: t.runs, hits: t.hits, errors: t.errors, line: t.line,
    starter: t.starter ? pit(t.starter) : null, pitchers: t.pitchers.map(pit), lineup: t.lineup.map((l) => [l.spot, l.name, l.pos, l.bats, l.slug || null]) });
  return { platform: x.platform, date: x.date, neutral: x.neutral, conference: x.conference, scheduled_innings: x.scheduled_innings, doubleheader_game: x.doubleheader_game,
    attendance: x.attendance, weather: x.weather, home: side(x.home), away: side(x.away) };
}
const readLines = (f) => { try { return zlib.gunzipSync(fs.readFileSync(f)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };
const writeLines = (f, rows) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, zlib.gzipSync(rows.map((r) => JSON.stringify(r)).join('\n') + '\n')); };

/* which games to read, and from which school: [{ school, host, season, game_key, url, platform, opponent, own_team_id, opp_team_id, site, date, dh_n }],
   newest season first (the current season's starters are wanted before the oldest seasons'). A game on SIDEARM's older sites
   whose two teams do not both resolve to our ids (the school's id; the opponent's website, through the registry of every
   division and the ids the schedules establish, teamids.js) is not read at all: its box could not be joined (`unjoinable`) */
function plan(dataDir, sport, seasons, schools, platforms, o) {
  o = o || {};
  const byId = new Map(schools.map((s) => [s.id, s]));
  const byHost = new Map(schools.map((s) => [s.host, s.id]));
  const teamOfHost = o.teamOfHost || require('./rosters').teamOfHost(dataDir, o.allSchools || schools);
  const reads = (id) => READ.has((platforms[id] || {}).platform);
  const out = []; let unjoinable = 0;
  for (const season of seasons) {
    const dir = path.join(dataDir, 'schedules', sport, String(season));
    if (!fs.existsSync(dir)) continue;
    const held = new Map();
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) { const d = readJson(path.join(dir, f), null); if (d && byId.has(d.school)) held.set(d.school, d); }
    for (const [sid, d] of held) {
      if (!reads(sid)) continue;
      /* a doubleheader's games (the same date and opponent listed twice), numbered in the order listed */
      const dkey = (g) => g.date + '|' + (g.opponent_host || g.opponent);
      const times = new Map();
      for (const g of d.games || []) times.set(dkey(g), (times.get(dkey(g)) || 0) + 1);
      const seen = new Map();
      const own = byId.get(sid).baseball_team_id ? String(byId.get(sid).baseball_team_id) : null;
      for (const g of d.games || []) {
        const n = (seen.get(dkey(g)) || 0) + 1; seen.set(dkey(g), n);
        if (g.status !== 'final' || !g.boxscore || g.exhibition) continue;
        const opp = g.opponent_host ? byHost.get(g.opponent_host) : null;
        const oppReads = opp && held.has(opp) && reads(opp);
        /* the other school reads it when it is home, or (neutral) sorts first */
        if (oppReads && (g.site === 'A' || (g.site === 'N' && opp < sid))) continue;
        const oppTeam = teamOfHost(g.opponent_host);
        if (platforms[sid].platform === 'sidearm_legacy' && (!own || !oppTeam)) { unjoinable++; continue; }
        out.push({ school: sid, host: byId.get(sid).host, season, game_key: g.game_key, url: 'https://' + byId.get(sid).host + g.boxscore,
          platform: platforms[sid].platform, opponent: opp || null, own_team_id: own, opp_team_id: oppTeam, site: g.site || null, date: g.date, conference: g.conference,
          dh_n: times.get(dkey(g)) > 1 ? n : 0 });
      }
    }
  }
  out.sort((a, b) => b.season - a.season);
  out.unjoinable = unjoinable;
  return out;
}

/* an older SIDEARM box's teams in our record's ids: the school's own and its opponent's, as the plan resolved them; null when
   either is unknown or the page does not say which side is the school */
function legacyCodes(x, t) {
  const own = t.own_team_id; const opp = t.opp_team_id;
  if (!x.own_side || !own || !opp) return null;
  const ownT = x.own_side === 'home' ? x.home : x.away; const oppT = x.own_side === 'home' ? x.away : x.home;
  ownT.code = String(own); oppT.code = String(opp);
  for (const p of oppT.pitchers.concat(oppT.lineup)) p.slug = null;      /* the opponent's links, if any, are not the school's roster */
  x.neutral = t.site === 'N'; x.conference = t.conference == null ? null : !!t.conference; x.doubleheader_game = t.dh_n || 0;
  return x;
}

async function collect(o) {
  const RO = require('./rosters');
  const today = o.today || new Date().toISOString().slice(0, 10);
  const dataDir = o.dataDir || DATA;
  const sport = o.sport || 'baseball';
  const all = o.schoolsList || RO.loadSchools(dataDir);
  const division = o.division == null ? 1 : o.division;
  const schools = all.filter((s) => s.host && (division === 'all' || s.division === division));
  const platforms = readJson(path.join(dataDir, 'platforms.json'), {});
  const todo = plan(dataDir, sport, o.seasons, schools, platforms, { allSchools: all });
  /* what is already held */
  const heldKeys = new Map();
  const fileOf = (season, school) => path.join(dataDir, 'boxscores', sport, String(season), school + '.jsonl.gz');
  const keysOf = (season, school) => { const k = season + '|' + school; if (!heldKeys.has(k)) heldKeys.set(k, new Set(readLines(fileOf(season, school)).map((r) => r.game_key))); return heldKeys.get(k); };
  const pending = todo.filter((t) => !keysOf(t.season, t.school).has(t.game_key));
  const polite = o.polite || require('./polite').createPolite({ hosts: [...new Set(schools.map((s) => s.host))], cacheDir: path.join(__dirname, '..', '.cache', 'collegiate'), log: (m) => console.error(m) });
  const perHost = o.perHost || 100;
  const byHost = new Map();
  for (const t of pending) { if (!byHost.has(t.host)) byHost.set(t.host, []); byHost.get(t.host).push(t); }
  const results = [];
  const queue = [...byHost.values()];
  const lanes = Math.max(1, Math.min(o.lanes || 64, queue.length));
  await Promise.all(Array.from({ length: lanes }, async () => {
    for (let list = queue.shift(); list; list = queue.shift()) {
      const bySeason = new Map();
      for (const t of list.slice(0, perHost)) {
        const r = await polite.get(t.url, { ttlMs: 30 * 24 * 3600 * 1000, noStore: true });
        if (!r.ok) { results.push({ ok: false, code: r.refused ? 'REFUSED' : 'HTTP', t }); if (r.refused) break; continue; }
        let x = parseBoxscore(r.text());
        if (x && x.platform === 'sidearm_legacy') {
          x = legacyCodes(x, t);
          if (!x) { results.push({ ok: false, code: 'NO_TEAM_CODE', t }); continue; }
        }
        if (!x || !x.home.code || !x.away.code) { results.push({ ok: false, code: 'NO_BOXSCORE', t }); continue; }
        const k = t.season + '|' + t.school;
        if (!bySeason.has(k)) bySeason.set(k, []);
        bySeason.get(k).push(Object.assign({ game_key: t.game_key, school: t.school, url: t.url, read_at: today }, compact(x)));
        results.push({ ok: true, t });
      }
      /* write what this host gave, whatever happens to the others */
      for (const [k, rows] of bySeason) {
        const [season, school] = k.split('|');
        const f = fileOf(season, school);
        writeLines(f, readLines(f).concat(rows));
      }
    }
  }));
  const byCode = {};
  for (const r of results) if (!r.ok) byCode[r.code] = (byCode[r.code] || 0) + 1;
  return { planned: todo.length, unjoinable: todo.unjoinable || 0, pending: pending.length, ok: results.filter((r) => r.ok).length, left: pending.length - results.filter((r) => r.ok).length, misses_by_reason: byCode };
}

module.exports = { parseBoxscore, sidearmBoxscore, sidearmLegacyBoxscore, legacyCodes, outsOf, weather, compact, plan, collect, readLines, READ };
