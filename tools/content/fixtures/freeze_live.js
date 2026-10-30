#!/usr/bin/env node
'use strict';
/* ===========================================================================
   FREEZE the research tools/content/evidence.test.js reads from "today" on a
   pull request (sections S 3c and L live), as a HISTORICAL TEST FIXTURE
   (tools/content/fixtures/research_2026_w9.json.gz, read by
   ART.frozen(ART.PINNED) in tools/content/artifacts.js).

   Section L drafts every article the engine would offer from the committed
   research and requires each to pass the editorial gate; S 3c requires every
   claim the evidence builder makes to cite only numbers its own text prints.
   Read live, both moved with the hourly data and the clock: L went red on main
   with no code change (1c3b5c07a, c933dc468, and Week 9 on 2026-10-29). A pull
   request now reads this snapshot at its own moment; `evidence.test.js --live`
   still reads today's research, from the daily sweep
   (.github/workflows/content-engine-live.yml).

   The snapshot is the research main held at ca6f867a0 (2026-10-29 20:14 UTC),
   read at that moment: the last time the live gate caught the writer out. Its
   own code BLOCKED two Week 9 articles there (the upset-watch preview,
   injuries_addressed; Utah–Cincinnati, numbers_in_evidence) until 05ad9abef
   and 64143ada2 repaired the writer and the evidence builder.

   It keeps the INPUTS, not the outputs, so the pin tests the code of the day:
     files              the files ART.load() reads (CE.ARTIFACTS), the facts
                        ledger and the season's market snapshots, two of them
                        trimmed (below)
     evidence_inputs    for each game of the week, what cfbInputs() and
                        nflInputs() in tools/content/evidence.js gathered at AT
                        (what every game of a league shares, once), and the
                        committed packet's hashes; ART.fromFiles() builds the
                        packets from them with evidence.js buildFrom(), at AT
   and checks that what the test reads from the fixture (the evidence set, the
   research, the opportunities, every drafted article and every gate verdict)
   is byte for byte what it reads from the full files at AT:

     football/cfb_terminal/games.json   this week's games keep every key
                                        section L reads; other weeks' keep
                                        their season, week and teams (the
                                        league's team list)
     football/rankings/current.json     each team's name, conference, rank,
                                        rating and rank movement
     football/evidence/packets.json     not copied: built from evidence_inputs
     evidence_inputs (CFB)              the rankings each game carries, its
                                        terminal game and its first-party
                                        record (and that record's research)
                                        keep every key some packet reads (the
                                        set built from them is the one
                                        ART.load() built)
     football/content/packets.json      not copied: section L reads none

   Build it from the data at COMMIT and the code being tested:

     git worktree add --detach /tmp/w9 ca6f867a06f
     git -C /tmp/w9 checkout <this branch> -- lib tools/content
     node tools/content/fixtures/freeze_live.js --root /tmp/w9
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, 'research_2026_w9.json.gz');
const COMMIT = 'ca6f867a06ffc993e99fabca32494584f87a865e';
const AT = '2026-10-29T20:14:42.000Z';
const FACTS = 'football/evidence/facts.json';
const RANKING_KEYS = ['team', 'conference', 'rank', 'etsr'];

function arg(name, d) { const i = process.argv.indexOf('--' + name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
const clone = (x) => JSON.parse(JSON.stringify(x));

/* what evidence.test.js reads at `now`: the evidence set, the research, the
   opportunities, and every drafted article with the gate's verdict (as
   section L drafts them) */
function sectionL(CE, ART, art, now) {
  const a0 = Object.assign({}, art, { packets: null });
  const snap = CE.research.fromArtifacts(a0, { now });
  const SR = CE.PUBLISHER_TEMPLATES['stadium-rant'];
  const opps = CE.discover(snap, { now, publisher: SR });
  const drafts = [];
  opps.forEach((o) => o.formats.filter((f) => f !== 'publisher_custom').forEach((f) => {
    const pub = f === 'edgedesk_analysis' ? null : SR;
    const a = CE.draft(o, { publisher: pub, format: f, now });
    const r = CE.validate(a, o, { publisher: pub, now, teamLists: ART.teamLists(a0) });
    drafts.push({ key: o.key + '/' + f, article: a, ok: r.ok, failed: r.failed, readiness: r.readiness });
  }));
  return JSON.stringify({ evidence: art.evidence, snap, opps, drafts });
}

