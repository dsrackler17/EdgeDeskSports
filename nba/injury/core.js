'use strict';
/* ===========================================================================
   EdgeDesk NBA — the roster and injury layer's core, and the Roster-Adjusted
   Projection (research model NBA-ROSTER-ADJ v0.1). README §NBA roster and
   injury layer is the narrative; this file is the contract.

   ONE FILE, TWO RUNTIMES. Everything between BEGIN and END below is copied
   VERBATIM into supabase/functions/nba_injury_sync/index.ts by
     node tools/nba/inline_injury_core.js
   because an edge function deploys one folder and an import that cannot
   resolve fails the bundle while the old version keeps serving (the circa and
   billing rule). tools/nba/nba_injury_core.test.js fails if the copy drifts.
   Plain JavaScript on purpose: Deno runs it as-is, Node tests load it as-is.

   WHAT IS IN IT
     T0  observations     the league's official injury report (PDF text ->
                          rows), ESPN's injury and roster JSON, team identity,
                          player-name matching. Nothing is estimated: a row
                          that does not read is kept as unread, a name that
                          does not match is kept as unmatched.
     T2  transforms       expected minutes (with the preseason prior), the
                          depth-chart minutes redistribution, the rating
                          deltas. Deterministic: the same inputs give the same
                          numbers, in Node and in Deno.
     T3  research model   the Roster-Adjusted Projection: the baseline model,
                          its availability features reset, shifted by the
                          minutes-weighted impact change, priced by the
                          baseline's own distribution (nba/model/distribution.js,
                          passed in as DIST). EXPERIMENTAL; it never replaces
                          the baseline.
   =========================================================================== */
// ── BEGIN NBA INJURY CORE ─────────────────────────────────────────────────
// Canonical source: nba/injury/core.js (copied verbatim by
// tools/nba/inline_injury_core.js; edit the canonical file, never the copy).

var NBA_INJURY_CORE_VERSION = 'nba-injury-core-2026-10-21-1';

/* THE MODEL VERSION, registered before any holdout evaluation
   (nba/research/roster_adjusted/registration.json carries the same numbers;
   tools/nba/nba_injury_core.test.js fails if they differ). Changing any number
   here is a NEW version, registered first — never a silent edit. */
var NBA_ROSTER_MODEL = {
  key: 'NBA-ROSTER-ADJ',
  name: 'NBA Roster-Adjusted Projection',
  version: '0.1',
  status: 'EXPERIMENTAL',
  provenance: 'EdgeDesk research',
  /* status -> probability the player plays. Fixed estimates, registered up
     front; never tuned on results. UNKNOWN is a source status with no
     official equivalent (ESPN's "Day-To-Day", fallback feed only). */
  play_probability: { OUT: 0, DOUBTFUL: 0.25, QUESTIONABLE: 0.5, PROBABLE: 0.9, AVAILABLE: 1, UNKNOWN: 0.5 },
  minutes: {
    team_minutes: 240,          /* five players x 48 */
    max_minutes: 40,            /* the baseline player model's cap (nba/model/players.js) */
    ewm_weight_games: 4,        /* the player's EWM minutes count as four games of evidence ... */
    preseason_weight_games: 4,  /* ... beside at most four preseason games ... */
    preseason_fade_games: 10,   /* ... whose weight fades to zero over the first ten regular-season games */
    rookie_minutes: 10,         /* no NBA or preseason minutes: the baseline player model's default */
    max_uncertain: 12           /* exact expectation over at most 2^12 availability scenarios per team */
  },
  impact: { measure: 'edgedesk_rapm_v1', tier: 'T2', prior_o: -0.5, prior_d: -0.5 },
  rating_coefficient: 1.0,      /* the minutes-weighted impact change enters the team ratings at full weight */
  sanity: { max_abs_margin_shift: 25, max_abs_total_shift: 30 }
};

/* Team identity. [ESPN id, ESPN abbreviation (the slate's), NBA tricode (the
   official report's), the official report's team name, other spellings] */
var NBA_TEAMS = [
  ['1', 'ATL', 'ATL', 'Atlanta Hawks', []], ['2', 'BOS', 'BOS', 'Boston Celtics', []], ['3', 'NO', 'NOP', 'New Orleans Pelicans', []],
  ['4', 'CHI', 'CHI', 'Chicago Bulls', []], ['5', 'CLE', 'CLE', 'Cleveland Cavaliers', []], ['6', 'DAL', 'DAL', 'Dallas Mavericks', []],
  ['7', 'DEN', 'DEN', 'Denver Nuggets', []], ['8', 'DET', 'DET', 'Detroit Pistons', []], ['9', 'GS', 'GSW', 'Golden State Warriors', []],
  ['10', 'HOU', 'HOU', 'Houston Rockets', []], ['11', 'IND', 'IND', 'Indiana Pacers', []], ['12', 'LAC', 'LAC', 'LA Clippers', ['Los Angeles Clippers']],
  ['13', 'LAL', 'LAL', 'Los Angeles Lakers', ['LA Lakers']], ['14', 'MIA', 'MIA', 'Miami Heat', []], ['15', 'MIL', 'MIL', 'Milwaukee Bucks', []],
  ['16', 'MIN', 'MIN', 'Minnesota Timberwolves', []], ['17', 'BKN', 'BKN', 'Brooklyn Nets', []], ['18', 'NY', 'NYK', 'New York Knicks', []],
  ['19', 'ORL', 'ORL', 'Orlando Magic', []], ['20', 'PHI', 'PHI', 'Philadelphia 76ers', ['Philadelphia Sixers']], ['21', 'PHX', 'PHX', 'Phoenix Suns', []],
  ['22', 'POR', 'POR', 'Portland Trail Blazers', ['Portland Trailblazers']], ['23', 'SAC', 'SAC', 'Sacramento Kings', []], ['24', 'SA', 'SAS', 'San Antonio Spurs', []],
  ['25', 'OKC', 'OKC', 'Oklahoma City Thunder', []], ['26', 'UTAH', 'UTA', 'Utah Jazz', []], ['27', 'WSH', 'WAS', 'Washington Wizards', []],
  ['28', 'TOR', 'TOR', 'Toronto Raptors', []], ['29', 'MEM', 'MEM', 'Memphis Grizzlies', []], ['30', 'CHA', 'CHA', 'Charlotte Hornets', []]
];
function nbaTeam(key) {
  var k = String(key == null ? '' : key).trim().toUpperCase();
  for (var i = 0; i < NBA_TEAMS.length; i++) {
    var t = NBA_TEAMS[i];
    if (t[0] === k || t[1] === k || t[2] === k || t[3].toUpperCase() === k || t[4].some(function (a) { return a.toUpperCase() === k; })) return { id: t[0], abbr: t[1], tricode: t[2], name: t[3] };
  }
  /* the abbreviations other feeds use */
  var alt = { GSW: '9', NOP: '3', NYK: '18', SAS: '24', UTA: '26', WAS: '27', NJ: '17', BRK: '17', PHO: '21', CHO: '30' }[k];
  return alt ? nbaTeam(alt) : null;
}
/* every spelling of every team name, longest first (a name is read as a prefix) */
var NBA_TEAM_NAMES = (function () {
  var out = [];
  NBA_TEAMS.forEach(function (t) { [t[3]].concat(t[4]).forEach(function (n) { out.push({ name: n, id: t[0] }); }); });
  return out.sort(function (a, b) { return b.name.length - a.name.length; });
})();

