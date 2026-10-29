/* ============================================================================
   SP+ from CollegeFootballData.com — the request, the parse, the team map.
   football/sp_plus/README.md

   SP+ is ESPN's opponent-adjusted efficiency rating, created by Bill
   Connelly. CollegeFootballData.com serves it at GET /ratings/sp?year=<season>
   (a free key, sent as a Bearer token, never logged and never committed:
   CFBD terms §2). The endpoint takes a year and a team, not a week: what it
   returns is SP+ as published at the moment of the request, so a "week" here
   is the week EdgeDesk captured it for, stamped with the capture time.

   Pure apart from fetchSp() (which takes an injectable fetch, so every test
   runs on a mocked response):

     fetchSp({season, key, base, fetch, timeoutMs}) -> {ok, status, body | error}
     parseSp(body, season)   -> {rows, rejected, skipped, n_received, refusal}
                                every row must carry a team name and finite
                                overall / offense / defense ratings; a row that
                                does not is rejected with its reason, never
                                repaired; the national-averages row is skipped
     payloadHash(rows)       -> sha256 of the values alone (team, overall,
                                offense, defense), sorted by team: two captures
                                with the same numbers have the same hash
     mapTeams(rows, opts)    -> {mapped, unmapped}: the identity master
                                (football/cfb_lab/identity.js) by CFBD's team id
                                when the payload carries one, and by name
                                through the shared alias table. A prefix match
                                or an ambiguous name is UNMAPPED and logged:
                                a team is never guessed
     ids                     -> deterministic row / snapshot / run ids
   ========================================================================== */
'use strict';
const crypto = require('crypto');

const SOURCE = 'collegefootballdata.com /ratings/sp (SP+ by ESPN, Bill Connelly)';
const DEFAULT_BASE = 'https://api.collegefootballdata.com';
const API_PATH = '/ratings/sp';
const AGGREGATE_TEAMS = ['nationalaverages'];
/* the resolutions a sync accepts; the identity master also answers with a
   longest-prefix match, which is a guess and is refused here */
const ACCEPTED_HOW = /^(provider_id:cfbd|internal_id|name:exact|name:alias|name:state-expansion)$/;

/* ids: the same rendering the Model Lab uses (SCHEMA.md rule 4): parts joined
   with '|', null as '', sha256, the first 24 hex characters */
function h(...parts) {
  return crypto.createHash('sha256').update(parts.map((x) => (x == null ? '' : String(x))).join('|'), 'utf8').digest('hex').slice(0, 24);
}
const ids = {
  snapshot: (s) => 'cfbss_' + h(s.season, s.week_key, s.payload_sha256, s.captured_at),
  rating: (r) => 'cfbsp_' + h(r.snapshot_id, r.team_id),
  run: (r) => 'cfbsr_' + h(r.season, r.week_key, r.started_at)
};

function finite(x) { return typeof x === 'number' && Number.isFinite(x); }
function round2(x) { return Math.round(x * 100) / 100; }

async function fetchSp(o) {
  o = o || {};
  const doFetch = o.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { ok: false, status: null, error: 'no fetch available' };
  if (!o.key) return { ok: false, status: null, error: 'no CFBD_API_KEY: the key is a repository secret and was not provided' };
  const url = (o.base || DEFAULT_BASE).replace(/\/+$/, '') + API_PATH + '?year=' + encodeURIComponent(o.season);
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), o.timeoutMs || 30000) : null;
  try {
    const res = await doFetch(url, { headers: { Authorization: 'Bearer ' + o.key, Accept: 'application/json' }, signal: ac ? ac.signal : undefined });
    if (!res.ok) return { ok: false, status: res.status, error: 'CollegeFootballData answered HTTP ' + res.status };
    let body;
    try { body = await res.json(); } catch (e) { return { ok: false, status: res.status, error: 'CollegeFootballData answered something that is not JSON' }; }
    return { ok: true, status: res.status, body };
  } catch (e) {
    return { ok: false, status: null, error: 'the request to CollegeFootballData failed: ' + (e && e.name === 'AbortError' ? 'timed out' : String(e && e.message || e)) };
  } finally { if (timer) clearTimeout(timer); }
}