/* the evidence builder's inputs for each game of the week ART.load() built */
function evidenceInputs(EV, root, set, now) {
  const S = EV.sources();
  const committed = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, EV.PATHS.out), 'utf8')); } catch (e) { return null; } })();
  const out = { inputs: clone(set.inputs), cfb: null, nfl: null };
  ['cfb', 'nfl'].forEach((league) => {
    const L = set[league];
    if (!L) return;
    const ids = Object.keys(L.packets), xs = {};
    let keys = null;
    ids.forEach((id) => {
      const g = league === 'cfb' ? Object.values(S.terminal.games).find((x) => String(x.game_id) === id) : S.nflSlate.games.find((x) => String(x.game_id) === id);
      const x = league === 'cfb' ? EV.cfbInputs(g, { now }) : EV.nflInputs(g, { now });
      keys = keys || Object.keys(x);
      xs[id] = clone(x);
    });
    const shared = {};
    keys.forEach((k) => { const v = JSON.stringify(xs[ids[0]][k]); if (v !== undefined && ids.every((id) => JSON.stringify(xs[id][k]) === v)) shared[k] = xs[ids[0]][k]; });
    const prev = (committed && committed[league] && committed[league].packets) || {};
    const games = {};
    ids.forEach((id) => {
      const inputs = {};
      keys.forEach((k) => { if (!(k in shared) && xs[id][k] !== undefined) inputs[k] = xs[id][k]; });
      games[id] = { inputs, previous: prev[id] ? { inputs_hash: prev[id].inputs_hash, hash: prev[id].hash, built_at: prev[id].built_at } : null };
    });
    out[league] = { season: L.season, week: L.week, keys, shared, games };
  });
  return out;
}

/* drop, one key at a time across `rows`, what `same()` does not change without */
function trimRows(rows, same) {
  rows = rows.filter((r) => r && typeof r === 'object');
  const size = (k) => rows.reduce((n, r) => n + (JSON.stringify(r[k]) || '').length, 0);
  const keys = [...new Set([].concat(...rows.map((r) => Object.keys(r))))].sort((x, y) => size(y) - size(x));
  const dropped = [];
  keys.forEach((key) => {
    const kept = rows.map((r) => r[key]);
    rows.forEach((r) => { delete r[key]; });
    if (same()) dropped.push(key);
    else rows.forEach((r, i) => { if (kept[i] !== undefined) r[key] = kept[i]; });
  });
  return { dropped, of: keys.length };
}

