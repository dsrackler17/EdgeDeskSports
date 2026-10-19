// ── BEGIN CIRCA CORE ──────────────────────────────────────────────────────
// Canonical source: football/market_structure/circa_core.js. This block is
// copied VERBATIM into supabase/functions/circa_ownership_sync/index.ts,
// because the dashboard deploy bundles one folder and an import that cannot
// resolve fails the bundle silently, leaving the old version serving. Edit the
// canonical file, then run
//   node tools/football/inline_circa_core.js
// tools/football/circa_ownership.test.js fails if the copy drifts, and if the
// club table below drifts from lib/football_identity.js NFL_TEAMS.
//
// WHAT IT DOES. Turns the text of a Circa Sports Million weekly selections PDF
// into per-side pick counts, and refuses to call anything complete that it
// could not account for:
//   circaLinesFromItems  pdf.js text items → reading-order lines (by y, then x)
//   circaParse           lines → entries of exactly five picks ("16. EAGLES +1"),
//                        plus every row it could not read, plus the document's
//                        own stated entry count when it states one
//   circaResolveTeam     a contest spelling → the club code, through the same
//                        alias table the rest of EdgeDesk resolves teams with
//   circaAggregate       picks → sides (team, contest line, picks, share of
//                        cards, share of that game's picks), every pick that
//                        did not resolve to a team or a game QUARANTINED, never
//                        dropped
//   circaValidate        complete / partial / failed, with the reasons
//
// Plain JavaScript on purpose: Deno runs it as-is, and Node tests load it
// without a build step.

var CIRCA_CORE_VERSION = 'circa-core-2026-10-19-1';

/* lib/football_identity.js NFL_TEAMS, verbatim: [code, name, aliases] */
var CIRCA_NFL_TEAMS = [
  ['ARI', 'Arizona Cardinals', ['ARZ', 'Arizona', 'Cardinals', 'Phoenix Cardinals']],
  ['ATL', 'Atlanta Falcons', ['Atlanta', 'Falcons']],
  ['BAL', 'Baltimore Ravens', ['BLT', 'Baltimore', 'Ravens']],
  ['BUF', 'Buffalo Bills', ['Buffalo', 'Bills']],
  ['CAR', 'Carolina Panthers', ['Carolina', 'Panthers']],
  ['CHI', 'Chicago Bears', ['Chicago', 'Bears']],
  ['CIN', 'Cincinnati Bengals', ['Cincinnati', 'Bengals']],
  ['CLE', 'Cleveland Browns', ['CLV', 'Cleveland', 'Browns']],
  ['DAL', 'Dallas Cowboys', ['Dallas', 'Cowboys']],
  ['DEN', 'Denver Broncos', ['Denver', 'Broncos']],
  ['DET', 'Detroit Lions', ['Detroit', 'Lions']],
  ['GB', 'Green Bay Packers', ['GNB', 'Green Bay', 'Packers']],
  ['HOU', 'Houston Texans', ['HST', 'Houston', 'Texans']],
  ['IND', 'Indianapolis Colts', ['Indianapolis', 'Colts']],
  ['JAX', 'Jacksonville Jaguars', ['JAC', 'Jacksonville', 'Jaguars']],
  ['KC', 'Kansas City Chiefs', ['KAN', 'KCC', 'Kansas City', 'Chiefs', 'KC Chiefs']],
  ['LV', 'Las Vegas Raiders', ['LVR', 'OAK', 'Las Vegas', 'Raiders', 'Oakland Raiders']],
  ['LAC', 'Los Angeles Chargers', ['SD', 'SDG', 'LA Chargers', 'Chargers', 'San Diego Chargers']],
  ['LAR', 'Los Angeles Rams', ['LA', 'STL', 'SL', 'LA Rams', 'Rams', 'St. Louis Rams']],
  ['MIA', 'Miami Dolphins', ['Miami', 'Dolphins']],
  ['MIN', 'Minnesota Vikings', ['Minnesota', 'Vikings']],
  ['NE', 'New England Patriots', ['NWE', 'New England', 'Patriots']],
  ['NO', 'New Orleans Saints', ['NOR', 'NOS', 'New Orleans', 'Saints']],
  ['NYG', 'New York Giants', ['NY Giants', 'Giants']],
  ['NYJ', 'New York Jets', ['NY Jets', 'Jets']],
  ['PHI', 'Philadelphia Eagles', ['Philadelphia', 'Eagles']],
  ['PIT', 'Pittsburgh Steelers', ['Pittsburgh', 'Steelers']],
  ['SF', 'San Francisco 49ers', ['SFO', 'San Francisco', '49ers', 'Niners']],
  ['SEA', 'Seattle Seahawks', ['Seattle', 'Seahawks']],
  ['TB', 'Tampa Bay Buccaneers', ['TAM', 'TBB', 'Tampa Bay', 'Buccaneers', 'Bucs']],
  ['TEN', 'Tennessee Titans', ['Tennessee', 'Titans']],
  ['WAS', 'Washington Commanders', ['WSH', 'WFT', 'Washington', 'Commanders', 'Washington Football Team']]
];

