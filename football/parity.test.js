#!/usr/bin/env node
/* ===========================================================================
   NFL TRAINING / SERVING PARITY (audit_report.md §0.2, §0.3).

   The python training pass (build_features.py + train_nfl.py, unmodified) is
   replayed over the full 2025 and 2026 seasons by
   football/research/nfl_v2/parity_dump.py, which records its state at the
   start of 2025 and after every absorbed game. This test loads that start
   state into football/engine.js and replays the same games through
   nfl.absorbCompleted — the one absorb path the live board, the slate
   builder, the daily check, the live check and both JS validators now share —
   from the committed feeds the board reads (football/nfl/stats_team_week_<y>.csv,
   football/nfl/qb_games_<y>.csv). It fails if ANY team rating, team QB level,
   league mean or credited quarterback value differs by more than 1e-9 after
   ANY game.

   It also proves every caller goes through that path (a source check), and
   that the old offence-only absorb really does diverge, so the test cannot
   pass by comparing a thing with itself.

   Regenerate the fixture after a retrain or a feed revision:
     football/research/nfl_v2/fetch_history.sh 2026
     NFL_LAST_SEASON=2026 python3 football/research/nfl_v2/parity_dump.py \
       football/research/nfl_v2/.cache/raw \
       football/research/nfl_v2/parity/nfl_parity_2025_2026.json.gz 2025

   Run: node football/parity.test.js      (exit 0 = parity holds)
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'football', 'params.js'));
const E = require(path.join(ROOT, 'football', 'engine.js'));
const { parseCsv } = require(path.join(ROOT, 'football', 'nfl', 'build_team_week.js'));

const TOL = 1e-9;
const FIXTURE = path.join(ROOT, 'football', 'research', 'nfl_v2', 'parity', 'nfl_parity_2025_2026.json.gz');
let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS | ' + name); }
  else { fail++; console.log('FAIL | ' + name + (detail !== undefined ? ' | ' + JSON.stringify(detail).slice(0, 400) : '')); }
}

const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString('utf8'));
function byGame(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  parseCsv(fs.readFileSync(file, 'utf8')).rows.forEach((r) => { (out[r.game_id] = out[r.game_id] || []).push(r); });
  return out;
}
const stw = {}, qbs = {};
for (let y = fx.meta.first_season; y <= fx.meta.last_season; y++) {
  Object.assign(stw, byGame(path.join(ROOT, 'football', 'nfl', `stats_team_week_${y}.csv`)));
  Object.assign(qbs, byGame(path.join(ROOT, 'football', 'nfl', `qb_games_${y}.csv`)));
}

function stateFromFixture(start) {
  const st = E.nfl.coldState();
  st.team = JSON.parse(JSON.stringify(start.team));
  st.lmean = JSON.parse(JSON.stringify(start.lmean));
  st.qb = JSON.parse(JSON.stringify(start.qb));
  st.teamQb = JSON.parse(JSON.stringify(start.team_qb));
  st.ngames = JSON.parse(JSON.stringify(start.ngames));
  st.pri = {}; st.season_games = {};
  return st;
}

/* replay with a given absorb; returns the per-absorb worst difference */
function replay(absorb) {
  const st = stateFromFixture(fx.start);
  let season = fx.meta.first_season, k = 0, worst = 0, where = null, orderOk = true, absorbedCount = 0;
  const diff = (a, b, label) => {
    const d = (a == null && b == null) ? 0 : (a == null || b == null) ? Infinity : Math.abs(a - b);
    if (d > worst) { worst = d; where = label; }
  };
  for (const g of fx.games) {
    if (g.season !== season) { E.nfl.seasonBreak(st); season = g.season; }
    const ok = absorb(st, g, stw[g.game_id] || [], qbs[g.game_id] || []);
    if (!ok) continue;
    absorbedCount++;
    const ref = fx.absorbs[k++];
    if (!ref) { worst = Infinity; where = 'js absorbed more games than python at ' + g.game_id; break; }
    const jsTeams = (stw[g.game_id] || []).map((r) => E.nfl.franchise(r.team));
    if (jsTeams.join() !== ref.teams.join()) orderOk = false;
    for (const t of ref.teams) {
      for (const f of E.nfl.RATE_FEATS) diff(st.team[t][f], ref.ratings[t][f], g.game_id + ' ' + t + '.' + f);
      diff(st.teamQb[t] || 0, ref.team_qb[t], g.game_id + ' ' + t + '.teamQb');
    }
    for (const f in ref.lmean) diff(st.lmean[f], ref.lmean[f], g.game_id + ' lmean.' + f);
    for (const t in ref.qb) {
      const q = ref.qb[t], mine = st.qb[q.id];
      if (q.v == null) { if (mine && q.dev != null) { worst = Infinity; where = g.game_id + ' qb ' + q.id + ' credited in JS only'; } continue; }
      diff(mine ? mine.v : null, q.v, g.game_id + ' qb ' + q.id + '.v');
      if (!mine || mine.n !== q.n) { worst = Infinity; where = g.game_id + ' qb ' + q.id + '.n'; }
    }
  }
  return { worst, where, absorbed: absorbedCount, expected: fx.absorbs.length, orderOk, state: st };
}

