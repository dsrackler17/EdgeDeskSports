#!/usr/bin/env node
/* ============================================================================
   BUILD football/personnel/current.json — the non-QB personnel availability
   assessment for every game on the two published slates.

     node football/personnel/build_personnel.js            # dry run, prints a summary
     node football/personnel/build_personnel.js --write    # writes current.json if it changed
     node football/personnel/build_personnel.js --check    # exits 1 if the artifact is stale

   It reads only committed artifacts (the slates, the player layer, the merged
   availability view, the matchup metrics, the NFL injury report) and changes
   none of them. The assessment is published as research: every game carries
   projection_adjustment 0, and no projection reads this file.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CORE = require('./impact.js');
const AD = require('./adapters.js');
const OVERLAY = require(path.join(ROOT, 'football', 'availability', 'overlay.js'));
const OPERATOR = require(path.join(ROOT, 'football', 'availability', 'operator.js'));
const { writeIfChanged, strip } = require(path.join(ROOT, 'tools', 'football', 'write_if_changed.js'));

const OUT = path.join(__dirname, 'current.json');
const OUT_FULL = path.join(__dirname, 'current.full.json');
const SCHEMA = 'edgedesk_personnel_impact_v1';

function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } }

/* Everything the build reads, loaded once. `now` only decides which operator
   corrections are live — the same rule the board and the engine's build use. */
function loadInputs(opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const fbs = readJson(path.join(ROOT, 'football', 'fbs', 'slate.json'), null);
  const nfl = readJson(path.join(ROOT, 'football', 'nfl', 'slate.json'), null);
  const season = (fbs && fbs.season) || (nfl && nfl.season) || null;
  const metrics = readJson(path.join(ROOT, 'football', 'matchup', 'metrics.json'), null);
  const injuries = season ? readJson(path.join(ROOT, 'football', 'injuries', 'nfl_' + season + '.json'), null) : null;

  const av = readJson(path.join(ROOT, 'football', 'availability', 'current.json'), null);
  const opStore = readJson(path.join(ROOT, 'football', 'availability', 'operator.json'), null);
  const reports = [];
  const rdir = path.join(ROOT, 'football', 'availability', 'reports');
  if (fs.existsSync(rdir)) {
    for (const f of fs.readdirSync(rdir).sort()) {
      if (!/\.json$/.test(f)) continue;
      const r = readJson(path.join(rdir, f), null);
      if (r && r.schema === 'edgedesk_availability_report_v1') reports.push(r);
    }
  }
  const merged = OVERLAY.build({ current: av, operator: OPERATOR.load(opStore || { entries: [] }, now),
    reports, now, normKey: AD.normKey });
  const availByTeam = {};
  Object.keys(merged.teams).forEach(function (id) {
    const t = merged.teams[id];
    const k = AD.normKey(t.team_name || t.team_display);
    if (k) availByTeam[k] = t;
  });

  const teamFiles = {};
  const tdir = path.join(ROOT, 'football', 'players', 'teams');
  function teamFile(key) {
    if (!key) return null;
    if (Object.prototype.hasOwnProperty.call(teamFiles, key)) return teamFiles[key];
    const f = path.join(tdir, key + '.json');
    teamFiles[key] = fs.existsSync(f) ? readJson(f, null) : null;
    return teamFiles[key];
  }

  return { now, season, fbs, nfl, metrics, injuries, av, merged, availByTeam, teamFile, reports_on_file: reports.length };
}

function cfbGame(inp, g) {
  function side(which) {
    const other = which === 'home' ? 'away' : 'home';
    const name = g[which + '_team'], key = g[which + '_team_id'];
    return AD.cfbTeam({
      game: g, side: which, teamName: name, teamKey: key,
      oppName: g[other + '_team'], oppKey: g[other + '_team_id'],
      availTeam: inp.availByTeam[AD.normKey(name)] || inp.availByTeam[AD.normKey(key)] || null,
      overlay: OVERLAY,
      teamFile: inp.teamFile(key),
      metricsOpp: inp.metrics && inp.metrics.teams ? inp.metrics.teams[g[other + '_team_id']] || null : null
    });
  }
  return CORE.assessGame({ game_id: g.game_id, sport: 'cfb', season: g.season, week: g.week, kickoff: g.kickoff,
    home: side('home'), away: side('away') });
}

