#!/usr/bin/env node
/* ============================================================================
   EdgeDesk Football — NFL injury report sync (nflverse, public, keyless).

   Writes football/injuries/nfl_<season>.json: the league's official injury
   report as nflverse publishes it (injuries_<season>.csv), reduced to the
   LATEST reported week per team, so the app can say who is Out, Doubtful,
   Questionable, or held out of practice — instead of "not on file".

   Honesty rules, same as the rest of this repo:
     * Nothing is inferred. A team with no rows for the latest week is
       carried as "no report filed yet", never as clean.
     * A season nflverse has not published yet is recorded as unpublished
       (published:false) and the app keeps saying the report is not on
       file. Last season's report is never shown as this season's.
     * The file is rewritten only when the rows changed, so the daily job
       commits nothing on a quiet day.
     * The run FAILS rather than committing a wrong-shaped dataset: a
       published season with fewer than 20 teams or under 100 rows.

   THE OBSERVATION LEDGER (football/injuries/history/nfl_<season>.jsonl).
   nflverse's file carries no per-row publication time, so a designation can
   be dated only by when EdgeDesk first saw it. Each run appends one row per
   game designation (Out, Doubtful, Questionable) that is new or changed
   since the ledger's last row for that player-week, stamped with this run's
   retrieval time (observed_at). It is append-only: a row is never rewritten.
     * The first run on a season writes what is already listed as a baseline
       (baseline: true). EdgeDesk did not see those change, so nothing reads
       them as news.
     * A designation that disappears is not recorded: an empty game status
       is not a clearance.
     * observed_at is EdgeDesk's time, never the league's: Signal Center
       prints it as "first seen by EdgeDesk".

   Run by .github/workflows/injury-sync.yml (full network).
     node football/injuries/fetch_injuries.js [--season 2026] [--out dir]
   Exit 0 = dataset written or unchanged; exit 1 = fetch failed hard.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = 'edgedesk_nfl_injuries_v1';
const URL = s => `https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_${s}.csv`;

function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }

/* RFC-4180-ish: quoted fields, doubled quotes, CRLF. */
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== '')).map(r => { const o = {}; head.forEach((h, i) => { o[h] = r[i] === undefined ? '' : r[i]; }); return o; });
}
const clean = s => String(s == null ? '' : s).trim();
/* nflverse team codes as the app spells them (LA for the Rams is already the app's own code). */
const CODE_ALIAS = { LAR: 'LA', SD: 'LAC', OAK: 'LV', STL: 'LA', WSH: 'WAS', JAC: 'JAX' };
function teamCode(t) { t = clean(t).toUpperCase(); return CODE_ALIAS[t] || t; }