/* ---------------------------------------------------------------- time (Eastern) */
var NBA_ET_FMT = null;
function nbaEtParts(t) {
  if (!NBA_ET_FMT) NBA_ET_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  var p = {}; NBA_ET_FMT.formatToParts(new Date(t)).forEach(function (x) { p[x.type] = x.value; });
  return { y: +p.year, mo: +p.month, d: +p.day, h: (+p.hour) % 24, mi: +p.minute };
}
function nbaEtOffsetMin(t) { var p = nbaEtParts(t); return Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(t / 60000) * 60000) / 60000); }
/** an Eastern wall-clock time -> epoch ms (daylight time handled by the zone database) */
function nbaEtToUtc(y, mo, d, h, mi) {
  var wall = Date.UTC(y, mo - 1, d, h, mi);
  var t = wall - nbaEtOffsetMin(wall + 5 * 3600e3) * 60000;
  var off2 = nbaEtOffsetMin(t);
  return wall - off2 * 60000;
}
/** epoch ms -> the Eastern date 'YYYY-MM-DD' */
function nbaEtDate(t) { var p = nbaEtParts(t); return p.y + '-' + (p.mo < 10 ? '0' : '') + p.mo + '-' + (p.d < 10 ? '0' : '') + p.d; }
function nbaIso(t) { return new Date(t).toISOString().replace(/\.000Z$/, 'Z'); }

/* ---------------------------------------------------------------- the official report: finding it */
var NBA_REPORT_BASE = 'https://ak-static.cms.nba.com/referee/injury/';
var NBA_REPORT_FILE_RE = /Injury-Report_(\d{4})-(\d{2})-(\d{2})_(\d{1,2})(?:_(\d{2}))?(AM|PM)\.pdf/i;
/** a report's publication time from its file name (Eastern), or null */
function nbaReportTimeFromName(url) {
  var m = NBA_REPORT_FILE_RE.exec(String(url || ''));
  if (!m) return null;
  var h = (+m[4]) % 12 + (m[6].toUpperCase() === 'PM' ? 12 : 0);
  return nbaEtToUtc(+m[1], +m[2], +m[3], h, m[5] ? +m[5] : 0);
}
/** every report PDF linked from the league's season page, newest first */
function nbaFindReportLinks(html, base) {
  var seen = {}, out = [], re = /href\s*=\s*["']([^"']*Injury-Report_[^"']*\.pdf)["']/gi, m;
  while ((m = re.exec(String(html || ''))) !== null) {
    var u = m[1];
    try { u = new URL(u, base || NBA_REPORT_BASE).toString(); } catch (_) { continue; }
    var t = nbaReportTimeFromName(u);
    if (t == null || seen[u]) continue;
    seen[u] = 1; out.push({ url: u, published_ms: t });
  }
  return out.sort(function (a, b) { return b.published_ms - a.published_ms; });
}
/** file names the league uses, newest first, for the last `hours` (the fallback when the season page cannot be read) */
function nbaReportCandidates(nowMs, hours) {
  var out = [], step = 15 * 60000, start = Math.floor(nowMs / step) * step;
  for (var t = start; t > nowMs - (hours || 8) * 3600e3; t -= step) {
    var p = nbaEtParts(t), h12 = p.h % 12 === 0 ? 12 : p.h % 12, ap = p.h < 12 ? 'AM' : 'PM';
    var day = p.y + '-' + (p.mo < 10 ? '0' : '') + p.mo + '-' + (p.d < 10 ? '0' : '') + p.d, hh = (h12 < 10 ? '0' : '') + h12, mm = (p.mi < 10 ? '0' : '') + p.mi;
    out.push({ url: NBA_REPORT_BASE + 'Injury-Report_' + day + '_' + hh + '_' + mm + ap + '.pdf', published_ms: t });
    if (p.mi === 0) out.push({ url: NBA_REPORT_BASE + 'Injury-Report_' + day + '_' + hh + ap + '.pdf', published_ms: t });
  }
  return out;
}
function nbaSeasonPageUrl(nowMs) {
  var p = nbaEtParts(nowMs), y = p.mo >= 8 ? p.y : p.y - 1;
  return 'https://official.nba.com/nba-injury-report-' + y + '-' + String(y + 1).slice(2) + '-season/';
}

