// @ts-nocheck — plain JavaScript core inlined in a .ts file, as the billing and portfolio functions are.
// ============================================================
//  FILE:    supabase/functions/circa_ownership_sync/index.ts
//  TYPE:    Edge Function — Circa Sports Million contest ownership (T0)
//  DEPLOY:  supabase functions deploy circa_ownership_sync --no-verify-jwt
//           (npm:unpdf is bundled at deploy because its import names it
//           literally, as growth_outbound_research names npm:@anthropic-ai/sdk)
//  CRON:    supabase/contest_ownership_cron.sql — Saturday 10:00-18:00 ET
//           every two hours, Sunday 08:00 / 10:00 / 12:00 ET
//  SQL:     supabase/contest_ownership.sql (and nfl_market_structure.sql)
// ============================================================
// WHAT IT DOES. Finds the week's selections PDF on circasports.com (a link on
// the site first, then the upload-folder pattern
// /wp-content/uploads/YYYY/MM/Circa-Sports-Million-<edition>-Week-<n>-Selections.pdf),
// reads its text, parses every entry's five picks ("16. EAGLES +1"), resolves
// each club through EdgeDesk's own alias table and each club to the week's
// game through EdgeDesk's own captured events (public.signals), and writes the
// per-side counts through public.contest_ownership_ingest().
//
// WHAT IT REFUSES. A PDF that is not there, will not read, reads as no
// entries, states an entry total the rows do not reach, or reads more than 1%
// of its rows as anything other than five picks is a FAILED run: nothing is
// published for that week and market_structure_alerts says why. A pick that
// does not resolve to a club or a game is QUARANTINED with its own text — the
// run publishes as PARTIAL, labelled so, never as complete. Ownership is by
// entry (cards), not by unique player.
//
// AUTH. pg_cron sends the Vault secret circa_cron_secret as x-cron-secret; it
// must equal CIRCA_CRON_SECRET. A GET is a public health probe (BUILD only).
//
// POST body (all optional): { week, season, url, force, dry }
//   week / season  default: the contest week now (contest_ownership_config)
//   url            read this PDF instead of looking for one
//   force          re-read even when this week already has a complete run
//   dry            parse and report; write nothing
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (provided), CIRCA_CRON_SECRET.
// ============================================================

const BUILD = "circa_ownership_sync@2026-10-21.1";
const CONTEST = "circa_million";
const SITE_PAGES = ["https://www.circasports.com/", "https://www.circasports.com/contests/"];

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

// deno-lint-ignore no-explicit-any
type Any = any;
const env = (k: string) => Deno.env.get(k) ?? "";