function nflGame(inp, g) {
  function side(which) {
    const other = which === 'home' ? 'away' : 'home';
    return AD.nflTeam({ game: g, side: which, code: g[which + '_code'], teamName: g[which + '_team'],
      oppCode: g[other + '_code'], oppName: g[other + '_team'], injuries: inp.injuries });
  }
  return CORE.assessGame({ game_id: g.game_id, sport: 'nfl', season: g.season, week: g.week, kickoff: g.kickoff,
    home: side('home'), away: side('away') });
}

/* The newest input time an assessment could have seen. The freeze refuses a
   record whose inputs were observed at or after kickoff. */
function inputsAsOf(inp) {
  const ts = [];
  function add(t) { const v = Date.parse(t || ''); if (isFinite(v)) ts.push(v); }
  add(inp.av && inp.av.generated_at);
  add(inp.metrics && inp.metrics.generated_at);
  add(inp.injuries && inp.injuries.retrieved_at);
  add(inp.fbs && inp.fbs.generated_at);
  add(inp.nfl && inp.nfl.generated_at);
  Object.keys(inp.merged.teams).forEach(function (k) { add(inp.merged.teams[k].observed_at); });
  return ts.length ? new Date(Math.max.apply(null, ts)).toISOString() : null;
}

function build(opts) {
  opts = opts || {};
  const inp = opts.inputs || loadInputs(opts);
  const games = {};
  const counts = { games: 0, cfb: 0, nfl: 0, teams_assessed: 0, teams_not_assessable: 0,
    absences_rated: 0, absences_unrated: 0 };
  const asOf = inputsAsOf(inp);

  function add(a) {
    a.as_of = asOf;
    games[a.game_id] = a;
    counts.games++; counts[a.sport]++;
    [a.home, a.away].forEach(function (t) {
      if (t.status === 'NOT_ASSESSABLE') counts.teams_not_assessable++; else counts.teams_assessed++;
      counts.absences_rated += t.absences.length;
      counts.absences_unrated += t.unrated.length;
    });
  }
  ((inp.fbs && inp.fbs.games) || []).slice().sort(function (a, b) {
    return String(a.game_id).localeCompare(String(b.game_id));
  }).forEach(function (g) { add(cfbGame(inp, g)); });
  ((inp.nfl && inp.nfl.games) || []).slice().sort(function (a, b) {
    return String(a.game_id).localeCompare(String(b.game_id));
  }).forEach(function (g) { add(nflGame(inp, g)); });

  const C = CORE.config;
  return {
    schema: SCHEMA,
    version: 1,
    config_version: C.VERSION,
    season: inp.season,
    generated_at: new Date(inp.now).toISOString(),
    inputs_as_of: asOf,
    projection: { adjustment_points: CORE.projectionAdjustment(), status: C.PROJECTION.status,
      coefficient_trained: false, statement: C.PROJECTION.statement, basis: C.PROJECTION.basis },
    sources: {
      cfb_slate: inp.fbs ? { path: 'football/fbs/slate.json', generated_at: inp.fbs.generated_at } : null,
      nfl_slate: inp.nfl ? { path: 'football/nfl/slate.json', generated_at: inp.nfl.generated_at } : null,
      availability: { path: 'football/availability/current.json + reports/ + operator.json (merged at read time)',
        generated_at: inp.av ? inp.av.generated_at : null, reports_on_file: inp.reports_on_file },
      player_quality: { path: 'football/players/teams/<key>.json', scale: 'EPIR' },
      matchup: inp.metrics ? { path: 'football/matchup/metrics.json', generated_at: inp.metrics.generated_at } : null,
      nfl_injuries: inp.injuries ? { path: 'football/injuries/nfl_' + inp.season + '.json',
        retrieved_at: inp.injuries.retrieved_at, latest_week: inp.injuries.latest_week } : null
    },
    counts: counts,
    notes: [
      'Injury impact is a 0-100 measurement, not points. Every game carries projection_adjustment 0.',
      'College player quality is EPIR where production was measured; a rating with no measured production is not used as quality.',
      'College usage is EdgeDesk’s participation estimate (appearances + touch share), not a snap share.',
      'NFL absences are listed unrated: no NFL player-quality, snap or depth feed is wired in.',
      'Quarterbacks are excluded: the trained QB layer prices them.'
    ],
    games: games
  };
}