/* ---------------------------------------------------------------- the official report: reading it */
/** pdf.js text items -> reading-order lines (by y, then x), as the circa core reads its PDF */
function nbaLinesFromItems(items, tol) {
  tol = tol == null ? 2 : tol;
  var rows = [];
  (items || []).forEach(function (it) {
    if (!it || typeof it.str !== 'string' || !it.str.trim() || !it.transform) return;
    var x = +it.transform[4], y = +it.transform[5], row = null;
    for (var i = 0; i < rows.length; i++) if (Math.abs(rows[i].y - y) <= tol) { row = rows[i]; break; }
    if (!row) { row = { y: y, parts: [] }; rows.push(row); }
    row.parts.push({ x: x, s: it.str });
  });
  rows.sort(function (a, b) { return b.y - a.y; });
  return rows.map(function (r) { r.parts.sort(function (a, b) { return a.x - b.x; }); return r.parts.map(function (p) { return p.s.trim(); }).join(' ').replace(/\s+/g, ' ').trim(); });
}
var NBA_STATUS_OFFICIAL = { out: 'OUT', doubtful: 'DOUBTFUL', questionable: 'QUESTIONABLE', probable: 'PROBABLE', available: 'AVAILABLE' };
var NBA_PLAYER_RE = /^(.+?,\s*\S.*?)\s+(Out|Doubtful|Questionable|Probable|Available)(?:\s+(.*))?$/;
/**
 * The official report's lines -> rows. The table's columns are Game Date,
 * Game Time, Matchup, Team, Player Name, Current Status, Reason; a column is
 * printed only where its value changes, so each is carried down. A team that
 * has not filed reads "NOT YET SUBMITTED". A line that is none of these and
 * follows a player is the wrapped end of his reason. Anything else is UNREAD,
 * returned, never guessed at.
 */
function nbaParseOfficialLines(lines, meta) {
  var out = { published_ms: null, rows: [], not_submitted: [], matchups: [], unread: [], header_seen: false };
  var cur = { date: null, time: null, matchup: null, team: null }, last = null, orphan = [];
  var seenMatch = {};
  function noteMatchup() {
    if (!cur.date || !cur.matchup) return;
    var k = cur.date + '|' + cur.matchup;
    if (seenMatch[k]) return;
    seenMatch[k] = 1;
    var ab = cur.matchup.split('@'), a = nbaTeam(ab[0]), h = nbaTeam(ab[1]);
    out.matchups.push({ game_date: cur.date, game_time_et: cur.time, matchup: cur.matchup, away_id: a ? a.id : null, home_id: h ? h.id : null });
  }
  (lines || []).forEach(function (raw) {
    var s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!s) return;
    var hm = /Injury Report:\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(s);
    if (hm) { var yy = +hm[3] < 100 ? 2000 + +hm[3] : +hm[3]; out.published_ms = nbaEtToUtc(yy, +hm[1], +hm[2], (+hm[4]) % 12 + (hm[6].toUpperCase() === 'PM' ? 12 : 0), +hm[5]); return; }
    if (/^Page \d+ of \d+$/i.test(s)) return;
    if (/Game Date/i.test(s) && /Player Name/i.test(s)) { out.header_seen = true; return; }
    var m, prefix = false;
    if ((m = /^(\d{2})\/(\d{2})\/(\d{4})\s*/.exec(s))) { cur.date = m[3] + '-' + m[1] + '-' + m[2]; cur.time = null; cur.matchup = null; cur.team = null; s = s.slice(m[0].length); prefix = true; }
    if ((m = /^(\d{1,2}):(\d{2})\s*\(ET\)\s*/i.exec(s))) { cur.time = (m[1].length < 2 ? '0' : '') + m[1] + ':' + m[2]; cur.matchup = null; cur.team = null; s = s.slice(m[0].length); prefix = true; }
    if ((m = /^([A-Z]{2,4})\s*@\s*([A-Z]{2,4})\b\s*/.exec(s))) { cur.matchup = m[1] + '@' + m[2]; cur.team = null; s = s.slice(m[0].length); prefix = true; noteMatchup(); }
    for (var i = 0; i < NBA_TEAM_NAMES.length; i++) {
      var n = NBA_TEAM_NAMES[i].name;
      if (s.slice(0, n.length).toUpperCase() === n.toUpperCase() && (s.length === n.length || s.charAt(n.length) === ' ')) { cur.team = NBA_TEAM_NAMES[i].id; s = s.slice(n.length).trim(); prefix = true; break; }
    }
    if (!s) return;
    var ctx = { game_date: cur.date, game_time_et: cur.time, matchup: cur.matchup, team_id: cur.team };
    if (/^NOT YET SUBMITTED$/i.test(s)) {
      if (cur.team && cur.matchup) out.not_submitted.push(ctx); else out.unread.push(raw);
      last = null; return;
    }
    var pm = NBA_PLAYER_RE.exec(s);
    if (pm && cur.team && cur.matchup && cur.date) {
      var row = { game_date: ctx.game_date, game_time_et: ctx.game_time_et, matchup: ctx.matchup, team_id: ctx.team_id,
        player_raw: pm[1].trim(), player_name: nbaDisplayName(pm[1]), status: NBA_STATUS_OFFICIAL[pm[2].toLowerCase()], source_status: pm[2], reason: (pm[3] || '').trim() };
      /* a vertically centred reason can print its first line above the row */
      if (!row.reason && orphan.length) { row.reason = orphan.join(' '); orphan = []; }
      else if (orphan.length && last) { last.reason = (last.reason + ' ' + orphan.join(' ')).trim(); orphan = []; }
      out.rows.push(row); last = row; return;
    }
    if (!prefix && !/(Out|Doubtful|Questionable|Probable|Available)\b/.test(s) && s.length <= 120 && (last || out.rows.length)) { orphan.push(s); return; }
    out.unread.push(raw);
  });
  if (orphan.length) { if (last) last.reason = (last.reason + ' ' + orphan.join(' ')).trim(); else orphan.forEach(function (x) { out.unread.push(x); }); }
  if (out.published_ms == null && meta && meta.url) out.published_ms = nbaReportTimeFromName(meta.url);
  return out;
}

