#!/usr/bin/env node
/* ============================================================================
   THE EDGEDESK RATING — the weekly build.

   Rebuilds every FBS team's EdgeDesk Rating from the sources this repo already
   owns and already trusts, and commits the result:

     RESULTS + CARRYOVER  cfbfastR-data season schedules (public, keyless) —
                          the same files tools/collective/settle_finals.js
                          grades finished games against.
     ROSTER               football/rosters/fbs_<season>_espn.json, committed by
                          the roster sync. Returning production and portal
                          movement come from athlete-id diffs against the
                          previous season, and the LEVEL each transfer came
                          from is that program's own EdgeDesk Rating in the
                          season it was left — EdgeDesk grading itself, not a
                          recruiting service's stars.
     AVAILABILITY         football/availability/current.json, when it exists.

   No API key, no paid feed, no scraped opinion. One failed season file does
   not fail the run: the rating is built from the seasons that answered and
   says which ones did.

     node football/rating/build_rating.js [--season 2026] [--seasons 5] [--dry]
   Exit 0 = written or unchanged. Exit 1 = could not run at all.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('./edr.js');

const DIR = __dirname;
const ROSTER_DIR = path.join(DIR, '..', 'rosters');
const AVAIL = path.join(DIR, '..', 'availability', 'current.json');
const SCHED = y => `https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules/csv/cfb_schedules_${y}.csv`;
const SEASONS_BACK = 5;

function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } }
function digestOf(o) { return crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 16); }
const TRUE = v => /^(true|1|t|yes)$/i.test(String(v == null ? '' : v).trim());

/* RFC-4180-ish, same shape the settler's parser handles. */
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
  return rows.filter(r => r.length > 1).map(r => { const o = {}; head.forEach((h, i) => { o[h] = r[i] === undefined ? '' : r[i]; }); return o; });
}
function isFbs(div) { return /^fbs$/i.test(String(div || '').trim()); }
function gamesFromCsv(rows) {
  const out = [];
  for (const r of rows) {
    const hp = r.home_points === '' || r.home_points == null ? null : +r.home_points;
    const ap = r.away_points === '' || r.away_points == null ? null : +r.away_points;
    if (!isFinite(hp) || !isFinite(ap)) continue;
    if (!TRUE(r.completed)) continue;
    if (!r.home_team || !r.away_team) continue;
    out.push({
      home_team: r.home_team, away_team: r.away_team, home_points: hp, away_points: ap,
      neutral: TRUE(r.neutral_site),
      home_fbs: isFbs(r.home_division), away_fbs: isFbs(r.away_division),
      week: r.week == null || r.week === '' ? null : +r.week
    });
  }
  return out;
}

/* ---- roster: team-level aggregates from the committed datasets ---------- */
/* espn_to_bundles produces per-position-group continuity; a rating needs one
   number per team, so groups are pooled by how many players they carry. The
   level each transfer came FROM is EdgeDesk's own rating of that program in
   the season the player left — self-referential on purpose, and honest: no
   recruiting service is consulted because none publishes a usable feed. */
function rosterAggregates(details, bundles, priorRatings) {
  const out = {};
  for (const k of Object.keys(bundles || {})) {
    const b = bundles[k], d = (details || {})[k];
    let n = 0, retN = 0, tin = 0, tout = 0;
    for (const g of Object.keys((b && b.by_group) || {})) {
      const grp = b.by_group[g];
      if (!grp || !grp.n) continue;
      n += grp.n;
      if (typeof grp.returning_share === 'number') retN += grp.returning_share * grp.n;
      tin += grp.transfers_in || 0; tout += grp.transfers_out || 0;
    }
    const key = E.teamKey((d && d.team) || k);
    const agg = {
      returning_share: n > 0 ? retN / n : null,
      portal_in: tin, portal_out: tout, players: n,
      portal_in_pedigree: null, transfers_rated: 0
    };
    /* the level the incoming transfers came from, on our own scale */
    if (d && Array.isArray(d.players) && priorRatings) {
      const lv = [];
      for (const p of d.players) {
        if (p.status !== 'transfer' || !p.from) continue;
        const r = priorRatings[E.teamKey(p.from)];
        if (!r) continue;
        /* map a points rating onto 0..1 across the field's own spread */
        lv.push(E.clamp(0.5 + r.rating / 40, 0, 1));
      }
      if (lv.length) { agg.portal_in_pedigree = E.mean(lv); agg.transfers_rated = lv.length; }
    }
    out[key] = agg;
  }
  return out;
}
/* Field-wide spread, so "returning" is judged against this era rather than a
   constant chosen before the portal existed. */