function main() {
  const root = path.resolve(arg('root', path.join(__dirname, '..', '..', '..')));
  const CE = require(path.join(root, 'lib', 'content_engine.js'));
  const ART = require(path.join(root, 'tools', 'content', 'artifacts.js'));
  const EV = require(path.join(root, 'tools', 'content', 'evidence.js'));
  const A = CE.ARTIFACTS;
  const now = Date.parse(AT);
  const art = ART.load({ now });
  const want = sectionL(CE, ART, art, now);
  const week = art.cfbBrief.week, season = art.nflSlate.season;

  /* the rankings: what the research reads of each team */
  const rankings = { schema: art.rankings.schema, season: art.rankings.season, week: art.rankings.week, data_as_of: art.rankings.data_as_of, generated_at: art.rankings.generated_at, teams: {} };
  Object.keys(art.rankings.teams).forEach((k) => { const t = art.rankings.teams[k]; if (!t) return;
    const row = {}; RANKING_KEYS.forEach((x) => { if (t[x] !== undefined) row[x] = t[x]; });
    if (t.movement && t.movement.rank) row.movement = { rank: t.movement.rank };
    rankings.teams[k] = row; });
  /* the terminal: other weeks name their teams; this week's games drop, one
     key at a time, only what section L does not change without */
  const games = clone(art.cfbGames);
  Object.keys(games.games).forEach((k) => { const g = games.games[k]; if (g.week !== week) games.games[k] = { season: g.season, week: g.week, game: { home: g.game.home, away: g.game.away } }; });
  const trial = Object.assign({}, art, { rankings, cfbGames: games });
  if (sectionL(CE, ART, trial, now) !== want) throw new Error('the trimmed rankings or the other weeks change what section L reads');
  const ours = Object.keys(games.games).filter((k) => games.games[k].week === week);
  const keys = [...new Set([].concat(...ours.map((k) => Object.keys(games.games[k]))))]
    .sort((x, y) => ours.reduce((n, k) => n + JSON.stringify(games.games[k][y] || '').length, 0) - ours.reduce((n, k) => n + JSON.stringify(games.games[k][x] || '').length, 0));
  const dropped = [];
  keys.forEach((key) => {
    const kept = ours.map((k) => games.games[k][key]);
    ours.forEach((k) => { delete games.games[k][key]; });
    if (sectionL(CE, ART, trial, now) === want) dropped.push(key);
    else ours.forEach((k, i) => { if (kept[i] !== undefined) games.games[k][key] = kept[i]; });
  });
  if (sectionL(CE, ART, trial, now) !== want) throw new Error('the trimmed terminal changes what section L reads');

  const files = {};
  files[A.cfb_games] = games;
  files[A.cfb_brief] = art.cfbBrief;
  files[A.rankings] = rankings;
  files[A.nfl_slate] = art.nflSlate;
  files[A.nfl_injuries] = art.nflInjuries;
  files[A.published] = art.published;
  files[A.performance] = art.performance;
  if (A.perf_weekly) files[A.perf_weekly] = art.perfWeekly;
  files[A.forecasts] = art.forecasts;
  ['cfb', 'nfl'].forEach((lg) => { files[A.record.replace('{league}', lg).replace('{season}', season)] = art.records[lg]; });
  const mdir = path.dirname(A.market);
  fs.readdirSync(path.join(root, mdir)).filter((f) => new RegExp('^' + season + '-week-\\d+\\.json$').test(f)).sort()
    .forEach((f) => { files[mdir + '/' + f] = JSON.parse(fs.readFileSync(path.join(root, mdir, f), 'utf8')); });
  files[FACTS] = JSON.parse(fs.readFileSync(path.join(root, FACTS), 'utf8'));
  Object.keys(files).forEach((f) => { if (files[f] == null) delete files[f]; });

  /* the builder's inputs: the rankings each game carries, its terminal game
     and its first-party record drop, one key at a time, only what no packet
     changes without (the evidence set built from them is the one ART.load()
     built) */
  const evidence_inputs = evidenceInputs(EV, root, art.evidence, now);
  const wantSet = JSON.stringify(art.evidence);
  const same = () => JSON.stringify(EV.buildFrom(evidence_inputs, { now })) === wantSet;
  if (!same()) throw new Error('the evidence inputs, built again, are not the evidence set ART.load() built');
  const C = evidence_inputs.cfb, cfbGames = C ? Object.values(C.games).map((g) => g.inputs) : [];
  const trimmedInputs = C ? {
    'rankings (each team)': trimRows(Object.values((C.shared.rankings || {}).teams || {}), same),
    'game': trimRows(cfbGames.map((x) => x.game), same),
    'record': trimRows(cfbGames.map((x) => x.record), same),
    'record research': trimRows(cfbGames.map((x) => x.record && x.record.research), same)
  } : {};
  if (!same()) throw new Error('the trimmed evidence inputs change the evidence set');

  const doc = {
    schema: 'edgedesk_research_fixture_v1',
    kind: 'HISTORICAL TEST FIXTURE — the research EdgeDesk committed at ca6f867a0 (CFB Week ' + week + ', NFL ' + season + '), read at 20:14 UTC on October 29, 2026. Never publishable; its dates are never reused for live publishing.',
    frozen_at: new Date().toISOString(), commit: COMMIT, at: AT, season, cfb_week: week,
    trimmed: { [A.cfb_games]: 'Week ' + week + ' games without ' + dropped.join(', ') + '; other weeks: season, week and teams only', [A.rankings]: 'each team’s ' + RANKING_KEYS.join(', ') + ' and rank movement',
      [A.evidence]: 'not copied: built by tools/content/evidence.js buildFrom() from evidence_inputs at ' + AT,
      evidence_inputs: Object.keys(trimmedInputs).map((k) => 'CFB ' + k + ' without ' + trimmedInputs[k].dropped.length + ' of ' + trimmedInputs[k].of + ' keys (' + trimmedInputs[k].dropped.join(', ') + ')').join('; ') },
    files,
    evidence_inputs
  };
  /* the fixture read back the way evidence.test.js reads it (ART.fromFiles,
     which builds the packets) is what it read from the full files */
  if (sectionL(CE, ART, ART.fromFiles(clone(doc)), now) !== want) throw new Error('the fixture, read back, changes what section L reads');
  fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify(doc), { level: 9 }));
  const n = (lg) => Object.keys(doc.evidence_inputs[lg] ? doc.evidence_inputs[lg].games : {}).length;
  console.log('wrote ' + path.relative(path.join(__dirname, '..', '..', '..'), OUT) + ' (' + fs.statSync(OUT).size + ' bytes): ' + Object.keys(files).length + ' files and the evidence inputs of '
    + n('cfb') + ' CFB and ' + n('nfl') + ' NFL games; Week ' + week + ' games without ' + dropped.length + ' of ' + keys.length + ' keys; at ' + AT);
}
if (require.main === module) main();
module.exports = { OUT, COMMIT, AT, FACTS };