function parseSp(body, season) {
  const out = { rows: [], rejected: [], skipped: [], n_received: 0, refusal: null };
  if (!Array.isArray(body)) { out.refusal = 'the payload is not a list of teams'; return out; }
  out.n_received = body.length;
  const seen = {};
  body.forEach((r, i) => {
    const team = r && typeof r.team === 'string' ? r.team.trim() : '';
    if (!team) { out.rejected.push({ index: i, team: null, reason: 'no team name' }); return; }
    if (AGGREGATE_TEAMS.includes(team.toLowerCase().replace(/[^a-z]/g, ''))) { out.skipped.push({ index: i, team, reason: 'an aggregate row, not a team' }); return; }
    if (r.year != null && Number(r.year) !== Number(season)) { out.rejected.push({ index: i, team, reason: 'year ' + r.year + ' is not ' + season }); return; }
    const overall = r.rating, off = r.offense && r.offense.rating, def = r.defense && r.defense.rating;
    if (!finite(overall)) { out.rejected.push({ index: i, team, reason: 'no finite overall rating' }); return; }
    if (!finite(off)) { out.rejected.push({ index: i, team, reason: 'no finite offense rating' }); return; }
    if (!finite(def)) { out.rejected.push({ index: i, team, reason: 'no finite defense rating' }); return; }
    if ([overall, off, def].some((x) => Math.abs(x) >= 100)) { out.rejected.push({ index: i, team, reason: 'a rating outside +/-100' }); return; }
    const k = team.toLowerCase();
    if (seen[k] != null) { out.rejected.push({ index: i, team, reason: 'the team appears twice in the payload' }); seen[k] = -1; return; }
    seen[k] = out.rows.length;
    const teamId = r.teamId != null ? r.teamId : (r.team_id != null ? r.team_id : null);
    out.rows.push({ source_team: team, source_team_id: teamId != null && /^\d+$/.test(String(teamId)) ? String(teamId) : null,
      sp_overall: round2(overall), sp_off: round2(off), sp_def: round2(def) });
  });
  /* a name seen twice: neither copy is trusted */
  const dup = Object.keys(seen).filter((k) => seen[k] === -1);
  if (dup.length) out.rows = out.rows.filter((x) => !dup.includes(x.source_team.toLowerCase()));
  if (!out.rows.length && !out.refusal) out.refusal = 'no valid team rows in the payload';
  return out;
}

function payloadHash(rows) {
  const vals = rows.map((r) => [r.source_team, r.sp_overall, r.sp_off, r.sp_def]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash('sha256').update(JSON.stringify(vals), 'utf8').digest('hex');
}

/* opts.identity: the identity module (default football/cfb_lab/identity.js);
   opts.master: a loaded team master (tests pass a small one) */
function mapTeams(rows, opts) {
  opts = opts || {};
  const I = opts.identity || require('../cfb_lab/identity.js');
  const M = opts.master || I.master();
  const mapped = [], unmapped = [], byKey = {};
  rows.forEach((r) => {
    const ref = r.source_team_id ? { id: r.source_team_id, name: r.source_team, provider: 'cfbd' } : { name: r.source_team };
    const hit = I.resolveTeam(ref, M);
    if (!hit || !hit.internal_team_id) { unmapped.push({ source_team: r.source_team, reason: (hit && hit.reason) || 'does not resolve' }); return; }
    if (!ACCEPTED_HOW.test(hit.how)) { unmapped.push({ source_team: r.source_team, reason: 'only a ' + hit.how.replace(/^name:/, '') + ' match to ' + hit.internal_team_id + ': not accepted, a team is never guessed' }); return; }
    if (byKey[hit.internal_team_id]) {
      /* two source names on one team: neither is trusted */
      unmapped.push({ source_team: r.source_team, reason: 'resolves to ' + hit.internal_team_id + ', which ' + byKey[hit.internal_team_id].source_team + ' already took' });
      byKey[hit.internal_team_id].collided = true;
      return;
    }
    const m = Object.assign({ team_id: hit.internal_team_id, how: hit.how }, r);
    byKey[hit.internal_team_id] = m;
    mapped.push(m);
  });
  const kept = mapped.filter((m) => {
    if (!m.collided) return true;
    unmapped.push({ source_team: m.source_team, reason: 'shares ' + m.team_id + ' with another source name' });
    return false;
  });
  kept.forEach((m) => { delete m.collided; });
  return { mapped: kept, unmapped };
}

module.exports = { SOURCE, DEFAULT_BASE, API_PATH, ACCEPTED_HOW, h, ids, fetchSp, parseSp, payloadHash, mapTeams };