async function db(path: string, init?: RequestInit): Promise<Any> {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const r = await fetch(env("SUPABASE_URL").replace(/\/$/, "") + "/rest/v1/" + path, {
    ...init,
    headers: { apikey: key, authorization: "Bearer " + key, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const t = await r.text();
  if (!r.ok) throw new Error("db " + r.status + " " + path.split("?")[0] + ": " + t.slice(0, 300));
  return t ? JSON.parse(t) : null;
}
const rpc = (fn: string, args: Any) => db("rpc/" + fn, { method: "POST", body: JSON.stringify(args) });

async function sha256hex(buf: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getPdf(url: string): Promise<Uint8Array | null> {
  const r = await fetch(url, { redirect: "follow", headers: { "user-agent": "EdgeDesk research (+https://edgedesksports.com)" } });
  if (!r.ok) return null;
  const b = new Uint8Array(await r.arrayBuffer());
  return b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 ? b : null; // %PDF
}

async function findPdf(edition: string, week: number, saturday: string, override?: string) {
  const tried: string[] = [];
  if (override) {
    tried.push(override);
    const b = await getPdf(override);
    return b ? { url: override, bytes: b, tried } : { tried };
  }
  for (const page of SITE_PAGES) {
    try {
      const r = await fetch(page, { headers: { "user-agent": "EdgeDesk research (+https://edgedesksports.com)" } });
      if (!r.ok) continue;
      const href = circaFindLink(await r.text(), edition, week);
      if (!href) continue;
      const url = new URL(href, page).toString();
      tried.push(url);
      const b = await getPdf(url);
      if (b) return { url, bytes: b, tried };
    } catch (_) { /* the pattern below is the fallback */ }
  }
  for (const url of circaUrlCandidates(edition, week, saturday)) {
    tried.push(url);
    try { const b = await getPdf(url); if (b) return { url, bytes: b, tried }; } catch (_) { /* next */ }
  }
  return { tried };
}

async function pdfLines(bytes: Uint8Array): Promise<string[]> {
  // The specifier must be a literal. The deploy bundles only the npm packages its
  // graph can see, and a specifier held in a constant leaves unpdf out ("Could not
  // find constraint 'unpdf@1.8.1' in the list of packages", as nba_injury_sync
  // found live on 2026-10-21).
  const { getDocumentProxy } = await import("npm:unpdf@1.8.1");
  const pdf = await getDocumentProxy(bytes);
  const out: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    out.push(...circaLinesFromItems(tc.items, 2));
  }
  return out;
}

/* the week's NFL games as EdgeDesk captured them, by club code */
async function weekEvents(from: string, to: string) {
  const rows: Any[] = await db("signals?select=event_id,home_team,away_team,commence_time&sport_key=eq.americanfootball_nfl&market=eq.spreads"
    + "&commence_time=gte." + encodeURIComponent(from) + "&commence_time=lt." + encodeURIComponent(to) + "&limit=5000");
  const byEvent: Record<string, Any> = {};
  for (const r of rows ?? []) if (r.event_id && !byEvent[r.event_id]) byEvent[r.event_id] = r;
  const byCode: Record<string, Any> = {}, twice: Record<string, boolean> = {};
  for (const e of Object.values(byEvent)) {
    const h = circaResolveTeam(e.home_team).code, a = circaResolveTeam(e.away_team).code;
    if (!h || !a) continue;
    const ev = { event_id: e.event_id, home_code: h, away_code: a, commence_time: e.commence_time };
    for (const c of [h, a]) { if (byCode[c]) twice[c] = true; byCode[c] = ev; }
  }
  for (const c of Object.keys(twice)) delete byCode[c]; // a club in two games this window is not resolvable
  return { byCode, n: Object.keys(byEvent).length };
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") return Response.json({ ok: true, build: BUILD, core: CIRCA_CORE_VERSION });
  if (req.method !== "POST") return Response.json({ ok: false, error: "method" }, { status: 405 });
  const secret = env("CIRCA_CRON_SECRET");
  if (!secret) return Response.json({ ok: false, error: "unauthorized", reason: "CIRCA_CRON_SECRET is not set on this function" }, { status: 401 });
  if (req.headers.get("x-cron-secret") !== secret) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body: Any = await req.json().catch(() => ({}));

  const cfgs: Any[] = await db("contest_ownership_config?contest=eq." + CONTEST + "&enabled=is.true&order=season.desc&limit=1"
    + (body.season ? "&season=eq." + Number(body.season) : ""));
  const cfg = cfgs?.[0];
  if (!cfg) return Response.json({ ok: true, skipped: "no enabled contest_ownership_config row" });
  const season = cfg.season, edition = cfg.edition;
  const week = body.week ? Number(body.week) : circaContestWeek(cfg.week1_thursday, Date.now());
  if (!week) return Response.json({ ok: true, skipped: "outside the contest weeks" });
  const win = circaWeekWindow(cfg.week1_thursday, week);
  const fail = async (code: string, message: string, url: string | null, detail: Any, parsed?: Any) => {
    if (body.dry) return Response.json({ ok: false, dry: true, week, code, message, url, detail, parsed });
    const r = await rpc("contest_ownership_fail", { p_contest: CONTEST, p_season: season, p_week: week, p_code: code, p_message: message,
      p_source_url: url, p_detail: detail ?? null, p_parsed: parsed ?? null });
    return Response.json({ ok: false, week, code, message, recorded: r });
  };

  try {
    const st: Any[] = await db("contest_ownership_status?contest=eq." + CONTEST + "&season=eq." + season + "&week=eq." + week);
    if (st?.[0]?.status === "complete" && !body.force && !body.url) return Response.json({ ok: true, week, skipped: "this week already has a complete run" });

    const found = await findPdf(edition, week, win.saturday, body.url);
    if (!("bytes" in found) || !found.bytes) return await fail("pdf_not_found", "no selections PDF for Week " + week + " (Million " + edition + ")", null, { tried: found.tried });
    const sha = await sha256hex(found.bytes);
    const prev: Any[] = await db("contest_ownership_runs?select=source_sha256,status&contest=eq." + CONTEST + "&season=eq." + season + "&week=eq." + week
      + "&status=in.(complete,partial)&order=fetched_at.desc&limit=1");
    if (prev?.[0]?.source_sha256 === sha && !body.force) return Response.json({ ok: true, week, skipped: "the PDF has not changed since the last good run", url: found.url });

    let lines: string[];
    try { lines = await pdfLines(found.bytes); }
    catch (e) { return await fail("pdf_unreadable", "the PDF would not read: " + String((e as Error)?.message ?? e).slice(0, 200), found.url, null); }

    const parsed = circaParse(lines);
    const ev = await weekEvents(win.from, win.to);
    const agg = circaAggregate(parsed, (code: string) => ev.byCode[code] ?? null);
    const v = circaValidate(parsed, agg, { week });
    const counts = { entries_stated: parsed.stated_entries, entries_parsed: parsed.entries.length, rows_unread: parsed.anomalies.length,
      picks_parsed: parsed.picks_parsed, parser_version: CIRCA_CORE_VERSION };
    if (v.status === "failed") {
      return await fail(v.fatal[0], "the PDF did not read as the selections format (" + v.fatal.join(", ") + ")", found.url,
        { anomalies: parsed.anomalies.slice(0, 5), lines: parsed.lines, events: ev.n }, counts);
    }
    const run = { run_id: crypto.randomUUID(), contest: CONTEST, season, week, status: v.status, code: null, message: v.notes.join("; ") || null,
      ...counts, picks_resolved: agg.picks_resolved, picks_quarantined: agg.picks_quarantined,
      source_url: found.url, source_sha256: sha, fetched_at: new Date().toISOString() };
    const quarantine = agg.quarantine.concat(parsed.anomalies.map((a: Any) => ({ row: a.row, contest_game_no: null, team_raw: a.text, line_raw: null,
      picks: Math.max(1, a.n_picks), reason: "unread_row", detail: { n_picks: a.n_picks } })));
    if (body.dry) return Response.json({ ok: true, dry: true, week, run, validation: v, sides: agg.sides, quarantine: quarantine.slice(0, 50), events: ev.n });
    const r = await rpc("contest_ownership_ingest", { p_run: run, p_sides: agg.sides, p_quarantine: quarantine });
    return Response.json({ ok: true, week, status: v.status, url: found.url, entries: parsed.entries.length, sides: agg.sides.length, recorded: r });
  } catch (e) {
    return await fail("sync_error", String((e as Error)?.message ?? e).slice(0, 300), null, null);
  }
});