function circaKey(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]+/g, ''); }

/* every spelling → the clubs it names; a spelling naming two clubs (NEW YORK,
   LOS ANGELES) is ambiguous and resolves to nothing */
var CIRCA_TEAM_INDEX = (function () {
  var idx = {};
  function add(k, code) { k = circaKey(k); if (!k) return; (idx[k] = idx[k] || []); if (idx[k].indexOf(code) < 0) idx[k].push(code); }
  CIRCA_NFL_TEAMS.forEach(function (t) {
    var words = t[1].split(' ');
    add(t[0], t[0]); add(t[1], t[0]);
    add(words[words.length - 1], t[0]);                       /* the nickname */
    add(words.slice(0, -1).join(' '), t[0]);                  /* the city (New York names two) */
    t[2].forEach(function (a) { add(a, t[0]); });
  });
  return idx;
})();

function circaResolveTeam(raw) {
  var k = circaKey(raw);
  if (!k) return { code: null, reason: 'empty', candidates: [] };
  var hit = CIRCA_TEAM_INDEX[k];
  if (hit && hit.length === 1) return { code: hit[0], method: 'alias' };
  if (hit && hit.length > 1) return { code: null, reason: 'ambiguous_team', candidates: hit.slice() };
  /* "PHILADELPHIA EAGLES*" or a trailing note: try the longest known prefix of words */
  var w = String(raw).toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').trim().split(/\s+/);
  for (var n = w.length - 1; n >= 1; n--) {
    var h = CIRCA_TEAM_INDEX[circaKey(w.slice(0, n).join(' '))];
    if (h && h.length === 1) return { code: h[0], method: 'prefix' };
  }
  return { code: null, reason: 'unresolved_team', candidates: [] };
}

/* pdf.js text items ({str, transform:[a,b,c,d,x,y]}) of ONE page → lines,
   top to bottom, left to right. Items within `tol` points of the same
   baseline are one line, whatever the PDF says about line ends. */
