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
/* the one canonical answer to "who is FBS and what conference are they in
   THIS season" — the same module the board, the coverage gate and the
   exports read, so a rating row and a board row can never disagree about a
   program's conference. */
const FBS = require('../fbs/fbs.js');

const DIR = __dirname;
const ROSTER_DIR = path.join(DIR, '..', 'rosters');
const AVAIL = path.join(DIR, '..', 'availability', 'current.json');
const SCHED = y => `https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules/csv/cfb_schedules_${y}.csv`;
const SEASONS_BACK = 5;

function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }
/* the trained universe carries the per-season Power 4 membership the grouping
   is resolved from. Optional: without it the structural default is used and
   the dataset says which basis it got. */
function p4Params() {
  try {
    global.window = global.window || global;
    require('../cfb_p4/params.js');
    return global.EDCfbP4Params || null;
  } catch (_) { return null; }
}
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
  const universe = opts.universe || null;
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

  /* ---- season conference, group and canonical identity --------------------
     EDR keys fold "&" to "and" ("Texas A&M" -> texasaandm) while the engine,
     the rankings pipeline and the schedule feed drop it ("texasam"). Those
     are both defensible and they are NOT the same string, so Texas A&M's
     rating was unreachable from every other artifact in the repo. The key
     rule is left exactly as it is — it is documented and tested — and a
     `canonical_key` is published alongside it so one team is one team across
     every join. Conference and group come from the SEASON'S OWN schedule
     feed, never a stored list, because alignment changes every winter. */
  const ix = universe ? FBS.teamIndex(universe) : null;
  let conferenced = 0, unresolved = [];
  for (const t of teams) {
    const hit = ix ? (FBS.resolveTeam(t.team, ix) || FBS.resolveTeam(t.key, ix)) : null;
    const u = hit && hit.key ? universe.teams[hit.key] : null;
    t.canonical_key = (u && u.key) || FBS.normKey(t.team) || t.key;
    t.division = u ? u.division : null;
    t.conference = u && u.conference ? u.conference.label : null;
    t.conference_id = u && u.conference ? u.conference.id : null;
    t.conference_source = u && u.conference ? u.conference.source_label : null;
    t.fbs_group = u ? u.group : null;
    if (t.conference_id) conferenced++;
    else unresolved.push(t.team);
  }
  /* rank INSIDE each group and conference, off the same connected scale —
     no subgroup is ever re-rated, it is only re-ordered */
  const groupSeen = {}, confSeen = {};
  for (const t of teams) {
    if (t.fbs_group) { groupSeen[t.fbs_group] = (groupSeen[t.fbs_group] || 0) + 1; t.group_rank = groupSeen[t.fbs_group]; }
    else t.group_rank = null;
    if (t.conference_id) { confSeen[t.conference_id] = (confSeen[t.conference_id] || 0) + 1; t.conference_rank = confSeen[t.conference_id]; }
    else t.conference_rank = null;
  }
  if (universe && unresolved.length) notes.push(unresolved.length + ' rated program'
    + (unresolved.length === 1 ? '' : 's') + ' could not be matched to the ' + season
    + ' schedule feed, so they carry no conference: ' + unresolved.slice(0, 6).join(', ')
    + '. They keep their rating and sit outside every conference view.');
  if (!universe) notes.push('the ' + season + ' schedule feed was unavailable when this was built, '
    + 'so no conference or program group is attached to any rating');

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
    /* DERIVED, every build. Nothing here is a constant: the day a program
       joins or leaves the FBS this number moves on its own. */
    team_count: teams.length,
    conference_coverage: { rated: teams.length, with_conference: conferenced,
      source: universe ? universe.source : null },
    conferences: universe ? universe.conferences : null,
    p4_scope: universe ? universe.p4 : null,
    notes
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
  let universe = null;
  for (let s = season - back + 1; s <= season; s++) {
    try {
      const txt = await fetchText(SCHED(s));
      if (txt == null) { failed.push({ season: s, error: 'not published' }); continue; }
      const rows = parseCsv(txt);
      const g = gamesFromCsv(rows);
      if (g.length) seasonGames[s] = g;
      else failed.push({ season: s, error: 'no completed games yet' });
      /* the TARGET season's own feed is what says who is FBS and in which
         conference — a historical season's alignment must never leak into
         this one's */
      if (s === season) {
        universe = FBS.buildUniverse({ rows, season: s,
          source: `cfbfastR-data schedules ${s}`, params: p4Params() });
        console.error(`[rating] ${s} universe: ${universe.counts.fbs_teams} FBS programs, `
          + `${universe.conferences.length} conferences (${universe.p4.basis})`);
      }
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
  const ds = buildDataset(seasonGames, rosters, availability, { season, week, universe, now: new Date().toISOString() });
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