/* Reduce the season's rows to the latest reported week per team. */
function build(rows, season, retrievedAt) {
  const reg = rows.filter(r => /^(REG|POST)$/i.test(clean(r.game_type || r.season_type)) && clean(r.team));
  const byTeam = {};
  reg.forEach(r => {
    const code = teamCode(r.team); const wk = parseInt(r.week, 10);
    if (!code || !isFinite(wk)) return;
    (byTeam[code] = byTeam[code] || {}); (byTeam[code][wk] = byTeam[code][wk] || []).push(r);
  });
  const latestWeek = reg.reduce((m, r) => Math.max(m, parseInt(r.week, 10) || 0), 0);
  const teams = {};
  Object.keys(byTeam).sort().forEach(code => {
    const weeks = Object.keys(byTeam[code]).map(Number).sort((a, b) => b - a);
    const wk = weeks[0];
    const players = byTeam[code][wk].map(r => ({
      gsis_id: clean(r.gsis_id) || null, name: clean(r.full_name) || (clean(r.first_name) + ' ' + clean(r.last_name)).trim(),
      position: clean(r.position) || null,
      status: clean(r.report_status) || null,                 /* Out / Doubtful / Questionable, or empty */
      injury: clean(r.report_primary_injury) || clean(r.practice_primary_injury) || null,
      secondary: clean(r.report_secondary_injury) || null,
      practice: clean(r.practice_status) || null,               /* Did Not Participate / Limited / Full */
      practice_injury: clean(r.practice_primary_injury) || null,
    })).filter(p => p.name).sort((a, b) => statusRank(b.status, b.practice) - statusRank(a.status, a.practice) || a.name.localeCompare(b.name));
    teams[code] = { week: wk, game_type: clean(byTeam[code][wk][0].game_type || byTeam[code][wk][0].season_type) || null, players };
  });
  const digest = crypto.createHash('sha1').update(JSON.stringify(teams)).digest('hex').slice(0, 16);
  return { schema: SCHEMA, source: 'nflverse-data injuries_' + season + '.csv (public, keyless)', requested_season: season, season, published: true,
    retrieved_at: retrievedAt, latest_week: latestWeek, rows: reg.length, team_count: Object.keys(teams).length, digest, teams };
}
function statusRank(status, practice) {
  const s = clean(status).toLowerCase(), p = clean(practice).toLowerCase();
  if (s === 'out') return 5; if (s === 'doubtful') return 4; if (s === 'questionable') return 3;
  if (/did not/.test(p)) return 2; if (/limited/.test(p)) return 1; return 0;
}
function unpublished(season, retrievedAt, why) {
  return { schema: SCHEMA, source: 'nflverse-data injuries_' + season + '.csv (public, keyless)', requested_season: season, season: null, published: false,
    retrieved_at: retrievedAt, reason: why, latest_week: null, rows: 0, team_count: 0, digest: 'unpublished', teams: {} };
}
function validate(ds) {
  if (!ds.published) return;
  if (ds.team_count < 20) throw new Error(`published season but only ${ds.team_count} teams — refusing to commit a hollow report`);
  if (ds.rows < 100) throw new Error(`published season but only ${ds.rows} rows — refusing to commit a hollow report`);
}
/* Rewrite only on a real change: the digest covers the rows, not the clock. */
function writeIfChanged(file, ds) {
  try { const prev = JSON.parse(fs.readFileSync(file, 'utf8')); if (prev && prev.digest === ds.digest && prev.published === ds.published) return false; } catch (_) {}
  fs.writeFileSync(file, JSON.stringify(ds, null, 1) + '\n');
  return true;
}
const OBS_SCHEMA = 'edgedesk_nfl_injury_observation_v1';
const DESIGNATIONS = { out: 'Out', doubtful: 'Doubtful', questionable: 'Questionable' };
function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch (e) { throw new Error(path.basename(file) + ' line ' + (i + 1) + ' does not parse: the ledger is append-only, so it is never rewritten to repair it'); }
  });
}
/* the rows to append: each designation new or changed since the ledger's last row for its player-week */
function observations(ledger, ds, observedAt) {
  if (!ds || !ds.published) return [];
  const last = new Map();
  (ledger || []).forEach((r) => { if (r && r.schema === OBS_SCHEMA && r.key) last.set(r.key, r); });
  const baseline = !(ledger || []).some((r) => r && r.schema === OBS_SCHEMA);
  const out = [];
  Object.keys(ds.teams).sort().forEach((team) => {
    const t = ds.teams[team];
    (t.players || []).forEach((p) => {
      const status = DESIGNATIONS[clean(p.status).toLowerCase()];
      if (!status) return;
      const key = ds.season + '|' + t.week + '|' + team + '|' + (p.gsis_id || p.name.toLowerCase());
      const prev = last.get(key);
      if (prev && prev.status === status) return;
      out.push({ schema: OBS_SCHEMA, key, season: ds.season, week: t.week, game_type: t.game_type || null, team, gsis_id: p.gsis_id || null, name: p.name, position: p.position || null,
        status, injury: p.injury || null, previous_status: prev ? prev.status : null, observed_at: observedAt, baseline, source: ds.source });
    });
  });
  return out;
}
function appendObservations(file, rows) {
  if (!rows.length) return 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return rows.length;
}
async function fetchText(url) {
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}
async function main() {
  const args = process.argv.slice(2);
  let season = defaultSeason(), out = __dirname;
  for (let i = 0; i < args.length; i++) { if (args[i] === '--season') season = parseInt(args[++i], 10); else if (args[i] === '--out') out = args[++i]; }
  const now = new Date().toISOString();
  const text = await fetchText(URL(season));
  const ds = text == null ? unpublished(season, now, 'nflverse has not published injuries_' + season + '.csv yet') : build(parseCsv(text), season, now);
  validate(ds);
  const file = path.join(out, `nfl_${season}.json`);
  const changed = writeIfChanged(file, ds);
  console.log(`[injuries] ${season}: ${ds.published ? ds.team_count + ' teams · latest week ' + ds.latest_week + ' · ' + ds.rows + ' rows' : 'not published yet'} · ${changed ? 'written' : 'unchanged'} → ${path.relative(process.cwd(), file)}`);
  const ledgerFile = path.join(out, 'history', `nfl_${season}.jsonl`);
  const obs = observations(readLedger(ledgerFile), ds, now);
  appendObservations(ledgerFile, obs);
  console.log(`[injuries] ${season}: ${obs.length} designation(s) observed${obs.length && obs[0].baseline ? ' (baseline: already listed when the ledger began)' : ''} → ${path.relative(process.cwd(), ledgerFile)}`);
  return 0;
}
module.exports = { parseCsv, build, unpublished, validate, statusRank, teamCode, writeIfChanged, defaultSeason, observations, readLedger, appendObservations, SCHEMA, OBS_SCHEMA };
if (require.main === module) main().then(c => process.exit(c)).catch(e => { console.error('[injuries] ' + e.message); process.exit(1); });