/* ---------------------------------------------------------------- the ESPN feeds (fallback statuses, rosters) */
var NBA_STATUS_ESPN = { out: 'OUT', doubtful: 'DOUBTFUL', questionable: 'QUESTIONABLE', probable: 'PROBABLE', available: 'AVAILABLE', active: 'AVAILABLE' };
function nbaEspnId(a) {
  if (!a) return null;
  if (a.id != null && /^\d+$/.test(String(a.id))) return String(a.id);
  var links = a.links || [];
  for (var i = 0; i < links.length; i++) { var m = /\/id\/(\d+)/.exec(String(links[i] && links[i].href || '')); if (m) return m[1]; }
  var u = /\/athletes\/(\d+)/.exec(String(a.$ref || a.uid || ''));
  return u ? u[1] : null;
}
/** ESPN's league injuries JSON -> rows (a status with no official equivalent, e.g. Day-To-Day, is UNKNOWN; the source's own word is kept) */
function nbaParseEspnInjuries(json) {
  var out = { rows: [], teams: [], unread: [] };
  ((json && json.injuries) || []).forEach(function (t) {
    var team = nbaTeam(t && (t.id || (t.team && t.team.id) || t.abbreviation));
    if (!team) { out.unread.push(t && t.displayName); return; }
    out.teams.push(team.id);
    (t.injuries || []).forEach(function (x) {
      var a = x.athlete || {}, raw = String(x.status || (x.type && x.type.description) || '').trim();
      if (!a.displayName && !a.fullName) { out.unread.push(raw); return; }
      var d = x.details || {}, why = [d.side && d.side !== 'Not Specified' ? d.side : null, d.location, d.type, d.detail].filter(Boolean).join(' ');
      out.rows.push({ team_id: team.id, player_id: nbaEspnId(a), player_name: a.displayName || a.fullName, status: NBA_STATUS_ESPN[raw.toLowerCase()] || 'UNKNOWN', source_status: raw,
        reason: why || x.shortComment || '', source_date: x.date || null });
    });
  });
  return out;
}
/** ESPN's team roster JSON -> players (flat list, or grouped by position) */
function nbaParseEspnRoster(json, teamId) {
  var list = [];
  ((json && json.athletes) || []).forEach(function (a) { if (a && Array.isArray(a.items)) list = list.concat(a.items); else if (a) list.push(a); });
  var players = [];
  list.forEach(function (a) {
    var id = nbaEspnId(a), name = a.displayName || a.fullName;
    if (!id || !name) return;
    var st = a.status || {}, raw = String(st.name || st.type || '').trim(), k = raw.toLowerCase().replace(/[^a-z]/g, '');
    players.push({ player_id: id, player_name: name, position: a.position && (a.position.abbreviation || a.position.name) || null, jersey: a.jersey != null ? String(a.jersey) : null,
      roster_status: k === 'active' ? 'ACTIVE' : k === 'twoway' ? 'TWO_WAY' : k === 'suspended' ? 'SUSPENDED' : k === 'inactive' ? 'INACTIVE' : (raw ? 'OTHER' : 'ACTIVE'), source_status: raw || null });
  });
  players.sort(function (a, b) { return a.player_id < b.player_id ? -1 : a.player_id > b.player_id ? 1 : 0; });
  return { team_id: String(teamId), players: players };
}