console.log(`python reference: ${fx.meta.source}; seasons ${fx.meta.first_season}-${fx.meta.last_season}; ${fx.meta.absorbed} absorbed games`);

/* 1. the shared absorb path matches training exactly */
const live = replay((st, g, rows, qbRows) => E.nfl.absorbCompleted(st, g, rows, qbRows));
chk(`every one of the ${fx.meta.absorbed} python absorbs is replayed (JS ${live.absorbed})`, live.absorbed === live.expected, live);
chk('teams are absorbed in the order training absorbs them (stats_team_week file order)', live.orderOk);
chk(`every rating, QB level, league mean and QB value matches python within ${TOL} after every game (worst ${live.worst.toExponential(2)} at ${live.where})`, live.worst <= TOL, { worst: live.worst, where: live.where });

/* 2. the old live absorb (offence rows only, no quarterbacks) does NOT match:
      the comparison above can detect the bug it exists to catch */
const old = replay((st, g, rows) => {
  if (rows.length !== 2) return false;
  const h = rows.find((r) => E.nfl.franchise(r.team) === g.home_team), a = rows.find((r) => E.nfl.franchise(r.team) === g.away_team);
  if (!h || !a) return false;
  const hr = E.nfl.teamGameFromStw(h), ar = E.nfl.teamGameFromStw(a);
  hr.pts_for = g.home_score; hr.pts_against = g.away_score; ar.pts_for = g.away_score; ar.pts_against = g.home_score;
  E.nfl.absorbGame(st, [[g.home_team, hr], [g.away_team, ar]], []);
  return true;
});
chk(`the pre-fix absorb (no defence, no QB) is caught by this test (worst ${old.worst.toExponential(2)} at ${old.where})`, old.worst > 1e-3, { worst: old.worst });

/* 3. the defence moves now: no def_* rating sits at its season-start value */
const frozen = [];
for (const t of Object.keys(live.state.team)) {
  const s = fx.start.team[t]; if (!s) continue;
  if (Math.abs(live.state.team[t].def_pass_epa_db - s.def_pass_epa_db * E.nfl.newState().hp.carry) < 1e-12) frozen.push(t);
}
chk('no club\'s pass-defence rating is still its carried 2025 value after 2026 is absorbed', frozen.length === 0, frozen);

/* 4. every caller of the rating recursion goes through the shared path */
const CALLERS = [
  'app.html', 'football/health/daily_check.js', 'football/research/live_check.js',
  'tools/football/validate_pricing.js', 'tools/football/linemaker_calibrate.js',
];
for (const f of CALLERS) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const usesShared = /nfl\.absorbCompleted\s*\(/.test(src);
  const rawOffenceAbsorb = /teamGameFromStw\([^)]*\)[\s\S]{0,400}?absorbGame\(/.test(src);
  chk(`${f} absorbs through nfl.absorbCompleted and never feeds absorbGame an offence-only row`, usesShared && !rawOffenceAbsorb, { usesShared, rawOffenceAbsorb });
}
const edge = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'ingest_nfl_features', 'index.ts'), 'utf8');
chk('supabase ingest_nfl_features mirrors the opponent\'s offence into def_* (its own Deno copy of the recursion)',
  /DEF_OF/.test(edge) && /mirrorDefence\s*\(/.test(edge), null);

console.log(fail ? `FAILURES ${pass} passed, ${fail} failed` : `ALL GREEN ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