function rosterOpts(aggs) {
  const rs = [], ps = [];
  for (const k of Object.keys(aggs)) {
    if (typeof aggs[k].returning_share === 'number') rs.push(aggs[k].returning_share);
    if (typeof aggs[k].portal_in === 'number' && typeof aggs[k].portal_out === 'number') ps.push(aggs[k].portal_in - aggs[k].portal_out);
  }
  return {
    mean_returning: E.mean(rs), sd_returning: E.sd(rs),
    sd_portal: E.sd(ps), field: rs.length
  };
}

/* ---- availability: high-impact absences, keyed by team ------------------ */
function availabilityByTeam(ds) {
  const out = {};
  for (const id of Object.keys((ds && ds.teams) || {})) {
    const t = ds.teams[id];
    const players = (t.players || []).filter(p => String(p.impact_level || '').toUpperCase() === 'HIGH');
    if (players.length) out[E.teamKey(t.team_name || t.team_display)] = players;
  }
  return out;
}

async function fetchText(url) {
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

function writeIfChanged(file, ds) {
  const prev = readJson(file, null);
  if (prev && prev.digest && prev.digest === ds.digest) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ds, null, 1) + '\n');
  return true;
}

/* ---- pure: everything above, assembled ---------------------------------- */
function buildDataset(seasonGames, rosters, availability, opts) {
  const notes = [];
  const seasonRatings = {}, seasonMeta = {};
  const seasons = Object.keys(seasonGames).map(Number).sort((a, b) => a - b);
  for (const s of seasons) {
    const r = E.rate(seasonGames[s]);
    seasonRatings[s] = r.ratings;
    seasonMeta[s] = { teams: r.teams, games: r.games, hfa: r.hfa, nonfbs: r.nonfbs };
  }
  const season = opts.season;
  const carryover = E.carryoverHistory(seasonRatings);
  const now = seasonRatings[season] || {};
  const priorSeasons = seasons.filter(s => s < season).sort((a, b) => b - a).slice(0, E.CARRY_SEASONS);

  /* the pedigree of a transfer is the rating of the program he left, in the
     last season that program actually played */
  const priorRatings = priorSeasons.length ? seasonRatings[priorSeasons[0]] : {};
  const aggs = rosterAggregates(rosters.details, rosters.bundles, priorRatings);
  const rOpts = rosterOpts(aggs);

  const names = {};
  for (const k of Object.keys(rosters.details || {})) {
    const d = rosters.details[k];
    if (d && d.team) names[E.teamKey(d.team)] = d.team;
  }
  for (const s of seasons) for (const k of Object.keys(seasonRatings[s])) if (!names[k]) names[k] = k;
  /* prefer the schedule's own spelling where the roster has none */
  for (const s of seasons) for (const g of seasonGames[s]) {
    const hk = E.teamKey(g.home_team), ak = E.teamKey(g.away_team);
    if (names[hk] === hk) names[hk] = g.home_team;
    if (names[ak] === ak) names[ak] = g.away_team;
  }

  const teams = E.build({
    now, seasonRatings, priorSeasons, carryover,
    bundles: aggs, rosterOpts: rOpts, availability, names
  });

  if (!carryover.pairs.length) notes.push('carryover could not be measured — only one season of results is on file');
  if (!Object.keys(aggs).length) notes.push('no roster bundles on file — the roster component is blind');
  if (!Object.keys(availability || {}).length) notes.push('no high-impact availability on file — that component is zero for every team');

  const head = {
    schema: E.SCHEMA, version: E.VERSION, season, week: opts.week == null ? null : opts.week,
    generated_at: opts.now,
    method: {
      results: 'opponent-adjusted scoring margin, margins capped at ' + E.MARGIN_CAP + ', home advantage measured from the season itself',
      carryover: 'prior seasons decayed at ' + E.CARRY_DECAY + ' and scaled by the MEASURED season-on-season slope',
      roster: 'returning production and portal movement from committed roster datasets; transfer pedigree is EdgeDesk’s own rating of the program left',
      availability: 'high-impact absences only, this week only, reversible',
      not_included: [
        'NIL spending — no public feed carries it',
        'per-player recruiting stars — absent from the public roster feed',
        'coaching and coordinator continuity — no public feed is wired',
        'anything a poll, a service or another model asserts'
      ]
    },
    carryover, season_meta: seasonMeta, roster_field: rOpts,
    seasons_used: seasons, prior_seasons_applied: priorSeasons,
    team_count: teams.length, notes
  };
  const ds = Object.assign({}, head, { teams });
  /* the digest covers everything the app reads EXCEPT the clock, so a rerun
     that changes no rating writes nothing, while a new week or a re-measured
     carryover does get written */
  ds.digest = digestOf({ teams, week: ds.week, season, carryover, notes });
  return ds;
}