/* ---------------------------------------------------------------- names */
/** "White, Coby" -> "Coby White"; "Porter Jr., Michael" -> "Michael Porter Jr." */
function nbaDisplayName(s) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  var m = /^([^,]+),\s*(.+)$/.exec(s);
  return m ? (m[2] + ' ' + m[1]).trim() : s;
}
/* official spelling -> the spelling ESPN's roster uses, where they differ (keys as nbaNameKey makes them) */
var NBA_NAME_ALIASES = { 'nicolas claxton': 'nic claxton', 'herbert jones': 'herb jones', 'cameron thomas': 'cam thomas', 'kenyon martin': 'kj martin', 'moe wagner': 'moritz wagner', 'alex sarr': 'alexandre sarr' };
function nbaNameKey(s) {
  s = nbaDisplayName(s);
  if (s.normalize) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.toLowerCase().replace(/[’'`.]/g, '').replace(/[-‐–—]/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return NBA_NAME_ALIASES[s] || s;
}
/** rosters: { teamId: [{ player_id, player_name }] } -> an index the matcher reads */
function nbaNameIndex(rosters) {
  var idx = { byTeam: {}, byKey: {} };
  Object.keys(rosters || {}).forEach(function (t) {
    idx.byTeam[t] = (rosters[t] || []).map(function (p) {
      var k = nbaNameKey(p.player_name), parts = k.split(' ');
      var e = { id: String(p.player_id), team: t, key: k, last: parts.slice(1).join(' '), first: parts[0] || '' };
      (idx.byKey[k] = idx.byKey[k] || []).push(e);
      return e;
    });
  });
  return idx;
}
/**
 * One published name -> an ESPN player id. In order: exact on the team's
 * roster; same surname and first initial, unique on the team's roster; exact
 * and unique anywhere in the league (reported as a team mismatch: the report
 * and the roster disagree). Otherwise UNMATCHED, never a nearest guess.
 */
function nbaMatchPlayer(name, teamId, idx) {
  var k = nbaNameKey(name), parts = k.split(' '), first = parts[0] || '', last = parts.slice(1).join(' ');
  var team = (idx.byTeam[String(teamId)] || []);
  var ex = team.filter(function (p) { return p.key === k; });
  if (ex.length === 1) return { player_id: ex[0].id, method: 'team_exact', team_id: String(teamId) };
  var ini = team.filter(function (p) { return p.last === last && last && p.first.charAt(0) === first.charAt(0); });
  if (!ex.length && ini.length === 1) return { player_id: ini[0].id, method: 'team_initial', team_id: String(teamId) };
  var lg = idx.byKey[k] || [];
  if (lg.length === 1) return { player_id: lg[0].id, method: 'league_exact', team_id: lg[0].team, team_mismatch: lg[0].team !== String(teamId) };
  return { player_id: null, method: ex.length > 1 || lg.length > 1 ? 'ambiguous' : 'unmatched', team_id: String(teamId) };
}

/* ---------------------------------------------------------------- games */
/** a report row's (Eastern date, matchup) -> the slate game; games: [{ game_id, start_utc, home: {id}, away: {id} }] */
function nbaResolveGame(row, games) {
  var ab = String(row.matchup || '').split('@'), a = nbaTeam(ab[0]), h = nbaTeam(ab[1]);
  if (!a || !h || !row.game_date) return null;
  for (var i = 0; i < (games || []).length; i++) {
    var g = games[i], t = Date.parse(g.start_utc);
    if (String(g.home.id) === h.id && String(g.away.id) === a.id && isFinite(t) && nbaEtDate(t) === row.game_date) return g;
  }
  return null;
}
/** a team's next game on the slate within `hours` (the ESPN fallback carries no game) */
function nbaNextGame(teamId, games, nowMs, hours) {
  var best = null;
  (games || []).forEach(function (g) {
    var t = Date.parse(g.start_utc);
    if (!isFinite(t) || t <= nowMs || t > nowMs + (hours || 36) * 3600e3) return;
    if (String(g.home.id) !== String(teamId) && String(g.away.id) !== String(teamId)) return;
    if (!best || t < Date.parse(best.start_utc)) best = g;
  });
  return best;
}

/* ---------------------------------------------------------------- T2: minutes */
/** a player's expected minutes when available: his EWM minutes beside the preseason prior, fading as the season accrues */
function nbaExpectedMinutes(pl, model) {
  var c = (model || NBA_ROSTER_MODEL).minutes;
  if (!pl) return { e: c.rookie_minutes, basis: 'default' };
  var hasM = pl.ewm_minutes != null && isFinite(pl.ewm_minutes) && (pl.games || 0) > 0;
  var pre = (pl.preseason_games || 0) > 0 && pl.preseason_minutes != null && isFinite(pl.preseason_minutes);
  var w = pre ? Math.min(pl.preseason_games, c.preseason_weight_games) * Math.max(0, 1 - (pl.season_games || 0) / c.preseason_fade_games) : 0;
  if (hasM && w > 0) return { e: (c.ewm_weight_games * pl.ewm_minutes + w * pl.preseason_minutes) / (c.ewm_weight_games + w), basis: 'ewm+preseason' };
  if (hasM) return { e: pl.ewm_minutes, basis: 'ewm' };
  if (pre) return { e: pl.preseason_minutes, basis: 'preseason' };
  return { e: c.rookie_minutes, basis: 'default' };
}
/** scale to the team's minutes with a per-player cap, the excess redistributed — PlayerModel.strength's own loop */
function nbaScaleMinutes(list, c) {
  var out = {}, tot = 0;
  list.forEach(function (x) { tot += x.e; });
  if (!list.length || tot <= 0) return out;
  var scale = c.team_minutes / tot;
  for (var iter = 0; iter < 5; iter++) {
    var capped = 0, free = 0;
    list.forEach(function (x) { var v = x.e * scale; if (v > c.max_minutes) capped += c.max_minutes; else free += v; });
    if (capped + free >= c.team_minutes - 0.5 && capped + free <= c.team_minutes + 0.5) break;
    var freeBase = 0;
    list.forEach(function (x) { if (x.e * scale <= c.max_minutes) freeBase += x.e; });
    if (freeBase <= 0) break;
    scale = (c.team_minutes - capped) / freeBase;
  }
  list.forEach(function (x) { out[x.id] = Math.min(c.max_minutes, x.e * scale); });
  return out;
}
/** THE DEPTH CHART: the available players by expected minutes; the rotation is
    the shortest top of it that covers the team's minutes, scaled to them. A
    player who is out opens his minutes to the next man down. */
function nbaRotationMinutes(avail, c) {
  var s = avail.filter(function (x) { return x.e > 0; }).sort(function (a, b) { return b.e - a.e || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
  var rot = [], sum = 0;
  for (var i = 0; i < s.length && sum < c.team_minutes; i++) { rot.push(s[i]); sum += s[i].e; }
  return nbaScaleMinutes(rot, c);
}
/** expected minutes over every availability scenario (players [{ id, e, p }]; independent; exact) */
function nbaExpectedAllocation(players, c) {
  var sure = players.filter(function (p) { return p.p >= 1; }), unc = players.filter(function (p) { return p.p > 0 && p.p < 1; });
  if (unc.length > c.max_uncertain) return null;
  var acc = {};
  players.forEach(function (p) { acc[p.id] = 0; });
  for (var mask = 0; mask < (1 << unc.length); mask++) {
    var w = 1, avail = sure.slice();
    for (var k = 0; k < unc.length; k++) { if (mask & (1 << k)) { w *= unc[k].p; avail.push(unc[k]); } else w *= 1 - unc[k].p; }
    if (w <= 0) continue;
    var m = nbaRotationMinutes(avail, c);
    for (var id in m) acc[id] += w * m[id];
  }
  return acc;
}
function nbaSdOf(rule, mu) { return typeof rule === 'number' ? rule : Math.max(6, rule.s0 + rule.s1 * Math.min(Math.abs(mu), 10)); }

/* ---------------------------------------------------------------- T3: the roster-adjusted projection */
function nbaR2(v) { return v == null || !isFinite(v) ? null : Math.round(v * 100) / 100; }
function nbaR4(v) { return v == null || !isFinite(v) ? null : Math.round(v * 1e4) / 1e4; }
function nbaSummary(DIST, shape, mu_m, mu_t) {
  var p = { mu_m: mu_m, sd_m: nbaSdOf(shape.sd_rule, mu_m), mu_t: mu_t, sd_t: shape.sd_t, theta: shape.theta, gamma: shape.gamma, ot: shape.ot, half: shape.half, quarter: shape.quarter };
  var pr = DIST.price(p, { joint: false });
  return { mu_m: nbaR4(mu_m), mu_t: nbaR4(mu_t), p_home: pr.moneyline.home, fair_spread_home: pr.spread.fair_line_home, fair_total: pr.total.fair_line,
    expected: { home: pr.expected.home, away: pr.expected.away, margin: pr.expected.margin, total: pr.expected.total }, margin_interval_80: pr.margin_interval_80, moneyline_american: { home: pr.moneyline.home_american, away: pr.moneyline.away_american } };
}
var NBA_STATUS_WORD = { OUT: 'OUT', DOUBTFUL: 'DOUBTFUL', QUESTIONABLE: 'QUESTIONABLE', PROBABLE: 'PROBABLE', UNKNOWN: 'status not an official designation' };
function nbaSigned(v) { var r = Math.round(v * 10) / 10; return (r > 0 ? '+' : r < 0 ? '−' : '±') + Math.abs(r).toFixed(1); }

/**
 * Price one game with current rosters and the injury report.
 *
 * input = {
 *   game:        one nba/roster_inputs.json game (baseline and neutral means,
 *                pace, each team's reference rotation)
 *   shape:       nba/roster_inputs.json shape (the chosen model's distribution
 *                parameters, the same for every game)
 *   players:     nba/roster_inputs.json players (impact and minutes by ESPN id)
 *   rosters:     { home: [player_id], away: [player_id] }  the latest capture
 *   roster_meta: { home: { capture_id, captured_at, source }, away: {...} }
 *   statuses:    { home: [row], away: [row] }  this game's report rows, each
 *                { id, player_id, player_name, status, source_status, match_method, team_mismatch }
 *   report:      { id, source, published_at, on_report, not_submitted: { home, away } }
 *   team_of:     { player_id: team_id } every current roster (names a departed player's new team)
 *   slate_generated_at
 * }
 * Returns { status: 'OK' | 'WITHHELD', reasons, baseline, adjusted, delta,
 * adjustments, roster_changes, minutes }. A WITHHELD game carries no adjusted
 * number — only why, and the roster facts.
 */
function nbaRosterAdjust(input, DIST, model) {
  model = model || NBA_ROSTER_MODEL;
  var c = model.minutes, g = input.game, P = input.players || {}, reasons = [];
  var sides = { home: g.home, away: g.away }, pace = g.pace;
  var team = function (k) { return sides[k].abbr; };
  var out = { status: 'OK', reasons: reasons, model: { key: model.key, version: model.version }, baseline: null, neutral: null, adjusted: null, delta: null, adjustments: [], roster_changes: { home: null, away: null }, minutes: { home: [], away: [] } };
  var stat = input.statuses || { home: [], away: [] }, rep = input.report || {};

  if (!rep.id) reasons.push('no injury report');
  else if (!rep.on_report) reasons.push('this game is not on the latest injury report');
  ['home', 'away'].forEach(function (k) {
    if (rep.not_submitted && rep.not_submitted[k]) reasons.push(team(k) + ' has not submitted its injury report');
    if (!input.rosters || !input.rosters[k] || !input.rosters[k].length) reasons.push('no current roster on file for ' + team(k));
    (stat[k] || []).forEach(function (r) {
      if (r.status === 'AVAILABLE') return;
      if (!r.player_id) reasons.push(team(k) + ': ' + r.player_name + ' (' + r.status + ') could not be matched to a player');
      else if (r.team_mismatch) reasons.push(team(k) + ': the report lists ' + r.player_name + ' but the roster capture has him elsewhere');
    });
  });

  var imp = function (id) { var p = P[id]; return p && p.o != null && p.d != null ? { o: p.o, d: p.d, known: p.known !== false } : { o: model.impact.prior_o, d: model.impact.prior_d, known: false }; };
  var nm = function (id, fallback) { return (P[id] && P[id].name) || fallback || id; };
  var perMin = function (id) { var v = imp(id); return { m: (v.o + v.d) / 48 * pace / 100 * model.rating_coefficient, t: (v.o - v.d) / 48 * pace / 100 * model.rating_coefficient }; };

  /* the roster facts first: they are observations and stand even when the number is withheld */
  var teamState = {};
  ['home', 'away'].forEach(function (k) {
    var roster = (input.rosters && input.rosters[k]) || [], inRoster = {};
    roster.forEach(function (id) { inRoster[id] = 1; });
    var ref = (g.reference && g.reference[k]) || [], inRef = {};
    ref.forEach(function (r) { inRef[r.id] = r; });
    var R = nbaRotationMinutes(ref.map(function (r) { return { id: r.id, e: r.minutes }; }), c);
    var departed = ref.filter(function (r) { return !inRoster[r.id] && (R[r.id] || 0) > 0; }).map(function (r) {
      var now = input.team_of ? input.team_of[r.id] : null, nt = now ? nbaTeam(now) : null;
      return { player_id: r.id, player_name: nm(r.id, r.name), reference_minutes: nbaR2(R[r.id]), now_with: nt ? nt.abbr : null };
    }).sort(function (a, b) { return b.reference_minutes - a.reference_minutes; });
    var E = {};
    roster.forEach(function (id) { E[id] = nbaExpectedMinutes(P[id], model); });
    var arrived = roster.filter(function (id) { return !inRef[id]; }).map(function (id) {
      var last = P[id] && P[id].team_id ? nbaTeam(P[id].team_id) : null;
      return { player_id: id, player_name: nm(id), expected_minutes: nbaR2(E[id].e), from: last && last.id !== String(sides[k].id) ? last.abbr : null, minutes_basis: E[id].basis };
    }).sort(function (a, b) { return b.expected_minutes - a.expected_minutes; });
    out.roster_changes[k] = { team: team(k), capture: input.roster_meta ? input.roster_meta[k] || null : null, departed: departed, arrived: arrived };
    teamState[k] = { roster: roster, R: R, E: E, inRef: inRef };
  });

  /* the baseline as published, and the baseline with its availability features reset */
  out.baseline = nbaSummary(DIST, input.shape, g.baseline.mu_m, g.baseline.mu_t);
  out.neutral = nbaSummary(DIST, input.shape, g.neutral.mu_m, g.neutral.mu_t);
  if (reasons.length) { out.status = 'WITHHELD'; return out; }

  var shift = { m: 0, t: 0 }, lines = [];
  var push = function (l) { lines.push(l); };
  /* stage 0: the baseline priced each team's last game; the reset prices its full rotation */
  var d0m = g.neutral.mu_m - g.baseline.mu_m, d0t = g.neutral.mu_t - g.baseline.mu_t;
  push({ stage: 'baseline_reset', kind: 'availability_reset', team: d0m >= 0 ? team('home') : team('away'), player_id: null, player_name: null,
    margin_home: nbaR4(d0m), total: nbaR4(d0t),
    text:'Baseline availability reset (each team’s last game → its full rotation): ' + nbaSigned(Math.abs(d0m)) + ' pts ' + (d0m >= 0 ? team('home') : team('away')),
    evidence: { source: 'nba/roster_inputs.json', slate_generated_at: input.slate_generated_at || null } });

  ['home', 'away'].forEach(function (k) {
    var S = teamState[k], sgn = k === 'home' ? 1 : -1, T = team(k), meta = input.roster_meta && input.roster_meta[k];
    var players = S.roster.map(function (id) { return { id: id, e: S.E[id].e, p: 1 }; });
    var H = nbaRotationMinutes(players, c);
    /* stage 1: the current roster, everyone available, against the reference rotation */
    var rc = out.roster_changes[k];
    rc.departed.forEach(function (d) {
      var pm = perMin(d.player_id), mins = S.R[d.player_id] || 0;
      push({ stage: 'roster', kind: 'departed', team: T, player_id: d.player_id, player_name: d.player_name, minutes: nbaR2(-mins), margin_home: nbaR4(-mins * pm.m * sgn), total: nbaR4(-mins * pm.t),
        text: d.player_name + ' no longer on ' + T + '’s roster' + (d.now_with ? ' (now ' + d.now_with + ')' : '') + ': ' + nbaSigned(-mins * pm.m) + ' pts ' + T,
        evidence: { roster_capture_id: meta ? meta.capture_id : null, roster_captured_at: meta ? meta.captured_at : null, roster_source: meta ? meta.source : null } });
    });
    var reshM = 0, reshT = 0;
    S.roster.forEach(function (id) {
      var pm = perMin(id), h = H[id] || 0;
      if (!S.inRef[id]) {
        if (h <= 0) return;
        var a = rc.arrived.filter(function (x) { return x.player_id === id; })[0];
        push({ stage: 'roster', kind: 'arrived', team: T, player_id: id, player_name: nm(id), minutes: nbaR2(h), margin_home: nbaR4(h * pm.m * sgn), total: nbaR4(h * pm.t), impact_known: imp(id).known,
          text: nm(id) + (a && a.from ? ' joined ' + T + ' (from ' + a.from + ')' : ' in ' + T + '’s rotation (not in the reference rotation)') + (imp(id).known ? '' : ', no NBA impact on file (prior)') + ': ' + nbaSigned(h * pm.m) + ' pts ' + T,
          evidence: { roster_capture_id: meta ? meta.capture_id : null, roster_captured_at: meta ? meta.captured_at : null, roster_source: meta ? meta.source : null, minutes_basis: S.E[id].basis } });
      } else { reshM += (h - (S.R[id] || 0)) * pm.m; reshT += (h - (S.R[id] || 0)) * pm.t; }
    });
    if (Math.abs(reshM) >= 0.005 || Math.abs(reshT) >= 0.005) push({ stage: 'roster', kind: 'rotation', team: T, player_id: null, player_name: null, margin_home: nbaR4(reshM * sgn), total: nbaR4(reshT),
      text: T + ' returning players’ minutes in the new rotation (expected minutes, preseason prior): ' + nbaSigned(reshM) + ' pts ' + T,
      evidence: { roster_capture_id: meta ? meta.capture_id : null, minutes: 'nbaExpectedMinutes' } });

    /* stage 2: the report's statuses, the expectation over every availability scenario */
    var prob = {}, rowOf = {};
    (stat[k] || []).forEach(function (r) { if (r.player_id && S.E[r.player_id] && model.play_probability[r.status] != null) { prob[r.player_id] = model.play_probability[r.status]; rowOf[r.player_id] = r; } });
    var withP = S.roster.map(function (id) { return { id: id, e: S.E[id].e, p: prob[id] != null ? prob[id] : 1 }; });
    var A = nbaExpectedAllocation(withP, c);
    if (!A) { reasons.push(T + ': more than ' + c.max_uncertain + ' players with an uncertain status'); return; }
    var J = Object.keys(prob).filter(function (id) { return prob[id] < 1; });
    var freed = {}, fTot = 0, gM = 0, gT = 0;
    J.forEach(function (id) { freed[id] = Math.max(0, (H[id] || 0) - (A[id] || 0)); fTot += freed[id]; });
    S.roster.forEach(function (id) { if (prob[id] != null && prob[id] < 1) return; var pm = perMin(id), d = (A[id] || 0) - (H[id] || 0); gM += d * pm.m; gT += d * pm.t; });
    var takers = S.roster.filter(function (id) { return !(prob[id] < 1); }).map(function (id) { return { id: id, d: (A[id] || 0) - (H[id] || 0) }; }).filter(function (x) { return x.d >= 0.5; }).sort(function (a, b) { return b.d - a.d; }).slice(0, 3);
    J.forEach(function (id) {
      var pm = perMin(id), own = ((A[id] || 0) - (H[id] || 0)), share = fTot > 0 ? freed[id] / fTot : 0, r = rowOf[id];
      var lm = own * pm.m + share * gM, lt = own * pm.t + share * gT, pPlay = prob[id];
      push({ stage: 'injury', kind: 'status', status: r.status, team: T, player_id: id, player_name: nm(id, r.player_name), minutes: nbaR2(own), play_probability: pPlay, margin_home: nbaR4(lm * sgn), total: nbaR4(lt),
        text: nm(id, r.player_name) + ' ' + (NBA_STATUS_WORD[r.status] || r.status) + (pPlay > 0 && pPlay < 1 ? ' (' + Math.round(pPlay * 100) + '% to play, registered)' : '') + ': ' + nbaSigned(lm) + ' pts ' + T
          + (freed[id] >= 0.5 && takers.length ? ' · ' + (Math.round(freed[id] * 10) / 10).toFixed(1) + ' expected minutes freed; ' + T + '’s freed minutes go mostly to ' + takers.map(function (x) { return nm(x.id); }).join(', ') : ''),
        evidence: { report_id: rep.id || null, report_row_id: r.id || null, report_source: rep.source || null, report_published_at: rep.published_at || null, source_status: r.source_status || null, match_method: r.match_method || null } });
    });
    /* nothing freed (every listed player was outside the rotation) yet teammates' minutes moved: keep the sum exact */
    if (fTot <= 0 && (Math.abs(gM) >= 0.005 || Math.abs(gT) >= 0.005)) push({ stage: 'injury', kind: 'redistribution', team: T, player_id: null, player_name: null, margin_home: nbaR4(gM * sgn), total: nbaR4(gT),
      text: T + ' minutes redistributed down the depth chart: ' + nbaSigned(gM) + ' pts ' + T, evidence: { report_id: rep.id || null } });
    out.minutes[k] = S.roster.map(function (id) { return { player_id: id, player_name: nm(id), reference: nbaR2(S.R[id] || 0), healthy: nbaR2(H[id] || 0), expected: nbaR2(A[id] || 0), status: rowOf[id] ? rowOf[id].status : null, basis: S.E[id].basis, impact_known: imp(id).known }; })
      .filter(function (x) { return x.reference > 0 || x.healthy > 0 || x.status; }).sort(function (a, b) { return b.expected - a.expected; });
  });
  if (reasons.length) { out.status = 'WITHHELD'; out.adjustments = []; return out; }
  lines.forEach(function (l) { shift.m += l.margin_home || 0; shift.t += l.total || 0; });
  /* the reset is already inside the neutral means; the rest shifts them */
  var mu_m = g.baseline.mu_m + shift.m, mu_t = g.baseline.mu_t + shift.t;
  if (Math.abs(mu_m - g.neutral.mu_m) > model.sanity.max_abs_margin_shift || Math.abs(mu_t - g.neutral.mu_t) > model.sanity.max_abs_total_shift) {
    out.status = 'WITHHELD'; reasons.push('the adjustment is outside the registered sanity bound (margin ' + nbaR2(mu_m - g.neutral.mu_m) + ', total ' + nbaR2(mu_t - g.neutral.mu_t) + ')');
    return out;
  }
  out.adjusted = nbaSummary(DIST, input.shape, mu_m, mu_t);
  out.adjustments = lines.filter(function (l) { return Math.abs(l.margin_home || 0) >= 0.005 || Math.abs(l.total || 0) >= 0.005 || l.kind === 'status'; });
  var b = out.baseline, a = out.adjusted;
  out.delta = { mu_m: nbaR4(mu_m - g.baseline.mu_m), mu_t: nbaR4(mu_t - g.baseline.mu_t), fair_spread_home: nbaR2(a.fair_spread_home - b.fair_spread_home), fair_total: nbaR2(a.fair_total - b.fair_total),
    p_home: nbaR4(a.p_home - b.p_home), exp_margin: nbaR2(a.expected.margin - b.expected.margin), exp_total: nbaR2(a.expected.total - b.expected.total) };
  return out;
}

/* ---------------------------------------------------------------- hashing and dedupe */
/** JSON with sorted keys (a content hash must not depend on key order) */
function nbaStable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(nbaStable).join(',') + ']';
  return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; }).map(function (k) { return JSON.stringify(k) + ':' + nbaStable(v[k]); }).join(',') + '}';
}
/** what makes two reports the same report: their rows and unfiled teams, not when they were fetched */
function nbaReportContent(rep) {
  var rows = (rep.rows || []).map(function (r) { return [r.game_date || '', r.matchup || '', r.team_id || '', nbaNameKey(r.player_name), r.status, r.reason || '']; })
    .sort(function (a, b) { var x = a.join('|'), y = b.join('|'); return x < y ? -1 : x > y ? 1 : 0; });
  var ns = (rep.not_submitted || []).map(function (r) { return [r.game_date || '', r.matchup || '', r.team_id || ''].join('|'); }).sort();
  var mu = (rep.matchups || []).map(function (r) { return [r.game_date || '', r.matchup || ''].join('|'); }).sort();
  return nbaStable({ rows: rows, not_submitted: ns, matchups: mu });
}
// ── END NBA INJURY CORE ───────────────────────────────────────────────────

module.exports = {
  NBA_INJURY_CORE_VERSION, NBA_ROSTER_MODEL, NBA_TEAMS, NBA_NAME_ALIASES, nbaTeam, nbaEtToUtc, nbaEtDate, nbaEtParts, nbaIso,
  nbaReportTimeFromName, nbaFindReportLinks, nbaReportCandidates, nbaSeasonPageUrl, nbaLinesFromItems, nbaParseOfficialLines,
  nbaParseEspnInjuries, nbaParseEspnRoster, nbaEspnId, nbaDisplayName, nbaNameKey, nbaNameIndex, nbaMatchPlayer, nbaResolveGame, nbaNextGame,
  nbaExpectedMinutes, nbaScaleMinutes, nbaRotationMinutes, nbaExpectedAllocation, nbaSdOf, nbaSummary, nbaRosterAdjust, nbaStable, nbaReportContent
};
