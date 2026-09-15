#!/usr/bin/env node
/* ============================================================================
   WHO IS COACHING THIS TEAM, AND SINCE WHEN.

   THE GAP THIS FILLS. The engine's stability layer prices staff turnover —
   `extra.coaching.new_hc`, `new_oc`, `new_dc` — and nothing in this
   repository ever supplied it. Every game on every slate carried
   `coaching_continuity: UNAVAILABLE`, the layer fell back to roster
   continuity alone, and the card said "a new coordinator changes a team's
   identity in ways the ratings only learn after the fact" without being able
   to say whether there WAS one.

   WHAT IS ACTUALLY AVAILABLE, AND WHAT IS NOT. cfbfastR publishes a coach
   table per season, derived from play-by-play, carrying the team and the
   head coach. It does NOT carry coordinators: every row is role `HC`. So
   this file answers the head-coach question and REFUSES to answer the other
   two — `new_oc` and `new_dc` are written as null, never as false, and the
   engine is told which of the three were supplied so it cannot report a
   third of the staff as the whole of it.

   TENURE, NOT A ONE-YEAR DIFF. Comparing this season's coach to last
   season's is wrong in the one case that matters most: a team that fired its
   coach in October has an INTERIM in last season's play-by-play, so the
   permanent hire who arrives in January looks like a second change and a
   coach in his fourth year looks new. So this walks back through the seasons
   until the name changes and reports the season the tenure began. `new_hc`
   is then "the tenure began this season", which is the question the engine
   is actually asking.

   AND A TEAM WITH NO HISTORY IS UNKNOWN, NOT CONTINUOUS. A programme whose
   earliest season in the window is the current one — a new FBS member, or a
   team with no play-by-play yet — gets null. Silence is not continuity.

     node football/coaching/build_coaching.js [--season 2026] [--back 8] [--check]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const RAW = 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-cfb-data/main/cfb/coach_tendencies/parquet';
const PY_HELPER = path.join(ROOT, 'football', 'data', 'tools', 'parquet_to_csv.py');
const SCHEMA = 'edgedesk_coaching_continuity_v1';
const OUT = path.join(__dirname, 'continuity.json');

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || String(v).startsWith('--')) ? true : v;
}
function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }
const QUIET = !!arg('quiet', false);
const log = (...a) => { if (!QUIET) console.error(...a); };
function num(v) { if (v == null || v === '' || v === 'NA') return null; const x = +v; return isFinite(x) ? x : null; }
function normKey(s) {
  if (s == null) return null;
  return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '') || null;
}
function parseCsv(text) {
  const out = [];
  const lines = String(text).split('\n');
  if (!lines.length) return out;
  function cells(line) {
    const r = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { r.push(cur); cur = ''; }
      else cur += c;
    }
    r.push(cur); return r;
  }
  const head = cells(lines[0].replace(/\r$/, ''));
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].length) continue;
    const c = cells(lines[i].replace(/\r$/, ''));
    const o = {};
    for (let j = 0; j < head.length; j++) o[head[j]] = c[j];
    out.push(o);
  }
  return out;
}
/* IDENTITY IS RESOLVED ON AN ID, NOT ON A NAME — the rule
   football/players/build_team_talent.js learned when a longest-prefix match
   silently joined "Houston Christian Huskies" onto `houston`. The provider's
   pos_team_id is the ESPN id EdgeDesk's own roster sync already carries; the
   name only has to corroborate it. A row whose id points at a team whose
   spellings share no token with the provider's is REFUSED, because a wrong
   join publishes one team's coach under another team's name and nothing
   downstream can tell. */