/* THE LEAN VIEW the board and the desk load. Every number that makes up the
   score is kept; the long-form evidence (each matchup driver, the confidence
   components, identity and source detail) stays in current.full.json, the
   file the freeze and the audit read. Same pattern as the availability layer. */
const LEAN_ABSENCE = ['player_id', 'player_name', 'label', 'position', 'slot', 'unit', 'unit_label',
  'depth_rank', 'injury_status', 'status_label', 'probability_of_absence', 'player_quality',
  'replacement_player_id', 'replacement_player_name', 'replacement_quality', 'replacement_confidence',
  'replacement_gap', 'gap_basis', 'gap_sd', 'usage_factor', 'usage_basis', 'position_leverage',
  'matchup_leverage', 'unit_concentration_multiplier', 'raw_injury_impact', 'impact_if_absent',
  'classification', 'expected_impact', 'confidence', 'rated', 'missing', 'drivers_text',
  'projection_adjustment'];
const LEAN_TEAM_DROP = { absences: 1, unrated: 1, inputs: 1, duplicates: 1, cleared: 1 };

function leanAbsence(a) {
  const o = {};
  LEAN_ABSENCE.forEach(function (k) { o[k] = a[k] === undefined ? null : a[k]; });
  o.source = a.source ? { name: a.source.name, tier: a.source.tier } : null;
  const md = (a.matchup_drivers || [])[0];
  o.matchup_driver = md ? { metric: md.metric, label: md.label || null, z: md.z == null ? null : Math.round(md.z * 10) / 10 } : null;
  return o;
}
function leanTeam(t) {
  const o = {};
  Object.keys(t).forEach(function (k) { if (!LEAN_TEAM_DROP[k]) o[k] = t[k]; });
  o.absences = t.absences.map(leanAbsence);
  o.unrated = t.unrated.map(leanAbsence);
  o.cleared_count = t.cleared.length;
  return o;
}
function lean(full) {
  const o = {};
  Object.keys(full).forEach(function (k) { if (k !== 'games') o[k] = full[k]; });
  o.full_evidence = 'football/personnel/current.full.json';
  o.games = {};
  Object.keys(full.games).forEach(function (id) {
    const g = full.games[id], c = {};
    Object.keys(g).forEach(function (k) { c[k] = g[k]; });
    c.home = leanTeam(g.home); c.away = leanTeam(g.away);
    o.games[id] = c;
  });
  return o;
}

function main() {
  const args = process.argv.slice(2);
  const write = args.indexOf('--write') >= 0, check = args.indexOf('--check') >= 0;
  const nowArg = args.indexOf('--now') >= 0 ? Date.parse(args[args.indexOf('--now') + 1]) : null;
  const out = build({ now: isFinite(nowArg) ? nowArg : Date.now() });
  const c = out.counts;
  console.log('personnel: ' + c.games + ' games (' + c.cfb + ' CFB, ' + c.nfl + ' NFL); '
    + c.teams_assessed + ' team sides assessed, ' + c.teams_not_assessable + ' not assessable; '
    + c.absences_rated + ' absences rated, ' + c.absences_unrated + ' unrated; projection adjustment '
    + out.projection.adjustment_points);
  const leanOut = lean(out);
  if (check) {
    const prev = readJson(OUT, null), prevFull = readJson(OUT_FULL, null);
    const same = prev && prevFull && JSON.stringify(strip(prev)) === JSON.stringify(strip(leanOut))
      && JSON.stringify(strip(prevFull)) === JSON.stringify(strip(out));
    console.log(same ? 'current.json is up to date' : 'current.json is STALE — run with --write');
    process.exit(same ? 0 : 1);
  }
  if (write) {
    console.log(OUT_FULL + ': ' + writeIfChanged(OUT_FULL, out));
    console.log(OUT + ': ' + writeIfChanged(OUT, leanOut));
  }
}

if (require.main === module) main();

module.exports = { build, lean, loadInputs, cfbGame, nflGame, SCHEMA, OUT, OUT_FULL };
