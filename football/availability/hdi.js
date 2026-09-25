#!/usr/bin/env node
/* ============================================================================
   THE CONFERENCE AVAILABILITY REPORTS, READ FROM WHERE THEY ARE PUBLISHED.

   The SEC, the ACC, the Big Ten, the Big 12, the American and the MAC do not
   publish their football availability reports as documents. Each
   conference's report page embeds one platform, HD Intelligence, and the
   table a reader sees is fetched by that platform's public report screen from

     POST https://app.hdintelligence.com/api/get-publish-public
          { sport: 'Football', organization: <code>, conference: <code> }

   with no credentials — the request every visitor's browser makes when the
   conference page loads (football/availability/probe_sources.js found it).
   EdgeDesk makes that request and nothing else. The platform's bundle also
   carries a key for its authenticated admin screens; that is not a public
   interface and nothing here sends it.

   WHAT COMES BACK is structured, which is why no page is scraped: one entry
   per game, each with its report type ("Update 1"), the conference's own
   filing time (publishDate + postedTime, in the conference's time zone), the
   game's date, time and site, and for each team that files the whole listed
   roster with a status for every player — Out, Out (1st Half), Doubtful,
   Questionable, Probable, Available, or Exempt (not required to be listed).
   Both teams file for a conference game. A MAC school files for its
   non-conference games too (policy.js ALL_GAMES), and that entry carries the
   MAC school alone.

   So a team with nobody designated is not silence here. The report lists
   every player and marks each one available, and that is an explicit
   statement (`explicit_none`) that football/availability/overlay.js may
   honour as a report of no absences.

   This file reads no roster and writes no report; sync_reports.js does both.
   ========================================================================== */
'use strict';

const BASE = 'https://app.hdintelligence.com';
const UA = 'EdgeDesk-availability-sync (+https://edgedesksports.com)';

/* the conference's platform code and the public report view a reader opens */
function publicViewUrl(code) {
  return BASE + '/?source=' + encodeURIComponent(code) + '&sport=Football&conf=' + encodeURIComponent(code) + '&type=report';
}

async function fetchPublished(code, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  try {
    const r = await f(BASE + '/api/get-publish-public', { method: 'POST', redirect: 'follow',
      signal: AbortSignal.timeout(45000),
      headers: { 'user-agent': UA, accept: 'application/json', 'content-type': 'application/json',
        origin: BASE, referer: publicViewUrl(code) },
      body: JSON.stringify({ sport: 'Football', organization: code, conference: code }) });
    if (!r.ok) return { ok: false, why: 'HTTP ' + r.status + ' from the published-report endpoint' };
    const data = await r.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, why: 'the published-report endpoint answered with something that is not a table of reports' };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, why: 'the published-report endpoint could not be read — ' + String((e && e.message) || e).slice(0, 200) };
  }
}

/* THE VOCABULARY. Exempt is not a designation: it marks a player the policy
   does not require the school to list. A status this table does not know is
   quarantined by the caller, never guessed. */
function statusOf(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return { status: null, known: false };
  if (s === 'available') return { status: 'AVAILABLE', known: true };
  if (s === 'exempt') return { status: 'EXEMPT', known: true };
  if (s === 'probable') return { status: 'PROBABLE', known: true };
  if (s === 'questionable') return { status: 'QUESTIONABLE', known: true };
  if (s === 'doubtful') return { status: 'DOUBTFUL', known: true };
  if (/^out\b.*(1st|first) half/.test(s)) return { status: 'OUT_FIRST_HALF', known: true };
  if (s === 'out') return { status: 'OUT', known: true };
  if (/game[- ]?time decision|^gtd$/.test(s)) return { status: 'GAME_TIME_DECISION', known: true };
  return { status: null, known: false };
}

/* "RB #5 Kewan Lacy", "S CJ Christian", "N/S #23 Emory Snyder",
   'RB #21 Anthony “Turbo” Rogers' → position, jersey, name (the nickname in
   quotes kept apart, because no roster carries it) */
