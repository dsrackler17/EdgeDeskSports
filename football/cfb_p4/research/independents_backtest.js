#!/usr/bin/env node
/* ============================================================================
   EdgeDesk CFB — THE INDEPENDENTS AND THE CONFERENCE TERM, walk-forward.

   THE DEFECT (audit 2026-09-30 #5). Syracuse @ UConn: EdgeDesk had UConn
   -12.2 against a Syracuse -7.5 market. The join was oriented correctly; the
   number was not. The engine's conference-strength term
   (situation.conference, engine.js) treated "FBS Independents" as a
   conference: the group's cross-conference strength is an average over
   unrelated programmes (Notre Dame, UConn, UMass, ...) and in 2025 it was the
   highest of any group (+15.2), so it handed UConn +3.8 pts over every ACC
   team at three games played. An independent now carries NO conference
   strength (the term is unavailable, and says why); two conferences still get
   the term.

   THIS FILE MEASURES THE FIX, IT DOES NOT CHOOSE IT. The replay
   (regime_backtest.js --dump: every FBS game 2007-2025 projected by the
   engine with only information available before kickoff) is run twice —
   once with the old reading (params.conference.independents_as_conference
   = true), once as shipped — and the two fair margins are scored against the
   final margin on the games the change touches: every game with exactly one
   FBS independent against a conference team, in the held-out seasons
   (2014-2025, as the regime fit scores them). Nothing is fitted.

     node football/cfb_p4/research/independents_backtest.js --data .cache
     node football/cfb_p4/research/independents_backtest.js --data .cache --write
                   (--write regenerates report/independents_backtest.json)
   ============================================================================ */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HERE = __dirname;
function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return (v == null || v.slice(0, 2) === '--') ? true : v;
}
const DATA = path.resolve(String(arg('data', path.join(HERE, '.cache'))));
const TEST_FROM = parseInt(arg('test-from', 2014), 10);
const TEST_TO = parseInt(arg('test-to', 2025), 10);
const WRITE = !!arg('write', false);
const OUT = path.join(HERE, 'report', 'independents_backtest.json');

/* ---- the two replays -------------------------------------------------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edgedesk-indep-'));
const preload = path.join(tmp, 'old_reading.js');
fs.writeFileSync(preload, "global.window = global.window || global;\nrequire(" + JSON.stringify(path.join(HERE, '..', 'params.js'))
  + ");\nglobal.window.EDCfbP4Params.conference.independents_as_conference = true;\n");
function replay(file, old) {
  const args = (old ? ['-r', preload] : []).concat([path.join(HERE, 'regime_backtest.js'), '--data', DATA, '--dump', file]);
  execFileSync(process.execPath, args, { stdio: ['ignore', 'ignore', 'inherit'], maxBuffer: 1 << 28 });
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
const oldRows = replay(path.join(tmp, 'old.json'), true);
const newRows = replay(path.join(tmp, 'new.json'), false);
const byId = {}; newRows.forEach((r) => { byId[r.game_id] = r; });

/* ---- the games the change touches ------------------------------------- */
const indep = (c) => /independent/i.test(String(c || ''));
const games = [];
oldRows.forEach((o) => {
  const n = byId[o.game_id];
  if (!n || o.season < TEST_FROM || o.season > TEST_TO || o.margin == null || o.fair_std == null || n.fair_std == null) return;
  const hi = indep(o.home_conference), ai = indep(o.away_conference);
  if (hi === ai) return;   /* two conferences (unchanged) or two independents */
  games.push({ id: o.game_id, season: o.season, margin: o.margin, close: o.close, old: o.fair_std, now: n.fair_std });
});

/* ---- the record --------------------------------------------------------- */
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const r3 = (x) => x == null ? null : Math.round(x * 1000) / 1000;
const errOld = games.map((g) => Math.abs(g.old - g.margin)), errNew = games.map((g) => Math.abs(g.now - g.margin));
const d = games.map((g, i) => errNew[i] - errOld[i]);
/* a paired bootstrap of the MAE difference, seeded (the same answer every run) */
let seed = 20260930;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const boots = [];
for (let b = 0; b < 2000; b++) { let s = 0; for (let i = 0; i < d.length; i++) s += d[Math.floor(rnd() * d.length)]; boots.push(s / d.length); }
boots.sort((a, b) => a - b);
const seasons = {};
games.forEach((g, i) => { const s = seasons[g.season] || (seasons[g.season] = { n: 0, old: 0, now: 0 }); s.n++; s.old += errOld[i]; s.now += errNew[i]; });
const bySeason = Object.keys(seasons).sort().map((k) => ({ season: +k, games: seasons[k].n, mae_old: r3(seasons[k].old / seasons[k].n), mae_new: r3(seasons[k].now / seasons[k].n) }));
const withClose = games.filter((g) => g.close != null);
const changed = games.filter((g) => Math.abs(g.now - g.old) > 1e-9);
const report = {
  schema: 'edgedesk_cfb_independents_backtest_v1', generated_by: 'football/cfb_p4/research/independents_backtest.js',
  question: 'Does removing the "FBS Independents" conference strength from games between an independent and a conference team move the fair margin closer to the result?',
  held_out_seasons: TEST_FROM + '-' + TEST_TO,
  games: games.length, games_changed: changed.length,
  max_abs_change_pts: r3(Math.max.apply(null, changed.map((g) => Math.abs(g.now - g.old)).concat([0]))),
  mae_old_reading: r3(mean(errOld)), mae_shipped: r3(mean(errNew)), delta: r3(mean(d)),
  delta_ci95: [r3(boots[Math.floor(0.025 * boots.length)]), r3(boots[Math.floor(0.975 * boots.length)])],
  improved_seasons: bySeason.filter((s) => s.mae_new < s.mae_old).length, seasons: bySeason.length,
  mean_abs_gap_to_close_old: r3(mean(withClose.map((g) => Math.abs(g.old - g.close)))),
  mean_abs_gap_to_close_shipped: r3(mean(withClose.map((g) => Math.abs(g.now - g.close)))),
  by_season: bySeason,
  reading: 'A negative delta is a smaller error. The fix is a correction of what the term measures (an independent has no conference), not a fitted '
    + 'improvement: it ships because a group average over unrelated programmes is not a strength of either team, and this record says it does not '
    + 'make the number worse. A 95% interval that includes 0 is reported as not significant.'
};
report.significant = report.delta_ci95[1] < 0;
console.log(JSON.stringify(report, null, 1));
if (WRITE) { fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n'); console.error('[independents] wrote ' + path.relative(process.cwd(), OUT)); }
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* a temp dir left behind is harmless */ }