function circaLinesFromItems(items, tol) {
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

/* "16. EAGLES +1", "3. 49ERS -3½", "22. CHIEFS PK". The team may start with a
   digit (49ERS); the line is signed, whole or half, or PK / PICK / EVEN. */
var CIRCA_PICK_RE = /(\d{1,3})\s*\.\s+([A-Z0-9][A-Z0-9 .'&\/-]*?)\s+([+\-−–]\s?\d{1,2}(?:\.5|½)?|PK|PICK(?:'?EM)?|EVEN)(?=\s|$|[,;|])/gi;
function circaLineValue(s) {
  var t = String(s || '').toUpperCase().replace(/\s+/g, '').replace(/[−–]/g, '-').replace('½', '.5');
  if (t === 'PK' || t === 'EVEN' || /^PICK/.test(t)) return 0;
  var n = Number(t); return isFinite(n) ? n : null;
}
function circaPicksOf(line) {
  var out = [], m; CIRCA_PICK_RE.lastIndex = 0;
  while ((m = CIRCA_PICK_RE.exec(line)) !== null) out.push({ num: Number(m[1]), team_raw: m[2].trim(), line_raw: m[3], line: circaLineValue(m[3]) });
  return out;
}
function circaStatedEntries(lines) {
  var re = [/(?:total|number of)\s+entries\s*[:#-]?\s*([\d,]{1,7})\b/i, /\b([\d,]{1,7})\s+(?:total\s+)?entries\b/i, /\bentries\s*[:#]\s*([\d,]{1,7})\b/i];
  for (var i = 0; i < lines.length; i++) for (var j = 0; j < re.length; j++) { var m = re[j].exec(lines[i]); if (m) return { n: Number(m[1].replace(/,/g, '')), line: lines[i] }; }
  return null;
}

/* lines → entries. A row with five picks is one entry. A row with fewer is
   held and joined with the rows after it until it reaches five (a long entry
   name can wrap); one that overshoots, or never reaches five, is an anomaly
   kept with its text. */
function circaParse(lines) {
  var entries = [], anomalies = [], pend = null, edition = null, week = null;
  function flush() { if (pend) anomalies.push({ row: pend.row, n_picks: pend.picks.length, text: pend.text.join(' / ').slice(0, 300), picks: pend.picks }); pend = null; }
  (lines || []).forEach(function (ln, i) {
    if (edition == null) { var e = /MILLION\s+([IVXLC]+)\b/i.exec(ln); if (e) edition = e[1].toUpperCase(); }
    if (week == null) { var w = /\bWEEK\s+(\d{1,2})\b/i.exec(ln); if (w) week = Number(w[1]); }
    var p = circaPicksOf(ln);
    if (!p.length) return;
    /* a whole row stands alone: whatever was held before it never completed */
    if (p.length === 5) { flush(); entries.push({ row: i, picks: p, wrapped: false }); return; }
    if (p.length > 5) { flush(); pend = { row: i, picks: p, text: [ln] }; flush(); return; }
    if (pend && pend.picks.length + p.length > 5) flush();
    if (!pend) pend = { row: i, picks: [], text: [] };
    pend.picks = pend.picks.concat(p); pend.text.push(ln);
    if (pend.picks.length === 5) { entries.push({ row: pend.row, picks: pend.picks, wrapped: pend.text.length > 1 }); pend = null; }
  });
  flush();
  var stated = circaStatedEntries(lines || []);
  return { entries: entries, anomalies: anomalies, stated_entries: stated ? stated.n : null, stated_line: stated ? stated.line : null,
    edition: edition, week: week, lines: (lines || []).length, picks_parsed: entries.length * 5 };
}

/* picks → sides. resolveEvent(code) → {event_id, home_code, away_code} | null:
   the week's game that club plays, from EdgeDesk's own events. */
function circaAggregate(parsed, resolveEvent) {
  var sides = {}, quarantine = [], lineSeen = {};
  function q(pick, entryRow, reason, extra) { quarantine.push({ row: entryRow, contest_game_no: pick.num, team_raw: pick.team_raw, line_raw: pick.line_raw, picks: 1, reason: reason, detail: extra || null }); }
  parsed.entries.forEach(function (e) {
    e.picks.forEach(function (p) {
      var t = circaResolveTeam(p.team_raw);
      if (!t.code) { q(p, e.row, t.reason, t.candidates && t.candidates.length ? { candidates: t.candidates } : null); return; }
      if (p.line == null) { q(p, e.row, 'unreadable_line'); return; }
      var ev = resolveEvent ? resolveEvent(t.code) : null;
      if (!ev || !ev.event_id) { q(p, e.row, 'no_event_for_team', { team_code: t.code }); return; }
      var k = t.code + '|' + p.line;
      var s = sides[k] = sides[k] || { team_code: t.code, contest_line: p.line, contest_game_no: p.num, event_id: ev.event_id, home_code: ev.home_code, away_code: ev.away_code, picks: 0, spellings: [] };
      s.picks++;
      if (s.spellings.indexOf(p.team_raw) < 0) s.spellings.push(p.team_raw);
      (lineSeen[t.code] = lineSeen[t.code] || {})[p.line] = true;
    });
  });
  /* a club carried at two contest lines in one week is a reading problem:
     every pick at the minority line is quarantined, not averaged in */
  Object.keys(lineSeen).forEach(function (code) {
    var ls = Object.keys(lineSeen[code]);
    if (ls.length < 2) return;
    var keep = ls.map(function (l) { return sides[code + '|' + l]; }).sort(function (a, b) { return b.picks - a.picks; });
    keep.slice(1).forEach(function (s) {
      quarantine.push({ row: null, contest_game_no: s.contest_game_no, team_raw: s.spellings.join(' / '), line_raw: String(s.contest_line), picks: s.picks, reason: 'conflicting_contest_line',
        detail: { team_code: code, kept_line: keep[0].contest_line } });
      delete sides[code + '|' + s.contest_line];
    });
  });
  var list = Object.keys(sides).map(function (k) { return sides[k]; });
  var byEvent = {};
  list.forEach(function (s) { byEvent[s.event_id] = (byEvent[s.event_id] || 0) + s.picks; });
  var entries = parsed.entries.length;
  list.forEach(function (s) {
    s.game_picks = byEvent[s.event_id];
    s.share_of_cards = entries ? Math.round(1e6 * s.picks / entries) / 1e6 : null;
    s.share_of_game = s.game_picks ? Math.round(1e6 * s.picks / s.game_picks) / 1e6 : null;
  });
  list.sort(function (a, b) { return a.contest_game_no - b.contest_game_no || (a.team_code < b.team_code ? -1 : 1); });
  var resolved = list.reduce(function (t, s) { return t + s.picks; }, 0);
  var quarantined = quarantine.reduce(function (t, x) { return t + x.picks; }, 0);
  return { sides: list, quarantine: quarantine, entries: entries, picks_parsed: parsed.picks_parsed, picks_resolved: resolved, picks_quarantined: quarantined };
}

/* complete: every row read, every pick placed, the document's own count
   matched (when it states one). partial: published WITH its quarantine
   count, never as complete. failed: nothing is published. */
function circaValidate(parsed, agg, opts) {
  opts = opts || {};
  var problems = [], fatal = [];
  var rows = parsed.entries.length + parsed.anomalies.length;
  if (!parsed.entries.length) fatal.push('no_entries_parsed');
  if (rows && parsed.anomalies.length / rows > (opts.max_anomaly_share == null ? 0.01 : opts.max_anomaly_share)) fatal.push('format_changed');
  if (parsed.stated_entries != null && parsed.stated_entries !== parsed.entries.length + parsed.anomalies.length) fatal.push('entry_count_mismatch');
  if (opts.week != null && parsed.week != null && parsed.week !== opts.week) fatal.push('wrong_week');
  if (agg && agg.picks_resolved + agg.picks_quarantined !== agg.picks_parsed) fatal.push('picks_unaccounted');
  if (parsed.anomalies.length) problems.push(parsed.anomalies.length + ' row(s) did not read as five picks');
  if (agg && agg.picks_quarantined) problems.push(agg.picks_quarantined + ' pick(s) quarantined');
  if (parsed.stated_entries == null) problems.push('the document states no entry total: entries are counted from its rows');
  var status = fatal.length ? 'failed' : (parsed.anomalies.length || (agg && agg.picks_quarantined) ? 'partial' : 'complete');
  return { status: status, fatal: fatal, notes: problems, entries_parsed: parsed.entries.length, entries_stated: parsed.stated_entries, rows_unread: parsed.anomalies.length };
}

/* where the PDF lives. The upload folder is the month it was posted (the
   Saturday), so the month of the Thursday and the next month are tried too. */
function circaUrlCandidates(edition, week, saturdayIso) {
  var d = new Date(saturdayIso), out = [];
  [0, -2, 30].forEach(function (shiftDays) {
    var x = new Date(d.getTime() + shiftDays * 864e5);
    var u = 'https://www.circasports.com/wp-content/uploads/' + x.getUTCFullYear() + '/' + ('0' + (x.getUTCMonth() + 1)).slice(-2)
      + '/Circa-Sports-Million-' + edition + '-Week-' + week + '-Selections.pdf';
    if (out.indexOf(u) < 0) out.push(u);
  });
  return out;
}
function circaFindLink(html, edition, week) {
  var re = /href\s*=\s*["']([^"']*Circa-Sports-Million-([IVXLC]+)-Week-(\d{1,2})-Selections[^"']*\.pdf)["']/gi, m;
  while ((m = re.exec(String(html || ''))) !== null) {
    if (m[2].toUpperCase() === String(edition).toUpperCase() && Number(m[3]) === Number(week)) return m[1].replace(/&amp;/g, '&');
  }
  return null;
}
/* the contest week an instant belongs to: weeks turn over on the Tuesday
   after the Monday game, counted from the Tuesday before Week 1's Thursday */
function circaContestWeek(week1ThursdayIso, nowMs) {
  var t = Date.parse(week1ThursdayIso + 'T12:00:00Z') - 2 * 864e5;
  var w = Math.floor((nowMs - t) / (7 * 864e5)) + 1;
  return w >= 1 && w <= 18 ? w : null;
}
/* the contest week's Saturday (UTC date) and its game window, Thursday 00:00
   Eastern to the Tuesday after (generous: a Wednesday opener is week 1) */
function circaWeekWindow(week1ThursdayIso, week) {
  var thu = Date.parse(week1ThursdayIso + 'T12:00:00Z') + (week - 1) * 7 * 864e5;
  return { saturday: new Date(thu + 2 * 864e5).toISOString().slice(0, 10), from: new Date(thu - 1.5 * 864e5).toISOString(), to: new Date(thu + 5 * 864e5).toISOString() };
}
// ── END CIRCA CORE ────────────────────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CIRCA_CORE_VERSION: CIRCA_CORE_VERSION, CIRCA_NFL_TEAMS: CIRCA_NFL_TEAMS, circaKey: circaKey, circaResolveTeam: circaResolveTeam,
    circaLinesFromItems: circaLinesFromItems, circaPicksOf: circaPicksOf, circaParse: circaParse, circaAggregate: circaAggregate, circaValidate: circaValidate,
    circaUrlCandidates: circaUrlCandidates, circaFindLink: circaFindLink, circaContestWeek: circaContestWeek, circaWeekWindow: circaWeekWindow, circaLineValue: circaLineValue };
}