function parseName(raw) {
  const t = String(raw || '').trim().replace(/\s+/g, ' ');
  const m = t.match(/^([A-Z][A-Z/]{0,5})\s+(?:#(\d{1,3})\s+)?(.+)$/);
  let position = null, jersey = null, name = t;
  if (m && /[a-z]/.test(m[3])) { position = m[1]; jersey = m[2] || null; name = m[3]; }
  const nick = name.match(/\s*["“”']([^"“”']+)["“”']\s*/);
  const plain = nick ? name.replace(nick[0], ' ').replace(/\s+/g, ' ').trim() : name;
  return { position, jersey, name: plain, nickname: nick ? nick[1] : null, raw: t };
}

/* WHEN IT WAS FILED, as an instant. The conference stamps the filing in its
   own zone; a wrong offset would reorder a morning update against the night
   before's, so the zone is resolved, never assumed. */
const ZONES = { ET: 'America/New_York', EST: 'America/New_York', EDT: 'America/New_York',
  CT: 'America/Chicago', CST: 'America/Chicago', CDT: 'America/Chicago',
  MT: 'America/Denver', MST: 'America/Denver', MDT: 'America/Denver',
  PT: 'America/Los_Angeles', PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles' };
function zonedToIso(date, time, zoneAbbr) {
  const zone = ZONES[String(zoneAbbr || '').trim().toUpperCase()];
  const dm = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const tm = String(time || '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!zone || !dm || !tm) return null;
  const want = Date.UTC(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2], +(tm[3] || 0));
  /* the zone's offset at that wall-clock time, found by asking what wall
     clock the guessed instant reads in the zone, twice (DST edges) */
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const wall = ms => {
    const p = {};
    fmt.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  };
  let guess = want;
  for (let i = 0; i < 2; i++) guess = guess - (wall(guess) - want);
  return new Date(guess).toISOString();
}

/* one published entry, flattened */
function readEntry(id, e) {
  const teams = (e.games || []).map(g => ({
    team_name: g.teamName || null,
    team_display: g.teamDisplayName || g.teamName || null,
    listed: (g.rows || []).map(r => {
      const p = parseName(r.name), st = statusOf(r.status);
      return { position: p.position, jersey: p.jersey, player_name: p.name, nickname: p.nickname,
        status_raw: r.status == null ? null : String(r.status), status: st.status, known: st.known,
        exempt: String(r.exemptStatus || '').toLowerCase() === 'exempt', raw_text: p.raw + ' · ' + r.status };
    })
  }));
  return {
    report_id: String(id), report_type: e.ReportType || null,
    published_at: zonedToIso(e.publishDate, e.postedTime, e.conferenceTimeZone),
    publish_local: [e.publishDate, e.postedTime, e.conferenceTimeZone].filter(Boolean).join(' ') || null,
    game_date: e.footer ? e.footer.date || null : null,
    game_time_local: e.footer ? e.footer.time || null : null,
    location: e.footer ? e.footer.location || null : null,
    neutral: e.gameNeutral === true,
    vocabulary: Array.isArray(e.statusReportOrder) ? e.statusReportOrder.slice() : [],
    teams
  };
}

/* THE FIXTURE AN ENTRY IS ABOUT: both teams, within a day of kickoff (the
   entry's date is local; a Friday-night game is Saturday in UTC). A team
   name is tried as the platform displays it and as it abbreviates it, with
   "St." read as "State" — and an entry that matches nothing is reported, not
   forced onto the nearest game. */
function nameKeys(s, normKey) {
  const out = new Set();
  [s, String(s || '').replace(/\bSt\.?(?=\s|$)/g, 'State')].forEach(x => { const k = normKey(x); if (k) out.add(k); });
  return out;
}
/* A ONE-TEAM ENTRY (a MAC school's non-conference game) is matched on that
   team and the date alone: a team plays once in a 36-hour window, and a
   second hit makes the match ambiguous, which is reported, never forced. */
function matchFixture(entry, games, normKey) {
  const day = Date.parse(String(entry.game_date || '') + 'T12:00:00Z');
  const n = (entry.teams || []).length;
  if (!isFinite(day) || n < 1 || n > 2) return null;
  const keysOf = t => new Set([...nameKeys(t.team_display, normKey), ...nameKeys(t.team_name, normKey)]);
  const a = keysOf(entry.teams[0]), b = n === 2 ? keysOf(entry.teams[1]) : null;
  const hits = (games || []).filter(g => {
    const t = Date.parse(g.kickoff || g.start_date || '');
    if (!isFinite(t) || Math.abs(t - day) > 36 * 3600e3) return false;
    const h = normKey(g.home_team), w = normKey(g.away_team);
    if (!b) return a.has(h) || a.has(w);
    return (a.has(h) && b.has(w)) || (a.has(w) && b.has(h));
  });
  return hits.length === 1 ? hits[0] : null;
}

/* which of an entry's two teams is `teamName` */
function sideOf(entry, teamName, normKey) {
  const k = normKey(teamName);
  return entry.teams.find(t => nameKeys(t.team_display, normKey).has(k) || nameKeys(t.team_name, normKey).has(k)) || null;
}

module.exports = { BASE, publicViewUrl, fetchPublished, statusOf, parseName, zonedToIso, readEntry, matchFixture, sideOf };