function schoolIndex(season) {
  const byId = new Map(), names = new Map();
  for (const y of [season, season - 1]) {
    let roster = null;
    try { roster = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'rosters', `fbs_${y}_espn.json`), 'utf8')); }
    catch (_) { continue; }
    for (const t of (roster.teams || [])) {
      const key = normKey(t.location || t.display_name);
      if (!key) continue;
      if (t.espn_id != null && !byId.has(String(t.espn_id))) byId.set(String(t.espn_id), key);
      names.set(key, [t.location, t.display_name, t.short_name, t.nickname].filter(Boolean));
    }
    if (byId.size) break;
  }
  return { byId, names };
}
function corroborates(providerName, spellings) {
  const a = String(providerName || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(x => x.length >= 3);
  const b = (spellings || []).join(' ').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(x => x.length >= 3);
  if (!a.length || !b.length) return false;
  return a.some(x => b.indexOf(x) >= 0);
}
function resolveTeam(teamId, teamName, idx) {
  const id = teamId == null ? null : String(teamId).replace(/\.0$/, '');
  if (!id || !idx.byId.has(id)) {
    return { key: null, why: id ? ('team_id ' + id + ' is not an FBS programme in EdgeDesk\u2019s roster sync')
      : 'the provider row carries no team id' };
  }
  const key = idx.byId.get(id);
  if (!corroborates(teamName, idx.names.get(key))) {
    return { key: null, why: 'team_id ' + id + ' resolves to ' + key + ', whose roster spellings share no token '
      + 'with "' + teamName + '" \u2014 refused rather than joined on an id EdgeDesk cannot corroborate' };
  }
  return { key: key, why: null };
}

async function grab(url, dest) {
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (r.status === 404) return { ok: false, why: 'not published for this season (HTTP 404)' };
  if (!r.ok) return { ok: false, why: 'HTTP ' + r.status };
  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return { ok: true, bytes: buf.length };
}

/* one season's head coach per team, keyed on the provider's team id */
function hcBySeason(rows, season) {
  const m = {};
  for (const r of rows) {
    if (num(r.season) !== season) continue;
    if (String(r.role || '').toUpperCase() !== 'HC') continue;
    const id = num(r.pos_team_id);
    if (id == null || !r.coach) continue;
    /* A TEAM WITH TWO HEAD COACHES IN ONE SEASON had an in-season change.
       The one with more games is the season's coach; the other is recorded
       so an interim cannot silently become "the coach since". */
    const g = num(r.games) || 0;
    if (!m[id] || g > m[id].games) {
      if (m[id]) m[id].also = (m[id].also || []).concat([m[id].coach]);
      m[id] = { coach: String(r.coach), games: g, team: r.pos_team || null,
        also: m[id] ? (m[id].also || []).concat([m[id].coach]) : [] };
    } else {
      m[id].also = (m[id].also || []).concat([String(r.coach)]);
    }
  }
  return m;
}

async function main() {
  const season = +(arg('season', defaultSeason()));
  const back = Math.max(2, +(arg('back', 8)));
  const check = !!arg('check', false);
  const offline = !!arg('offline', false);
  if (offline) { log('[coaching] --offline: nothing fetched'); return 0; }

  const bySeason = {}, fetched = [], missing = [];
  for (let y = season; y > season - back; y--) {
    const file = `coach_tendencies_${y}.parquet`;
    const tmp = path.join(__dirname, '.cache', file);
    const got = await grab(`${RAW}/${file}`, tmp);
    if (!got.ok) { missing.push({ season: y, why: got.why }); continue; }
    let rows;
    try { rows = parseCsv(execFileSync('python3', [PY_HELPER, tmp], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8')); }
    catch (e) { missing.push({ season: y, why: 'unreadable parquet: ' + ((e && e.message) || e) }); continue; }
    bySeason[y] = hcBySeason(rows, y);
    fetched.push(y);
  }
  if (!bySeason[season]) {
    console.error('[coaching] the ' + season + ' coach table is not published yet; nothing is written');
    return check ? 2 : 1;
  }
  const earliest = Math.min.apply(null, fetched);

  const byTeam = {}, teams = [], refused = [];
  let isNew = 0, returning = 0, unknown = 0;
  const idx = schoolIndex(season);
  const cur = bySeason[season];
  for (const id of Object.keys(cur)) {
    const who = cur[id];
    /* WALK BACK UNTIL THE NAME CHANGES. The season the tenure began is the
       first one, going backwards, still coached by the same person. */
    let since = season, sawAnyPrior = false;
    for (let y = season - 1; y >= earliest; y--) {
      const prev = bySeason[y] && bySeason[y][id];
      if (!prev) break;
      sawAnyPrior = true;
      if (prev.coach !== who.coach) break;
      since = y;
    }
    const prevSeason = bySeason[season - 1] && bySeason[season - 1][id];
    /* NO HISTORY IS UNKNOWN, NEVER CONTINUOUS. */
    const new_hc = sawAnyPrior ? (since === season) : null;
    const rec = {
      team: who.team || null,
      team_id: +id,
      hc: who.coach,
      since_season: sawAnyPrior ? since : null,
      tenure_seasons: sawAnyPrior ? (season - since + 1) : null,
      /* A TENURE THAT REACHES THE EDGE OF THE WINDOW IS A FLOOR, NOT A FACT.
         Pat Narduzzi shows "since 2019" because 2019 is as far back as this
         run read, not because he arrived then. Saying so is the difference
         between a measurement and a rounding. */
      tenure_is_floor: sawAnyPrior ? (since === earliest) : null,
      previous_hc: prevSeason ? prevSeason.coach : null,
      new_hc: new_hc,
      /* THE TWO THIS SOURCE CANNOT ANSWER. Null, never false. */
      new_oc: null,
      new_dc: null,
      known: ['hc'],
      unknown: ['oc', 'dc'],
      why_unknown: 'this feed publishes head coaches only — every row carries role HC — so coordinator '
        + 'turnover is unmeasured rather than absent',
      in_season_change: (who.also && who.also.length) ? who.also : null,
      source: `${RAW}/coach_tendencies_${season}.parquet`,
      seasons_read: fetched.slice()
    };
    const res = resolveTeam(id, who.team, idx);
    if (!res.key) { refused.push({ team: who.team, team_id: +id, why: res.why }); continue; }
    if (new_hc === true) isNew++; else if (new_hc === false) returning++; else unknown++;
    rec.key = res.key;
    byTeam[res.key] = rec;
    teams.push(rec);
  }

  const out = {
    schema: SCHEMA,
    season, generated_at: new Date().toISOString(),
    source: `${RAW}/coach_tendencies_<season>.parquet`,
    source_note: 'cfbfastR coach table, one row per team per season, derived from play-by-play. It carries HEAD '
      + 'COACHES ONLY: every row’s role is HC, so coordinator continuity is not in this feed and is published '
      + 'as unknown rather than as unchanged.',
    method: 'tenure is walked back season by season until the name changes, rather than diffed against last '
      + 'season alone — a team that fired its coach in October has an INTERIM in last season’s play-by-play, '
      + 'and diffing would report the permanent hire as a second change and a fourth-year coach as new.',
    seasons_read: fetched, seasons_missing: missing,
    counts: { teams: teams.length, new_hc: isNew, returning_hc: returning, unknown_hc: unknown,
      coordinators_known: 0, refused: refused.length },
    refused: refused,
    by_team: byTeam
  };
  if (check) { log('[coaching] --check: ' + teams.length + ' teams, ' + isNew + ' new HC, ' + returning
    + ' returning, ' + unknown + ' unknown'); return 0; }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  log('[coaching] ' + teams.length + ' teams written; ' + isNew + ' new head coach, ' + returning
    + ' returning, ' + unknown + ' with no prior season to compare; ' + refused.length + ' refused. '
    + 'Coordinators: 0 (not in this feed).');
  return 0;
}

if (require.main === module) main().then(c => process.exit(c || 0)).catch(e => {
  console.error('[coaching] ' + ((e && e.stack) || e)); process.exit(2);
});
module.exports = { hcBySeason, normKey, parseCsv, SCHEMA };
