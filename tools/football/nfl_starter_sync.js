#!/usr/bin/env node
/* ============================================================================
   THE NFL STARTER SYNC (football/nfl/starter_sync.js, docs/nfl-prior-decay/README.md §2)

   The quarterback the card prices is decided at slate build time from the
   schedule feed, the depth chart and the injury report. This job recomputes,
   from the committed inputs, the fingerprint of everything that decides each
   UPCOMING game's starter and compares it with the one the slate was built on.
   When any of them moved (an OUT on Friday's report, a new QB1 on the depth
   chart, the feed re-filling a game), it rebuilds football/nfl/slate.json now,
   instead of waiting for the next scheduled build, and appends every
   priced-starter change to football/nfl/starter_sync/nfl_<season>.jsonl, each
   with the number before and after. The game cards are rebuilt from the new
   slate by the job that owns football/game_research/ (cfb-lab.yml, which the
   workflow dispatches when this job rebuilt).

   It never chooses a starter itself: the slate build has the one rule
   (tools/football/build_nfl_slate.js reconcileQb / starterOf, app.html
   fbNflReconcileStarters), so the sync and the card cannot disagree on who
   starts.

   Usage
     node tools/football/nfl_starter_sync.js                  # detect; rebuild and log on a change
     node tools/football/nfl_starter_sync.js --check          # detect only: exit 1 when a rebuild is due
     node tools/football/nfl_starter_sync.js --record --prev <slate.json>
                                                              # log the starter changes between an earlier
                                                              # slate and the current one (a scheduled build)
   Exit 0 = nothing moved, or rebuilt and logged; 1 = --check found a rebuild due;
   3 = the rebuild failed (the previous slate stands).
   In GitHub Actions it writes rebuilt=true|false to $GITHUB_OUTPUT.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const SYNC = require(path.join(ROOT, 'football', 'nfl', 'starter_sync.js'));
const FEEDS = require('./fetch_nfl_feeds.js');
const { parseCsv } = require(path.join(ROOT, 'football', 'nfl', 'build_team_week.js'));

const SLATE = path.join(ROOT, 'football', 'nfl', 'slate.json');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const ledgerFile = (season) => path.join(ROOT, 'football', 'nfl', 'starter_sync', 'nfl_' + season + '.jsonl');

async function gamesCsv(offline) {
  const url = FEEDS.FEEDS(new Date().getUTCFullYear())[0], p = FEEDS.key(url);
  if (!offline) {
    try { const r = await fetch(url, { redirect: 'follow' }); if (r.ok) { const t = await r.text(); if (t.length > 100) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); return t; } } }
    catch (_) { /* the cached copy below */ }
  }
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  throw new Error('games.csv is neither reachable nor cached');
}

/* the current fingerprints of every upcoming game in the slate */
function currentInputs(slate, feedRows, startersFile, injuries, now) {
  const feed = {}; (feedRows || []).forEach((r) => { feed[r.game_id] = r; });
  const out = {};
  ((slate && slate.games) || []).forEach((g) => {
    const k = Date.parse(g.kickoff);
    if (Number.isFinite(k) && k <= now) return;                /* kicked off: its card is frozen */
    const f = feed[g.game_id]; if (!f) return;
    out[g.game_id] = { home: SYNC.sideInputs(g.home_code, f.home_qb_id || null, startersFile, injuries),
      away: SYNC.sideInputs(g.away_code, f.away_qb_id || null, startersFile, injuries) };
  });
  return out;
}

function appendLedger(season, rows) {
  if (!rows.length) return 0;
  const f = ledgerFile(season);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return rows.length;
}
function output(k, v) { if (process.env.GITHUB_OUTPUT) { try { fs.appendFileSync(process.env.GITHUB_OUTPUT, k + '=' + v + '\n'); } catch (_) { /* local run */ } } }
function say(changes) {
  changes.forEach((c) => console.log(`  ${c.game_id} ${c.side} (${c.team}): ${c.from ? c.from.player_name + ' [' + c.from.status + ']' : 'none'} -> ${c.to ? c.to.player_name + ' [' + c.to.status + ']' : 'none'}; home margin ${c.home_margin.before} -> ${c.home_margin.after}`));
}

async function main() {
  const argv = process.argv.slice(2);
  const at = new Date().toISOString();
  if (argv.includes('--record')) {
    const pi = argv.indexOf('--prev'), prev = pi >= 0 ? readJson(argv[pi + 1], null) : null, next = readJson(SLATE, null);
    if (!prev || !next) { console.log('starter sync --record: no earlier slate to compare'); return 0; }
    const changes = SYNC.starterChanges(prev, next), logged = SYNC.ledgerRows(changes, at, 'scheduled slate build', next.season);
    appendLedger(next.season, logged);
    if (SYNC.annotate(next, logged)) fs.writeFileSync(SLATE, JSON.stringify(next, null, 1) + '\n');
    console.log(`starter sync --record: ${changes.length} priced-starter change(s) between the two slates`); say(changes);
    return 0;
  }
  const slate = readJson(SLATE, null);
  if (!slate || !slate.season) { console.log('starter sync: no slate on file; nothing to compare'); output('rebuilt', 'false'); return 0; }
  const season = slate.season;
  const startersFile = readJson(path.join(ROOT, 'football', 'starters', 'nfl_' + season + '.json'), null);
  const injuries = readJson(path.join(ROOT, 'football', 'injuries', 'nfl_' + season + '.json'), null);
  const feedRows = parseCsv(await gamesCsv(argv.includes('--offline'))).rows.filter((r) => Number(r.season) === season);
  const stale = SYNC.staleGames(slate, currentInputs(slate, feedRows, startersFile, injuries, Date.now()));
  if (!stale.length) { console.log('starter sync: every upcoming game’s starter inputs match the slate'); output('rebuilt', 'false'); return 0; }
  console.log(`starter sync: ${stale.length} side(s) moved: ${stale.map((x) => x.game_id + ' ' + x.side + ' (' + x.reason + ')').join(', ')}`);
  if (argv.includes('--check')) { output('rebuilt', 'false'); return 1; }
  const r = spawnSync(process.execPath, [path.join(__dirname, 'build_nfl_slate.js')].concat(argv.includes('--offline') ? ['--offline'] : []), { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) { console.error('starter sync: the slate rebuild failed (exit ' + r.status + '); the previous slate stands'); output('rebuilt', 'false'); return 3; }
  const next = readJson(SLATE, null);
  const trigger = 'starter inputs changed: ' + [...new Set(stale.map((x) => x.game_id + ' ' + x.side))].join(', ');
  const changes = SYNC.starterChanges(slate, next), logged = SYNC.ledgerRows(changes, at, trigger, season);
  appendLedger(season, logged);
  /* the card says what changed, with both versions' numbers (the slate was built before the row existed) */
  if (SYNC.annotate(next, logged)) fs.writeFileSync(SLATE, JSON.stringify(next, null, 1) + '\n');
  console.log(`starter sync: slate rebuilt; ${changes.length} priced-starter change(s) logged to ${path.relative(ROOT, ledgerFile(season))}`); say(changes);
  output('rebuilt', 'true');
  return 0;
}
module.exports = { currentInputs, appendLedger };
if (require.main === module) main().then((c) => process.exit(c || 0)).catch((e) => { console.error('starter sync: ' + (e && e.stack || e)); process.exit(3); });