async function main() {
  const args = process.argv.slice(2);
  let season = defaultSeason(), back = SEASONS_BACK, dry = false, week = null;
  for (let i = 0; i < args.length; i++) {
    const v = args[i];
    if (v === '--season') season = parseInt(args[++i], 10);
    else if (v === '--seasons') back = parseInt(args[++i], 10);
    else if (v === '--week') week = parseInt(args[++i], 10);
    else if (v === '--dry') dry = true;
  }
  const seasonGames = {}, failed = [];
  for (let s = season - back + 1; s <= season; s++) {
    try {
      const txt = await fetchText(SCHED(s));
      if (txt == null) { failed.push({ season: s, error: 'not published' }); continue; }
      const g = gamesFromCsv(parseCsv(txt));
      if (g.length) seasonGames[s] = g;
      else failed.push({ season: s, error: 'no completed games yet' });
      console.error(`[rating] ${s}: ${g.length} completed games`);
    } catch (e) {
      failed.push({ season: s, error: String(e.message).slice(0, 120) });
      console.error(`[rating] ${s}: ${e.message}`);
    }
  }
  if (!Object.keys(seasonGames).length) throw new Error('no season schedule could be read — nothing to rate');

  /* rosters: the committed datasets, through the same bundle builder the
     Power 4 talent layer reads */
  let rosters = { bundles: {}, details: {} };
  try {
    const B = require(path.join(ROSTER_DIR, 'espn_to_bundles.js'));
    let cur = readJson(path.join(ROSTER_DIR, `fbs_${season}_espn.json`), null);
    let used = season;
    if (!cur) { cur = readJson(path.join(ROSTER_DIR, `fbs_${season - 1}_espn.json`), null); used = season - 1; }
    const prev = cur ? readJson(path.join(ROSTER_DIR, `fbs_${used - 1}_espn.json`), null) : null;
    if (cur) {
      const built = B.build(cur, prev, E.teamKey);
      rosters = { bundles: built.bundles || {}, details: built.details || {} };
      console.error(`[rating] rosters: ${Object.keys(rosters.bundles).length} programs from ${used}${prev ? ' vs ' + (used - 1) : ' (no previous season — continuity unknown)'}`);
    } else console.error('[rating] rosters: none on file');
  } catch (e) { console.error('[rating] rosters: ' + e.message); }

  const availability = availabilityByTeam(readJson(AVAIL, null));
  const ds = buildDataset(seasonGames, rosters, availability, { season, week, now: new Date().toISOString() });
  ds.failed_seasons = failed;

  const top = ds.teams.slice(0, 5).map(t => `${t.rank}. ${t.team} ${t.rating > 0 ? '+' : ''}${t.rating}`).join(' · ');
  const cw = ds.carryover.weight;
  console.error(`[rating] ${ds.team_count} teams · carryover weight ${cw == null ? 'unmeasured' : cw} (${ds.carryover.note}) · ${top}`);
  if (dry) { console.log(JSON.stringify({ team_count: ds.team_count, carryover: ds.carryover, top: ds.teams.slice(0, 10) }, null, 1)); return 0; }
  const a = writeIfChanged(path.join(DIR, 'current.json'), ds);
  const b = writeIfChanged(path.join(DIR, `${season}.json`), ds);
  console.error(`[rating] ${a || b ? 'written' : 'unchanged'}`);
  return 0;
}

module.exports = { parseCsv, gamesFromCsv, rosterAggregates, rosterOpts, availabilityByTeam, buildDataset, writeIfChanged, defaultSeason, isFbs };
if (require.main === module) main().then(c => process.exit(c)).catch(e => { console.error('[rating] ' + e.message); process.exit(1); });
